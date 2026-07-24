import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { tileBounds, readPyramid, tileKml, rootKml } from '../src/main/superoverlay';
import { readGeoFile, writeGeoFile } from '../src/main/kmz';

/** A 1×1 PNG standing in for a tile image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let root: string;
let tilesDir: string;
const HASH = 'abcdef0123456789';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'earthy-so-test-'));
  tilesDir = join(root, 'tiles');
  // A tiny two-level pyramid: one tile at z1 with two children at z2.
  for (const [z, x, y] of [
    [1, 0, 0],
    [2, 0, 0],
    [2, 1, 1],
  ] as [number, number, number][]) {
    const dir = join(tilesDir, HASH, String(z), String(x));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${y}.png`), PNG);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('tile geography', () => {
  it('maps XYZ tiles to their geographic bounds', () => {
    const world = tileBounds(0, 0, 0);
    expect(world.west).toBe(-180);
    expect(world.east).toBe(180);
    expect(world.north).toBeCloseTo(85.051, 2); // Web Mercator's latitude limit
    expect(world.south).toBeCloseTo(-85.051, 2);

    // Level 1 splits the world into quadrants; the NW tile is the top-left one.
    const nw = tileBounds(1, 0, 0);
    expect(nw.west).toBe(-180);
    expect(nw.east).toBe(0);
    expect(nw.north).toBeCloseTo(85.051, 2);
    expect(nw.south).toBe(0);
  });
});

describe('super-overlay generation', () => {
  it('reads a pyramid off disk', () => {
    const { tiles, minZoom, maxZoom } = readPyramid(join(tilesDir, HASH));
    expect(tiles.size).toBe(3);
    expect(minZoom).toBe(1);
    expect(maxZoom).toBe(2);
  });

  it('links a tile to the children that actually exist', () => {
    const { tiles, maxZoom } = readPyramid(join(tilesDir, HASH));
    const kml = tileKml(1, 0, 0, tiles, maxZoom);

    expect(kml).toContain('<GroundOverlay>');
    expect(kml).toContain('<href>0.png</href>'); // sits beside its own KML
    // Only 2/0/0 exists under 1/0/0 — the other three quadrants must not be linked.
    expect(kml).toContain('../../2/0/0.kml');
    expect(kml).not.toContain('2/0/1.kml');
    expect(kml).not.toContain('2/1/0.kml');
    expect(kml).toContain('<viewRefreshMode>onRegion</viewRefreshMode>');
    // Having children, it retires at a finite level of detail.
    expect(kml).toContain('<maxLodPixels>2048</maxLodPixels>');
  });

  it('lets a leaf tile stay visible at any zoom', () => {
    const { tiles, maxZoom } = readPyramid(join(tilesDir, HASH));
    const leaf = tileKml(2, 0, 0, tiles, maxZoom);
    expect(leaf).toContain('<maxLodPixels>-1</maxLodPixels>');
    expect(leaf).not.toContain('<NetworkLink>');
  });

  it('roots the hierarchy at the shallowest zoom', () => {
    const { tiles, minZoom } = readPyramid(join(tilesDir, HASH));
    const kml = rootKml('My raster', tiles, minZoom);
    expect(kml).toContain('<name>My raster</name>');
    expect(kml).toContain('<href>1/0/0.kml</href>');
    expect(kml).not.toContain('2/0/0.kml'); // reached through its parent
  });
});

describe('KMZ portability', () => {
  const kml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Doc</name>' +
    '<NetworkLink><name>Raster</name><Link><href>tiles/' +
    HASH +
    '/doc.kml</href></Link></NetworkLink></Document></kml>';

  it('embeds the pyramid as a super-overlay, with every link resolvable', async () => {
    const out = join(root, 'out.kmz');
    await writeGeoFile(out, kml, true, {}, [{ hash: HASH, name: 'Raster' }], tilesDir);

    const zip = await JSZip.loadAsync(readFileSync(out));
    const names = Object.keys(zip.files);
    expect(names).toContain('doc.kml');
    expect(names).toContain(`tiles/${HASH}/doc.kml`);
    // Every tile contributes both its image and its KML.
    for (const t of ['1/0/0', '2/0/0', '2/1/1']) {
      expect(names).toContain(`tiles/${HASH}/${t}.png`);
      expect(names).toContain(`tiles/${HASH}/${t}.kml`);
    }

    // Follow the hrefs the way Google Earth would, and check they all exist.
    const rootDoc = await zip.files[`tiles/${HASH}/doc.kml`].async('text');
    for (const href of [...rootDoc.matchAll(/<href>([^<]+)<\/href>/g)].map((m) => m[1])) {
      expect(names).toContain(`tiles/${HASH}/${href}`);
    }
    const child = await zip.files[`tiles/${HASH}/1/0/0.kml`].async('text');
    expect(names).toContain(`tiles/${HASH}/1/0/0.png`); // <href>0.png</href>
    expect(child).toContain('../../2/0/0.kml'); // resolves to tiles/<hash>/2/0/0.kml
  });

  it('restores an embedded pyramid into an empty cache on open', async () => {
    const out = join(root, 'restore.kmz');
    await writeGeoFile(out, kml, true, {}, [{ hash: HASH, name: 'Raster' }], tilesDir);

    const freshCache = join(root, 'cache-restore');
    const opened = await readGeoFile(out, freshCache);

    expect(existsSync(join(freshCache, HASH, '1', '0', '0.png'))).toBe(true);
    expect(existsSync(join(freshCache, HASH, '2', '1', '1.png'))).toBe(true);
    // Tiles must never become data-URL resources — there can be tens of thousands.
    expect(Object.keys(opened.resources)).toHaveLength(0);
    expect(opened.kml).toContain('NetworkLink');
  });
});
