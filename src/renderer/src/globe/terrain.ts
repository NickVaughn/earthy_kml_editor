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
 *    Earth shows by default).
 */
import {
  Cartesian3,
  Cartographic,
  Credit,
  Ellipsoid,
  Event as CesiumEvent,
  HeightmapTerrainData,
  Math as CesiumMath,
  Request,
  TerrainData,
  TerrainProvider,
  TileAvailability,
  TilingScheme,
  WebMercatorTilingScheme,
} from 'cesium';
import { terrainSourceById, type TerrainSourceDesc } from '@shared/terrain';
import { geoidHeight } from '@renderer/model/geoid';

/** Terrarium source tiles are 256×256. */
const TILE_SRC = 256;
/** Height samples per side handed to Cesium; a light regular grid per tile. */
const GRID = 65;

/** Terrarium RGB → metres. */
function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

// Log the first success and the first failure, so DevTools shows whether terrain
// tiles are actually loading without spamming a line per tile.
let loggedOk = false;
let loggedErr = false;

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

  private async loadTile(x: number, y: number, level: number): Promise<TerrainData> {
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
    try {
      const terrain = this.toTerrain(bitmap, x, y, level);
      if (!loggedOk) {
        loggedOk = true;
        console.info('[earthy] terrain: first tile decoded OK');
      }
      return terrain;
    } finally {
      bitmap.close();
    }
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

  private toTerrain(image: ImageBitmap, x: number, y: number, level: number): TerrainData {
    const { ctx } = scratchCanvas();
    ctx.clearRect(0, 0, TILE_SRC, TILE_SRC);
    ctx.drawImage(image, 0, 0, TILE_SRC, TILE_SRC);
    const { data } = ctx.getImageData(0, 0, TILE_SRC, TILE_SRC);

    const { lons, lats } = this.tileGraticule(x, y, level);
    const heights = new Int16Array(GRID * GRID);
    const span = TILE_SRC - 1;
    const step = GRID - 1;
    for (let j = 0; j < GRID; j++) {
      const sy = Math.round((j * span) / step);
      const lat = lats[j];
      for (let i = 0; i < GRID; i++) {
        const sx = Math.round((i * span) / step);
        const p = (sy * TILE_SRC + sx) * 4;
        // Orthometric (EGM96) metres, as the source encodes them.
        let h = decodeTerrarium(data[p], data[p + 1], data[p + 2]);
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

    return new HeightmapTerrainData({
      buffer: heights,
      width: GRID,
      height: GRID,
      structure: { heightScale: 1, heightOffset: 0 },
    });
  }
}

/** Build a terrain provider for a source id, or null if the id is unknown. */
export function terrainProviderFor(
  id: string,
  opts?: { showBathymetry?: boolean },
): TerrariumTerrainProvider | null {
  const desc: TerrainSourceDesc | undefined = terrainSourceById(id);
  if (!desc) return null;
  return new TerrariumTerrainProvider({
    sourceId: desc.id,
    maxZoom: desc.maxZoom,
    credit: desc.attribution,
    showBathymetry: opts?.showBathymetry,
  });
}
