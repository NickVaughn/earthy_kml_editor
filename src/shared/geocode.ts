/**
 * Place-name search ("geocoding"). Two sources:
 *
 * - OpenStreetMap's Nominatim — keyless, the default. Its usage policy asks
 *   for an identifying User-Agent and at most one request per second, so the
 *   app only searches on Enter, never per keystroke, and main sets the agent.
 * - Cesium ion's geocoder (Pelias) — needs the ion token, so it is only
 *   offered when one is configured.
 *
 * The HTTP calls live in main (`main/geocode.ts`); the response parsers here
 * are pure so they can be unit-tested, and both reduce to the same shape.
 */

export type GeocodeSource = 'osm' | 'ion';

export const GEOCODE_SOURCES: {
  id: GeocodeSource;
  /** Menu label. */
  label: string;
  /** Fits the search box's placeholder. */
  shortLabel: string;
  needsIonKey: boolean;
}[] = [
  { id: 'osm', label: 'OpenStreetMap (Nominatim)', shortLabel: 'OpenStreetMap', needsIonKey: false },
  { id: 'ion', label: 'Cesium ion', shortLabel: 'Cesium ion', needsIonKey: true },
];

export function geocodeSourceLabel(id: GeocodeSource): string {
  return GEOCODE_SOURCES.find((s) => s.id === id)?.shortLabel ?? id;
}

export interface GeocodeResult {
  /** Display name, e.g. "Flagstaff, Coconino County, Arizona, United States". */
  label: string;
  /** [west, south, east, north] in degrees, already padded (see `padBounds`). */
  bounds: [number, number, number, number];
}

export interface GeocodeResponse {
  results: GeocodeResult[];
  /** The source that produced `results` (may differ from the one asked for). */
  source: GeocodeSource;
  /** Set when the search could not be run (network, missing key…). */
  error?: string;
}

/** Nominatim's `format=jsonv2` items, the fields used here. */
export interface NominatimItem {
  display_name?: string;
  /** [south, north, west, east] — as strings. */
  boundingbox?: (string | number)[];
  lat?: string | number;
  lon?: string | number;
}

/** Pelias / Cesium ion `FeatureCollection`, the fields used here. */
export interface PeliasFeature {
  bbox?: number[];
  geometry?: { type?: string; coordinates?: number[] };
  properties?: { label?: string; name?: string };
}

/**
 * Smallest extent (degrees) a result is flown to. A point result's box is
 * zero-sized and a village's is a few hundred metres; flying to either would
 * end with the camera on the ground. ~2 km is the closest sensible "here".
 */
export const MIN_SPAN_DEG = 0.02;

/** Widen `bounds` to at least MIN_SPAN_DEG on each axis, about its centre. */
export function padBounds(
  bounds: [number, number, number, number],
): [number, number, number, number] {
  let [w, s, e, n] = bounds;
  if (e - w < MIN_SPAN_DEG) {
    const c = (w + e) / 2;
    w = c - MIN_SPAN_DEG / 2;
    e = c + MIN_SPAN_DEG / 2;
  }
  if (n - s < MIN_SPAN_DEG) {
    const c = (s + n) / 2;
    s = Math.max(-90, c - MIN_SPAN_DEG / 2);
    n = Math.min(90, c + MIN_SPAN_DEG / 2);
  }
  return [w, s, e, n];
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function parseNominatim(items: unknown): GeocodeResult[] {
  if (!Array.isArray(items)) return [];
  const out: GeocodeResult[] = [];
  for (const raw of items as NominatimItem[]) {
    if (!raw || typeof raw !== 'object') continue;
    const label = typeof raw.display_name === 'string' ? raw.display_name : '';
    let bounds: [number, number, number, number] | null = null;
    const bb = raw.boundingbox;
    if (Array.isArray(bb) && bb.length === 4) {
      const [s, n, w, e] = bb.map(num);
      if (s !== null && n !== null && w !== null && e !== null) bounds = [w, s, e, n];
    }
    if (!bounds) {
      const lat = num(raw.lat);
      const lon = num(raw.lon);
      if (lat === null || lon === null) continue;
      bounds = [lon, lat, lon, lat];
    }
    if (!label) continue;
    out.push({ label, bounds: padBounds(bounds) });
  }
  return out;
}

export function parsePelias(collection: unknown): GeocodeResult[] {
  const features = (collection as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: GeocodeResult[] = [];
  for (const f of features as PeliasFeature[]) {
    if (!f || typeof f !== 'object') continue;
    const label = f.properties?.label ?? f.properties?.name ?? '';
    let bounds: [number, number, number, number] | null = null;
    if (Array.isArray(f.bbox) && f.bbox.length === 4) {
      const [w, s, e, n] = f.bbox.map(num);
      if (w !== null && s !== null && e !== null && n !== null) bounds = [w, s, e, n];
    }
    if (!bounds && f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
      const [lon, lat] = f.geometry.coordinates.map(num);
      if (lon !== null && lat !== null) bounds = [lon, lat, lon, lat];
    }
    if (!bounds || !label) continue;
    out.push({ label, bounds: padBounds(bounds) });
  }
  return out;
}
