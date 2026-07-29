/**
 * EGM96 geoid access for the renderer. Main sends the raw GeoTIFF bytes; we
 * parse them here (geotiff.js, bundled by Vite so its ESM deps are fine) and
 * sample the undulation N live. Orthometric MSL = ellipsoidal height − N.
 */
import { fromArrayBuffer } from 'geotiff';
import type { GeoidGrid } from '@shared/ipc';

let grid: GeoidGrid | null = null;
let loading: Promise<void> | null = null;

/** Fetch + parse + cache the geoid grid (once). Safe to call repeatedly. */
export function loadGeoid(): Promise<void> {
  if (grid) return Promise.resolve();
  if (!loading) loading = doLoad();
  return loading;
}

async function doLoad(): Promise<void> {
  try {
    const bytes = await window.api.getGeoidGrid();
    if (!bytes) return;
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const tiff = await fromArrayBuffer(buf);
    const image = await tiff.getImage();
    const [originLon, originLat] = image.getOrigin();
    const [dLon, dLat] = image.getResolution();
    const rasters = await image.readRasters({ interleave: false });
    const band = rasters[0] as Float32Array | ArrayLike<number>;
    grid = {
      width: image.getWidth(),
      height: image.getHeight(),
      originLon,
      originLat,
      dLon,
      dLat,
      values: band instanceof Float32Array ? band : Float32Array.from(band),
    };
  } catch (err) {
    console.error('[earthy] geoid parse failed:', err);
  }
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
