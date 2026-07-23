import { describe, it, expect } from 'vitest';
import { parseKml } from '@renderer/model/parse';
import { serializeKml } from '@renderer/model/serialize';
import { KmlDocument } from '@renderer/model/document';
import { tiledOverlayInfo, tileUrlTemplate } from '@renderer/model/overlays';
import { fixture, generatePolygonKml } from './helpers';

const FIXTURES = [
  'simple.kml',
  'styles-torture.kml',
  'unknown-extensions.kml',
  'overlay.kml',
  'hawaii_may26_campaign.kml', // real-world: Schema, BalloonStyle, SchemaData, 191 placemarks
];

/** Strip internal ids (which are regenerated each parse) for structural compare. */
function normalize(node: unknown): unknown {
  return JSON.parse(
    JSON.stringify(node, (k, v) => (k === 'id' ? undefined : v)),
  );
}

describe('round-trip fidelity', () => {
  for (const name of FIXTURES) {
    describe(name, () => {
      const src = fixture(name);

      it('serializer is idempotent (parse→ser→parse→ser is a fixed point)', () => {
        const text1 = serializeKml(parseKml(src));
        const text2 = serializeKml(parseKml(text1));
        expect(text2).toBe(text1);
      });

      it('model is stable across a round trip (no data loss)', () => {
        const a = parseKml(src);
        const b = parseKml(serializeKml(a));
        expect(normalize(b.root)).toEqual(normalize(a.root));
        expect([...b.sharedStyles.keys()].sort()).toEqual(
          [...a.sharedStyles.keys()].sort(),
        );
      });
    });
  }

  it('preserves gx: track content verbatim', () => {
    const out = serializeKml(parseKml(fixture('unknown-extensions.kml')));
    // Standalone raw blocks may carry their own xmlns:gx declaration, so match
    // on tag substrings rather than exact opening tags.
    expect(out).toContain('gx:Track');
    expect(out).toContain('<gx:coord>-95.0 39.0 0</gx:coord>');
    expect(out).toContain('2020-01-01T00:00:00Z');
  });

  it('preserves CDATA descriptions as CDATA', () => {
    const out = serializeKml(parseKml(fixture('unknown-extensions.kml')));
    expect(out).toContain('<![CDATA[<h1>Hello</h1>');
  });

  it('preserves ExtendedData and Region blocks', () => {
    const out = serializeKml(parseKml(fixture('unknown-extensions.kml')));
    expect(out).toContain('<Data name="population">');
    expect(out).toContain('Region');
    expect(out).toContain('<minLodPixels>128</minLodPixels>');
  });

  it('preserves atom: namespace author', () => {
    const out = serializeKml(parseKml(fixture('unknown-extensions.kml')));
    expect(out).toContain('atom:author');
    expect(out).toContain('Jane Mapper');
    expect(out).toContain('xmlns:atom="http://www.w3.org/2005/Atom"');
  });
});

describe('document model', () => {
  it('counts features and folders', () => {
    const doc = KmlDocument.fromKml(fixture('simple.kml'));
    const stats = doc.stats();
    expect(stats.features).toBe(3); // 1 point + line + polygon
  });

  it('extracts geometry types', () => {
    const doc = KmlDocument.fromKml(fixture('simple.kml'));
    const kinds = doc.placemarksUnder().map((p) => p.geometry!.kind).sort();
    expect(kinds).toEqual(['LineString', 'Point', 'Polygon']);
  });

  it('parses point coordinates with altitude', () => {
    const doc = KmlDocument.fromKml(fixture('unknown-extensions.kml'));
    const pt = doc
      .placemarksUnder()
      .find((p) => p.geometry?.kind === 'Point' && p.geometry.coordinates[2] === 100);
    expect(pt).toBeTruthy();
  });
});

describe('ground overlays', () => {
  it('models the image href and lat/lon box', () => {
    const doc = KmlDocument.fromKml(fixture('overlay.kml'));
    const overlays = [...doc.walk()].filter((n) => n.type === 'GroundOverlay');
    expect(overlays.length).toBe(2);

    const scan = overlays.find((o) => o.name === 'Scanned map')!;
    expect(scan.overlay?.href).toBe('files/scan.png');
    expect(scan.overlay?.box).toEqual({
      north: 37.9475896,
      south: 37.8574079,
      east: -122.8861706,
      west: -123,
      rotation: -12.5,
    });
    expect(scan.overlay?.color).toBe('c0ffffff');
    expect(scan.overlay?.drawOrder).toBe(3);
    expect(scan.kmlId).toBe('go-1');

    const hidden = overlays.find((o) => o.name !== 'Scanned map')!;
    expect(hidden.visible).toBe(false);
    expect(hidden.overlay?.box?.rotation).toBeUndefined();
    // Unmodelled children still survive verbatim.
    expect(hidden.unknownChildren.join()).toContain('gx:altitudeMode');
  });

  it('does not duplicate overlays on save', () => {
    // Regression: overlays were missing from the container "known" set, so they
    // were captured as raw unknownChildren *and* parsed as child nodes — every
    // save doubled them.
    const out = serializeKml(parseKml(fixture('overlay.kml')));
    expect(out.match(/<GroundOverlay/g)?.length).toBe(2);
    expect(out.match(/<ScreenOverlay/g)?.length).toBe(1);
    expect(out.match(/Scanned map/g)?.length).toBe(1);
  });

  it('adds an imported raster as an undoable overlay that round-trips', () => {
    const doc = KmlDocument.empty();
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const id = doc.addGroundOverlay(doc.root.id, {
      name: 'Scan',
      href: 'overlays/scan.png',
      dataUrl,
      box: { west: -123, south: 37.85, east: -122.88, north: 37.94 },
    });

    // The image is a document resource, which is what a KMZ save embeds.
    expect(doc.resources['overlays/scan.png']).toBe(dataUrl);
    expect(doc.nodeById(id)?.type).toBe('GroundOverlay');

    // Survives save + reload.
    const reloaded = new KmlDocument(parseKml(serializeKml(doc.data)));
    const overlay = [...reloaded.walk()].find((n) => n.type === 'GroundOverlay')!;
    expect(overlay.name).toBe('Scan');
    expect(overlay.overlay?.href).toBe('overlays/scan.png');
    expect(overlay.overlay?.box).toEqual({
      west: -123,
      south: 37.85,
      east: -122.88,
      north: 37.94,
    });

    // Undo removes the node *and* its image.
    doc.undo();
    expect(doc.nodeById(id)).toBeUndefined();
    expect(doc.resources['overlays/scan.png']).toBeUndefined();
  });

  it('marks a tiled raster so it can be re-rendered from the tile cache', () => {
    const doc = KmlDocument.empty();
    const id = doc.addTiledOverlay(doc.root.id, {
      name: 'Big scan',
      sourcePath: '/data/big.tif',
      box: { west: -123, south: 37.7, east: -122.7, north: 37.95 },
      marker: { hash: 'abc123', minZoom: 11, maxZoom: 16 },
    });
    // No image is embedded — tiles live in the local cache, not the document.
    expect(Object.keys(doc.resources)).toHaveLength(0);
    expect(doc.nodeById(id)?.overlay?.href).toBe('/data/big.tif');

    const reloaded = new KmlDocument(parseKml(serializeKml(doc.data)));
    const overlay = [...reloaded.walk()].find((n) => n.type === 'GroundOverlay')!;
    expect(tiledOverlayInfo(overlay)).toEqual({ hash: 'abc123', minZoom: 11, maxZoom: 16 });
    expect(tileUrlTemplate('abc123')).toBe('earthy-tiles://abc123/{z}/{x}/{y}.png');

    // A plain (non-tiled) overlay must not be mistaken for a tiled one.
    const plain = KmlDocument.fromKml(fixture('overlay.kml'));
    const scan = [...plain.walk()].find((n) => n.name === 'Scanned map')!;
    expect(tiledOverlayInfo(scan)).toBeNull();
  });

  it('keeps ScreenOverlay/NetworkLink verbatim (only GroundOverlay is modelled)', () => {
    const doc = KmlDocument.fromKml(fixture('overlay.kml'));
    const screen = [...doc.walk()].find((n) => n.type === 'ScreenOverlay')!;
    expect(screen.rawElement).toContain('screenXY');
    expect(screen.overlay).toBeUndefined();
  });
});

describe('performance', () => {
  it('parses + serializes 10k polygons under 3s', () => {
    const kml = generatePolygonKml(10_000);
    const t0 = performance.now();
    const doc = parseKml(kml);
    const parseMs = performance.now() - t0;
    const t1 = performance.now();
    serializeKml(doc);
    const serMs = performance.now() - t1;

    expect(doc.root.children[0].children.length).toBe(10_000);
    // Generous ceilings; real machines are far faster. Logs help track regressions.
    console.log(`10k polygons: parse ${parseMs.toFixed(0)}ms, serialize ${serMs.toFixed(0)}ms`);
    expect(parseMs).toBeLessThan(3000);
    expect(serMs).toBeLessThan(3000);
  });
});
