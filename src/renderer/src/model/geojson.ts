import { nextId } from './ids';
import type { KmlNode, KmlStyle, Geometry, Position } from './types';

/**
 * Convert a GeoJSON FeatureCollection (already reprojected to EPSG:4326 by
 * GDAL) into a KML folder of placemarks, with attribute-driven naming,
 * description tables, and either a single style or one style per category.
 */

export interface ImportOptions {
  /** Folder name (usually the source layer name). */
  layerName: string;
  /** Attribute used as each placemark's <name>. */
  nameField?: string;
  /** Attributes rendered as an HTML table in <description>. */
  descriptionFields?: string[];
  styleMode: 'single' | 'categorized';
  /** Attribute whose distinct values drive per-category colors. */
  categoryField?: string;
  /** Style used when styleMode === 'single'. */
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

/** Distinct categorical colors as `#rrggbb`, evenly spaced around the hue wheel. */
export function categoryColor(index: number, total: number): string {
  const hue = total <= 1 ? 200 : (index * 360) / total;
  return hslToHex(hue, 0.65, 0.55);
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

function styleForColor(id: string, hex: string): KmlStyle {
  return {
    id,
    icon: { color: hexToKml(hex, 0xff), scale: 1 },
    line: { color: hexToKml(hex, 0xff), width: 2 },
    poly: { color: hexToKml(hex, 0x80), fill: true, outline: true },
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
    const values: string[] = [];
    for (const f of features) {
      const v = String(f.properties?.[opts.categoryField] ?? '');
      if (!values.includes(v)) values.push(v);
    }
    values.forEach((value, i) => {
      const id = `nge-cat-${suffix}-${i}`;
      styleIdByCategory.set(value, id);
      styles.push(styleForColor(id, categoryColor(i, values.length)));
    });
  } else {
    const id = `nge-import-${suffix}`;
    const base = opts.singleStyle
      ? { ...structuredClone(opts.singleStyle), id }
      : styleForColor(id, '#4da6ff');
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

  let skipped = 0;
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

    folder.children.push({
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
  }

  return { folder, styles, featureCount: folder.children.length, skipped };
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
