/**
 * Built-in 3D terrain sources, shared between the main process (which builds the
 * Terrain menu and proxies tile fetches) and the renderer (which turns a source
 * into a Cesium terrain provider). Keep this dependency-free — no electron or
 * cesium imports — so both sides can consume it.
 *
 * All sources are Terrarium-encoded raster-DEM tiles: height in metres is
 *   (R * 256 + G + B / 256) − 32768
 * decoded per pixel. The renderer meshes them on the fly (see globe/terrain.ts).
 */

export interface TerrainSourceDesc {
  /** Stable id; also the host in `earthy-terrain://<id>/<z>/<x>/<y>.png`. */
  id: string;
  /** User-facing name shown in the Terrain menu. */
  label: string;
  /** Remote XYZ tile template, fetched server-side by the main process. */
  urlTemplate: string;
  encoding: 'terrarium';
  /** Deepest zoom the source actually has tiles for; deeper views upsample. */
  maxZoom: number;
  attribution: string;
}

export const BUILTIN_TERRAIN: TerrainSourceDesc[] = [
  {
    id: 'aws-terrarium',
    label: 'AWS Terrain (online)',
    urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium',
    maxZoom: 15,
    attribution: 'Elevation — AWS Terrain Tiles (Mapzen · SRTM/GMTED et al.)',
  },
];

export function terrainSourceById(id: string): TerrainSourceDesc | undefined {
  return BUILTIN_TERRAIN.find((s) => s.id === id);
}

// ---- Terrarium decoding and void repair -----------------------------------
// Kept here (dependency-free) rather than in the renderer's provider so the
// pixel maths can be unit-tested without pulling in Cesium.

/** Terrarium source tiles are 256×256. */
export const TILE_SRC = 256;

/** Terrarium RGB → metres above mean sea level. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Below this a sample is not an elevation. Challenger Deep, the deepest point
 * in any ocean, is −10,935 m; Terrarium encodes a void as RGB(0,0,0), which
 * decodes to exactly −32768.
 */
const MIN_VALID_HEIGHT = -11000;
/**
 * A void does not end cleanly. The source resamples its zero pixels into the
 * neighbourhood, leaving a skirt that ramps up from −32768 towards real data —
 * one coastal tile off South Kona held 17 pixels at exactly −32768 but 86 below
 * −12,000. Anything this deep that touches a void is part of that skirt.
 */
const VOID_SUSPECT_HEIGHT = -500;
/** If growing a void swallows this much of a tile, the tile really is deep. */
const VOID_MAX_FRACTION = 0.25;
/** Neighbour-averaging passes used to grow valid data back over a void. */
const VOID_FILL_PASSES = 32;

/**
 * Repair decoder voids in a decoded tile, in place. Returns how many samples
 * were replaced.
 *
 * One bad vertex takes its whole triangle fan with it, so 17 void pixels in the
 * corner of a tile were enough to hang a kilometre-wide black wedge 32 km below
 * the sea floor. Seed on the physically impossible samples, grow through the
 * resampling skirt around them, then grow the surrounding valid data back over
 * the hole. A tile that is genuinely deep everywhere would be swallowed whole by
 * that growth, so if it runs away only the impossible samples are treated as
 * voids.
 */
export function repairVoids(h: Float32Array, width = TILE_SRC): number {
  const n = h.length;
  const height = n / width;
  const bad = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (h[i] < MIN_VALID_HEIGHT) {
      bad[i] = 1;
      count++;
    }
  }
  if (count === 0) return 0;

  // Grow the void through anything anomalously deep that touches it.
  const stack: number[] = [];
  for (let i = 0; i < n; i++) if (bad[i]) stack.push(i);
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % width;
    const y = (i / width) | 0;
    const grow = (j: number): void => {
      if (!bad[j] && h[j] < VOID_SUSPECT_HEIGHT) {
        bad[j] = 1;
        count++;
        stack.push(j);
      }
    };
    if (x > 0) grow(i - 1);
    if (x < width - 1) grow(i + 1);
    if (y > 0) grow(i - width);
    if (y < height - 1) grow(i + width);
  }

  if (count > n * VOID_MAX_FRACTION) {
    bad.fill(0);
    count = 0;
    for (let i = 0; i < n; i++) {
      if (h[i] < MIN_VALID_HEIGHT) {
        bad[i] = 1;
        count++;
      }
    }
  }

  // Grow valid neighbours inward. Each pass writes only after reading the whole
  // frontier, so a fill never seeds off another fill from the same pass.
  let holes: number[] = [];
  for (let i = 0; i < n; i++) if (bad[i]) holes.push(i);
  const repaired = holes.length;
  for (let pass = 0; pass < VOID_FILL_PASSES && holes.length > 0; pass++) {
    const stillEmpty: number[] = [];
    const at: number[] = [];
    const value: number[] = [];
    for (const i of holes) {
      const x = i % width;
      const y = (i / width) | 0;
      let sum = 0;
      let k = 0;
      if (x > 0 && !bad[i - 1]) (sum += h[i - 1]), k++;
      if (x < width - 1 && !bad[i + 1]) (sum += h[i + 1]), k++;
      if (y > 0 && !bad[i - width]) (sum += h[i - width]), k++;
      if (y < height - 1 && !bad[i + width]) (sum += h[i + width]), k++;
      if (k > 0) {
        at.push(i);
        value.push(sum / k);
      } else {
        stillEmpty.push(i);
      }
    }
    if (at.length === 0) break; // nothing valid left to grow from
    for (let j = 0; j < at.length; j++) {
      h[at[j]] = value[j];
      bad[at[j]] = 0;
    }
    holes = stillEmpty;
  }

  if (holes.length > 0) {
    // The whole tile was void: no valid sample to grow from, so level it.
    let sum = 0;
    let k = 0;
    for (let i = 0; i < n; i++) if (!bad[i]) (sum += h[i]), k++;
    const fallback = k > 0 ? sum / k : 0;
    for (const i of holes) {
      h[i] = fallback;
      bad[i] = 0;
    }
  }
  return repaired;
}
