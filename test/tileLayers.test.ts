import { describe, expect, it } from 'vitest';
import { KmlDocument } from '@renderer/model/document';
import { parseKml } from '@renderer/model/parse';
import {
  isTileTemplate,
  normalizeTileTemplate,
  tileLayerInfo,
  tileTemplateError,
} from '@renderer/model/tileLayers';
import { parseCapabilities } from '@renderer/model/wmts';
import { fixture } from './helpers';

describe('tile URL templates', () => {
  it('normalizes placeholder spellings', () => {
    expect(normalizeTileTemplate(' https://a/${z}/{X}/{-y}.png ')).toBe(
      'https://a/{z}/{x}/{reverseY}.png',
    );
  });

  it('tells templates from documents', () => {
    expect(isTileTemplate('https://a/{z}/{x}/{y}.png')).toBe(true);
    expect(isTileTemplate('https://a/wms?bbox={westProjected},{southProjected}')).toBe(true);
    expect(isTileTemplate('https://a/WMTSCapabilities.xml')).toBe(false);
    expect(tileTemplateError('ftp://a/{z}/{x}/{y}.png')).toMatch(/http/);
    expect(tileTemplateError('https://a/{z}/{x}/{y}.png')).toBeNull();
  });
});

describe('WMTS capabilities', () => {
  const src = 'https://example.com/WMTSCapabilities.xml';

  it('reads a RESTful GoogleMapsCompatible layer', () => {
    const layers = parseCapabilities(fixture('wmts-oahu.xml'), src);
    expect(layers).toHaveLength(1);
    expect(layers[0].title).toBe('Oahu VSWIR RGB mosaic v1');
    expect(layers[0].service).toBe('WMTS');
    expect(layers[0].tiles).toEqual({
      url: 'https://storage.googleapis.com/hawaii-bucket/MHI_VSWIR_RGB_mosaics/oahu_v1/tiles/{z}/{x}/{y}.png',
      minZoom: 0,
      maxZoom: 17,
      bounds: [-158.30338492, 21.23046085, -157.63130829, 21.7293],
      source: src,
    });
  });

  const caps = (layer: string, set: string, ops = ''): string =>
    `<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink">${ops}<Contents><Layer><ows:Identifier>L</ows:Identifier>${layer}</Layer>${set}</Contents></Capabilities>`;
  const matrix = (id: string, width: number): string =>
    `<TileMatrix><ows:Identifier>${id}</ows:Identifier><MatrixWidth>${width}</MatrixWidth></TileMatrix>`;
  const mercator =
    `<TileMatrixSet><ows:Identifier>EPSG:900913</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::900913</ows:SupportedCRS>` +
    `${matrix('EPSG:900913:3', 8)}${matrix('EPSG:900913:4', 16)}</TileMatrixSet>`;

  it('builds a KVP URL, with prefixed matrix ids and dimension defaults', () => {
    const ops =
      `<ows:OperationsMetadata><ows:Operation name="GetTile"><ows:DCP><ows:HTTP>` +
      `<ows:Get xlink:href="https://example.com/wmts?"/></ows:HTTP></ows:DCP></ows:Operation></ows:OperationsMetadata>`;
    const layer =
      `<Style isDefault="true"><ows:Identifier>s1</ows:Identifier></Style><Format>image/jpeg</Format>` +
      `<TileMatrixSetLink><TileMatrixSet>EPSG:900913</TileMatrixSet></TileMatrixSetLink>`;
    const [kvp] = parseCapabilities(caps(layer, mercator, ops), src);
    expect(kvp.tiles?.url).toBe(
      'https://example.com/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=L&STYLE=s1' +
        '&TILEMATRIXSET=EPSG%3A900913&TILEMATRIX=EPSG%3A900913%3A{z}&TILEROW={y}&TILECOL={x}' +
        '&FORMAT=image%2Fjpeg',
    );
    expect([kvp.tiles?.minZoom, kvp.tiles?.maxZoom]).toEqual([3, 4]);

    const rest =
      `<Dimension><ows:Identifier>Time</ows:Identifier><Default>2020-01-01</Default></Dimension>` +
      `<TileMatrixSetLink><TileMatrixSet>EPSG:900913</TileMatrixSet></TileMatrixSetLink>` +
      `<ResourceURL format="image/png" resourceType="tile" template="https://t/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png"/>`;
    const [r] = parseCapabilities(caps(rest, mercator), src);
    expect(r.tiles?.url).toBe('https://t/2020-01-01/EPSG:900913/EPSG:900913:{z}/{y}/{x}.png');

    // An http:// endpoint advertised by an https:// service is upgraded.
    const [h] = parseCapabilities(caps(rest.replace('https://t/', 'http://t/'), mercator), src);
    expect(h.tiles?.url).toMatch(/^https:\/\/t\//);
  });

  it('reports layers that are not on the Web Mercator grid', () => {
    const geographic =
      `<TileMatrixSet><ows:Identifier>WGS84</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::4326</ows:SupportedCRS>` +
      `${matrix('0', 2)}</TileMatrixSet>`;
    const layer = `<TileMatrixSetLink><TileMatrixSet>WGS84</TileMatrixSet></TileMatrixSetLink>`;
    const [l] = parseCapabilities(caps(layer, geographic), src);
    expect(l.tiles).toBeUndefined();
    expect(l.error).toMatch(/Web Mercator/);
  });

  it('rejects other documents', () => {
    expect(() => parseCapabilities('<html/>', src)).toThrow(/WMTS or WMS/);
  });
});

describe('WMS capabilities', () => {
  const src = 'https://example.com/ows?service=wms&request=GetCapabilities';
  const getMap = (href: string): string =>
    `<Request><GetMap><Format>image/jpeg</Format><Format>image/png</Format><DCPType><HTTP><Get>` +
    `<OnlineResource xlink:href="${href}"/></Get></HTTP></DCPType></GetMap></Request>`;

  it('builds a Web Mercator GetMap template, inheriting CRS and bounds', () => {
    const xml =
      `<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">` +
      `<Capability>${getMap('http://example.com/ows?SERVICE=WMS&amp;map=a&amp;')}` +
      `<Layer><Title>Root</Title><CRS>EPSG:3857</CRS><CRS>CRS:84</CRS>` +
      `<EX_GeographicBoundingBox><westBoundLongitude>-180</westBoundLongitude><eastBoundLongitude>180</eastBoundLongitude>` +
      `<southBoundLatitude>-90</southBoundLatitude><northBoundLatitude>90</northBoundLatitude></EX_GeographicBoundingBox>` +
      `<Layer><Name>ns:reefs</Name><Title>Reefs</Title></Layer></Layer></Capability></WMS_Capabilities>`;
    const layers = parseCapabilities(xml, src);
    expect(layers.map((l) => l.id)).toEqual(['ns:reefs']); // the unnamed root is a group
    expect(layers[0]).toMatchObject({ title: 'Reefs', service: 'WMS' });
    expect(layers[0].tiles).toEqual({
      // https like the capabilities URL, and the server's own parameters kept.
      url:
        'https://example.com/ows?map=a&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ns%3Areefs' +
        '&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=TRUE&CRS=EPSG%3A3857&WIDTH=256&HEIGHT=256' +
        '&BBOX={westProjected},{southProjected},{eastProjected},{northProjected}',
      minZoom: 0,
      maxZoom: 22,
      bounds: [-180, -85.0511287798, 180, 85.0511287798],
      source: src,
    });
  });

  it('falls back to a lon/lat grid, minding the 1.3.0 axis order', () => {
    const v13 =
      `<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink"><Capability>${getMap('https://e.com/wms')}` +
      `<Layer><Name>a</Name><CRS>EPSG:4326</CRS></Layer></Capability></WMS_Capabilities>`;
    const a = parseCapabilities(v13, src)[0].tiles;
    expect(a?.grid).toBe('geographic');
    expect(a?.url).toContain('CRS=EPSG%3A4326&WIDTH=256&HEIGHT=256&BBOX={southDegrees},{westDegrees},');

    const v11 =
      `<WMT_MS_Capabilities version="1.1.1" xmlns:xlink="http://www.w3.org/1999/xlink"><Capability>${getMap('https://e.com/wms')}` +
      `<Layer><Name>a</Name><SRS>EPSG:4326 EPSG:27700</SRS>` +
      `<LatLonBoundingBox minx="-8" miny="49" maxx="2" maxy="61"/></Layer></Capability></WMT_MS_Capabilities>`;
    const b = parseCapabilities(v11, src)[0].tiles;
    expect(b?.url).toContain('VERSION=1.1.1');
    expect(b?.url).toContain('SRS=EPSG%3A4326&WIDTH=256&HEIGHT=256&BBOX={westDegrees},{southDegrees},');
    expect(b?.bounds).toEqual([-8, 49, 2, 61]);
  });

  it('reports layers in projections it cannot tile', () => {
    const xml =
      `<WMS_Capabilities version="1.3.0"><Capability><Layer><Name>a</Name><CRS>EPSG:27700</CRS></Layer></Capability></WMS_Capabilities>`;
    expect(parseCapabilities(xml, src)[0].error).toMatch(/Web Mercator/);
  });
});

describe('tile layer nodes', () => {
  it('survive a save and reload as plain KML', () => {
    const doc = KmlDocument.empty();
    const tiles = {
      url: 'https://example.com/wmts?LAYER=a&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
      minZoom: 2,
      maxZoom: 15,
      bounds: [-158.3, 21.2, -157.6, 21.7] as [number, number, number, number],
      source: 'https://example.com/caps.xml',
    };
    doc.addTileLayer(null, { name: 'Oahu', tiles });

    const kml = doc.serialize();
    expect(kml).toContain('LAYER=a&amp;TILEMATRIX');
    const node = parseKml(kml).root.children[0];
    expect(node.type).toBe('GroundOverlay');
    expect(node.name).toBe('Oahu');
    expect(tileLayerInfo(node)).toEqual(tiles);

    // A lon/lat WMS keeps its grid, and defaults to the whole globe.
    const wms = { url: 'https://e.com/wms?BBOX={westDegrees}', minZoom: 0, maxZoom: 22, grid: 'geographic' as const };
    doc.addTileLayer(null, { name: 'WMS', tiles: wms });
    const back = parseKml(doc.serialize()).root.children.find((n) => n.name === 'WMS')!;
    expect(tileLayerInfo(back)).toEqual({ ...wms, bounds: [-180, -90, 180, 90] });
    // Not a local pyramid: nothing for a KMZ to embed.
    expect(doc.tiledOverlays()).toEqual([]);
  });
});
