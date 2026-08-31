/**
 * Bundled point icons, for embedding in a KMZ.
 *
 * Plain .kml references the standard KML shape URLs — every reader knows them,
 * and there is nowhere in a text file to put an image. A KMZ can carry its own
 * copy, which makes the archive self-contained and correct offline, so on the
 * way out any style pointing at a catalog icon is rewritten to a relative path
 * and the matching PNG is added to the archive.
 *
 * The PNGs are Earthy's own (build/make-point-icons.py), not Google's artwork.
 */
import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embeddedIconPath, iconChoiceByHref, POINT_ICONS } from '../shared/icons';

/** `resources/icons/` in dev, `resources/icons` beside the app when packaged. */
function iconPath(id: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', `${id}.png`)
    : join(__dirname, '../../resources/icons', `${id}.png`);
}

const cache = new Map<string, string>();

/** One icon as a data URL, or null if it is missing from the bundle. */
async function iconDataUrl(id: string): Promise<string | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const buf = await readFile(iconPath(id));
    const url = `data:image/png;base64,${buf.toString('base64')}`;
    cache.set(id, url);
    return url;
  } catch {
    // A missing bundled icon must not fail the save; the href stays remote,
    // which is exactly what a plain .kml would have done anyway.
    return null;
  }
}

/**
 * Rewrite catalog icon hrefs in `kml` to KMZ-relative paths, returning the
 * rewritten KML plus the resources to add to the archive. Custom hrefs — a
 * user's own URL, or an image the source archive already carried — are left
 * exactly as they are.
 */
export async function embedIcons(
  kml: string,
  resources: Record<string, string>,
): Promise<{ kml: string; resources: Record<string, string> }> {
  let out = kml;
  const added: Record<string, string> = { ...resources };
  for (const icon of POINT_ICONS) {
    // Both spellings of the remote href, since files carry either.
    const variants = [icon.href, icon.href.replace(/^https:/, 'http:')];
    if (!variants.some((v) => out.includes(v))) continue;
    const dataUrl = await iconDataUrl(icon.id);
    if (!dataUrl) continue;
    const rel = embeddedIconPath(icon.id);
    for (const v of variants) out = out.split(v).join(rel);
    added[rel] = dataUrl;
  }
  return { kml: out, resources: added };
}

/**
 * The reverse, for opening: a KMZ Earthy wrote references its icons by
 * relative path, which means nothing once the KML is read out of the archive.
 * Point them back at the catalog's remote href so the renderer and a later
 * plain-.kml save both resolve.
 */
export function unembedIcons(kml: string): string {
  let out = kml;
  for (const icon of POINT_ICONS) {
    const rel = embeddedIconPath(icon.id);
    if (out.includes(rel)) out = out.split(rel).join(icon.href);
  }
  return out;
}

export { iconChoiceByHref };
