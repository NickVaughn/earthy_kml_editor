import { fromFile } from 'geotiff';
import { app } from 'electron';
import { join } from 'node:path';
import type { GeoidGrid } from '@shared/ipc';

let cached: GeoidGrid | null = null;

/** The bundled EGM96 grid: `resources/geoid/` in dev, `resources` beside the app when packaged. */
function gridPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'geoid', 'egm96-15.tif')
    : join(__dirname, '../../resources/geoid/egm96-15.tif');
}

/**
 * Load the bundled EGM96 geoid grid (us_nga_egm96_15.tif from the PROJ CDN).
 * Values are the undulation N in metres, so orthometric MSL = ellipsoidal − N.
 * Parsed once and cached; the ~4 MB grid is handed to the renderer, which
 * samples it live for the coordinate readout and captured vertex heights.
 */
export async function getGeoidGrid(): Promise<GeoidGrid | null> {
  if (cached) return cached;
  try {
    const tiff = await fromFile(gridPath());
    const image = await tiff.getImage();
    const [originLon, originLat] = image.getOrigin();
    const [dLon, dLat] = image.getResolution();
    const rasters = await image.readRasters({ interleave: false });
    const band = rasters[0] as Float32Array | ArrayLike<number>;
    const values = band instanceof Float32Array ? band : Float32Array.from(band);
    cached = {
      width: image.getWidth(),
      height: image.getHeight(),
      originLon,
      originLat,
      dLon,
      dLat,
      values,
    };
    return cached;
  } catch (err) {
    console.error('[earthy] geoid grid load failed:', err);
    return null;
  }
}
