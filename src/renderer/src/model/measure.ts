import type { Position } from './types';

/**
 * Geodesic measurement on the WGS84 ellipsoid, for the ruler. Kept Cesium-free
 * so it is unit-testable and usable from the model layer.
 *
 * Distances and headings are ellipsoidal geodesics (Vincenty, accurate to well
 * under a millimetre), which is what Google Earth reports. Areas are exact on
 * the ellipsoid's authalic (equal-area) sphere, so a hectare is a hectare at
 * any latitude.
 */

const A = 6378137; // semi-major axis (m)
const F = 1 / 298.257223563; // flattening
const B = A * (1 - F); // semi-minor axis (m)
const E2 = F * (2 - F); // first eccentricity squared
const E = Math.sqrt(E2);

/** Mean Earth radius (m): the sphere used for circles and sampling paths. */
export const R_MEAN = 6371008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** A longitude difference wrapped into (-π, π], so paths may cross the antimeridian. */
function wrapPi(rad: number): number {
  const w = rad - 2 * Math.PI * Math.floor((rad + Math.PI) / (2 * Math.PI));
  return w === -Math.PI ? Math.PI : w;
}

/** Great-circle distance between two [lon, lat] points on the mean sphere, in metres. */
export function haversine(a: Position, b: Position): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MEAN * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b on the sphere, degrees clockwise from north. */
function sphericalBearing(a: Position, b: Position): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * The geodesic between two [lon, lat] points on WGS84 (Vincenty's inverse
 * formula): its length in metres and its initial heading in degrees clockwise
 * from north, [0, 360). Vincenty fails to converge for nearly antipodal
 * points; those fall back to the great circle, which is within 0.5 %.
 */
export function geodesic(a: Position, b: Position): { distance: number; heading: number } {
  const L = wrapPi(toRad(b[0] - a[0]));
  const U1 = Math.atan((1 - F) * Math.tan(toRad(a[1])));
  const U2 = Math.atan((1 - F) * Math.tan(toRad(b[1])));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 1;
  let sigma = 0;
  let cos2Alpha = 1;
  let cos2SigmaM = 0;
  let sinLambda = 0;
  let cosLambda = 1;
  for (let iter = 0; ; iter++) {
    if (iter === 200) return { distance: haversine(a, b), heading: sphericalBearing(a, b) };
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    if (sinSigma === 0) return { distance: 0, heading: 0 }; // coincident points
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    // On the equator cos²α is 0 and the term drops out.
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda =
      L +
      (1 - C) *
        F *
        sinAlpha *
        (sigma +
          C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-12) break;
  }

  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const deltaSigma =
    bigB *
    sinSigma *
    (cos2SigmaM +
      (bigB / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (bigB / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  const distance = B * bigA * (sigma - deltaSigma);
  const alpha1 = Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
  return { distance, heading: (toDeg(alpha1) + 360) % 360 };
}

/** Total geodesic length of a polyline, in metres. */
export function lineLength(positions: Position[]): number {
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    total += geodesic(positions[i - 1], positions[i]).distance;
  }
  return total;
}

/** Geodesic perimeter of a ring, closing it if it is open. */
export function ringPerimeter(ring: Position[]): number {
  if (ring.length < 2) return 0;
  const last = ring[ring.length - 1];
  const closed = last[0] === ring[0][0] && last[1] === ring[0][1];
  return lineLength(closed ? ring : [...ring, ring[0]]);
}

// ---- Area -------------------------------------------------------------------

/** q(φ) of the authalic-latitude transform (Snyder, Map Projections, eq. 3-12). */
function authalicQ(sinPhi: number): number {
  const es = E * sinPhi;
  return (1 - E2) * (sinPhi / (1 - es * es) - (1 / (2 * E)) * Math.log((1 - es) / (1 + es)));
}
const Q_POLE = authalicQ(1);
/** Radius of the sphere with the ellipsoid's surface area. */
export const R_AUTHALIC = A * Math.sqrt(Q_POLE / 2);

/** Authalic latitude β (radians) for a geodetic latitude in degrees. */
function authalicLatitude(latDeg: number): number {
  return Math.asin(Math.max(-1, Math.min(1, authalicQ(Math.sin(toRad(latDeg))) / Q_POLE)));
}

/**
 * Area of a polygon ring on the WGS84 ellipsoid, in square metres. The ring
 * may be open or closed; winding is ignored, as is any crossing of the
 * antimeridian. Edges are great circles on the authalic sphere — the
 * difference from true geodesics is negligible at any size a person draws.
 * A ring that circles a pole is measured as the cap on the pole's side, and
 * the smaller of a ring's two sides is always the one reported.
 */
export function polygonArea(ring: Position[]): number {
  const pts = ring.slice();
  const last = pts[pts.length - 1];
  if (pts.length > 1 && last[0] === pts[0][0] && last[1] === pts[0][1]) pts.pop();
  const n = pts.length;
  if (n < 3) return 0;

  // Sum each edge's signed area to the equator (exact spherical excess on the
  // unit sphere), and how far the ring winds in longitude.
  let excess = 0;
  let winding = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const dLon = wrapPi(toRad(q[0] - p[0]));
    const t1 = Math.tan(authalicLatitude(p[1]) / 2);
    const t2 = Math.tan(authalicLatitude(q[1]) / 2);
    excess += 2 * Math.atan2(Math.tan(dLon / 2) * (t1 + t2), 1 + t1 * t2);
    winding += dLon;
  }
  // Circling a pole adds a full turn of longitude: the band to the equator
  // came out, and the cap is the hemisphere less that band.
  let area = Math.abs(excess);
  if (Math.abs(winding) > Math.PI) area = 2 * Math.PI - area;
  area = Math.min(area, 4 * Math.PI - area);
  return area * R_AUTHALIC * R_AUTHALIC;
}

// ---- Circles ----------------------------------------------------------------

/** Area of a circle of geodesic radius r (m): a spherical cap on the mean sphere. */
export function circleArea(radius: number): number {
  return 2 * Math.PI * R_MEAN * R_MEAN * (1 - Math.cos(radius / R_MEAN));
}

/** Circumference of a circle of geodesic radius r (m) on the mean sphere. */
export function circleCircumference(radius: number): number {
  return 2 * Math.PI * R_MEAN * Math.sin(radius / R_MEAN);
}

/** The point `distance` metres from `origin` along great-circle `heading` (degrees). */
export function destination(origin: Position, heading: number, distance: number): Position {
  const d = distance / R_MEAN;
  const th = toRad(heading);
  const lat1 = toRad(origin[1]);
  const lon1 = toRad(origin[0]);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(th),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(th) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [toDeg(wrapPi(lon2)), toDeg(lat2)];
}

/**
 * A circle around `centre` passing through `edge`, as an open ring of `n`
 * points (for drawing and saving). Built on the mean sphere so it passes
 * exactly through the edge point the user placed.
 */
export function circleRing(centre: Position, edge: Position, n = 128): Position[] {
  const r = haversine(centre, edge);
  const start = sphericalBearing(centre, edge);
  const ring: Position[] = [];
  for (let i = 0; i < n; i++) ring.push(destination(centre, start + (360 * i) / n, r));
  return ring;
}

// ---- Ground length ------------------------------------------------------------

/** `n + 1` points evenly spaced along the great circle from a to b (both ends included). */
export function greatCirclePoints(a: Position, b: Position, n: number): Position[] {
  const unit = (p: Position): [number, number, number] => {
    const lat = toRad(p[1]);
    const lon = toRad(p[0]);
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  };
  const va = unit(a);
  const vb = unit(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  const out: Position[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let s0 = 1 - t;
    let s1 = t;
    if (omega > 1e-12) {
      s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
      s1 = Math.sin(t * omega) / Math.sin(omega);
    }
    const x = s0 * va[0] + s1 * vb[0];
    const y = s0 * va[1] + s1 * vb[1];
    const z = s0 * va[2] + s1 * vb[2];
    out.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  return out;
}

/** Finest spacing worth sampling terrain at, in metres (about a DEM pixel). */
const PROFILE_MIN_SPACING = 10;
/** Most terrain samples taken for one measurement, so a long path stays cheap. */
const PROFILE_MAX_SAMPLES = 1000;

/**
 * Length along the ground of a polyline, in metres: the surface distance with
 * the rise and fall of the terrain added in, as a profile sampled every 10 m
 * (coarser on long paths, at most 1000 samples). `heightAt` returns the
 * terrain height at a point, or undefined where none is known; such samples
 * are skipped. With no heights at all this is the map length.
 */
export function groundLength(
  positions: Position[],
  heightAt: (lon: number, lat: number) => number | undefined,
): number {
  const lengths: number[] = [];
  for (let i = 1; i < positions.length; i++) {
    lengths.push(geodesic(positions[i - 1], positions[i]).distance);
  }
  const total = lengths.reduce((s, l) => s + l, 0);
  if (total === 0) return 0;
  const spacing = Math.max(PROFILE_MIN_SPACING, total / PROFILE_MAX_SAMPLES);

  let length = 0;
  let run = 0; // horizontal distance since the last known height
  let lastH: number | undefined;
  for (let i = 0; i < lengths.length; i++) {
    const steps = Math.max(1, Math.ceil(lengths[i] / spacing));
    const step = lengths[i] / steps;
    const samples = greatCirclePoints(positions[i], positions[i + 1], steps);
    // Each segment's first sample is the previous segment's last.
    for (let j = i === 0 ? 0 : 1; j < samples.length; j++) {
      if (j > 0) run += step;
      const h = heightAt(samples[j][0], samples[j][1]);
      if (h === undefined || !Number.isFinite(h)) continue;
      length += lastH === undefined ? run : Math.hypot(run, h - lastH);
      run = 0;
      lastH = h;
    }
  }
  return length + run;
}

// ---- 3D ---------------------------------------------------------------------

/** Earth-centred, Earth-fixed coordinates (m) of [lon, lat, ellipsoidal height]. */
export function toEcef(p: Position): [number, number, number] {
  const lat = toRad(p[1]);
  const lon = toRad(p[0]);
  const h = p[2] ?? 0;
  const sinLat = Math.sin(lat);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (N + h) * Math.cos(lat) * Math.cos(lon),
    (N + h) * Math.cos(lat) * Math.sin(lon),
    (N * (1 - E2) + h) * sinLat,
  ];
}

/** Straight-line (3D) length of a path through [lon, lat, ellipsoidal height] points. */
export function pathLength3D(positions: Position[]): number {
  let total = 0;
  for (let i = 1; i < positions.length; i++) {
    const p = toEcef(positions[i - 1]);
    const q = toEcef(positions[i]);
    total += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  }
  return total;
}

/** Straight-line perimeter of a 3D ring, closing it. */
export function ringPerimeter3D(ring: Position[]): number {
  return ring.length < 2 ? 0 : pathLength3D([...ring, ring[0]]);
}

/**
 * Area of a polygon through 3D points, in square metres (Newell's method):
 * exact for a flat polygon in any orientation, such as a wall; for a warped
 * one, the area of its outline seen square-on to its best-fit plane.
 */
export function polygonArea3D(ring: Position[]): number {
  if (ring.length < 3) return 0;
  // Relative to the first vertex, so the cross products of Earth-sized
  // coordinates do not swamp a building-sized answer.
  const o = toEcef(ring[0]);
  const pts = ring.map((p) => {
    const e = toEcef(p);
    return [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
  });
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1, z1] = pts[i];
    const [x2, y2, z2] = pts[(i + 1) % pts.length];
    nx += y1 * z2 - z1 * y2;
    ny += z1 * x2 - x1 * z2;
    nz += x1 * y2 - y1 * x2;
  }
  return Math.hypot(nx, ny, nz) / 2;
}
