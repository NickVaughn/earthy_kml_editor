import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { embedIcons, unembedIcons } from './icons';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import JSZip from 'jszip';
import type { OpenedFile } from '@shared/ipc';
import { readPyramid, tileKml, rootKml } from './superoverlay';

/** Archive prefix holding embedded tile pyramids. */
export const TILES_PREFIX = 'tiles/';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  dae: 'model/vnd.collada+xml',
};

function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Write one embedded tile back into the local pyramid cache. */
async function restoreTile(
  zip: JSZip,
  name: string,
  tilesDir: string,
): Promise<void> {
  if (!name.endsWith('.png')) return; // the super-overlay KMLs are regenerated
  const target = join(tilesDir, name.slice(TILES_PREFIX.length));
  if (existsSync(target)) return; // already cached
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await zip.files[name].async('nodebuffer'));
}

/**
 * Read a .kml or .kmz file into an OpenedFile (kml text + resources as data
 * URLs). `tilesDir` is the tile-cache root; any pyramid embedded in the archive
 * is restored there so a document saved elsewhere still renders here.
 */
export async function readGeoFile(path: string, tilesDir = ''): Promise<OpenedFile> {
  const lower = path.toLowerCase();
  if (lower.endsWith('.kmz')) {
    const buf = await readFile(path);
    const zip = await JSZip.loadAsync(buf);
    // Find the main KML: prefer doc.kml, else the first root-level .kml.
    const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    let kmlName =
      entries.find((n) => n.toLowerCase() === 'doc.kml') ??
      entries.find((n) => n.toLowerCase().endsWith('.kml') && !n.includes('/')) ??
      entries.find((n) => n.toLowerCase().endsWith('.kml'));
    if (!kmlName) throw new Error('KMZ contains no .kml file');
    // Relative icon paths mean nothing once the KML leaves the archive; point
    // them back at the catalog's remote href.
    const kml = unembedIcons(await zip.files[kmlName].async('text'));

    const resources: Record<string, string> = {};
    for (const name of entries) {
      if (name === kmlName) continue;
      // Embedded tile pyramids go straight back to the on-disk cache. There can
      // be tens of thousands of them, so they must never become data URLs.
      if (name.startsWith(TILES_PREFIX)) {
        await restoreTile(zip, name, tilesDir);
        continue;
      }
      const data = await zip.files[name].async('base64');
      resources[name] = `data:${mimeFor(name)};base64,${data}`;
    }
    return { path, kml, resources, wasKmz: true };
  }

  const kml = await readFile(path, 'utf-8');
  return { path, kml, resources: {}, wasKmz: false };
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma); // strip "data:"
  const body = dataUrl.slice(comma + 1);
  if (meta.includes(';base64')) return Buffer.from(body, 'base64');
  return Buffer.from(decodeURIComponent(body), 'utf-8');
}

/**
 * Add a tile pyramid to the archive as a KML super-overlay: every tile image
 * plus a small KML per tile describing its region and linking to the tiles
 * below it. Google Earth walks that hierarchy natively, so the raster travels
 * with the file instead of depending on this machine's cache.
 */
function addSuperOverlay(
  zip: JSZip,
  tilesDir: string,
  hash: string,
  name: string,
): number {
  const dir = join(tilesDir, hash);
  const { tiles, minZoom, maxZoom } = readPyramid(dir);
  if (!tiles.size) return 0;

  for (const key of tiles) {
    const [z, x, y] = key.split('/').map(Number);
    zip.file(`${TILES_PREFIX}${hash}/${z}/${x}/${y}.png`, readFileSync(join(dir, `${z}`, `${x}`, `${y}.png`)));
    zip.file(`${TILES_PREFIX}${hash}/${z}/${x}/${y}.kml`, tileKml(z, x, y, tiles, maxZoom));
  }
  zip.file(`${TILES_PREFIX}${hash}/doc.kml`, rootKml(name, tiles, minZoom));
  return tiles.size;
}

/** Write a .kml (plain) or .kmz (zipped kml + resources + tile pyramids). */
export async function writeGeoFile(
  path: string,
  kml: string,
  asKmz: boolean,
  resources: Record<string, string> = {},
  tiled: { hash: string; name: string }[] = [],
  tilesDir = '',
): Promise<void> {
  if (!asKmz) {
    await writeFile(path, kml, 'utf-8');
    return;
  }
  // Catalog icons become archive-relative and travel with the file, so a KMZ
  // renders correctly offline instead of fetching a shape URL.
  const embedded = await embedIcons(kml, resources);
  const zip = new JSZip();
  zip.file('doc.kml', embedded.kml);
  for (const [name, dataUrl] of Object.entries(embedded.resources)) {
    zip.file(name, dataUrlToBuffer(dataUrl));
  }
  for (const t of tiled) addSuperOverlay(zip, tilesDir, t.hash, t.name);
  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await writeFile(path, out);
}
