import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { DEFAULT_ICON_HREF, embeddedIconPath } from '../src/shared/icons';

// main/icons.ts resolves bundled PNGs through electron's app.isPackaged.
vi.mock('electron', () => ({ app: { isPackaged: false } }));

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Style id="s"><IconStyle><color>ff20ffff</color>
<Icon><href>${DEFAULT_ICON_HREF}</href></Icon></IconStyle></Style>
<Placemark><styleUrl>#s</styleUrl>
<Point><coordinates>-155.9,19.4</coordinates></Point></Placemark>
</Document></kml>`;

describe('KMZ icon embedding', () => {
  it('carries the icon inside the archive and points the KML at it', async () => {
    const { writeGeoFile } = await import('../src/main/kmz');
    const out = join(mkdtempSync(join(tmpdir(), 'earthy-icons-')), 'doc.kmz');
    await writeGeoFile(out, KML, true);

    const zip = await JSZip.loadAsync(readFileSync(out));
    const rel = embeddedIconPath('circle');
    // The PNG travels with the file...
    expect(Object.keys(zip.files)).toContain(rel);
    expect((await zip.files[rel].async('nodebuffer')).length).toBeGreaterThan(0);
    // ...and the KML references it instead of the network.
    const kml = await zip.files['doc.kml'].async('text');
    expect(kml).toContain(rel);
    expect(kml).not.toContain(DEFAULT_ICON_HREF);
  });

  it('restores the remote href when the archive is read back', async () => {
    // A relative path means nothing once the KML leaves the archive.
    const { writeGeoFile, readGeoFile } = await import('../src/main/kmz');
    const out = join(mkdtempSync(join(tmpdir(), 'earthy-icons-')), 'doc.kmz');
    await writeGeoFile(out, KML, true);

    const opened = await readGeoFile(out, '');
    expect(opened.kml).toContain(DEFAULT_ICON_HREF);
    expect(opened.kml).not.toContain(embeddedIconPath('circle'));
  });

  it('leaves a plain .kml referencing the remote href', async () => {
    // A text file has nowhere to put an image.
    const { writeGeoFile } = await import('../src/main/kmz');
    const out = join(mkdtempSync(join(tmpdir(), 'earthy-icons-')), 'doc.kml');
    await writeGeoFile(out, KML, false);
    expect(readFileSync(out, 'utf8')).toContain(DEFAULT_ICON_HREF);
  });

  it("does not touch a custom icon it doesn't own", async () => {
    const { writeGeoFile } = await import('../src/main/kmz');
    const custom = KML.replace(DEFAULT_ICON_HREF, 'https://example.com/mine.png');
    const out = join(mkdtempSync(join(tmpdir(), 'earthy-icons-')), 'doc.kmz');
    await writeGeoFile(out, custom, true);
    const zip = await JSZip.loadAsync(readFileSync(out));
    const kml = await zip.files['doc.kml'].async('text');
    expect(kml).toContain('https://example.com/mine.png');
    expect(Object.keys(zip.files)).not.toContain(embeddedIconPath('circle'));
  });
});
