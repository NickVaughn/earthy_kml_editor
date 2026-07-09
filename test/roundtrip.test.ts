import { describe, it, expect } from 'vitest';
import { parseKml } from '@renderer/model/parse';
import { serializeKml } from '@renderer/model/serialize';
import { KmlDocument } from '@renderer/model/document';
import { fixture, generatePolygonKml } from './helpers';

const FIXTURES = ['simple.kml', 'styles-torture.kml', 'unknown-extensions.kml'];

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
