import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import { sampleGrid } from '../src/renderer/src/model/geoid';
import type { GeoidGrid } from '../src/shared/ipc';

const gridFile = fileURLToPath(new URL('../resources/geoid/egm96-15.tif', import.meta.url));

async function loadGrid(): Promise<GeoidGrid> {
  const tiff = await fromFile(gridFile);
  const image = await tiff.getImage();
  const [originLon, originLat] = image.getOrigin();
  const [dLon, dLat] = image.getResolution();
  const rasters = await image.readRasters({ interleave: false });
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    originLon,
    originLat,
    dLon,
    dLat,
    values: rasters[0] as Float32Array,
  };
}

describe('EGM96 geoid sampling', () => {
  let g: GeoidGrid;
  beforeAll(async () => {
    g = await loadGrid();
  });

  it('parses the expected grid geometry', () => {
    expect(g.width).toBe(1440);
    expect(g.height).toBe(721);
    expect(g.originLon).toBe(-180);
    expect(g.originLat).toBe(90);
  });

  it('reproduces the raw value at an exact node', () => {
    // node (col 720, row 180) = lon -180 + 720*0.25 = 0, lat 90 + 180*(-0.25) = 45
    const raw = g.values[180 * g.width + 720];
    expect(sampleGrid(g, 0, 45)).toBeCloseTo(raw, 4);
  });

  it('gives a plausible undulation at 0,0 (EGM96 ~ +17 m)', () => {
    const n = sampleGrid(g, 0, 0);
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(25);
  });

  it('stays within the global envelope everywhere, including the seam and poles', () => {
    const samples: [number, number][] = [
      [-122.3, 47.6],
      [139.7, 35.7],
      [-58.4, -34.6],
      [179.99, 0],
      [-179.99, 0],
      [0, 89.9],
      [0, -89.9],
    ];
    for (const [lon, lat] of samples) {
      const n = sampleGrid(g, lon, lat);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(-110);
      expect(n).toBeLessThan(90);
    }
  });

  it('interpolates between neighbouring nodes (value lies between them)', () => {
    const i = 180 * g.width + 720;
    const a = g.values[i];
    const b = g.values[i + 1];
    const mid = sampleGrid(g, 0.125, 45); // halfway to the next lon node (0.25 step)
    expect(mid).toBeGreaterThanOrEqual(Math.min(a, b) - 1e-4);
    expect(mid).toBeLessThanOrEqual(Math.max(a, b) + 1e-4);
  });
});
