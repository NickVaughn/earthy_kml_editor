import { dirname, join, relative } from 'node:path';

/**
 * Loading gdal3.js, and the one place it disagrees with Windows. Split out of
 * the worker so it can be tested without one.
 */

type AnyGdal = any;

/**
 * gdal3.js finds a file's folder by splitting its path on '/', so a Windows
 * path — all backslashes — reads as one long file name in no folder and GDAL
 * can't open it. Forward slashes work on every platform.
 */
export function gdalPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export async function initGdal(errorHandler: (text: string) => void): Promise<AnyGdal> {
  // gdal3.js resolves its asset `path` relative to cwd (it prefixes './'),
  // so we must hand it a RELATIVE path to dist/package. On Windows that only
  // exists on the same drive; main/index.ts makes sure cwd is on it.
  const pkgJson = require.resolve('gdal3.js/package.json');
  const distDir = join(dirname(pkgJson), 'dist', 'package');
  const rel = relative(process.cwd(), distDir) || '.';
  const initGdalJs = require('gdal3.js/node');
  const gdal = await initGdalJs({ path: rel, errorHandler });
  // Every disk path reaches GDAL through open(); fix them all there.
  const open = gdal.open;
  gdal.open = (files: string | string[], ...rest: unknown[]) =>
    open(Array.isArray(files) ? files.map(gdalPath) : gdalPath(files), ...rest);
  return gdal;
}
