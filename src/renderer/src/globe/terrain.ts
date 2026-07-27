/**
 * A minimal Cesium terrain provider that meshes Terrarium raster-DEM tiles on
 * the fly. Each Terrarium PNG encodes elevation in its RGB channels; we decode a
 * tile to a height grid and hand Cesium a HeightmapTerrainData. No Web Worker and
 * no third-party meshing library — Cesium tessellates the regular grid itself.
 *
 * Tiles come as raw PNG bytes over IPC (the main process fetches the remote
 * source, dodging CORS). We decode them with createImageBitmap on a same-origin
 * Blob, so the canvas pixel read-back is never tainted.
 */
import {
  Credit,
  Ellipsoid,
  Event as CesiumEvent,
  HeightmapTerrainData,
  Request,
  TerrainData,
  TerrainProvider,
  TileAvailability,
  TilingScheme,
  WebMercatorTilingScheme,
} from 'cesium';
import { terrainSourceById, type TerrainSourceDesc } from '@shared/terrain';

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

  constructor(opts: TerrariumTerrainOptions) {
    const ellipsoid = opts.ellipsoid ?? Ellipsoid.WGS84;
    this._sourceId = opts.sourceId;
    this._maxZoom = opts.maxZoom;
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
      const terrain = this.toTerrain(bitmap);
      if (!loggedOk) {
        loggedOk = true;
        console.info('[earthy] terrain: first tile decoded OK');
      }
      return terrain;
    } finally {
      bitmap.close();
    }
  }

  private toTerrain(image: ImageBitmap): TerrainData {
    const { ctx } = scratchCanvas();
    ctx.clearRect(0, 0, TILE_SRC, TILE_SRC);
    ctx.drawImage(image, 0, 0, TILE_SRC, TILE_SRC);
    const { data } = ctx.getImageData(0, 0, TILE_SRC, TILE_SRC);

    const heights = new Int16Array(GRID * GRID);
    const span = TILE_SRC - 1;
    const step = GRID - 1;
    for (let j = 0; j < GRID; j++) {
      const sy = Math.round((j * span) / step);
      for (let i = 0; i < GRID; i++) {
        const sx = Math.round((i * span) / step);
        const p = (sy * TILE_SRC + sx) * 4;
        const h = decodeTerrarium(data[p], data[p + 1], data[p + 2]);
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
export function terrainProviderFor(id: string): TerrariumTerrainProvider | null {
  const desc: TerrainSourceDesc | undefined = terrainSourceById(id);
  if (!desc) return null;
  return new TerrariumTerrainProvider({
    sourceId: desc.id,
    maxZoom: desc.maxZoom,
    credit: desc.attribution,
  });
}
