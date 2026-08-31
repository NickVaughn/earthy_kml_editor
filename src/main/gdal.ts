import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { createHash } from 'node:crypto';
import { stat as fsStat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import type {
  GdalRequest,
  VectorInfo,
  RasterInfo,
  ConvertedLayer,
  ConvertedRaster,
  RasterPlan,
  TiledRaster,
  GdalProgress,
  CsvOptions,
} from '@shared/gdal';

/**
 * Main-process façade over the GDAL worker thread. Spawns the worker lazily,
 * correlates requests/responses by id, and forwards progress to the renderer.
 */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(join(__dirname, 'gdal-worker.js'));
  worker.on('message', (msg: Record<string, unknown>) => {
    const id = msg.id as string;
    if (msg.progress) {
      const p = msg.progress as GdalProgress;
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('gdal-progress', p);
      }
      return;
    }
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(String(msg.error)));
  });
  worker.on('error', (err) => {
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
    worker = null;
  });
  worker.on('exit', () => {
    worker = null;
  });
  return worker;
}

/** Omit that distributes over a union, so each variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function request<T>(req: DistributiveOmit<GdalRequest, 'id'>): Promise<T> {
  const id = `g${++seq}`;
  const w = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...req, id } as GdalRequest);
  });
}

export function inspectVector(path: string, csv?: CsvOptions): Promise<VectorInfo> {
  return request<VectorInfo>({ type: 'inspectVector', path, csv });
}

export function convertVector(
  path: string,
  layerName: string,
  csv?: CsvOptions,
): Promise<ConvertedLayer> {
  return request<ConvertedLayer>({ type: 'convertVector', path, layerName, csv });
}

export function inspectRaster(path: string): Promise<RasterInfo> {
  return request<RasterInfo>({ type: 'inspectRaster', path });
}

export function planRaster(path: string): Promise<RasterPlan> {
  return request<RasterPlan>({ type: 'planRaster', path });
}

export function convertRaster(
  path: string,
  maxDimension?: number,
): Promise<ConvertedRaster> {
  return request<ConvertedRaster>({ type: 'convertRaster', path, maxDimension });
}

/**
 * Build (or reuse) an XYZ tile pyramid for a raster. Tiles are cached under the
 * app's userData directory, keyed by a hash of the file's identity, so
 * re-opening the same raster is instant.
 */
export async function tileRaster(path: string): Promise<TiledRaster> {
  const stat = await fsStat(path);
  const hash = createHash('sha1')
    .update(`${path}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  const cacheDir = join(tilesRoot(), hash);
  return request<TiledRaster>({ type: 'tileRaster', path, hash, cacheDir });
}

/** Reproject downloaded coastline polygons for fast per-tile rasterisation. */
export function prepareCoastline(shpPath: string, outDir: string): Promise<{ path: string }> {
  return request<{ path: string }>({ type: 'prepareCoastline', shpPath, outDir });
}

/** 256x256 land mask (1 = land, 0 = water) for one Web Mercator XYZ tile. */
export function rasterizeMask(
  path: string,
  z: number,
  x: number,
  y: number,
): Promise<{ mask: Uint8Array }> {
  return request<{ mask: Uint8Array }>({ type: 'rasterizeMask', path, z, x, y });
}

/** Total bytes held by the tile cache, and how many pyramids it holds. */
export function tileCacheUsage(): { bytes: number; pyramids: number } {
  const root = tilesRoot();
  if (!existsSync(root)) return { bytes: 0, pyramids: 0 };
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else bytes += statSync(full).size;
    }
  };
  const pyramids = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const p of pyramids) walk(join(root, p.name));
  return { bytes, pyramids: pyramids.length };
}

/**
 * Delete every cached pyramid. Safe once documents have been saved as KMZ,
 * because the archive embeds its tiles and restores them on open.
 */
export function clearTileCache(): void {
  rmSync(tilesRoot(), { recursive: true, force: true });
}

/** Root directory holding every raster's tile pyramid. */
export function tilesRoot(): string {
  return join(app.getPath('userData'), 'tiles');
}

/** Marker on the rejection a cancel produces, so callers can tell it apart. */
export const GDAL_CANCELLED = 'EARTHY_GDAL_CANCELLED';

/**
 * Abort whatever GDAL is doing. A `gdalwarp` call is synchronous inside the
 * WASM runtime and cannot be interrupted cooperatively, so the only reliable
 * stop is to terminate the worker; the next request lazily spawns a fresh one
 * (which also re-loads the WASM, taking a second or two).
 */
export function cancelGdal(): void {
  for (const [, entry] of pending) entry.reject(new Error(GDAL_CANCELLED));
  pending.clear();
  worker?.terminate();
  worker = null;
}

export function shutdownGdal(): void {
  worker?.terminate();
  worker = null;
}
