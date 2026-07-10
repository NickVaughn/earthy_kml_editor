import type { Position } from './types';

/**
 * Geodesic measurement helpers on the WGS84 sphere. Kept Cesium-free so they
 * are unit-testable and usable from the model layer.
 */

const R_MEAN = 6371008.8; // mean Earth radius (m), for distances
const R_EQ = 6378137; // semi-major axis (m), for the spherical area approximation

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two [lon, lat] points, in metres. */
export function haversine(a: Position, b: Position): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MEAN * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a polyline, in metres. */
export function lineLength(positions: Position[]): number {
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    total += haversine(positions[i - 1], positions[i]);
  }
  return total;
}

/**
 * Area of a polygon ring (spherical excess approximation), in square metres.
 * The ring may be open or closed; sign is ignored.
 */
export function polygonArea(ring: Position[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    total += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((total * R_EQ * R_EQ) / 2);
}

export function formatLength(metres: number): string {
  if (metres < 1000) return `${metres.toFixed(1)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

export function formatArea(sqMetres: number): string {
  if (sqMetres < 1_000_000) return `${sqMetres.toFixed(0)} m²`;
  const km2 = sqMetres / 1_000_000;
  const ha = sqMetres / 10_000;
  return `${km2.toFixed(3)} km² (${ha.toFixed(1)} ha)`;
}
