import { describe, expect, it } from 'vitest';
import { KmlDocument } from '@renderer/model/document';
import { parseKml } from '@renderer/model/parse';
import {
  isTileTemplate,
  normalizeTileTemplate,
  tileLayerInfo,
  tileTemplateError,
} from '@renderer/model/tileLayers';
import { parseWmtsCapabilities } from '@renderer/model/wmts';
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
    const layers = parseWmtsCapabilities(fixture('wmts-oahu.xml'), src);
    expect(layers).toHaveLength(1);
    expect(layers[0].title).toBe('Oahu VSWIR RGB mosaic v1');
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
    const [kvp] = parseWmtsCapabilities(caps(layer, mercator, ops), src);
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
    const [r] = parseWmtsCapabilities(caps(rest, mercator), src);
    expect(r.tiles?.url).toBe('https://t/2020-01-01/EPSG:900913/EPSG:900913:{z}/{y}/{x}.png');
  });

  it('reports layers that are not on the Web Mercator grid', () => {
    const geographic =
      `<TileMatrixSet><ows:Identifier>WGS84</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::4326</ows:SupportedCRS>` +
      `${matrix('0', 2)}</TileMatrixSet>`;
    const layer = `<TileMatrixSetLink><TileMatrixSet>WGS84</TileMatrixSet></TileMatrixSetLink>`;
    const [l] = parseWmtsCapabilities(caps(layer, geographic), src);
    expect(l.tiles).toBeUndefined();
    expect(l.error).toMatch(/Web Mercator/);
  });

  it('rejects other documents', () => {
    expect(() => parseWmtsCapabilities('<html/>', src)).toThrow(/WMTS/);
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
    // Not a local pyramid: nothing for a KMZ to embed.
    expect(doc.tiledOverlays()).toEqual([]);
  });
});
