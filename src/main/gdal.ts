import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import type {
  GdalRequest,
  VectorInfo,
  RasterInfo,
  ConvertedLayer,
  ConvertedRaster,
  RasterPlan,
  GdalProgress,
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

export function inspectVector(path: string): Promise<VectorInfo> {
  return request<VectorInfo>({ type: 'inspectVector', path });
}

export function convertVector(path: string, layerName: string): Promise<ConvertedLayer> {
  return request<ConvertedLayer>({ type: 'convertVector', path, layerName });
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

export function shutdownGdal(): void {
  worker?.terminate();
  worker = null;
}
