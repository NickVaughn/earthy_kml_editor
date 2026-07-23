import { describe, it, expect, beforeEach, vi } from 'vitest';

// cancelGdalJob talks to the preload bridge; stub it before importing the module.
const cancelGdal = vi.fn(async () => undefined);
(globalThis as unknown as { window: unknown }).window = { api: { cancelGdal } };

const { withGdalJob, cancelGdalJob, GdalCancelled, gdalJobActive } = await import(
  '@renderer/state/gdalJob'
);
const { useStore } = await import('@renderer/state/store');

describe('GDAL job progress + cancel', () => {
  beforeEach(() => {
    cancelGdal.mockClear();
    useStore.getState().setGdalJob(null);
  });

  it('publishes a job while running and clears it afterwards', async () => {
    expect(useStore.getState().gdalJob).toBeNull();
    const result = await withGdalJob('Working…', async () => {
      expect(useStore.getState().gdalJob?.message).toBe('Working…');
      expect(gdalJobActive()).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(useStore.getState().gdalJob).toBeNull();
    expect(gdalJobActive()).toBe(false);
  });

  it('clears the job and preserves the error when the call fails', async () => {
    await expect(
      withGdalJob('Working…', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(useStore.getState().gdalJob).toBeNull();
  });

  it('reports a cancelled job as GdalCancelled, not a failure', async () => {
    await expect(
      withGdalJob('Working…', async () => {
        // Cancelling terminates the worker, so the in-flight call rejects.
        await cancelGdalJob();
        throw new Error('Worker terminated');
      }),
    ).rejects.toBeInstanceOf(GdalCancelled);
    expect(cancelGdal).toHaveBeenCalledOnce();
    expect(useStore.getState().gdalJob).toBeNull();
  });

  it('does not leak cancellation into the next job', async () => {
    await expect(
      withGdalJob('First…', async () => {
        await cancelGdalJob();
        throw new Error('Worker terminated');
      }),
    ).rejects.toBeInstanceOf(GdalCancelled);

    // A later failure must surface as itself, not as a phantom cancel.
    await expect(
      withGdalJob('Second…', async () => {
        throw new Error('unrelated');
      }),
    ).rejects.toThrow('unrelated');
  });

  it('ignores a cancel request when nothing is running', async () => {
    await cancelGdalJob();
    expect(cancelGdal).not.toHaveBeenCalled();
  });
});
