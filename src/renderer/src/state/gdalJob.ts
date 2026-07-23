import { useStore } from './store';

/**
 * Progress + cancellation for GDAL work. The worker already reports progress;
 * this wires it to the status strip and gives the user a way out of a long job.
 */

/** Thrown by {@link withGdalJob} when the user cancelled, so callers can stay
 *  quiet instead of reporting it as a failure. */
export class GdalCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'GdalCancelled';
  }
}

let cancelRequested = false;
let depth = 0;

/** True while a GDAL job is in flight (so progress events are meaningful). */
export function gdalJobActive(): boolean {
  return depth > 0;
}

/**
 * Ask the main process to abort the running job. GDAL's WASM calls are
 * synchronous and can't be interrupted cooperatively, so this terminates the
 * worker; the next request spawns a fresh one.
 */
export async function cancelGdalJob(): Promise<void> {
  if (depth === 0) return;
  cancelRequested = true;
  useStore.getState().setGdalJob({ message: 'Cancelling…', fraction: null });
  await window.api.cancelGdal();
}

/**
 * Run a GDAL call with the progress bar and Cancel button attached. Rejections
 * caused by a cancel are re-thrown as {@link GdalCancelled}.
 */
export async function withGdalJob<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const s = useStore.getState();
  if (depth === 0) cancelRequested = false;
  depth++;
  s.setGdalJob({ message, fraction: null });
  try {
    return await fn();
  } catch (err) {
    if (cancelRequested) throw new GdalCancelled();
    throw err;
  } finally {
    depth--;
    if (depth === 0) {
      cancelRequested = false;
      s.setGdalJob(null);
    }
  }
}
