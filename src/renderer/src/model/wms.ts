import { childElements, childText, childrenNamed, firstChild, localName } from './dom';
import { MERCATOR_MAX_LAT, matchScheme, type TileLayerSpec } from './tileLayers';
import type { ServiceLayer } from './wmts';

/**
 * Read a WMS capabilities document (1.1.1 or 1.3.0) and turn each named layer
 * into a tile template: a GetMap request whose BBOX is filled in per tile. The
 * server renders every tile on demand, so there is no zoom range to respect.
 *
 * Web Mercator is asked for where the layer offers it; otherwise plain
 * lon/lat, drawn on a geographic tile grid.
 */

const MERCATOR_CODES = ['EPSG:3857', 'EPSG:900913', 'EPSG:102100', 'EPSG:102113'];
/** Deep enough for any imagery; a WMS has no levels of its own. */
const WMS_MAX_ZOOM = 22;

type Bounds = [number, number, number, number];

/** What a layer inherits from the layers it is nested in. */
interface Inherited {
  crs: Set<string>;
  bounds?: Bounds;
}

function readBounds(el: Element): Bounds | undefined {
  // 1.3.0: child elements; 1.1.1: attributes on <LatLonBoundingBox>.
  const ex = firstChild(el, 'EX_GeographicBoundingBox');
  const old = firstChild(el, 'LatLonBoundingBox');
  const b = ex
    ? ['westBoundLongitude', 'southBoundLatitude', 'eastBoundLongitude', 'northBoundLatitude'].map(
        (t) => Number(childText(ex, t)),
      )
    : old
      ? ['minx', 'miny', 'maxx', 'maxy'].map((a) => Number(old.getAttribute(a)))
      : null;
  if (!b || !b.every(Number.isFinite) || b[0] >= b[2] || b[1] >= b[3]) return undefined;
  return [Math.max(b[0], -180), Math.max(b[1], -90), Math.min(b[2], 180), Math.min(b[3], 90)];
}

/** The GetMap endpoint, without the request's own parameters. */
function getMapEndpoint(root: Element, source: string): string {
  const request = firstChild(firstChild(root, 'Capability') ?? root, 'Request');
  const getMap = request ? firstChild(request, 'GetMap') : null;
  const http = getMap ? firstChild(firstChild(getMap, 'DCPType') ?? getMap, 'HTTP') : null;
  const get = http ? firstChild(http, 'Get') : null;
  const resource = get ? firstChild(get, 'OnlineResource') : null;
  const href = matchScheme(resource?.getAttribute('xlink:href') || source, source);
  const [base, query = ''] = href.split('?');
  const kept = query
    .split('&')
    .filter((p) => p && !/^(service|version|request)=/i.test(p));
  return `${base}?${kept.map((p) => `${p}&`).join('')}`;
}

function layerTiles(
  name: string,
  inherited: Inherited,
  endpoint: string,
  v13: boolean,
  format: string,
  source: string,
): TileLayerSpec | string {
  const mercator = MERCATOR_CODES.find((c) => inherited.crs.has(c));
  let crs: string;
  let bbox: string;
  if (mercator) {
    crs = mercator;
    bbox = '{westProjected},{southProjected},{eastProjected},{northProjected}';
  } else if (inherited.crs.has('CRS:84')) {
    crs = 'CRS:84';
    bbox = '{westDegrees},{southDegrees},{eastDegrees},{northDegrees}';
  } else if (inherited.crs.has('EPSG:4326')) {
    crs = 'EPSG:4326';
    // WMS 1.3.0 reads EPSG:4326 as latitude first.
    bbox = v13
      ? '{southDegrees},{westDegrees},{northDegrees},{eastDegrees}'
      : '{westDegrees},{southDegrees},{eastDegrees},{northDegrees}';
  } else {
    return 'offered in neither Web Mercator nor lon/lat';
  }

  const q = encodeURIComponent;
  const tiles: TileLayerSpec = {
    url:
      `${endpoint}SERVICE=WMS&VERSION=${v13 ? '1.3.0' : '1.1.1'}&REQUEST=GetMap` +
      `&LAYERS=${q(name)}&STYLES=&FORMAT=${q(format)}&TRANSPARENT=TRUE` +
      `&${v13 ? 'CRS' : 'SRS'}=${q(crs)}&WIDTH=256&HEIGHT=256&BBOX=${bbox}`,
    minZoom: 0,
    maxZoom: WMS_MAX_ZOOM,
    source,
  };
  if (!mercator) tiles.grid = 'geographic';
  const b = inherited.bounds;
  if (b) {
    const lat = mercator ? MERCATOR_MAX_LAT : 90;
    tiles.bounds = [b[0], Math.max(b[1], -lat), b[2], Math.min(b[3], lat)];
  }
  return tiles;
}

/** The named layers of a parsed WMS capabilities document, in document order. */
export function readWmsLayers(root: Element, source: string): ServiceLayer[] {
  const v13 = (root.getAttribute('version') ?? '').startsWith('1.3');
  const capability = firstChild(root, 'Capability');
  if (!capability) throw new Error('Not a WMS capabilities document');
  const endpoint = getMapEndpoint(root, source);
  const request = firstChild(capability, 'Request');
  const getMap = request ? firstChild(request, 'GetMap') : null;
  const formats = getMap ? childrenNamed(getMap, 'Format').map((f) => f.textContent?.trim() ?? '') : [];
  const format =
    formats.find((f) => f === 'image/png') ?? formats.find((f) => f === 'image/jpeg') ?? 'image/png';

  const out: ServiceLayer[] = [];
  const visit = (el: Element, parent: Inherited): void => {
    const crs = new Set(parent.crs);
    for (const c of childElements(el)) {
      const tag = localName(c);
      // 1.1.1 may pack several codes into one <SRS>.
      if (tag === 'CRS' || tag === 'SRS') {
        for (const code of (c.textContent ?? '').trim().split(/\s+/)) crs.add(code.toUpperCase());
      }
    }
    const inherited: Inherited = { crs, bounds: readBounds(el) ?? parent.bounds };
    const name = childText(el, 'Name');
    if (name) {
      const layer: ServiceLayer = { id: name, title: childText(el, 'Title') || name, service: 'WMS' };
      const tiles = layerTiles(name, inherited, endpoint, v13, format, source);
      if (typeof tiles === 'string') layer.error = tiles;
      else layer.tiles = tiles;
      out.push(layer);
    }
    for (const child of childrenNamed(el, 'Layer')) visit(child, inherited);
  };
  for (const top of childrenNamed(capability, 'Layer')) visit(top, { crs: new Set() });
  return out;
}
