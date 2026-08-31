/**
 * Where API keys come from.
 *
 * Running under `npm run dev`, keys arrive as environment variables (direnv,
 * a shell export). An installed app launched from Finder or the Dock inherits
 * none of that — macOS gives GUI processes a minimal environment, and direnv
 * only ever touches interactive shells — so the same machine would silently
 * lose every keyed feature. Hence a file next to the app's other settings,
 * checked whenever the environment comes up empty.
 *
 * The parsing and precedence rules live in shared/keys.ts; this adds the file.
 */
import { app, shell } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS_TEMPLATE, parseKeyFile, resolveKey } from '../shared/keys';

/** `<userData>/keys.env` — the same folder as settings and the tile cache. */
export function keysFilePath(): string {
  return join(app.getPath('userData'), 'keys.env');
}

/** Parsed once per launch; editing the file needs a restart, as it says. */
let fileKeys: Record<string, string> | null = null;

function loadFileKeys(): Record<string, string> {
  if (fileKeys) return fileKeys;
  try {
    const path = keysFilePath();
    fileKeys = existsSync(path) ? parseKeyFile(readFileSync(path, 'utf8')) : {};
  } catch {
    // An unreadable keys file must never stop the app from starting; the
    // keyed features simply stay unavailable, exactly as with no file.
    fileKeys = {};
  }
  return fileKeys;
}

/** First non-empty value among `names`, environment first, or null. */
export function apiKey(...names: string[]): string | null {
  return resolveKey(names, process.env, loadFileKeys());
}

/** Create the keys file (with its template) if absent, then open it. */
export async function openKeysFile(): Promise<void> {
  const path = keysFilePath();
  if (!existsSync(path)) writeFileSync(path, KEYS_TEMPLATE, 'utf8');
  await shell.openPath(path);
}
