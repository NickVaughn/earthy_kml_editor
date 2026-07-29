import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let cached: Uint8Array | null = null;

/** The bundled EGM96 grid: `resources/geoid/` in dev, `resources` beside the app when packaged. */
function gridPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'geoid', 'egm96-15.tif')
    : join(__dirname, '../../resources/geoid/egm96-15.tif');
}

/**
 * Return the raw EGM96 geoid GeoTIFF bytes (us_nga_egm96_15.tif, PROJ CDN). The
 * renderer parses + samples them — parsing here would drag geotiff.js (and its
 * ESM-only deps) into the CommonJS main process, which Electron can't require.
 */
export async function getGeoidGrid(): Promise<Uint8Array | null> {
  if (cached) return cached;
  try {
    const buf = await readFile(gridPath());
    cached = new Uint8Array(buf);
    return cached;
  } catch (err) {
    console.error('[earthy] geoid grid read failed:', err);
    return null;
  }
}
