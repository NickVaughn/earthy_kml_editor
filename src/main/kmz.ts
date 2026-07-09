import { readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import type { OpenedFile } from '@shared/ipc';

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

/** Read a .kml or .kmz file into an OpenedFile (kml text + resources as data URLs). */
export async function readGeoFile(path: string): Promise<OpenedFile> {
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
    const kml = await zip.files[kmlName].async('text');

    const resources: Record<string, string> = {};
    for (const name of entries) {
      if (name === kmlName) continue;
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

/** Write a .kml (plain) or .kmz (zipped kml + resources). */
export async function writeGeoFile(
  path: string,
  kml: string,
  asKmz: boolean,
  resources: Record<string, string> = {},
): Promise<void> {
  if (!asKmz) {
    await writeFile(path, kml, 'utf-8');
    return;
  }
  const zip = new JSZip();
  zip.file('doc.kml', kml);
  for (const [name, dataUrl] of Object.entries(resources)) {
    zip.file(name, dataUrlToBuffer(dataUrl));
  }
  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await writeFile(path, out);
}
