/**
 * API keys, from the environment or from a file the app owns.
 *
 * Running under `npm run dev`, keys arrive as environment variables (direnv,
 * a shell export). An installed app launched from Finder or the Dock inherits
 * none of that — macOS gives GUI processes a minimal environment, and direnv
 * only ever touches interactive shells — so the same machine would silently
 * lose every keyed feature. Hence a file next to the app's other settings,
 * checked whenever the environment comes up empty.
 *
 * The environment still wins, so a dev shell can override the installed app's
 * keys without editing anything.
 */
import { app, shell } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `<userData>/keys.env` — the same folder as settings and the tile cache. */
export function keysFilePath(): string {
  return join(app.getPath('userData'), 'keys.env');
}

const TEMPLATE = `# Earthy API keys — one KEY=value per line, '#' starts a comment.
#
# Everything works without these: Esri imagery and AWS terrain need no key.
# They are read at launch, so restart Earthy after editing this file.
#
# Cesium ion (free Community tier: https://ion.cesium.com). Unlocks Cesium
# World Terrain, World Bathymetry, and the ion basemaps.
#EARTHY_ION_TOKEN=

# Google Maps Platform key with the Map Tiles API enabled. Unlocks the Google
# Hybrid / Roadmap / Terrain basemaps.
#EARTHY_GOOGLE_MAPS_API_KEY=
`;

/** Parsed once per launch; editing the file needs a restart, as it says. */
let fileKeys: Record<string, string> | null = null;

function loadFileKeys(): Record<string, string> {
  if (fileKeys) return fileKeys;
  const out: Record<string, string> = {};
  try {
    const path = keysFilePath();
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        // Tolerate `export KEY=value` and surrounding quotes, so a line
        // pasted straight out of an .envrc works.
        const name = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
        const value = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (name && value) out[name] = value;
      }
    }
  } catch {
    // An unreadable keys file must never stop the app from starting; the
    // keyed features simply stay unavailable, exactly as with no file.
  }
  fileKeys = out;
  return out;
}

/** First non-empty value among `names`, environment first, or null. */
export function apiKey(...names: string[]): string | null {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  const file = loadFileKeys();
  for (const n of names) {
    const v = file[n]?.trim();
    if (v) return v;
  }
  return null;
}

/** Create the keys file (with its template) if absent, then open it. */
export async function openKeysFile(): Promise<void> {
  const path = keysFilePath();
  if (!existsSync(path)) writeFileSync(path, TEMPLATE, 'utf8');
  await shell.openPath(path);
}
