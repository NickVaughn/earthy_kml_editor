import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gdalPath, initGdal } from '../src/main/gdal-load';

const here = dirname(fileURLToPath(import.meta.url));

describe('GDAL file paths', () => {
  it('turns Windows separators into forward slashes', () => {
    expect(gdalPath('C:\\data\\parcels.shp')).toBe('C:/data/parcels.shp');
    expect(gdalPath('/Users/me/parcels.shp')).toBe('/Users/me/parcels.shp');
  });

  // join() gives backslashes on Windows: the path shape that broke every
  // import there. Only a Windows run (CI) actually exercises the fix.
  it('opens a file by its absolute native path', async () => {
    const Gdal = await initGdal(() => undefined);
    const opened = await Gdal.open(join(here, 'fixtures', 'vector', 'parcels.shp'));
    expect(opened.datasets).toHaveLength(1);
    await Gdal.close(opened.datasets[0]);
  }, 60_000);
});
