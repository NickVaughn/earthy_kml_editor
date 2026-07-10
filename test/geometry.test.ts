import { describe, it, expect } from 'vitest';
import { KmlDocument } from '@renderer/model/document';
import { serializeKml } from '@renderer/model/serialize';
import { parseKml } from '@renderer/model/parse';
import { lineLength, polygonArea, haversine, formatLength, formatArea } from '@renderer/model/measure';
import type { Geometry } from '@renderer/model/types';
import { fixture } from './helpers';

describe('measurement', () => {
  it('measures 1° of latitude as ~111 km', () => {
    const d = haversine([0, 0], [0, 1]);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('sums polyline length', () => {
    const len = lineLength([
      [0, 0],
      [0, 1],
      [0, 2],
    ]);
    expect(len).toBeGreaterThan(221_000);
    expect(len).toBeLessThan(223_000);
  });

  it('computes a ~12,300 km² area for a 1°×1° box at the equator', () => {
    const area = polygonArea([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(area).toBeGreaterThan(12.0e9);
    expect(area).toBeLessThan(12.5e9);
  });

  it('formats length and area', () => {
    expect(formatLength(500)).toBe('500.0 m');
    expect(formatLength(2500)).toBe('2.50 km');
    expect(formatArea(500)).toBe('500 m²');
    expect(formatArea(2_000_000)).toContain('km²');
  });
});

describe('geometry creation + editing', () => {
  const point: Geometry = { kind: 'Point', coordinates: [-100, 40] };
  const polygon: Geometry = {
    kind: 'Polygon',
    outerBoundary: [
      [-100, 40],
      [-99, 40],
      [-99, 41],
      [-100, 41],
      [-100, 40],
    ],
    innerBoundaries: [],
  };

  it('adds a placemark and undoes it', () => {
    const doc = KmlDocument.fromKml(fixture('simple.kml'));
    const before = doc.stats().features;
    const id = doc.addPlacemark(doc.root.id, point, 'Dropped pin');
    expect(doc.nodeById(id)?.name).toBe('Dropped pin');
    expect(doc.stats().features).toBe(before + 1);
    doc.undo();
    expect(doc.nodeById(id)).toBeUndefined();
    expect(doc.stats().features).toBe(before);
  });

  it('adds under the nearest container when a placemark is selected', () => {
    const doc = KmlDocument.fromKml(fixture('simple.kml'));
    const origin = doc.placemarksUnder().find((p) => p.name === 'Origin')!;
    const parent = doc.parentOf(origin.id)!;
    const id = doc.addPlacemark(origin.id, point, 'Near origin');
    // Added into the placemark's parent container, not into the placemark.
    expect(doc.parentOf(id)).toBe(parent);
  });

  it('updates geometry with undo/redo', () => {
    const doc = KmlDocument.fromKml(fixture('simple.kml'));
    const id = doc.addPlacemark(doc.root.id, polygon, 'Poly');
    const moved: Geometry = {
      ...polygon,
      outerBoundary: polygon.outerBoundary.map(([x, y]) => [x + 1, y] as [number, number]),
    };
    doc.updateGeometry(id, moved);
    expect((doc.nodeById(id)!.geometry as typeof polygon).outerBoundary[0][0]).toBe(-99);
    doc.undo();
    expect((doc.nodeById(id)!.geometry as typeof polygon).outerBoundary[0][0]).toBe(-100);
    doc.redo();
    expect((doc.nodeById(id)!.geometry as typeof polygon).outerBoundary[0][0]).toBe(-99);
  });

  it('serializes a drawn polygon to valid, reparseable KML', () => {
    const doc = KmlDocument.fromKml(fixture('simple.kml'));
    doc.addPlacemark(doc.root.id, polygon, 'Drawn');
    const out = serializeKml(doc.data);
    expect(out).toContain('<name>Drawn</name>');
    expect(out).toContain('<Polygon>');
    // Reparse and confirm the geometry survived.
    const re = new KmlDocument(parseKml(out));
    const drawn = re.placemarksUnder().find((p) => p.name === 'Drawn')!;
    expect(drawn.geometry?.kind).toBe('Polygon');
  });
});
