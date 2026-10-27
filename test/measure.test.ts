import { describe, it, expect } from 'vitest';
import {
  haversine,
  geodesic,
  lineLength,
  ringPerimeter,
  polygonArea,
  circleArea,
  circleCircumference,
  circleRing,
  destination,
  greatCirclePoints,
  groundLength,
  pathLength3D,
  polygonArea3D,
  R_AUTHALIC,
} from '@renderer/model/measure';
import type { Position } from '@renderer/model/types';

/** Degrees–minutes–seconds to decimal degrees. */
const dms = (d: number, m: number, s: number): number => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600);

/** WGS84 surface area (m²), the published figure. */
const EARTH_AREA = 510_065_621.724e6;

// WGS84, for the closed-form references below.
const WGS_A = 6378137;
const WGS_F = 1 / 298.257223563;
const WGS_E2 = WGS_F * (2 - WGS_F);
const WGS_E = Math.sqrt(WGS_E2);
/** Snyder's q(φ), from which authalic latitudes and band areas follow. */
const q = (sinPhi: number): number =>
  (1 - WGS_E2) *
  (sinPhi / (1 - WGS_E2 * sinPhi ** 2) -
    (1 / (2 * WGS_E)) * Math.log((1 - WGS_E * sinPhi) / (1 + WGS_E * sinPhi)));
const sinRad = (deg: number): number => Math.sin((deg * Math.PI) / 180);

describe('geodesic distance and heading', () => {
  it('reproduces Vincenty’s own test line (Flinders Peak → Buninyong)', () => {
    const flinders: Position = [dms(144, 25, 29.5244), dms(-37, 57, 3.7203)];
    const buninyong: Position = [dms(143, 55, 35.3839), dms(-37, 39, 10.1561)];
    const g = geodesic(flinders, buninyong);
    expect(g.distance).toBeCloseTo(54_972.271, 2);
    expect(g.heading).toBeCloseTo(dms(306, 52, 5.37), 4);
  });

  it('measures a degree along the equator and along a meridian', () => {
    expect(geodesic([0, 0], [1, 0]).distance).toBeCloseTo(111_319.491, 2);
    expect(geodesic([0, 0], [0, 1]).distance).toBeCloseTo(110_574.389, 2);
  });

  it('reads headings clockwise from north', () => {
    expect(geodesic([0, 0], [0, 1]).heading).toBeCloseTo(0, 6);
    expect(geodesic([0, 0], [1, 0]).heading).toBeCloseTo(90, 6);
    expect(geodesic([0, 1], [0, 0]).heading).toBeCloseTo(180, 6);
    expect(geodesic([1, 0], [0, 0]).heading).toBeCloseTo(270, 6);
  });

  it('takes the short way across the antimeridian', () => {
    const across = geodesic([179.5, 10], [-179.5, 10]);
    expect(across.distance).toBeCloseTo(geodesic([-0.5, 10], [0.5, 10]).distance, 3);
    expect(across.heading).toBeGreaterThan(80);
    expect(across.heading).toBeLessThan(100);
  });

  it('is zero for coincident points and finite for antipodal ones', () => {
    expect(geodesic([10, 20], [10, 20]).distance).toBe(0);
    const anti = geodesic([0, 0], [180, 0]);
    expect(Number.isFinite(anti.distance)).toBe(true);
    expect(anti.distance).toBeGreaterThan(19_900_000);
    expect(anti.distance).toBeLessThan(20_100_000);
  });

  it('sums path lengths and closes ring perimeters', () => {
    expect(lineLength([[0, 0], [0, 1], [0, 2]])).toBeCloseTo(221_149.453, 1);
    const square: Position[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const closed = ringPerimeter([...square, square[0]]);
    expect(ringPerimeter(square)).toBeCloseTo(closed, 6);
    expect(closed).toBeGreaterThan(4 * 110_000);
  });

  it('keeps the old spherical helper', () => {
    expect(haversine([0, 0], [0, 1])).toBeCloseTo(111_195, -1);
  });
});

describe('polygon area on the ellipsoid', () => {
  it('measures an octant of the Earth exactly', () => {
    // Equator, prime meridian and 90°E bound one eighth of the surface.
    const octant: Position[] = [[0, 0], [90, 0], [0, 90]];
    expect(polygonArea(octant) / (EARTH_AREA / 8)).toBeCloseTo(1, 9);
    expect(4 * Math.PI * R_AUTHALIC ** 2).toBeCloseTo(EARTH_AREA, -4);
  });

  it('measures a 1° × 1° cell at the equator (≈ 12,308 km²)', () => {
    const cell: Position[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    // Closed-form ellipsoidal area between two parallels, for comparison.
    const exact = ((WGS_A ** 2 * (Math.PI / 180)) / 2) * (q(sinRad(1)) - q(0));
    // The top edge is a great circle, not the parallel: a few metres of bow.
    expect(Math.abs(polygonArea(cell) - exact)).toBeLessThan(0.5e6);
    expect(polygonArea(cell) / 1e6).toBeCloseTo(12_308.8, 0);
  });

  it('ignores winding, a closing vertex and the antimeridian', () => {
    const ccw: Position[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const cw = [...ccw].reverse();
    const closed = [...ccw, ccw[0]];
    const across: Position[] = [[179.5, 0], [-179.5, 0], [-179.5, 1], [179.5, 1]];
    expect(polygonArea(cw)).toBeCloseTo(polygonArea(ccw), 3);
    expect(polygonArea(closed)).toBeCloseTo(polygonArea(ccw), 3);
    expect(polygonArea(across)).toBeCloseTo(polygonArea(ccw), 3);
  });

  it('measures a ring around a pole as the polar cap', () => {
    const ring: Position[] = [];
    for (let lon = -180; lon < 180; lon += 1) ring.push([lon, 80]);
    const area = polygonArea(ring);
    // The cap north of 80°N, less a sliver: each 1° edge bows poleward.
    const cap = 2 * Math.PI * R_AUTHALIC ** 2 * (1 - q(sinRad(80)) / q(1));
    expect(area / cap).toBeCloseTo(1, 4);
    expect(area).toBeLessThan(cap);
    expect(polygonArea([...ring].reverse())).toBeCloseTo(area, 0);
  });

  it('is zero for degenerate rings', () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([[0, 0], [1, 1]])).toBe(0);
  });
});

describe('circles', () => {
  it('agrees with πr² and 2πr for a small circle', () => {
    expect(circleArea(1000) / (Math.PI * 1000 ** 2)).toBeCloseTo(1, 6);
    expect(circleCircumference(1000) / (2 * Math.PI * 1000)).toBeCloseTo(1, 6);
  });

  it('draws a ring through the edge point, equidistant from the centre', () => {
    const centre: Position = [-111.9, 33.4];
    const edge: Position = [-111.85, 33.43];
    const ring = circleRing(centre, edge, 64);
    expect(ring).toHaveLength(64);
    expect(ring[0][0]).toBeCloseTo(edge[0], 9);
    expect(ring[0][1]).toBeCloseTo(edge[1], 9);
    const r = haversine(centre, edge);
    for (const p of ring) expect(haversine(centre, p)).toBeCloseTo(r, 3);
  });

  it('steps a heading and distance out from a point', () => {
    const p = destination([0, 0], 90, 111_195);
    expect(p[0]).toBeCloseTo(1, 3);
    expect(p[1]).toBeCloseTo(0, 9);
  });
});

describe('ground length', () => {
  const line: Position[] = [[0, 0], [0.01, 0]];

  it('interpolates along the great circle, ends included', () => {
    const pts = greatCirclePoints([0, 0], [10, 0], 10);
    expect(pts).toHaveLength(11);
    expect(pts[5][0]).toBeCloseTo(5, 9);
    expect(pts[10][0]).toBeCloseTo(10, 9);
  });

  it('equals the map length on flat ground', () => {
    expect(groundLength(line, () => 120)).toBeCloseTo(lineLength(line), 6);
  });

  it('adds the climb on a slope', () => {
    // A steady 3-in-4 rise: the ground is 5/4 of the map distance.
    const map = lineLength(line);
    const ramp = (lon: number) => (lon / 0.01) * map * 0.75;
    expect(groundLength(line, ramp) / map).toBeCloseTo(1.25, 6);
  });

  it('skips points with no terrain and falls back to the map length', () => {
    expect(groundLength(line, () => undefined)).toBeCloseTo(lineLength(line), 6);
    const holes = (lon: number) => (lon > 0.004 && lon < 0.006 ? undefined : 50);
    expect(groundLength(line, holes)).toBeCloseTo(lineLength(line), 6);
  });

  it('follows every segment of a path', () => {
    const path: Position[] = [[0, 0], [0.01, 0], [0.01, 0.01]];
    expect(groundLength(path, () => 0)).toBeCloseTo(lineLength(path), 6);
    expect(groundLength([[0, 0]], () => 0)).toBe(0);
  });
});

describe('3D measurement', () => {
  it('measures straight up as the height difference', () => {
    expect(pathLength3D([[10, 45, 100], [10, 45, 130]])).toBeCloseTo(30, 6);
  });

  it('measures a vertical wall', () => {
    // A 10 m high wall, ~111 m long, along the equator.
    const wall: Position[] = [[0, 0, 0], [0.001, 0, 0], [0.001, 0, 10], [0, 0, 10]];
    const length = pathLength3D([wall[0], wall[1]]);
    expect(polygonArea3D(wall)).toBeCloseTo(length * 10, 1);
  });

  it('measures a flat plot like the ground area', () => {
    const plot: Position[] = [[0, 0, 0], [0.001, 0, 0], [0.001, 0.001, 0], [0, 0.001, 0]];
    expect(polygonArea3D(plot) / polygonArea(plot)).toBeCloseTo(1, 4);
  });
});
