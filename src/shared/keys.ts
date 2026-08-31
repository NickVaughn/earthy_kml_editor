/**
 * API-key parsing and lookup. Dependency-free — no electron — so the rules
 * are testable on their own; `main/keys.ts` supplies the file itself.
 */

/** The commented starter written when the keys file is first created. */
export const KEYS_TEMPLATE = `# Earthy API keys — one KEY=value per line, '#' starts a comment.
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

/**
 * Parse `KEY=value` lines. Tolerates `export KEY=value` and surrounding
 * quotes, so a line pasted straight out of an `.envrc` works.
 */
export function parseKeyFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (name && value) out[name] = value;
  }
  return out;
}

/**
 * First non-empty value among `names`, checking the environment before the
 * file — so a dev shell overrides whatever an installed app has stored.
 */
export function resolveKey(
  names: string[],
  env: Record<string, string | undefined>,
  file: Record<string, string>,
): string | null {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  for (const n of names) {
    const v = file[n]?.trim();
    if (v) return v;
  }
  return null;
}
