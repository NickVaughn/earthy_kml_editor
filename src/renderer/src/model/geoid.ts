/**
 * EGM96 geoid access for the renderer. The grid is parsed in the main process
 * and sent here once; we hold it and sample the undulation N live. Orthometric
 * MSL height = ellipsoidal height − N.
 */
import type { GeoidGrid } from '@shared/ipc';

let grid: GeoidGrid | null = null;
let loading: Promise<void> | null = null;

/** Fetch + cache the geoid grid from main (once). Safe to call repeatedly. */
export function loadGeoid(): Promise<void> {
  if (grid) return Promise.resolve();
  if (!loading) {
    loading = window.api.getGeoidGrid().then((g) => {
      grid = g;
    });
  }
  return loading;
}

/** Geoid undulation N (metres) at lon/lat, or null until the grid has loaded. */
export function geoidHeight(lon: number, lat: number): number | null {
  return grid ? sampleGrid(grid, lon, lat) : null;
}

/**
 * Bilinear sample of a node-registered global grid. Longitude wraps at the
 * antimeridian; latitude clamps to the poles. Pure (grid passed in) so the
 * interpolation is unit-testable without the IPC/singleton path.
 */
export function sampleGrid(g: GeoidGrid, lon: number, lat: number): number {
  const { width, height, originLon, originLat, dLon, dLat, values } = g;
  let fx = (lon - originLon) / dLon;
  let fy = (lat - originLat) / dLat;
  fx = ((fx % width) + width) % width; // wrap longitude into [0, width)
  if (fy < 0) fy = 0;
  else if (fy > height - 1) fy = height - 1; // clamp latitude to the grid
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = (x0 + 1) % width; // wrap the east seam
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = values[y0 * width + x0];
  const v10 = values[y0 * width + x1];
  const v01 = values[y1 * width + x0];
  const v11 = values[y1 * width + x1];
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}
