import type { Geometry, Position } from './types';
import {
  geodesic,
  lineLength,
  ringPerimeter,
  polygonArea,
  circleArea,
  circleCircumference,
  circleRing,
  pathLength3D,
  ringPerimeter3D,
  polygonArea3D,
} from './measure';

/**
 * The ruler's model, after Google Earth's: one tab per kind of measurement,
 * the rows each tab reads out, the units, and the geometry a measurement
 * saves as. Cesium-free; the interaction lives in globe/RulerTool.ts.
 */

export type RulerShape = 'line' | 'path' | 'polygon' | 'circle' | 'path3d' | 'polygon3d';

export const RULER_SHAPES: { id: RulerShape; label: string; blurb: string; hint: string }[] = [
  {
    id: 'line',
    label: 'Line',
    blurb: 'Measure the distance between two points on the ground',
    hint: 'Click the start and end · drag an end to adjust',
  },
  {
    id: 'path',
    label: 'Path',
    blurb: 'Measure the distance along several points on the ground',
    hint: 'Click points · double-click or Enter to finish · Backspace removes the last',
  },
  {
    id: 'polygon',
    label: 'Polygon',
    blurb: 'Measure the perimeter and area of a polygon on the ground',
    hint: 'Click vertices · click the first or press Enter to close · Backspace removes the last',
  },
  {
    id: 'circle',
    label: 'Circle',
    blurb: 'Measure the radius, area and circumference of a circle on the ground',
    hint: 'Click the centre, then a point on the edge · drag either to adjust',
  },
  {
    id: 'path3d',
    label: '3D path',
    blurb: 'Measure straight-line distances in 3D, over terrain and buildings',
    hint: 'Click points on terrain or 3D buildings · double-click or Enter to finish',
  },
  {
    id: 'polygon3d',
    label: '3D polygon',
    blurb: 'Measure the perimeter and area of a polygon in 3D, such as a wall',
    hint: 'Click vertices on terrain or 3D buildings · click the first or press Enter to close',
  },
];

export function rulerShapeInfo(shape: RulerShape): (typeof RULER_SHAPES)[number] {
  return RULER_SHAPES.find((s) => s.id === shape) ?? RULER_SHAPES[0];
}

/** Line and circle take two points; the rest take as many as the user clicks. */
export function isTwoPointShape(shape: RulerShape): boolean {
  return shape === 'line' || shape === 'circle';
}

export function isClosedShape(shape: RulerShape): boolean {
  return shape === 'polygon' || shape === 'polygon3d';
}

export function is3DShape(shape: RulerShape): boolean {
  return shape === 'path3d' || shape === 'polygon3d';
}

// ---- Units ------------------------------------------------------------------

export const LENGTH_UNITS = [
  { id: 'cm', label: 'Centimetres', metres: 0.01 },
  { id: 'm', label: 'Metres', metres: 1 },
  { id: 'km', label: 'Kilometres', metres: 1000 },
  { id: 'in', label: 'Inches', metres: 0.0254 },
  { id: 'ft', label: 'Feet', metres: 0.3048 },
  { id: 'yd', label: 'Yards', metres: 0.9144 },
  { id: 'mi', label: 'Miles', metres: 1609.344 },
  { id: 'nmi', label: 'Nautical Miles', metres: 1852 },
] as const;

export const AREA_UNITS = [
  { id: 'm2', label: 'Square Metres', sqMetres: 1 },
  { id: 'km2', label: 'Square Kilometres', sqMetres: 1e6 },
  { id: 'ha', label: 'Hectares', sqMetres: 1e4 },
  { id: 'ft2', label: 'Square Feet', sqMetres: 0.09290304 },
  { id: 'yd2', label: 'Square Yards', sqMetres: 0.83612736 },
  { id: 'ac', label: 'Acres', sqMetres: 4046.8564224 },
  { id: 'mi2', label: 'Square Miles', sqMetres: 2589988.110336 },
] as const;

export type LengthUnit = (typeof LENGTH_UNITS)[number]['id'];
export type AreaUnit = (typeof AREA_UNITS)[number]['id'];

/** A number the way the ruler shows it: two decimals, grouped ("1,234.56"). */
export function formatQuantity(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatLength(metres: number, unit: string): string {
  const u = LENGTH_UNITS.find((x) => x.id === unit) ?? LENGTH_UNITS[1];
  return formatQuantity(metres / u.metres);
}

export function formatArea(sqMetres: number, unit: string): string {
  const u = AREA_UNITS.find((x) => x.id === unit) ?? AREA_UNITS[0];
  return formatQuantity(sqMetres / u.sqMetres);
}

// ---- Readout ----------------------------------------------------------------

/** What the ruler tool reports as the user measures. */
export interface RulerReading {
  shape: RulerShape;
  /**
   * The measured points as [lon, lat, ellipsoidal height]; while a measurement
   * is under way the last one follows the cursor. Circles are [centre, edge].
   */
  points: Position[];
  /** Still being drawn: the last point is the cursor. */
  live: boolean;
  /** Length along the terrain (m), sampled behind the cursor; null until first sampled. */
  groundLength: number | null;
}

/** The points the user placed, without the cursor point a live measurement trails. */
export function committedPoints(reading: RulerReading): Position[] {
  return reading.live ? reading.points.slice(0, -1) : reading.points;
}

export interface RulerRow {
  label: string;
  quantity: 'length' | 'area' | 'heading';
  /** Metres, square metres or degrees; null while not yet known. */
  value: number | null;
}

/** The rows a tab reads out for the current points, as Google Earth lays them out. */
export function rulerRows(reading: RulerReading | null, shape: RulerShape): RulerRow[] {
  const pts = reading?.shape === shape ? reading.points : [];
  const ground = pts.length >= 2 ? (reading?.groundLength ?? null) : 0;
  switch (shape) {
    case 'line': {
      const g = pts.length >= 2 ? geodesic(pts[0], pts[1]) : { distance: 0, heading: 0 };
      return [
        { label: 'Map Length', quantity: 'length', value: g.distance },
        { label: 'Ground Length', quantity: 'length', value: ground },
        { label: 'Heading', quantity: 'heading', value: g.heading },
      ];
    }
    case 'path':
      return [
        { label: 'Map Length', quantity: 'length', value: lineLength(pts) },
        { label: 'Ground Length', quantity: 'length', value: ground },
      ];
    case 'polygon':
      return [
        { label: 'Perimeter', quantity: 'length', value: ringPerimeter(pts) },
        { label: 'Area', quantity: 'area', value: polygonArea(pts) },
      ];
    case 'circle': {
      const r = pts.length >= 2 ? geodesic(pts[0], pts[1]).distance : 0;
      return [
        { label: 'Radius', quantity: 'length', value: r },
        { label: 'Area', quantity: 'area', value: circleArea(r) },
        { label: 'Circumference', quantity: 'length', value: circleCircumference(r) },
      ];
    }
    case 'path3d':
      return [{ label: 'Length', quantity: 'length', value: pathLength3D(pts) }];
    case 'polygon3d':
      return [
        { label: 'Perimeter', quantity: 'length', value: ringPerimeter3D(pts) },
        { label: 'Area', quantity: 'area', value: polygonArea3D(pts) },
      ];
  }
}

// ---- Saving -----------------------------------------------------------------

export const SAVED_NAMES: Record<RulerShape, string> = {
  line: 'Measured line',
  path: 'Measured path',
  polygon: 'Measured polygon',
  circle: 'Measured circle',
  path3d: 'Measured 3D path',
  polygon3d: 'Measured 3D polygon',
};

/**
 * The KML geometry a measurement saves as, or null if there is not enough of
 * it yet. Ground measurements are clamped, like drawn features; 3D ones keep
 * their heights as `absolute` altitudes, which KML measures from sea level —
 * `mslOf` converts a point's ellipsoidal height to that.
 */
export function rulerGeometry(
  shape: RulerShape,
  points: Position[],
  mslOf: (p: Position) => number,
): Geometry | null {
  const flat = points.map((p): Position => [p[0], p[1]]);
  const raised = points.map((p): Position => [p[0], p[1], mslOf(p)]);
  switch (shape) {
    case 'line':
    case 'path':
      return points.length >= 2
        ? { kind: 'LineString', coordinates: flat, tessellate: true }
        : null;
    case 'polygon':
      return points.length >= 3
        ? { kind: 'Polygon', outerBoundary: [...flat, flat[0]], innerBoundaries: [], tessellate: true }
        : null;
    case 'circle': {
      if (points.length < 2 || geodesic(points[0], points[1]).distance === 0) return null;
      const ring = circleRing(flat[0], flat[1]);
      return { kind: 'Polygon', outerBoundary: [...ring, ring[0]], innerBoundaries: [], tessellate: true };
    }
    case 'path3d':
      return points.length >= 2
        ? { kind: 'LineString', coordinates: raised, altitudeMode: 'absolute' }
        : null;
    case 'polygon3d':
      return points.length >= 3
        ? {
            kind: 'Polygon',
            outerBoundary: [...raised, raised[0]],
            innerBoundaries: [],
            altitudeMode: 'absolute',
          }
        : null;
  }
}
