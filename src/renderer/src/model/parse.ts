import {
  parseXml,
  serializeStripped,
  localName,
  childElements,
  firstChild,
  childrenNamed,
  childText,
  hasCdata,
  boolText,
  numText,
} from './dom';
import type {
  KmlDocumentData,
  KmlNode,
  KmlNodeType,
  KmlStyle,
  KmlStyleMap,
  SharedStyleEntry,
  ExtendedDataField,
  Geometry,
  Position,
  AltitudeMode,
  IconStyle,
  OverlayData,
} from './types';
import { nextId } from './ids';

const CONTAINER_CHILD_KNOWN = new Set([
  'name',
  'visibility',
  'open',
  'description',
  'styleUrl',
  // NOTE: Style/StyleMap are deliberately NOT listed here. They must route
  // through the onUnknown handler so shared (id'd) styles get registered for
  // the resolver AND preserved verbatim. Placemark keeps them "known" because
  // it handles inline styles separately.
  'Folder',
  'Document',
  'Placemark',
  'ExtendedData',
  // Overlays/links are parsed into child nodes by the loop below. They must be
  // "known" here or they'd ALSO be captured as raw unknownChildren and emitted
  // twice on save.
  'GroundOverlay',
  'ScreenOverlay',
  'NetworkLink',
]);

const PLACEMARK_CHILD_KNOWN = new Set([
  'name',
  'visibility',
  'open',
  'description',
  'styleUrl',
  'Style',
  'StyleMap',
  'ExtendedData',
  'Point',
  'LineString',
  'Polygon',
  'MultiGeometry',
]);

const OVERLAY_TYPES = new Set(['GroundOverlay', 'ScreenOverlay', 'NetworkLink']);

const GROUND_OVERLAY_CHILD_KNOWN = new Set([
  'name',
  'visibility',
  'open',
  'description',
  'styleUrl',
  'ExtendedData',
  'Icon',
  'LatLonBox',
  'color',
  'drawOrder',
]);

function parseCoordinates(text: string): Position[] {
  const out: Position[] = [];
  for (const tuple of text.trim().split(/\s+/)) {
    if (!tuple) continue;
    const parts = tuple.split(',').map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      out.push(
        parts.length >= 3
          ? [parts[0], parts[1], parts[2]]
          : [parts[0], parts[1]],
      );
    }
  }
  return out;
}

function parseExtendedDataFields(extEl: Element): ExtendedDataField[] {
  const fields: ExtendedDataField[] = [];
  for (const c of childElements(extEl)) {
    const tag = localName(c);
    if (tag === 'Data') {
      fields.push({
        name: c.getAttribute('name') ?? '',
        value: childText(c, 'value') ?? '',
      });
    } else if (tag === 'SchemaData') {
      for (const sd of childrenNamed(c, 'SimpleData')) {
        fields.push({
          name: sd.getAttribute('name') ?? '',
          value: (sd.textContent ?? '').trim(),
        });
      }
    }
  }
  return fields;
}

function altMode(el: Element): AltitudeMode {
  const v = childText(el, 'altitudeMode');
  if (v === 'clampToGround' || v === 'relativeToGround' || v === 'absolute') return v;
  return undefined;
}

function parseGeometry(el: Element): Geometry | undefined {
  switch (localName(el)) {
    case 'Point': {
      const coords = parseCoordinates(childText(el, 'coordinates') ?? '');
      if (coords.length === 0) return undefined;
      return {
        kind: 'Point',
        coordinates: coords[0],
        altitudeMode: altMode(el),
        extrude: boolText(childText(el, 'extrude')),
      };
    }
    case 'LineString':
      return {
        kind: 'LineString',
        coordinates: parseCoordinates(childText(el, 'coordinates') ?? ''),
        altitudeMode: altMode(el),
        tessellate: boolText(childText(el, 'tessellate')),
        extrude: boolText(childText(el, 'extrude')),
      };
    case 'Polygon': {
      const outer = firstChild(el, 'outerBoundaryIs');
      const outerRing = outer ? firstChild(outer, 'LinearRing') : null;
      const inners = childrenNamed(el, 'innerBoundaryIs')
        .map((ib) => firstChild(ib, 'LinearRing'))
        .filter((r): r is Element => !!r)
        .map((r) => parseCoordinates(childText(r, 'coordinates') ?? ''));
      return {
        kind: 'Polygon',
        outerBoundary: outerRing
          ? parseCoordinates(childText(outerRing, 'coordinates') ?? '')
          : [],
        innerBoundaries: inners,
        altitudeMode: altMode(el),
        tessellate: boolText(childText(el, 'tessellate')),
        extrude: boolText(childText(el, 'extrude')),
      };
    }
    case 'MultiGeometry': {
      const geometries: Geometry[] = [];
      for (const c of childElements(el)) {
        const g = parseGeometry(c);
        if (g) geometries.push(g);
      }
      return { kind: 'MultiGeometry', geometries };
    }
    default:
      return undefined;
  }
}

function parseIconStyle(el: Element): IconStyle {
  const iconEl = firstChild(el, 'Icon');
  const raw: string[] = [];
  for (const c of childElements(el)) {
    if (!['color', 'scale', 'heading', 'Icon'].includes(localName(c))) {
      raw.push(serializeStripped(c));
    }
  }
  return {
    color: childText(el, 'color'),
    scale: numText(childText(el, 'scale')),
    heading: numText(childText(el, 'heading')),
    iconHref: iconEl ? childText(iconEl, 'href') : undefined,
    raw: raw.length ? raw : undefined,
  };
}

function parseStyle(el: Element): KmlStyle {
  const style: KmlStyle = {};
  const id = el.getAttribute('id');
  if (id) style.id = id;
  const raw: string[] = [];
  for (const c of childElements(el)) {
    switch (localName(c)) {
      case 'IconStyle':
        style.icon = parseIconStyle(c);
        break;
      case 'LabelStyle':
        style.label = {
          color: childText(c, 'color'),
          scale: numText(childText(c, 'scale')),
        };
        break;
      case 'LineStyle':
        style.line = {
          color: childText(c, 'color'),
          width: numText(childText(c, 'width')),
        };
        break;
      case 'PolyStyle':
        style.poly = {
          color: childText(c, 'color'),
          fill: boolText(childText(c, 'fill')),
          outline: boolText(childText(c, 'outline')),
        };
        break;
      default:
        if (localName(c) === 'BalloonStyle') {
          // Extract the <text> template for display; raw still round-trips it.
          const textEl = firstChild(c, 'text');
          if (textEl) style.balloonText = textEl.textContent ?? '';
        }
        raw.push(serializeStripped(c)); // BalloonStyle, ListStyle, …
    }
  }
  if (raw.length) style.raw = raw;
  return style;
}

function parseStyleMap(el: Element): KmlStyleMap {
  const map: KmlStyleMap = { pairs: [] };
  const id = el.getAttribute('id');
  if (id) map.id = id;
  for (const pair of childrenNamed(el, 'Pair')) {
    const styleEl = firstChild(pair, 'Style');
    map.pairs.push({
      key: childText(pair, 'key') ?? 'normal',
      styleUrl: childText(pair, 'styleUrl'),
      inlineStyle: styleEl ? parseStyle(styleEl) : undefined,
    });
  }
  return map;
}

function nodeTypeFor(tag: string): KmlNodeType {
  if (tag === 'Document') return 'Document';
  if (tag === 'Folder') return 'Folder';
  if (tag === 'Placemark') return 'Placemark';
  if (tag === 'GroundOverlay') return 'GroundOverlay';
  if (tag === 'ScreenOverlay') return 'ScreenOverlay';
  if (tag === 'NetworkLink') return 'NetworkLink';
  return 'Unknown';
}

function parseCommon(
  el: Element,
  node: KmlNode,
  knownSet: Set<string>,
  onUnknown: (child: Element) => void,
): void {
  const descEl = firstChild(el, 'description');
  node.name = childText(el, 'name') ?? '';
  node.description = descEl ? (descEl.textContent ?? '').trim() : undefined;
  node.descriptionCdata = hasCdata(descEl);
  node.visible = boolText(childText(el, 'visibility')) ?? true;
  node.open = boolText(childText(el, 'open'));
  node.styleUrl = childText(el, 'styleUrl');

  const extEl = firstChild(el, 'ExtendedData');
  if (extEl) {
    node.extendedData = {
      raw: serializeStripped(extEl),
      fields: parseExtendedDataFields(extEl),
    };
  }

  // Preserve unmodeled attributes (id handled by caller).
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item(i)!;
    if (a.name !== 'id') node.attrs[a.name] = a.value;
  }

  for (const c of childElements(el)) {
    if (!knownSet.has(localName(c))) onUnknown(c);
  }
}

function parseContainer(el: Element, doc: KmlDocumentData): KmlNode {
  const node: KmlNode = {
    id: nextId(),
    kmlId: el.getAttribute('id') ?? undefined,
    type: nodeTypeFor(localName(el)),
    name: '',
    visible: true,
    children: [],
    unknownChildren: [],
    attrs: {},
  };

  parseCommon(el, node, CONTAINER_CHILD_KNOWN, (c) => {
    const tag = localName(c);
    // Shared styles/maps live in the model (editable + re-serialized), while
    // unknown elements are kept verbatim as raw XML.
    if ((tag === 'Style' || tag === 'StyleMap') && c.getAttribute('id')) {
      (node.styles ??= []).push(registerShared(c, doc));
    } else {
      if (tag === 'Schema') captureSchema(c, doc);
      node.unknownChildren.push(serializeStripped(c));
    }
  });

  for (const c of childElements(el)) {
    const tag = localName(c);
    if (tag === 'Folder' || tag === 'Document') {
      node.children.push(parseContainer(c, doc));
    } else if (tag === 'Placemark') {
      node.children.push(parsePlacemark(c, doc));
    } else if (tag === 'GroundOverlay') {
      node.children.push(parseGroundOverlay(c));
    } else if (OVERLAY_TYPES.has(tag)) {
      node.children.push(parseOverlayLike(c));
    }
  }
  return node;
}

function parsePlacemark(el: Element, doc: KmlDocumentData): KmlNode {
  const node: KmlNode = {
    id: nextId(),
    kmlId: el.getAttribute('id') ?? undefined,
    type: 'Placemark',
    name: '',
    visible: true,
    children: [],
    unknownChildren: [],
    attrs: {},
  };
  parseCommon(el, node, PLACEMARK_CHILD_KNOWN, (c) => {
    node.unknownChildren.push(serializeStripped(c));
  });

  const styleEl = firstChild(el, 'Style');
  if (styleEl && !styleEl.getAttribute('id')) node.inlineStyle = parseStyle(styleEl);
  else if (styleEl) {
    // An id'd Style inside a Placemark is unusual; register it and keep it on
    // the node so it round-trips from the model.
    (node.styles ??= []).push(registerShared(styleEl, doc));
  }
  const styleMapEl = firstChild(el, 'StyleMap');
  if (styleMapEl && !styleMapEl.getAttribute('id'))
    node.inlineStyleMap = parseStyleMap(styleMapEl);

  for (const c of childElements(el)) {
    const g = parseGeometry(c);
    if (g) {
      node.geometry = g;
      break;
    }
  }
  return node;
}

/**
 * GroundOverlay is modelled (not kept as raw XML) so it can be rendered on the
 * globe, toggled, moved in the tree and re-saved. Anything we don't model is
 * still preserved through `unknownChildren`.
 */
function parseGroundOverlay(el: Element): KmlNode {
  const node: KmlNode = {
    id: nextId(),
    kmlId: el.getAttribute('id') ?? undefined,
    type: 'GroundOverlay',
    name: '',
    visible: true,
    children: [],
    unknownChildren: [],
    attrs: {},
  };
  parseCommon(el, node, GROUND_OVERLAY_CHILD_KNOWN, (c) => {
    node.unknownChildren.push(serializeStripped(c));
  });

  const overlay: OverlayData = {};
  const iconEl = firstChild(el, 'Icon');
  const href = iconEl ? childText(iconEl, 'href') : undefined;
  if (href) overlay.href = href;

  const boxEl = firstChild(el, 'LatLonBox');
  if (boxEl) {
    const num = (tag: string): number | undefined => {
      const raw = childText(boxEl, tag);
      if (raw === undefined || raw === '') return undefined;
      const v = Number(raw);
      return Number.isFinite(v) ? v : undefined;
    };
    const north = num('north');
    const south = num('south');
    const east = num('east');
    const west = num('west');
    if (north !== undefined && south !== undefined && east !== undefined && west !== undefined) {
      overlay.box = { north, south, east, west };
      const rotation = num('rotation');
      if (rotation !== undefined) overlay.box.rotation = rotation;
    }
  }

  const color = childText(el, 'color');
  if (color) overlay.color = color;
  const drawOrder = childText(el, 'drawOrder');
  if (drawOrder !== undefined && drawOrder !== '') {
    const v = Number(drawOrder);
    if (Number.isFinite(v)) overlay.drawOrder = v;
  }

  node.overlay = overlay;
  return node;
}

function parseOverlayLike(el: Element): KmlNode {
  return {
    id: nextId(),
    kmlId: el.getAttribute('id') ?? undefined,
    type: nodeTypeFor(localName(el)),
    name: childText(el, 'name') ?? '',
    description: childText(el, 'description'),
    visible: boolText(childText(el, 'visibility')) ?? true,
    children: [],
    unknownChildren: [],
    attrs: {},
    rawElement: serializeStripped(el),
  };
}

/**
 * Parse an id'd Style/StyleMap into the model, register it (same object) in the
 * document's resolver maps, and return an entry to store on the owning node so
 * the serializer re-emits it from the model (making it editable).
 */
/** Capture a <Schema>'s SimpleField display names for default ExtendedData tables. */
function captureSchema(el: Element, doc: KmlDocumentData): void {
  doc.schemaDisplayNames ??= new Map();
  for (const sf of childrenNamed(el, 'SimpleField')) {
    const name = sf.getAttribute('name');
    if (name) doc.schemaDisplayNames.set(name, childText(sf, 'displayName') ?? name);
  }
}

function registerShared(el: Element, doc: KmlDocumentData): SharedStyleEntry {
  const id = el.getAttribute('id');
  if (localName(el) === 'Style') {
    const style = parseStyle(el);
    if (id) {
      doc.sharedStyles.set(id, style);
      if (!doc.sharedOrder.includes(id)) doc.sharedOrder.push(id);
    }
    return { kind: 'Style', style };
  }
  const map = parseStyleMap(el);
  if (id) {
    doc.sharedStyleMaps.set(id, map);
    if (!doc.sharedOrder.includes(id)) doc.sharedOrder.push(id);
  }
  return { kind: 'StyleMap', map };
}

export function parseKml(text: string): KmlDocumentData {
  const dom = parseXml(text);
  const kmlEl =
    firstChild(dom.documentElement, 'Document') !== null
      ? dom.documentElement
      : dom.documentElement;

  const doc: KmlDocumentData = {
    root: null as unknown as KmlNode,
    sharedStyles: new Map(),
    sharedStyleMaps: new Map(),
    kmlAttrs: {},
    sharedOrder: [],
  };

  // Capture <kml> namespace declarations for faithful re-emit.
  const rootEl = dom.documentElement;
  if (rootEl && localName(rootEl) === 'kml') {
    const attrs = rootEl.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs.item(i)!;
      doc.kmlAttrs[a.name] = a.value;
    }
  }

  // Find the primary container.
  const topDoc = firstChild(kmlEl, 'Document');
  const topFolder = firstChild(kmlEl, 'Folder');
  if (topDoc) {
    doc.root = parseContainer(topDoc, doc);
  } else if (topFolder) {
    doc.root = parseContainer(topFolder, doc);
  } else {
    // Headless KML: features directly under <kml>. Synthesize a Document root.
    const synthetic: KmlNode = {
      id: nextId(),
      type: 'Document',
      name: '',
      visible: true,
      children: [],
      unknownChildren: [],
      attrs: {},
    };
    for (const c of childElements(kmlEl)) {
      const tag = localName(c);
      if (tag === 'Placemark') synthetic.children.push(parsePlacemark(c, doc));
      else if (tag === 'Folder') synthetic.children.push(parseContainer(c, doc));
      else if (tag === 'GroundOverlay') synthetic.children.push(parseGroundOverlay(c));
      else if (OVERLAY_TYPES.has(tag)) synthetic.children.push(parseOverlayLike(c));
      else if ((tag === 'Style' || tag === 'StyleMap') && c.getAttribute('id')) {
        (synthetic.styles ??= []).push(registerShared(c, doc));
      }
    }
    doc.root = synthetic;
  }
  return doc;
}
