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

export type TerrainSourceDesc =
  | {
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
  | {
      id: string;
      label: string;
      /**
       * Cesium ion quantized-mesh terrain, streamed by Cesium's own provider.
       * Needs an ion access token (EARTHY_ION_TOKEN); the renderer fetches
       * directly, no main-process proxy. Carries a built-in water mask, so the
       * coastline comes from the source rather than from DEM guesswork.
       */
      encoding: 'ion';
      /** The ion asset to stream. 1 = Cesium World Terrain. */
      ionAssetId: number;
      attribution: string;
    };

export const BUILTIN_TERRAIN: TerrainSourceDesc[] = [
  {
    id: 'aws-terrarium',
    label: 'AWS Terrain (online)',
    urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium',
    maxZoom: 15,
    attribution: 'Elevation — AWS Terrain Tiles (Mapzen · SRTM/GMTED et al.)',
  },
  {
    id: 'cesium-world-terrain',
    label: 'Cesium World Terrain (ion key)',
    encoding: 'ion',
    ionAssetId: 1,
    attribution: 'Terrain — Cesium World Terrain © Cesium ion',
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
/** Structural-void limits: exact-constant regions that cannot be topography.
 * A "pit" is a small patch of exactly-0 punched into ground that is high all
 * around it — a real beach 0 always touches water or low ground somewhere. A
 * "slab" is a constant positive patch every observed neighbour of which sits
 * far BELOW it — a real lake or reservoir is dead constant too, but its shores
 * are at or above its surface, never 30 m under it. Measured off South Kona:
 * a constant-187 slab against 1..60 m ground (rendered as a freestanding arch)
 * and exact-0 pinpricks in smooth 40..55 m land (rendered as black pits). */
const STRUCT_PIT_MAX_SIZE = 64;
const STRUCT_PIT_RIM = 25;
const STRUCT_SLAB_MIN_SIZE = 8;
const STRUCT_SLAB_DROP = 30;
const STRUCT_SLAB_MEAN_DROP = 60;

/**
 * A jump this large between ADJACENT samples is not topography. At z15 a
 * sample step is ~30 m of ground, and no coast on Earth drops a kilometre in
 * 30 m — the steepest real escarpments manage ~45°. Off South Kona the source
 * carries a gouge of -3800..-5073 directly against a +150 m cliff top (no
 * sentinel pixels at all), which rendered as a 5 km pit with bathymetry on.
 * The gouge announces itself by its edges.
 */
const VOID_GRADIENT = 1000;

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
export function repairVoids(
  h: Float32Array,
  width = TILE_SRC,
  /**
   * Optional out-parameter (same length as h): set to 1 wherever a void was
   * filled. The in-tile fill is a guess — its anchors may all be on the wrong
   * side of a coastline — so callers with access to coarser real data (the
   * terrain provider's ancestor tiles) overlay that over the mask instead.
   */
  voidMask?: Uint8Array,
): number {
  const n = h.length;
  const height = n / width;
  const bad = voidMask ?? new Uint8Array(n);
  bad.fill(0);
  let count = 0;
  // Seed on samples that cannot be real: deeper than any ocean, or anomalously
  // deep with a physically impossible jump to a neighbour (see VOID_GRADIENT).
  // A coherent plate of coarse bathymetry is neither — its interior is smooth
  // and its shoreline edge, though sharp, stays well under the gradient bar —
  // so wrong-but-smooth source data is left alone.
  for (let i = 0; i < n; i++) {
    if (h[i] < MIN_VALID_HEIGHT) {
      bad[i] = 1;
      count++;
      continue;
    }
    if (h[i] >= VOID_SUSPECT_HEIGHT) continue;
    const x = i % width;
    const y = (i / width) | 0;
    if (
      (x > 0 && h[i - 1] - h[i] > VOID_GRADIENT) ||
      (x < width - 1 && h[i + 1] - h[i] > VOID_GRADIENT) ||
      (y > 0 && h[i - width] - h[i] > VOID_GRADIENT) ||
      (y < height - 1 && h[i + width] - h[i] > VOID_GRADIENT)
    ) {
      bad[i] = 1;
      count++;
    }
  }
  if (count === 0) {
    // No depth seeds — structural ones may still exist; skip straight there.
    count = structuralSeeds(h, width, height, bad);
    if (count === 0) return 0;
    return fillVoids(h, width, height, bad);
  }

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

  // Structural seeds join AFTER the runaway bail: they are shape-verified, so
  // a flood that ran away must not wipe them — and they must not feed the
  // flood either, or a large slab would guarantee the bail that erases it.
  count += structuralSeeds(h, width, height, bad);
  if (count === 0) return 0;
  return fillVoids(h, width, height, bad);
}

/** Grow valid data back over every marked void; returns how many were filled.
 *  Works on a copy of the mask, so the caller's record of WHERE survives. */
function fillVoids(h: Float32Array, width: number, height: number, mask: Uint8Array): number {
  const bad = mask.slice();
  const n = h.length;
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

/**
 * Mark exact-constant regions that cannot be real terrain (see the STRUCT_*
 * constants) as voids. Pixels already marked bad are never used as evidence —
 * and pits are judged before slabs for the same reason: a flat plain riddled
 * with garbage pits must not have the pits testify that the plain "floats".
 */
function structuralSeeds(
  h: Float32Array,
  width: number,
  height: number,
  bad: Uint8Array,
): number {
  const n = h.length;
  const seen = new Uint8Array(n);
  interface Region {
    value: number;
    members: number[];
    /** Indices of adjacent non-member samples (may repeat; filtered on use). */
    outside: number[];
  }
  const regions: Region[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || bad[i] || h[i] < 0) continue;
    const c = h[i];
    const region: Region = { value: c, members: [i], outside: [] };
    seen[i] = 1;
    stack.length = 0;
    stack.push(i);
    while (stack.length > 0) {
      const j = stack.pop() as number;
      const x = j % width;
      const y = (j / width) | 0;
      const visit = (k: number): void => {
        if (h[k] === c && !bad[k]) {
          if (!seen[k]) {
            seen[k] = 1;
            region.members.push(k);
            stack.push(k);
          }
        } else {
          region.outside.push(k);
        }
      };
      if (x > 0) visit(j - 1);
      if (x < width - 1) visit(j + 1);
      if (y > 0) visit(j - width);
      if (y < height - 1) visit(j + width);
    }
    regions.push(region);
  }

  let added = 0;
  const mark = (r: Region): void => {
    for (const j of r.members) {
      if (!bad[j]) {
        bad[j] = 1;
        added++;
      }
    }
  };
  const rim = (r: Region): { min: number; max: number; mean: number; count: number } => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    for (const k of r.outside) {
      if (bad[k]) continue; // a void is not evidence
      if (h[k] < min) min = h[k];
      if (h[k] > max) max = h[k];
      sum += h[k];
      count++;
    }
    return { min, max, mean: count > 0 ? sum / count : 0, count };
  };

  for (const r of regions) {
    if (r.value > 1 || r.members.length > STRUCT_PIT_MAX_SIZE) continue;
    const e = rim(r);
    if (e.count > 0 && e.min > STRUCT_PIT_RIM) mark(r);
  }
  for (const r of regions) {
    if (r.value <= 0 || r.members.length < STRUCT_SLAB_MIN_SIZE) continue;
    const e = rim(r);
    // No minimum rim count: the measured 21,114-px slab of exact-71 off Kona
    // is ringed almost entirely by the deep gouge, which phase one voids — so
    // only a handful of valid samples remain to testify, and they are enough.
    // Flat ground is protected structurally instead: pits (and any sunken
    // divot in high constant ground — c <= 1 with a high rim) are voided
    // first, so a plain's only "low neighbours" stop counting as evidence and
    // e.count reaches 0.
    if (
      e.count > 0 &&
      e.max < r.value - STRUCT_SLAB_DROP &&
      e.mean < r.value - STRUCT_SLAB_MEAN_DROP
    )
      mark(r);
  }
  return added;
}
