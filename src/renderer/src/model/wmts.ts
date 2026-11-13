import { childElements, childText, childrenNamed, firstChild, localName, parseXml } from './dom';
import { MERCATOR_MAX_LAT, matchScheme, type TileLayerSpec } from './tileLayers';
import { readWmsLayers } from './wms';

/**
 * Service capabilities (WMTS here, WMS in wms.ts) reduced to tile templates.
 *
 * Read a WMTS capabilities document far enough to turn each layer into a plain
 * `{z}/{x}/{y}` tile template, which is all the globe needs to stream it.
 *
 * Only Web Mercator tile matrix sets on the standard XYZ grid are usable
 * ("GoogleMapsCompatible" and its equivalents): matrix N must be 2^N tiles
 * wide. Layers offered only in other grids are reported with the reason.
 */

/** One layer of a WMTS or WMS service. */
export interface ServiceLayer {
  id: string;
  title: string;
  service: 'WMTS' | 'WMS';
  /** How to stream it, or absent when the layer can't be used (see `error`). */
  tiles?: TileLayerSpec;
  error?: string;
}

const MERCATOR_CRS = /(?:EPSG|OSGEO)[:\d.]*:(3857|900913|3785|102100|102113)$/i;

interface MatrixSet {
  id: string;
  /** Matrix identifier = `prefix` + zoom level. */
  prefix: string;
  levels: number[];
}

/** A matrix set as an XYZ pyramid, or null if it isn't one. */
function readMatrixSet(el: Element): MatrixSet | null {
  const id = childText(el, 'Identifier') ?? '';
  if (!MERCATOR_CRS.test(childText(el, 'SupportedCRS') ?? '')) return null;
  let prefix: string | null = null;
  const levels: number[] = [];
  for (const m of childrenNamed(el, 'TileMatrix')) {
    const ident = childText(m, 'Identifier') ?? '';
    const match = /^(.*?)(\d+)$/.exec(ident);
    if (!match) return null;
    const level = Number(match[2]);
    // The identifier's number has to be the XYZ zoom: 2^level tiles across.
    if (Number(childText(m, 'MatrixWidth')) !== 2 ** level) return null;
    if (prefix !== null && prefix !== match[1]) return null;
    prefix = match[1];
    levels.push(level);
  }
  return levels.length ? { id, prefix: prefix ?? '', levels } : null;
}

function corner(el: Element | null, tag: string): [number, number] | null {
  const parts = (el ? childText(el, tag) ?? '' : '').split(/\s+/).map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) ? [parts[0], parts[1]] : null;
}

/** Fill a WMTS template's placeholders (they are matched case-insensitively). */
function fillTemplate(template: string, values: Record<string, string>): string {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => lower.get(key.toLowerCase()) ?? whole);
}

/** The KVP GetTile endpoint, for services that publish no RESTful template. */
function kvpEndpoint(root: Element): string | null {
  const ops = firstChild(root, 'OperationsMetadata');
  if (!ops) return null;
  for (const op of childrenNamed(ops, 'Operation')) {
    if (op.getAttribute('name') !== 'GetTile') continue;
    const http = firstChild(firstChild(op, 'DCP') ?? op, 'HTTP');
    for (const get of http ? childrenNamed(http, 'Get') : []) {
      const encoding = (get.textContent ?? '').trim();
      const href = get.getAttribute('xlink:href');
      // No encoding constraint listed means KVP, the WMTS default.
      if (href && (encoding === '' || /kvp/i.test(encoding))) return href;
    }
  }
  return null;
}

function pickFormat<T extends { format: string }>(options: T[]): T | undefined {
  return (
    options.find((o) => /png/i.test(o.format)) ??
    options.find((o) => /jpe?g/i.test(o.format)) ??
    options[0]
  );
}

function readLayer(
  el: Element,
  sets: Map<string, MatrixSet | null>,
  kvp: string | null,
  source: string,
): ServiceLayer {
  const id = childText(el, 'Identifier') ?? '';
  const layer: ServiceLayer = { id, title: childText(el, 'Title') || id, service: 'WMTS' };

  // The first Web Mercator matrix set the layer is published in.
  const link = childrenNamed(el, 'TileMatrixSetLink').find(
    (l) => !!sets.get(childText(l, 'TileMatrixSet') ?? ''),
  );
  const set = link ? sets.get(childText(link, 'TileMatrixSet') ?? '') : null;
  if (!set || !link) {
    layer.error = 'not offered on the Web Mercator (GoogleMapsCompatible) tile grid';
    return layer;
  }

  const styles = childrenNamed(el, 'Style');
  const style = styles.find((s) => s.getAttribute('isDefault') === 'true') ?? styles[0];
  const values: Record<string, string> = {
    TileMatrix: `${set.prefix}{z}`,
    TileRow: '{y}',
    TileCol: '{x}',
    TileMatrixSet: set.id,
    Style: style ? childText(style, 'Identifier') ?? '' : '',
    Layer: id,
  };
  for (const dim of childrenNamed(el, 'Dimension')) {
    const name = childText(dim, 'Identifier');
    const value = childText(dim, 'Default') ?? childText(dim, 'Value');
    if (name && value !== undefined) values[name] = value;
  }

  const rest = pickFormat(
    childrenNamed(el, 'ResourceURL')
      .filter((r) => r.getAttribute('resourceType') === 'tile')
      .map((r) => ({
        format: r.getAttribute('format') ?? '',
        template: r.getAttribute('template') ?? '',
      }))
      .filter((r) => r.template),
  );
  let url: string;
  if (rest) {
    url = fillTemplate(rest.template, values);
  } else if (kvp) {
    const format = pickFormat(
      childrenNamed(el, 'Format').map((f) => ({ format: f.textContent?.trim() ?? '' })),
    );
    const q = (v: string): string => encodeURIComponent(v);
    url =
      kvp +
      (kvp.includes('?') ? (/[?&]$/.test(kvp) ? '' : '&') : '?') +
      `SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${q(id)}&STYLE=${q(values.Style)}` +
      `&TILEMATRIXSET=${q(set.id)}&TILEMATRIX=${q(set.prefix)}{z}&TILEROW={y}&TILECOL={x}` +
      `&FORMAT=${q(format?.format || 'image/png')}`;
  } else {
    layer.error = 'publishes no tile URL';
    return layer;
  }

  // Zoom range: the layer's own limits where given, else the whole matrix set.
  let levels = set.levels;
  const limits = firstChild(link, 'TileMatrixSetLimits');
  if (limits) {
    const limited = childElements(limits)
      .filter((l) => localName(l) === 'TileMatrixLimits')
      .map((l) => (childText(l, 'TileMatrix') ?? '').slice(set.prefix.length))
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    if (limited.length) levels = limited;
  }

  const tiles: TileLayerSpec = {
    url: matchScheme(url, source),
    minZoom: Math.min(...levels),
    maxZoom: Math.max(...levels),
    source,
  };
  const box = firstChild(el, 'WGS84BoundingBox');
  const lower = corner(box, 'LowerCorner');
  const upper = corner(box, 'UpperCorner');
  if (lower && upper && lower[0] < upper[0] && lower[1] < upper[1]) {
    tiles.bounds = [
      Math.max(lower[0], -180),
      Math.max(lower[1], -MERCATOR_MAX_LAT),
      Math.min(upper[0], 180),
      Math.min(upper[1], MERCATOR_MAX_LAT),
    ];
  }
  layer.tiles = tiles;
  return layer;
}

/** The layers of a parsed WMTS capabilities document. */
function readWmtsLayers(root: Element, source: string): ServiceLayer[] {
  const contents = firstChild(root, 'Contents');
  if (!contents) throw new Error('Not a WMTS capabilities document');
  const sets = new Map<string, MatrixSet | null>();
  for (const s of childrenNamed(contents, 'TileMatrixSet')) {
    sets.set(childText(s, 'Identifier') ?? '', readMatrixSet(s));
  }
  const kvp = kvpEndpoint(root);
  return childrenNamed(contents, 'Layer').map((l) => readLayer(l, sets, kvp, source));
}

/**
 * The layers of a WMTS or WMS capabilities document. `source` is the URL it
 * was read from, recorded on each layer. Throws if the text is neither.
 */
export function parseCapabilities(xml: string, source: string): ServiceLayer[] {
  const root = parseXml(xml).documentElement as Element | null;
  const tag = root ? localName(root) : '';
  if (root && tag === 'Capabilities') return readWmtsLayers(root, source);
  if (root && (tag === 'WMS_Capabilities' || tag === 'WMT_MS_Capabilities')) {
    return readWmsLayers(root, source);
  }
  throw new Error('Not a WMTS or WMS capabilities document');
}
