import type { ExtendedDataField, KmlNode } from './types';

/**
 * A tiled raster is a GroundOverlay whose `<Icon><href>` points at the *source*
 * file rather than an embedded image, plus an `<ExtendedData>` marker naming
 * the local tile pyramid. Other KML readers still see a normal (if unresolvable)
 * overlay; Earthy sees the marker and renders from its tile cache.
 *
 * Tiled rasters are therefore app-local: the pyramid lives in the user's cache,
 * not inside the KMZ (PLAN §6.2.3).
 */

export const TILE_HASH_KEY = 'earthy:tiles';
export const TILE_MIN_ZOOM_KEY = 'earthy:minZoom';
export const TILE_MAX_ZOOM_KEY = 'earthy:maxZoom';

export interface TileMarker {
  hash: string;
  minZoom: number;
  maxZoom: number;
}

/** The tile marker on a node, or null if it isn't a tiled overlay. */
export function tiledOverlayInfo(node: KmlNode): TileMarker | null {
  const fields = node.extendedData?.fields;
  if (!fields) return null;
  const value = (key: string): string | undefined =>
    fields.find((f) => f.name === key)?.value;
  const hash = value(TILE_HASH_KEY);
  if (!hash) return null;
  const minZoom = Number(value(TILE_MIN_ZOOM_KEY));
  const maxZoom = Number(value(TILE_MAX_ZOOM_KEY));
  return {
    hash,
    minZoom: Number.isFinite(minZoom) ? minZoom : 0,
    maxZoom: Number.isFinite(maxZoom) ? maxZoom : 0,
  };
}

/** Build the `<ExtendedData>` payload that marks a node as tiled. */
export function tileMarkerExtendedData(marker: TileMarker): {
  raw: string;
  fields: ExtendedDataField[];
} {
  const fields: ExtendedDataField[] = [
    { name: TILE_HASH_KEY, value: marker.hash },
    { name: TILE_MIN_ZOOM_KEY, value: String(marker.minZoom) },
    { name: TILE_MAX_ZOOM_KEY, value: String(marker.maxZoom) },
  ];
  const raw = `<ExtendedData>${fields
    .map((f) => `<Data name="${f.name}"><value>${f.value}</value></Data>`)
    .join('')}</ExtendedData>`;
  return { raw, fields };
}

/** The imagery URL template for a tiled overlay, served by the main process. */
export function tileUrlTemplate(hash: string): string {
  return `earthy-tiles://${hash}/{z}/{x}/{y}.png`;
}
