import type { ExtendedDataField, KmlNode } from './types';
import { TILE_MAX_ZOOM_KEY, TILE_MIN_ZOOM_KEY } from './overlays';

/**
 * A web tile layer is a GroundOverlay whose `<ExtendedData>` names a tile URL
 * template instead of an image: Earthy streams tiles from it, other KML
 * readers see an overlay with an unloadable icon. Nothing is embedded, so the
 * layer saves in plain KML and reloads from the server next time.
 *
 * Tiles are Web Mercator (the XYZ / "GoogleMapsCompatible" grid) unless the
 * layer says otherwise (see `grid`). The template
 * uses Cesium's placeholders: `{z}` `{x}` `{y}`, `{reverseY}` for TMS rows,
 * `{s}` for a/b/c subdomains, or `{westProjected}` … for a WMS-style bbox.
 */

export const TILE_URL_KEY = 'earthy:tileUrl';
/** Where the template came from (a WMTS capabilities URL), for reference. */
export const TILE_SOURCE_KEY = 'earthy:tileSource';
export const TILE_GRID_KEY = 'earthy:tileGrid';
export const TILE_HIDE_BELOW_KEY = 'earthy:tileHideBelow';

/** Web Mercator's latitude limit. */
export const MERCATOR_MAX_LAT = 85.0511287798;
export const DEFAULT_MAX_ZOOM = 18;

export interface TileLayerSpec {
  /** URL template with `{z}`/`{x}`/`{y}` placeholders. */
  url: string;
  minZoom: number;
  maxZoom: number;
  /** [west, south, east, north] in degrees; the whole world if absent. */
  bounds?: [number, number, number, number];
  source?: string;
  /**
   * The tile grid: Web Mercator unless 'geographic' (plain lon/lat, two tiles
   * across at level 0), which is what a WMS without Web Mercator is asked for.
   */
  grid?: 'geographic';
  /**
   * Request nothing while the view is zoomed out past this level. For servers
   * that time out rendering a wide view (a WMS over a large vector dataset).
   */
  hideBelow?: number;
}

const BBOX_PLACEHOLDER = /\{(west|south|east|north)(Projected|Degrees)?\}/;

/**
 * Tidy a pasted template into Cesium's syntax: `${z}` → `{z}`, upper-case
 * `{Z}` → `{z}`, and the TMS spellings `{-y}` / `{ry}` → `{reverseY}`.
 */
export function normalizeTileTemplate(raw: string): string {
  return raw
    .trim()
    .replace(/\$\{/g, '{')
    .replace(/\{([xyzs])\}/gi, (_m, p: string) => `{${p.toLowerCase()}}`)
    .replace(/\{(-y|ry|reversey)\}/gi, '{reverseY}');
}

/** True when the (normalized) URL is a tile template rather than a document. */
export function isTileTemplate(url: string): boolean {
  const u = normalizeTileTemplate(url);
  const xyz = u.includes('{z}') && u.includes('{x}') && /\{(y|reverseY)\}/.test(u);
  return xyz || BBOX_PLACEHOLDER.test(u);
}

/** Why a URL can't be used as a tile template, or null if it can. */
export function tileTemplateError(url: string): string | null {
  const u = normalizeTileTemplate(url);
  if (!/^https?:\/\//i.test(u)) return 'The URL must start with http:// or https://';
  if (!isTileTemplate(u)) return 'The URL needs {z}, {x} and {y} placeholders';
  return null;
}

/** The tile-layer marker on a node, or null if it isn't a web tile layer. */
export function tileLayerInfo(node: KmlNode): TileLayerSpec | null {
  const fields = node.extendedData?.fields;
  if (!fields) return null;
  const value = (key: string): string | undefined =>
    fields.find((f) => f.name === key)?.value;
  const url = value(TILE_URL_KEY);
  if (!url) return null;
  const minZoom = Number(value(TILE_MIN_ZOOM_KEY));
  const maxZoom = Number(value(TILE_MAX_ZOOM_KEY));
  const spec: TileLayerSpec = {
    url,
    minZoom: Number.isFinite(minZoom) ? minZoom : 0,
    maxZoom: Number.isFinite(maxZoom) ? maxZoom : DEFAULT_MAX_ZOOM,
  };
  const source = value(TILE_SOURCE_KEY);
  if (source) spec.source = source;
  if (value(TILE_GRID_KEY) === 'geographic') spec.grid = 'geographic';
  const hideBelow = Number(value(TILE_HIDE_BELOW_KEY));
  if (Number.isInteger(hideBelow) && hideBelow > 0) spec.hideBelow = hideBelow;
  const b = node.overlay?.box;
  if (b) spec.bounds = [b.west, b.south, b.east, b.north];
  return spec;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the `<ExtendedData>` payload that marks a node as a web tile layer. */
export function tileLayerExtendedData(spec: TileLayerSpec): {
  raw: string;
  fields: ExtendedDataField[];
} {
  const fields: ExtendedDataField[] = [
    { name: TILE_URL_KEY, value: spec.url },
    { name: TILE_MIN_ZOOM_KEY, value: String(spec.minZoom) },
    { name: TILE_MAX_ZOOM_KEY, value: String(spec.maxZoom) },
  ];
  if (spec.source) fields.push({ name: TILE_SOURCE_KEY, value: spec.source });
  if (spec.grid) fields.push({ name: TILE_GRID_KEY, value: spec.grid });
  if (spec.hideBelow) fields.push({ name: TILE_HIDE_BELOW_KEY, value: String(spec.hideBelow) });
  const raw = `<ExtendedData>${fields
    .map((f) => `<Data name="${f.name}"><value>${esc(f.value)}</value></Data>`)
    .join('')}</ExtendedData>`;
  return { raw, fields };
}

/**
 * Capabilities served over https often advertise http:// endpoints (the server
 * sits behind a proxy and doesn't know). Follow the document's own scheme.
 */
export function matchScheme(url: string, source: string): string {
  return /^https:/i.test(source) && /^http:/i.test(url) ? `https:${url.slice(5)}` : url;
}
