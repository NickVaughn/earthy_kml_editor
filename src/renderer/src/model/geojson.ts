import { nextId } from './ids';
import type { KmlNode, KmlStyle, Geometry, Position } from './types';

/**
 * Convert a GeoJSON FeatureCollection (already reprojected to EPSG:4326 by
 * GDAL) into a KML folder of placemarks, with attribute-driven naming,
 * description tables, and either a single style or one style per category.
 */

/** How a feature's polygon/line styling is drawn. */
export type FillMode = 'outline' | 'fill' | 'both';

export interface ImportOptions {
  /** Folder name (usually the source layer name). */
  layerName: string;
  /** Attribute used as each placemark's <name>. */
  nameField?: string;
  /** Attributes rendered as an HTML table in <description>. */
  descriptionFields?: string[];
  /** Attribute whose distinct values become sub-folders. */
  groupField?: string;
  styleMode: 'single' | 'categorized';
  /** Attribute whose distinct values drive per-category colors. */
  categoryField?: string;
  /** Colour ramp used for categories (default 'category'). */
  ramp?: RampName;
  /** Outline only, fill only, or both (default 'both'). */
  fillMode?: FillMode;
  /** 0..1 opacity for the fill (default 0.5). */
  fillOpacity?: number;
  /** 0..1 opacity for the outline/line (default 1). */
  lineOpacity?: number;
  /** Outline width in pixels (default 2). */
  lineWidth?: number;
  /** Base colour when styleMode === 'single' (hex, default blue). */
  singleColor?: string;
  /** Full style override when styleMode === 'single'. */
  singleStyle?: KmlStyle;
}

export interface ImportResult {
  folder: KmlNode;
  /** Shared styles the placemarks reference; caller registers them. */
  styles: KmlStyle[];
  featureCount: number;
  skipped: number;
}

interface GeoJsonFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { type: string; coordinates?: unknown; geometries?: unknown[] } | null;
}

// ---- colors ---------------------------------------------------------------

export type RampName =
  | 'category'
  | 'rainbow'
  | 'viridis'
  | 'warm'
  | 'cool'
  | 'grayscale';

export const RAMPS: { id: RampName; label: string }[] = [
  { id: 'category', label: 'Categorical (distinct)' },
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'warm', label: 'Warm' },
  { id: 'cool', label: 'Cool' },
  { id: 'grayscale', label: 'Grayscale' },
];

/** Qualitative palette (cycles) — best for unordered categories. */
const CATEGORY_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

/** Control points for the continuous ramps. */
const RAMP_STOPS: Record<Exclude<RampName, 'category' | 'rainbow'>, string[]> = {
  viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  warm: ['#fff7bc', '#fec44f', '#fe9929', '#ec7014', '#cc4c02', '#8c2d04'],
  cool: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
  grayscale: ['#eeeeee', '#222222'],
};

function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Sample a multi-stop ramp at t in 0..1. */
function interpolateStops(stops: string[], t: number): string {
  if (stops.length === 1) return stops[0];
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const [r1, g1, b1] = hexToRgb(stops[i]);
  const [r2, g2, b2] = hexToRgb(stops[i + 1]);
  return rgbToHex(r1 + (r2 - r1) * f, g1 + (g2 - g1) * f, b1 + (b2 - b1) * f);
}

/** Colour for category `index` of `total`, from the chosen ramp. */
export function rampColor(ramp: RampName, index: number, total: number): string {
  if (ramp === 'category') return CATEGORY_PALETTE[index % CATEGORY_PALETTE.length];
  if (ramp === 'rainbow') {
    const hue = total <= 1 ? 200 : (index * 360) / total;
    return hslToHex(hue, 0.65, 0.55);
  }
  const t = total <= 1 ? 0.5 : index / (total - 1);
  return interpolateStops(RAMP_STOPS[ramp], t);
}

/** Back-compat helper: rainbow ramp. */
export function categoryColor(index: number, total: number): string {
  return rampColor('rainbow', index, total);
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  const to = (v: number): string =>
    Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** `#rrggbb` + alpha byte -> KML aabbggrr. */
function hexToKml(hex: string, alphaByte: number): string {
  const s = hex.replace('#', '');
  const r = s.slice(0, 2);
  const g = s.slice(2, 4);
  const b = s.slice(4, 6);
  return `${alphaByte.toString(16).padStart(2, '0')}${b}${g}${r}`;
}

function alphaByte(opacity: number | undefined, fallback: number): number {
  if (opacity === undefined) return fallback;
  return Math.max(0, Math.min(255, Math.round(opacity * 255)));
}

/** Build a shared style for one colour, honouring fill mode and opacities. */
function styleForColor(id: string, hex: string, opts: ImportOptions): KmlStyle {
  const mode: FillMode = opts.fillMode ?? 'both';
  const showFill = mode === 'fill' || mode === 'both';
  const showOutline = mode === 'outline' || mode === 'both';
  const lineAlpha = alphaByte(opts.lineOpacity, 0xff);
  const fillAlpha = alphaByte(opts.fillOpacity, 0x80);
  return {
    id,
    icon: { color: hexToKml(hex, lineAlpha), scale: 1 },
    line: { color: hexToKml(hex, lineAlpha), width: opts.lineWidth ?? 2 },
    poly: {
      color: hexToKml(hex, fillAlpha),
      fill: showFill,
      outline: showOutline,
    },
  };
}

// ---- geometry -------------------------------------------------------------

function toPositions(coords: unknown): Position[] {
  if (!Array.isArray(coords)) return [];
  return (coords as number[][])
    .filter((c) => Array.isArray(c) && c.length >= 2)
    .map((c) => (c.length >= 3 ? [c[0], c[1], c[2]] : [c[0], c[1]]) as Position);
}

/** Convert a GeoJSON geometry to the KML model's geometry, or null if unsupported. */
export function geojsonGeometry(g: GeoJsonFeature['geometry']): Geometry | null {
  if (!g) return null;
  const c = g.coordinates as never;
  switch (g.type) {
    case 'Point': {
      const p = toPositions([c as unknown as number[]])[0];
      return p ? { kind: 'Point', coordinates: p } : null;
    }
    case 'MultiPoint': {
      const pts = toPositions(c).map<Geometry>((p) => ({ kind: 'Point', coordinates: p }));
      return pts.length ? { kind: 'MultiGeometry', geometries: pts } : null;
    }
    case 'LineString': {
      const line = toPositions(c);
      return line.length >= 2
        ? { kind: 'LineString', coordinates: line, tessellate: true }
        : null;
    }
    case 'MultiLineString': {
      const parts = (c as unknown[][])
        .map((l) => toPositions(l))
        .filter((l) => l.length >= 2)
        .map<Geometry>((l) => ({ kind: 'LineString', coordinates: l, tessellate: true }));
      return parts.length ? { kind: 'MultiGeometry', geometries: parts } : null;
    }
    case 'Polygon': {
      const rings = (c as unknown[]).map((r) => toPositions(r));
      if (!rings.length || rings[0].length < 3) return null;
      return {
        kind: 'Polygon',
        outerBoundary: rings[0],
        innerBoundaries: rings.slice(1).filter((r) => r.length >= 3),
        tessellate: true,
      };
    }
    case 'MultiPolygon': {
      const polys = (c as unknown[][])
        .map((poly) => geojsonGeometry({ type: 'Polygon', coordinates: poly as never }))
        .filter((p): p is Geometry => !!p);
      return polys.length ? { kind: 'MultiGeometry', geometries: polys } : null;
    }
    case 'GeometryCollection': {
      const geoms = (g.geometries ?? [])
        .map((sub) => geojsonGeometry(sub as GeoJsonFeature['geometry']))
        .filter((p): p is Geometry => !!p);
      return geoms.length ? { kind: 'MultiGeometry', geometries: geoms } : null;
    }
    default:
      return null;
  }
}

// ---- import ---------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function descriptionTable(
  props: Record<string, unknown>,
  fields: string[],
): string | undefined {
  const rows = fields
    .filter((f) => props[f] !== undefined && props[f] !== null)
    .map(
      (f) =>
        `<tr><td><b>${escapeHtml(f)}</b></td><td>${escapeHtml(String(props[f]))}</td></tr>`,
    );
  return rows.length ? `<table>${rows.join('')}</table>` : undefined;
}

export function geojsonToFolder(
  geojsonText: string | { features?: GeoJsonFeature[] },
  opts: ImportOptions,
): ImportResult {
  const data =
    typeof geojsonText === 'string'
      ? (JSON.parse(geojsonText) as { features?: GeoJsonFeature[] })
      : geojsonText;
  const features = data.features ?? [];

  // Build the style set up front so placemarks can reference by styleUrl.
  const styles: KmlStyle[] = [];
  const styleIdByCategory = new Map<string, string>();
  const suffix = nextId();

  if (opts.styleMode === 'categorized' && opts.categoryField) {
    const values = distinctValues(features, opts.categoryField);
    const ramp = opts.ramp ?? 'category';
    values.forEach((value, i) => {
      const id = `nge-cat-${suffix}-${i}`;
      styleIdByCategory.set(value, id);
      styles.push(styleForColor(id, rampColor(ramp, i, values.length), opts));
    });
  } else {
    const id = `nge-import-${suffix}`;
    const base = opts.singleStyle
      ? { ...structuredClone(opts.singleStyle), id }
      : styleForColor(id, opts.singleColor ?? '#4da6ff', opts);
    styles.push(base);
    styleIdByCategory.set('', id);
  }

  const folder: KmlNode = {
    id: nextId(),
    type: 'Folder',
    name: opts.layerName || 'Imported layer',
    visible: true,
    open: true,
    children: [],
    unknownChildren: [],
    attrs: {},
  };

  // Optional grouping: features land in sub-folders named by a field's value.
  const groups = new Map<string, KmlNode>();
  const groupFolder = (props: Record<string, unknown>): KmlNode => {
    if (!opts.groupField) return folder;
    const raw = String(props[opts.groupField] ?? '').trim();
    const label = raw || '(blank)';
    let sub = groups.get(label);
    if (!sub) {
      sub = {
        id: nextId(),
        type: 'Folder',
        name: label,
        visible: true,
        open: false,
        children: [],
        unknownChildren: [],
        attrs: {},
      };
      groups.set(label, sub);
    }
    return sub;
  };

  let skipped = 0;
  let featureCount = 0;
  for (const f of features) {
    const geometry = geojsonGeometry(f.geometry);
    if (!geometry) {
      skipped++;
      continue;
    }
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const name = opts.nameField ? String(props[opts.nameField] ?? '') : '';
    const styleId =
      opts.styleMode === 'categorized' && opts.categoryField
        ? styleIdByCategory.get(String(props[opts.categoryField] ?? ''))
        : styleIdByCategory.get('');

    const description = opts.descriptionFields?.length
      ? descriptionTable(props, opts.descriptionFields)
      : undefined;

    groupFolder(props).children.push({
      id: nextId(),
      type: 'Placemark',
      name,
      description,
      descriptionCdata: !!description,
      visible: true,
      children: [],
      unknownChildren: [],
      attrs: {},
      geometry,
      styleUrl: styleId ? `#${styleId}` : undefined,
      extendedData: buildExtendedData(props),
    });
    featureCount++;
  }

  // Attach group sub-folders in natural order, with "(blank)" last.
  if (opts.groupField) {
    const sorted = [...groups.entries()].sort(([a], [b]) => {
      if (a === '(blank)') return 1;
      if (b === '(blank)') return -1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
    for (const [, sub] of sorted) folder.children.push(sub);
  }

  return { folder, styles, featureCount, skipped };
}

/** Distinct values of a field across features, in first-seen order. */
function distinctValues(features: GeoJsonFeature[], field: string): string[] {
  const out: string[] = [];
  for (const f of features) {
    const v = String(f.properties?.[field] ?? '');
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Preserve all source attributes as KML <Data> so nothing is lost on import. */
function buildExtendedData(
  props: Record<string, unknown>,
): { raw: string; fields: { name: string; value: string }[] } | undefined {
  const entries = Object.entries(props).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return undefined;
  const fields = entries.map(([name, v]) => ({ name, value: String(v) }));
  const raw = `<ExtendedData>${fields
    .map(
      (f) =>
        `<Data name="${escapeHtml(f.name)}"><value>${escapeHtml(f.value)}</value></Data>`,
    )
    .join('')}</ExtendedData>`;
  return { raw, fields };
}
