import { describe, it, expect } from 'vitest';
import {
  RULER_SHAPES,
  rulerRows,
  rulerGeometry,
  committedPoints,
  formatLength,
  formatArea,
  type RulerReading,
  type RulerShape,
} from '@renderer/model/ruler';
import { geodesic, lineLength, polygonArea } from '@renderer/model/measure';
import type { Position } from '@renderer/model/types';

const reading = (shape: RulerShape, points: Position[], extra: Partial<RulerReading> = {}): RulerReading => ({
  shape,
  points,
  live: false,
  groundLength: null,
  ...extra,
});

const row = (r: RulerReading, label: string): number | null | undefined =>
  rulerRows(r, r.shape).find((x) => x.label === label)?.value;

const square: Position[] = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]];

describe('ruler readout', () => {
  it('has Google Earth’s six tabs', () => {
    expect(RULER_SHAPES.map((s) => s.label)).toEqual([
      'Line', 'Path', 'Polygon', 'Circle', '3D path', '3D polygon',
    ]);
  });

  it('reads a line’s map length, ground length and heading', () => {
    const r = reading('line', [[0, 0], [0, 1]], { groundLength: 110_600 });
    expect(rulerRows(r, 'line').map((x) => x.label)).toEqual(['Map Length', 'Ground Length', 'Heading']);
    expect(row(r, 'Map Length')).toBeCloseTo(110_574.389, 2);
    expect(row(r, 'Ground Length')).toBe(110_600);
    expect(row(r, 'Heading')).toBeCloseTo(0, 6);
  });

  it('shows the ground length as pending until it is sampled', () => {
    expect(row(reading('path', [[0, 0], [1, 0]]), 'Ground Length')).toBeNull();
    // Nothing to sample yet is simply zero.
    expect(row(reading('path', [[0, 0]]), 'Ground Length')).toBe(0);
  });

  it('reads a polygon’s perimeter and area, closing it', () => {
    const r = reading('polygon', square);
    expect(row(r, 'Perimeter')).toBeCloseTo(lineLength([...square, square[0]]), 6);
    expect(row(r, 'Area')).toBeCloseTo(polygonArea(square), 6);
  });

  it('reads a circle from its centre and edge', () => {
    const r = reading('circle', [[0, 0], [0, 0.001]]);
    const radius = geodesic([0, 0], [0, 0.001]).distance;
    expect(row(r, 'Radius')).toBeCloseTo(radius, 6);
    expect(row(r, 'Area')! / (Math.PI * radius ** 2)).toBeCloseTo(1, 6);
    expect(row(r, 'Circumference')! / (2 * Math.PI * radius)).toBeCloseTo(1, 6);
  });

  it('reads 3D lengths through heights', () => {
    const r = reading('path3d', [[10, 45, 100], [10, 45, 160]]);
    expect(row(r, 'Length')).toBeCloseTo(60, 6);
  });

  it('reads zeros for an empty tab, or a reading from another tab', () => {
    for (const s of RULER_SHAPES) {
      for (const x of rulerRows(null, s.id)) expect(x.value).toBe(0);
    }
    const line = reading('line', [[0, 0], [0, 1]]);
    expect(rulerRows(line, 'path').every((x) => x.value === 0)).toBe(true);
  });

  it('drops the cursor point from a live reading', () => {
    const pts: Position[] = [[0, 0], [1, 0], [2, 0]];
    expect(committedPoints(reading('path', pts, { live: true }))).toEqual(pts.slice(0, 2));
    expect(committedPoints(reading('path', pts))).toEqual(pts);
  });
});

describe('ruler units', () => {
  it('converts and formats lengths', () => {
    expect(formatLength(1234.5678, 'm')).toBe('1,234.57');
    expect(formatLength(1234.5678, 'km')).toBe('1.23');
    expect(formatLength(0.3048, 'ft')).toBe('1.00');
    expect(formatLength(1609.344, 'mi')).toBe('1.00');
    expect(formatLength(1852, 'nmi')).toBe('1.00');
    expect(formatLength(1, 'cm')).toBe('100.00');
  });

  it('converts and formats areas', () => {
    expect(formatArea(25_000, 'ha')).toBe('2.50');
    expect(formatArea(4046.8564224, 'ac')).toBe('1.00');
    expect(formatArea(2_000_000, 'km2')).toBe('2.00');
    expect(formatArea(1, 'ft2')).toBe('10.76');
  });

  it('falls back to metres for an unknown unit', () => {
    expect(formatLength(5, 'furlongs')).toBe('5.00');
    expect(formatArea(5, 'roods')).toBe('5.00');
  });
});

describe('saving a measurement', () => {
  const msl = (p: Position) => (p[2] ?? 0) - 20; // a 20 m geoid undulation

  it('saves ground measurements clamped, without heights', () => {
    const line = rulerGeometry('path', [[0, 0, 5], [1, 0, 7]], msl);
    expect(line).toEqual({ kind: 'LineString', coordinates: [[0, 0], [1, 0]], tessellate: true });
    const poly = rulerGeometry('polygon', square, msl);
    expect(poly?.kind).toBe('Polygon');
    if (poly?.kind === 'Polygon') {
      expect(poly.outerBoundary).toHaveLength(5);
      expect(poly.outerBoundary[4]).toEqual(poly.outerBoundary[0]);
      expect(poly.altitudeMode).toBeUndefined();
    }
  });

  it('saves a circle as a closed polygon ring', () => {
    const g = rulerGeometry('circle', [[0, 0], [0, 0.001]], msl);
    expect(g?.kind).toBe('Polygon');
    if (g?.kind === 'Polygon') {
      expect(g.outerBoundary).toHaveLength(129);
      expect(g.outerBoundary[128]).toEqual(g.outerBoundary[0]);
    }
    expect(rulerGeometry('circle', [[0, 0], [0, 0]], msl)).toBeNull();
  });

  it('saves 3D measurements with sea-level altitudes', () => {
    const g = rulerGeometry('path3d', [[0, 0, 120], [0.001, 0, 150]], msl);
    expect(g).toEqual({
      kind: 'LineString',
      coordinates: [[0, 0, 100], [0.001, 0, 130]],
      altitudeMode: 'absolute',
    });
    const wall = rulerGeometry('polygon3d', [[0, 0, 20], [0.001, 0, 20], [0.001, 0, 30]], msl);
    expect(wall?.kind === 'Polygon' && wall.altitudeMode).toBe('absolute');
  });

  it('refuses measurements with too few points', () => {
    expect(rulerGeometry('line', [[0, 0]], msl)).toBeNull();
    expect(rulerGeometry('polygon', [[0, 0], [1, 1]], msl)).toBeNull();
    expect(rulerGeometry('polygon3d', [[0, 0], [1, 1]], msl)).toBeNull();
  });
});
