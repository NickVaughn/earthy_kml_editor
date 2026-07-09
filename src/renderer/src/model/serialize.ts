import type {
  KmlDocumentData,
  KmlNode,
  KmlStyle,
  KmlStyleMap,
  IconStyle,
  Geometry,
  Position,
} from './types';

/**
 * Serialize the model back to KML. Output is canonical and **idempotent**:
 * parse→serialize→parse→serialize is a fixed point. Unmodeled content stored as
 * raw XML strings is emitted verbatim so nothing is dropped (PLAN §4.2).
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

class Writer {
  private parts: string[] = [];
  private depth = 0;
  private pad(): string {
    return '  '.repeat(this.depth);
  }
  raw(xml: string): void {
    // Re-indent a raw block minimally by prefixing the current pad on each line.
    const lines = xml.split('\n');
    for (const line of lines) this.parts.push(this.pad() + line);
  }
  open(tag: string, attrs?: Record<string, string>): void {
    const a = attrs
      ? Object.entries(attrs)
          .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
          .join('')
      : '';
    this.parts.push(`${this.pad()}<${tag}${a}>`);
    this.depth++;
  }
  close(tag: string): void {
    this.depth--;
    this.parts.push(`${this.pad()}</${tag}>`);
  }
  /** Leaf element with escaped text. */
  leaf(tag: string, text: string): void {
    this.parts.push(`${this.pad()}<${tag}>${esc(text)}</${tag}>`);
  }
  /** Leaf element whose content is emitted as CDATA. */
  cdata(tag: string, text: string): void {
    this.parts.push(`${this.pad()}<${tag}><![CDATA[${text}]]></${tag}>`);
  }
  line(s: string): void {
    this.parts.push(this.pad() + s);
  }
  toString(): string {
    return this.parts.join('\n');
  }
}

function coordStr(positions: Position[]): string {
  return positions
    .map((p) => (p.length >= 3 ? `${p[0]},${p[1]},${p[2]}` : `${p[0]},${p[1]}`))
    .join(' ');
}

function writeIconStyle(w: Writer, icon: IconStyle): void {
  w.open('IconStyle');
  if (icon.color !== undefined) w.leaf('color', icon.color);
  if (icon.scale !== undefined) w.leaf('scale', String(icon.scale));
  if (icon.heading !== undefined) w.leaf('heading', String(icon.heading));
  if (icon.iconHref !== undefined) {
    w.open('Icon');
    w.leaf('href', icon.iconHref);
    w.close('Icon');
  }
  if (icon.raw) for (const r of icon.raw) w.raw(r);
  w.close('IconStyle');
}

function writeStyleBody(w: Writer, style: KmlStyle): void {
  if (style.icon) writeIconStyle(w, style.icon);
  if (style.label) {
    w.open('LabelStyle');
    if (style.label.color !== undefined) w.leaf('color', style.label.color);
    if (style.label.scale !== undefined) w.leaf('scale', String(style.label.scale));
    w.close('LabelStyle');
  }
  if (style.line) {
    w.open('LineStyle');
    if (style.line.color !== undefined) w.leaf('color', style.line.color);
    if (style.line.width !== undefined) w.leaf('width', String(style.line.width));
    w.close('LineStyle');
  }
  if (style.poly) {
    w.open('PolyStyle');
    if (style.poly.color !== undefined) w.leaf('color', style.poly.color);
    if (style.poly.fill !== undefined) w.leaf('fill', style.poly.fill ? '1' : '0');
    if (style.poly.outline !== undefined)
      w.leaf('outline', style.poly.outline ? '1' : '0');
    w.close('PolyStyle');
  }
  if (style.raw) for (const r of style.raw) w.raw(r);
}

function writeStyle(w: Writer, style: KmlStyle): void {
  w.open('Style', style.id ? { id: style.id } : undefined);
  writeStyleBody(w, style);
  w.close('Style');
}

export function styleToXml(style: KmlStyle): string {
  const w = new Writer();
  writeStyle(w, style);
  return w.toString();
}

export function styleMapToXml(map: KmlStyleMap): string {
  const w = new Writer();
  w.open('StyleMap', map.id ? { id: map.id } : undefined);
  for (const pair of map.pairs) {
    w.open('Pair');
    w.leaf('key', pair.key);
    if (pair.styleUrl !== undefined) w.leaf('styleUrl', pair.styleUrl);
    if (pair.inlineStyle) writeStyle(w, pair.inlineStyle);
    w.close('Pair');
  }
  w.close('StyleMap');
  return w.toString();
}

function writeGeometry(w: Writer, g: Geometry): void {
  switch (g.kind) {
    case 'Point':
      w.open('Point');
      if (g.extrude) w.leaf('extrude', '1');
      if (g.altitudeMode) w.leaf('altitudeMode', g.altitudeMode);
      w.leaf('coordinates', coordStr([g.coordinates]));
      w.close('Point');
      break;
    case 'LineString':
      w.open('LineString');
      if (g.extrude) w.leaf('extrude', '1');
      if (g.tessellate) w.leaf('tessellate', '1');
      if (g.altitudeMode) w.leaf('altitudeMode', g.altitudeMode);
      w.leaf('coordinates', coordStr(g.coordinates));
      w.close('LineString');
      break;
    case 'Polygon':
      w.open('Polygon');
      if (g.extrude) w.leaf('extrude', '1');
      if (g.tessellate) w.leaf('tessellate', '1');
      if (g.altitudeMode) w.leaf('altitudeMode', g.altitudeMode);
      w.open('outerBoundaryIs');
      w.open('LinearRing');
      w.leaf('coordinates', coordStr(g.outerBoundary));
      w.close('LinearRing');
      w.close('outerBoundaryIs');
      for (const inner of g.innerBoundaries) {
        w.open('innerBoundaryIs');
        w.open('LinearRing');
        w.leaf('coordinates', coordStr(inner));
        w.close('LinearRing');
        w.close('innerBoundaryIs');
      }
      w.close('Polygon');
      break;
    case 'MultiGeometry':
      w.open('MultiGeometry');
      for (const child of g.geometries) writeGeometry(w, child);
      w.close('MultiGeometry');
      break;
  }
}

function writeCommonHead(w: Writer, node: KmlNode): void {
  if (node.name) w.leaf('name', node.name);
  if (node.visible === false) w.leaf('visibility', '0');
  if (node.open) w.leaf('open', '1');
  if (node.styleUrl !== undefined) w.leaf('styleUrl', node.styleUrl);
  if (node.description !== undefined) {
    if (node.descriptionCdata) w.cdata('description', node.description);
    else w.leaf('description', node.description);
  }
}

function writeNode(w: Writer, node: KmlNode): void {
  if (node.rawElement && node.type !== 'Placemark' && node.children.length === 0) {
    w.raw(node.rawElement);
    return;
  }

  const tag = node.type === 'Unknown' ? 'Folder' : node.type;
  const attrs = node.kmlId ? { id: node.kmlId, ...node.attrs } : { ...node.attrs };
  w.open(tag, Object.keys(attrs).length ? attrs : undefined);

  writeCommonHead(w, node);

  if (node.type === 'Placemark') {
    if (node.inlineStyle) writeStyle(w, node.inlineStyle);
    if (node.inlineStyleMap) {
      w.raw(styleMapToXml(node.inlineStyleMap));
    }
    if (node.extendedData) w.raw(node.extendedData.raw);
    for (const r of node.unknownChildren) w.raw(r);
    if (node.geometry) writeGeometry(w, node.geometry);
  } else {
    if (node.extendedData) w.raw(node.extendedData.raw);
    for (const r of node.unknownChildren) w.raw(r);
    for (const child of node.children) writeNode(w, child);
  }

  w.close(tag);
}

export function serializeKml(doc: KmlDocumentData): string {
  const w = new Writer();
  w.line('<?xml version="1.0" encoding="UTF-8"?>');
  const kmlAttrs =
    Object.keys(doc.kmlAttrs).length > 0
      ? doc.kmlAttrs
      : { xmlns: 'http://www.opengis.net/kml/2.2' };
  w.open('kml', kmlAttrs);
  writeNode(w, doc.root);
  w.close('kml');
  return w.toString() + '\n';
}
