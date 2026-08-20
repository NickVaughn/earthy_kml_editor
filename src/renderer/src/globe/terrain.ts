/**
 * A minimal Cesium terrain provider that meshes Terrarium raster-DEM tiles on
 * the fly. Each Terrarium PNG encodes elevation in its RGB channels; we decode a
 * tile to a height grid and hand Cesium a HeightmapTerrainData. No Web Worker and
 * no third-party meshing library — Cesium tessellates the regular grid itself.
 *
 * Tiles come as raw PNG bytes over IPC (the main process fetches the remote
 * source, dodging CORS). We decode them with createImageBitmap on a same-origin
 * Blob, so the canvas pixel read-back is never tainted.
 *
 * Two corrections are applied to every decoded sample:
 *
 * 1. **Vertical datum.** Terrarium heights are orthometric — metres above mean
 *    sea level (EGM96) — but Cesium treats terrain heights as ellipsoidal. Left
 *    alone the whole surface sits off by the geoid undulation N: ~19 m too low
 *    over Hawai'i, ~30 m too high over California. We add N per sample, which
 *    puts terrain, `absolute` vector features and the cursor readout on one
 *    datum.
 *
 * 2. **Bathymetry.** These tiles carry sea floor as well as land. Rendering it
 *    means the "ocean" you fly over is the sea bed, and since the source bathy
 *    grid is far coarser than the deepest zoom, each deep tile decodes to a
 *    single constant depth — neighbouring tiles differing by hundreds of metres
 *    turn the sea into a staircase of flat plates. Unless the user asks for the
 *    sea floor we clamp at sea level, so the ocean is a surface (what Google
 *    Earth shows by default). When they do ask for it, water NEVER comes from a
 *    zoom the bathymetry doesn't really have: any sample below sea level in a
 *    tile deeper than BATHY_NATIVE_MAX is re-sampled from that zoom's ancestor
 *    (measured off Kona: z13 is real, smooth NOAA coastal-relief data with 1 m
 *    steps, while z14/15 water is nearest-upsampled constant plates). Land
 *    keeps the requested zoom, so cliffs stay sharp while the water beside
 *    them gets a real slope instead of a plate wall. A wholly-flat tile still
 *    walks to the nearest resolving ancestor — see resolvedSource — which
 *    covers plate zoom levels at or below BATHY_NATIVE_MAX too.
 */
import {
  Cartesian3,
  Cartographic,
  CesiumTerrainProvider,
  Credit,
  Ellipsoid,
  Event as CesiumEvent,
  HeightmapTerrainData,
  Ion,
  IonResource,
  Math as CesiumMath,
  Request,
  TerrainData,
  TerrainProvider,
  TileAvailability,
  TilingScheme,
  WebMercatorTilingScheme,
} from 'cesium';
import {
  terrainSourceById,
  decodeTerrarium,
  repairVoids,
  TILE_SRC,
  type TerrainSourceDesc,
} from '@shared/terrain';
import { geoidHeight } from '@renderer/model/geoid';

/** Height samples per side handed to Cesium; a light regular grid per tile. */
const GRID = 65;

/**
 * How far up to look for a tile with real detail in it. Off Hawai'i the sea
 * floor resolves around z13, so three levels covers it with room to spare;
 * beyond that the source really is flat and the constant value is the answer.
 */
const MAX_ANCESTOR_WALK = 5;
/**
 * Deepest zoom whose WATER is native data rather than nearest-upsampled
 * plates. Samples below sea level in deeper tiles are taken from this zoom's
 * ancestor instead (capped at 0 where the coarse coastline says land).
 */
const BATHY_NATIVE_MAX = 13;
/** Decoded source tiles, so an ancestor shared by many children decodes once. */
const SOURCE_CACHE_MAX = 192;

/** A decoded source tile: orthometric metres, plus whether it has any relief. */
interface SourceTile {
  /** TILE_SRC x TILE_SRC, row-major, north row first. */
  heights: Float32Array;
  /** True when every pixel is identical — the source has no data at this zoom. */
  flat: boolean;
  /** Lowest sample; below 0 means the tile holds water (or garbage). */
  min: number;
  /**
   * Where repairVoids filled garbage, or null if it found none. The in-tile
   * fill is a guess (its anchors can all sit on the wrong side of a coast), so
   * these samples are overlaid with ancestor data when any is available.
   */
  voids: Uint8Array | null;
}

const sourceCache = new Map<string, SourceTile>();

/**
 * Bilinear sample of a source tile at normalised (u, v), both in [0, 1] across
 * the tile, v measured from the north edge. Pixel centres sit at (i + 0.5)/N,
 * hence the half-pixel shift; edges clamp.
 */
function sampleSource(tile: SourceTile, u: number, v: number): number {
  const fx = Math.min(Math.max(u * TILE_SRC - 0.5, 0), TILE_SRC - 1);
  const fy = Math.min(Math.max(v * TILE_SRC - 0.5, 0), TILE_SRC - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, TILE_SRC - 1);
  const y1 = Math.min(y0 + 1, TILE_SRC - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const h = tile.heights;
  const top = h[y0 * TILE_SRC + x0] + (h[y0 * TILE_SRC + x1] - h[y0 * TILE_SRC + x0]) * tx;
  const bot = h[y1 * TILE_SRC + x0] + (h[y1 * TILE_SRC + x1] - h[y1 * TILE_SRC + x0]) * tx;
  return top + (bot - top) * ty;
}

// Log the first success, the first failure and the first repaired tile, so
// DevTools shows what is happening without spamming a line per tile.
let loggedOk = false;
let loggedErr = false;
let loggedVoid = false;

// One reusable canvas for pixel read-back (renderer is single-threaded).
let scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
function scratchCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (!scratch) {
    const canvas = document.createElement('canvas');
    canvas.width = TILE_SRC;
    canvas.height = TILE_SRC;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable for terrain decode');
    scratch = { canvas, ctx };
  }
  return scratch;
}

export interface TerrariumTerrainOptions {
  /** Terrain source id; tiles are fetched via window.api.fetchTerrainTile. */
  sourceId: string;
  maxZoom: number;
  credit: string;
  ellipsoid?: Ellipsoid;
  /** Render the source's sea floor instead of clamping the ocean at sea level. */
  showBathymetry?: boolean;
}

export class TerrariumTerrainProvider implements TerrainProvider {
  readonly errorEvent = new CesiumEvent<TerrainProvider.ErrorEvent>();
  readonly credit: Credit;
  readonly tilingScheme: TilingScheme;
  readonly hasWaterMask = false;
  readonly hasVertexNormals = false;
  readonly availability: TileAvailability | undefined = undefined;

  private readonly _sourceId: string;
  private readonly _maxZoom: number;
  private readonly _levelZeroError: number;
  private readonly _showBathymetry: boolean;

  constructor(opts: TerrariumTerrainOptions) {
    const ellipsoid = opts.ellipsoid ?? Ellipsoid.WGS84;
    this._sourceId = opts.sourceId;
    this._maxZoom = opts.maxZoom;
    this._showBathymetry = opts.showBathymetry ?? false;
    this.credit = new Credit(opts.credit);
    this.tilingScheme = new WebMercatorTilingScheme({ ellipsoid });
    this._levelZeroError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      ellipsoid,
      GRID,
      this.tilingScheme.getNumberOfXTilesAtLevel(0),
    );
  }

  getLevelMaximumGeometricError(level: number): number {
    return this._levelZeroError / (1 << level);
  }

  getTileDataAvailable(_x: number, _y: number, level: number): boolean {
    return level <= this._maxZoom;
  }

  loadTileDataAvailability(): undefined {
    return undefined;
  }

  requestTileGeometry(
    x: number,
    y: number,
    level: number,
    _request?: Request,
  ): Promise<TerrainData> | undefined {
    return this.loadTile(x, y, level);
  }

  /** Fetch and decode one source tile, memoised. Throws if the tile is missing. */
  private async sourceTile(x: number, y: number, level: number): Promise<SourceTile> {
    const key = `${this._sourceId}/${level}/${x}/${y}`;
    const hit = sourceCache.get(key);
    if (hit) return hit;

    let bitmap: ImageBitmap;
    try {
      const bytes = await window.api.fetchTerrainTile(this._sourceId, level, x, y);
      if (!bytes) throw new Error('no tile bytes');
      // Main returns a fresh, zero-offset Uint8Array, so its buffer is exactly
      // the PNG bytes — hand the ArrayBuffer straight to Blob (no copy).
      bitmap = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' }));
    } catch (err) {
      if (!loggedErr) {
        loggedErr = true;
        console.error(`[earthy] terrain tile ${level}/${x}/${y} failed:`, err);
      }
      throw err;
    }

    let tile: SourceTile;
    try {
      const { ctx } = scratchCanvas();
      ctx.clearRect(0, 0, TILE_SRC, TILE_SRC);
      ctx.drawImage(bitmap, 0, 0, TILE_SRC, TILE_SRC);
      const { data } = ctx.getImageData(0, 0, TILE_SRC, TILE_SRC);
      const heights = new Float32Array(TILE_SRC * TILE_SRC);
      for (let i = 0; i < heights.length; i++) {
        const p = i * 4;
        heights[i] = decodeTerrarium(data[p], data[p + 1], data[p + 2]);
      }
      // Before anything else looks at the data: a single void sample drags its
      // whole triangle fan 32 km down (see repairVoids).
      const mask = new Uint8Array(heights.length);
      const repaired = repairVoids(heights, TILE_SRC, mask);
      if (repaired > 0 && !loggedVoid) {
        loggedVoid = true;
        console.info(
          `[earthy] terrain: repaired ${repaired} void samples in tile ${level}/${x}/${y}` +
            ' (logged once; other tiles may need it too)',
        );
      }
      let flat = true;
      let min = Infinity;
      for (let i = 0; i < heights.length; i++) {
        if (heights[i] !== heights[0]) flat = false;
        if (heights[i] < min) min = heights[i];
      }
      tile = { heights, flat, min, voids: repaired > 0 ? mask : null };
    } finally {
      bitmap.close();
    }

    // Plain insertion-order eviction; the working set is whatever the camera
    // is over, so the oldest entry is reliably the least interesting one.
    if (sourceCache.size >= SOURCE_CACHE_MAX) {
      const oldest = sourceCache.keys().next().value;
      if (oldest !== undefined) sourceCache.delete(oldest);
    }
    sourceCache.set(key, tile);
    return tile;
  }

  /**
   * The source tile to mesh this tile from, and where this tile sits inside it.
   *
   * Normally that is the tile itself. But the sea floor is far coarser than the
   * deepest zoom: off Kona every z15 ocean tile decodes to one constant depth,
   * with neighbours hundreds of metres apart, so the sea renders as a staircase
   * of flat tile-sized plates. When a tile comes back flat we walk up to the
   * nearest ancestor that isn't and sample its sub-window instead — neighbours
   * then interpolate across the same data and meet, giving a slope rather than
   * a step. It also cuts fetches: one z12 ancestor serves 256 z15 tiles.
   */
  private async resolvedSource(
    x: number,
    y: number,
    level: number,
  ): Promise<{ tile: SourceTile; u0: number; v0: number; span: number }> {
    const tile = await this.sourceTile(x, y, level);
    // A flat NEGATIVE plate is harmless with the sea clamped at 0, but a flat
    // POSITIVE one would render as land standing in the ocean — walk those to
    // a resolving ancestor regardless of the bathymetry setting.
    const walkable = tile.flat && (this._showBathymetry || tile.heights[0] > 0);
    if (!walkable) return { tile, u0: 0, v0: 0, span: 1 };

    for (let up = 1; up <= MAX_ANCESTOR_WALK && level - up >= 0; up++) {
      let ancestor: SourceTile;
      try {
        ancestor = await this.sourceTile(x >> up, y >> up, level - up);
      } catch {
        break; // ancestor missing: the flat tile we have is the best available
      }
      if (!ancestor.flat) {
        const span = 1 / (1 << up); // this tile's share of the ancestor
        return {
          tile: ancestor,
          u0: (x - ((x >> up) << up)) * span,
          v0: (y - ((y >> up) << up)) * span,
          span,
        };
      }
    }
    // Flat all the way up — an abyssal plain. Keep this tile's own constant
    // rather than an ancestor's, which may average to a different depth.
    return { tile, u0: 0, v0: 0, span: 1 };
  }

  /**
   * The window of the BATHY_NATIVE_MAX-level ancestor covering this tile, for
   * water samples — walking further up if that ancestor is itself flat. Null
   * when unavailable; callers then keep the fine (plate) samples.
   */
  private async bathySource(
    x: number,
    y: number,
    level: number,
  ): Promise<{ tile: SourceTile; u0: number; v0: number; span: number } | null> {
    for (let up = level - BATHY_NATIVE_MAX; up <= level && level - up >= 0; up++) {
      let anc: SourceTile;
      try {
        anc = await this.sourceTile(x >> up, y >> up, level - up);
      } catch {
        return null;
      }
      if (!anc.flat) {
        const span = 1 / (1 << up);
        return {
          tile: anc,
          u0: (x - ((x >> up) << up)) * span,
          v0: (y - ((y >> up) << up)) * span,
          span,
        };
      }
    }
    return null;
  }

  private async loadTile(x: number, y: number, level: number): Promise<TerrainData> {
    const src = await this.resolvedSource(x, y, level);
    // The coastline's word beats the DEM's: where downloaded GSHHG polygons say
    // water, positive DEM heights are garbage (bay-fill, land smear) and are
    // held at or below sea level. Null until the user downloads the data.
    const water = await window.api.getWaterMask(level, x, y).catch(() => null);
    // Fetch the resolving ancestor when either use exists: water above the
    // bathymetry's native zoom is plates (only matters with the sea floor
    // shown — clamping kills every negative sample anyway), and repaired void
    // samples are overlaid with ancestor data whatever the setting, because
    // the in-tile fill cannot know which side of the coastline it is on.
    const wantsBathy = this._showBathymetry && src.tile.min < 0;
    const bathy =
      level > BATHY_NATIVE_MAX && (wantsBathy || src.tile.voids)
        ? await this.bathySource(x, y, level)
        : null;
    const terrain = this.toTerrain(src, bathy, water, x, y, level);
    if (!loggedOk) {
      loggedOk = true;
      console.info('[earthy] terrain: first tile decoded OK');
    }
    return terrain;
  }

  /**
   * Geographic position of each node of this tile's GRID x GRID height grid.
   *
   * The samples are evenly spaced in the tiling scheme's native (Web Mercator)
   * coordinates, not in latitude — so longitudes come straight off the
   * geographic rectangle, but latitudes have to be unprojected from evenly
   * spaced mercator northings. Only needed to look the geoid up, which varies
   * slowly, but it costs one unproject per row so it may as well be exact.
   */
  private tileGraticule(x: number, y: number, level: number): { lons: Float64Array; lats: Float64Array } {
    const step = GRID - 1;
    const geo = this.tilingScheme.tileXYToRectangle(x, y, level);
    const native = this.tilingScheme.tileXYToNativeRectangle(x, y, level);
    const lons = new Float64Array(GRID);
    for (let i = 0; i < GRID; i++) {
      lons[i] = CesiumMath.toDegrees(geo.west + ((geo.east - geo.west) * i) / step);
    }
    const lats = new Float64Array(GRID);
    const scratchPoint = new Cartesian3(native.west, 0, 0);
    const scratchCarto = new Cartographic();
    for (let j = 0; j < GRID; j++) {
      // Row 0 is the north edge, matching the PNG's top row.
      scratchPoint.y = native.north - ((native.north - native.south) * j) / step;
      lats[j] = CesiumMath.toDegrees(
        this.tilingScheme.projection.unproject(scratchPoint, scratchCarto).latitude,
      );
    }
    return { lons, lats };
  }

  private toTerrain(
    src: { tile: SourceTile; u0: number; v0: number; span: number },
    bathy: { tile: SourceTile; u0: number; v0: number; span: number } | null,
    water: Uint8Array | null,
    x: number,
    y: number,
    level: number,
  ): TerrainData {
    const { lons, lats } = this.tileGraticule(x, y, level);
    const heights = new Int16Array(GRID * GRID);
    const step = GRID - 1;
    for (let j = 0; j < GRID; j++) {
      const v = src.v0 + (src.span * j) / step;
      const vb = bathy ? bathy.v0 + (bathy.span * j) / step : 0;
      const lat = lats[j];
      for (let i = 0; i < GRID; i++) {
        const u = src.u0 + (src.span * i) / step;
        // Orthometric (EGM96) metres, as the source encodes them. Sampled
        // bilinearly: the 65-node grid is a quarter of the source's resolution,
        // so averaging beats dropping three pixels in four.
        let h = sampleSource(src.tile, u, v);
        if (bathy) {
          const voided =
            src.tile.voids !== null &&
            src.tile.voids[
              Math.min(TILE_SRC - 1, Math.round(v * TILE_SRC - 0.5)) * TILE_SRC +
                Math.min(TILE_SRC - 1, Math.round(u * TILE_SRC - 0.5))
            ] === 1;
          if (voided) {
            // A repaired void: the fill was a guess, the ancestor is data —
            // take it whole, land or water.
            h = sampleSource(bathy.tile, bathy.u0 + (bathy.span * i) / step, vb);
          } else if (h < 0) {
            // Water from the zoom that resolves it. Capped at 0: where the
            // coarse coastline says land and the fine one says water, split at
            // sea level rather than hoisting coarse land into the fine sea.
            h = Math.min(sampleSource(bathy.tile, bathy.u0 + (bathy.span * i) / step, vb), 0);
          }
        }
        // Where the coastline mask says water, the DEM cannot claim land: cap
        // at sea level, keeping real (negative) bathymetry underneath. The
        // mask is in THIS tile's own frame, not the resolved source window.
        if (water) {
          const mi =
            Math.min(TILE_SRC - 1, Math.round((j / step) * TILE_SRC - 0.5)) * TILE_SRC +
            Math.min(TILE_SRC - 1, Math.round((i / step) * TILE_SRC - 0.5));
          if (water[mi] === 0) h = Math.min(h, 0);
        }
        // Clamp the sea floor away while still in the MSL datum, so "0" here
        // really is sea level rather than the ellipsoid.
        if (!this._showBathymetry && h < 0) h = 0;
        // Orthometric -> ellipsoidal, the datum Cesium positions terrain in.
        // Null until the geoid grid has parsed; 0 then leaves it as it was.
        h += geoidHeight(lons[i], lat) ?? 0;
        // Whole-metre precision is plenty for terrain relief and keeps the grid
        // in an Int16, which the heightmap structure reads as metres directly.
        heights[j * GRID + i] = Math.max(-32768, Math.min(32767, Math.round(h)));
      }
    }

    const data = new HeightmapTerrainData({
      buffer: heights,
      width: GRID,
      height: GRID,
      structure: { heightScale: 1, heightOffset: 0 },
    });
    // Longer tile skirts than Cesium's default (~level error x4: 19 m at z15,
    // 38 m at z14). This source's zoom levels genuinely disagree — off Kona a
    // bay reads +94 m at z14 and a -55 m water plate at z15 — and a step
    // taller than the skirt shows as a hole straight through to the skybox at
    // LOD boundaries. A skirt is cheap wall geometry; 150 m covers every
    // disagreement measured. Cesium computes `_skirtHeight` privately inside
    // createMesh (verified against @cesium/engine 1.143), so pin the property.
    const skirt = Math.max(150, (this._levelZeroError / (1 << level)) * 4);
    Object.defineProperty(data, '_skirtHeight', {
      configurable: true,
      get: () => skirt,
      set: () => {},
    });
    return data;
  }
}

/** What terrainProviderFor resolved, plus anything the user should be told. */
export interface TerrainBuild {
  provider: TerrainProvider | null;
  /** A degradation worth flashing (e.g. bathymetry asset missing from ion). */
  note?: string;
}

async function ionProvider(
  assetId: number,
  token: string,
  waterMask: boolean,
  credit: string,
): Promise<TerrainProvider> {
  // Scope the token to this request rather than mutating Ion.defaultAccessToken:
  // nothing else in the app talks to ion, and a global default would silently
  // authorise future accidental ion use.
  void Ion; // (kept imported for discoverability of the global alternative)
  const resource = await IonResource.fromAssetId(assetId, { accessToken: token });
  return CesiumTerrainProvider.fromUrl(resource, {
    // The water mask is the point of the land asset: the coastline comes from
    // the source instead of DEM guesswork, and the sea renders as sea. Showing
    // the sea FLOOR, waves painted over it would be a lie.
    requestWaterMask: waterMask,
    requestVertexNormals: false,
    credit,
  });
}

/**
 * Build a terrain provider for a source id. `provider` is null when the id is
 * unknown or its key is missing. Async because Cesium's ion provider
 * bootstraps over the network (layer.json + token exchange).
 */
export async function terrainProviderFor(
  id: string,
  opts?: { showBathymetry?: boolean },
): Promise<TerrainBuild> {
  const desc: TerrainSourceDesc | undefined = terrainSourceById(id);
  if (!desc) return { provider: null };
  if (desc.encoding === 'ion') {
    const token = await window.api.getIonToken();
    if (!token) return { provider: null };
    const wantBathy = opts?.showBathymetry === true && desc.bathymetryAssetId !== undefined;
    if (wantBathy) {
      try {
        return {
          provider: await ionProvider(
            desc.bathymetryAssetId as number,
            token,
            false,
            desc.attribution,
          ),
        };
      } catch (err) {
        // Depot assets (Cesium World Bathymetry) 404 until the user adds them
        // to their ion account. Falling back to the land asset keeps terrain
        // on screen; a flat ellipsoid would read as everything being broken.
        const why = err instanceof Error ? err.message : String(err);
        return {
          provider: await ionProvider(desc.ionAssetId, token, true, desc.attribution),
          note:
            'Sea-floor terrain is not available on this ion account — add ' +
            '“Cesium World Bathymetry” in ion’s Asset Depot. Showing land terrain. ' +
            `(${why})`,
        };
      }
    }
    return { provider: await ionProvider(desc.ionAssetId, token, true, desc.attribution) };
  }
  return {
    provider: new TerrariumTerrainProvider({
      sourceId: desc.id,
      maxZoom: desc.maxZoom,
      credit: desc.attribution,
      showBathymetry: opts?.showBathymetry,
    }),
  };
}
