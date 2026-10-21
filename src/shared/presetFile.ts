/**
 * Style presets as a file, for sharing them between people and machines. A
 * file may come from anyone, so reading one validates every field and builds
 * clean presets from it rather than trusting its shape.
 */
import {
  FILL_MODE_NAMES,
  RAMP_NAMES,
  type CategorySpec,
  type StylePreset,
} from './stylePresets';
import { iconChoiceByHref } from './icons';

/** Marks a JSON file as Earthy style presets. */
const FORMAT = 'earthy-style-presets';
/** Layout version; bump when a change would mislead an older reader. */
const VERSION = 1;
/** Suggested filename ending, so the files are recognisable in a folder. */
export const PRESET_FILE_SUFFIX = '.earthy-presets.json';

export function presetFileText(presets: StylePreset[]): string {
  return `${JSON.stringify({ format: FORMAT, version: VERSION, presets }, null, 2)}\n`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isOpacity = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  list.includes(v as T);

function validCategory(raw: unknown): CategorySpec | null {
  if (!isObject(raw)) return null;
  const { value, label, color, fillMode, fillOpacity, lineOpacity } = raw;
  if (typeof value !== 'string' || typeof label !== 'string' || !isHex(color)) return null;
  if (!isOneOf(FILL_MODE_NAMES, fillMode) || !isOpacity(fillOpacity) || !isOpacity(lineOpacity)) {
    return null;
  }
  return { value, label, color: color.toLowerCase(), fillMode, fillOpacity, lineOpacity };
}

/**
 * A clean preset from untrusted data, or null if any part of it is unusable —
 * a partly-applied mapping would be more misleading than none. An icon Earthy
 * does not offer is dropped rather than failing the preset: it would never be
 * selectable, and a file should not make Earthy fetch arbitrary URLs.
 */
export function validPreset(raw: unknown): StylePreset | null {
  if (!isObject(raw)) return null;
  const { name, field, ramp, rampReversed, fillMode, fillOpacity, lineOpacity } = raw;
  const { lineWidth, labelScale, iconHref, categories } = raw;
  if (typeof name !== 'string' || !name.trim() || typeof field !== 'string' || !field) {
    return null;
  }
  if (!isOneOf(RAMP_NAMES, ramp) || typeof rampReversed !== 'boolean') return null;
  if (!isOneOf(FILL_MODE_NAMES, fillMode) || !isOpacity(fillOpacity) || !isOpacity(lineOpacity)) {
    return null;
  }
  if (typeof lineWidth !== 'number' || !Number.isFinite(lineWidth) || lineWidth <= 0) return null;
  const scaleOk =
    labelScale === undefined ||
    (typeof labelScale === 'number' && Number.isFinite(labelScale) && labelScale >= 0);
  if (!scaleOk) return null;
  if (!Array.isArray(categories) || categories.length === 0) return null;
  const cats = categories.map(validCategory);
  if (cats.some((c) => c === null)) return null;
  // Matching is by filename, so keep the catalog's own href, not the file's.
  const icon = typeof iconHref === 'string' ? iconChoiceByHref(iconHref) : undefined;

  return {
    name: name.trim(),
    field,
    ramp,
    rampReversed,
    fillMode,
    fillOpacity,
    lineOpacity,
    lineWidth,
    ...(labelScale !== undefined ? { labelScale } : {}),
    ...(icon ? { iconHref: icon.href } : {}),
    categories: cats as CategorySpec[],
  };
}

export interface ParsedPresetFile {
  presets: StylePreset[];
  /** Entries that failed validation, or repeated a name earlier in the file. */
  skipped: number;
}

/** Read a presets file. Throws, with a message for the user, if it is not one. */
export function parsePresetFile(text: string): ParsedPresetFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (!isObject(data) || data.format !== FORMAT || !Array.isArray(data.presets)) {
    throw new Error('The file is not an Earthy style presets file.');
  }
  if (typeof data.version !== 'number' || data.version > VERSION) {
    throw new Error('The file was written by a newer version of Earthy.');
  }
  const presets: StylePreset[] = [];
  let skipped = 0;
  for (const raw of data.presets) {
    const p = validPreset(raw);
    if (p && !presets.some((q) => q.name === p.name)) presets.push(p);
    else skipped++;
  }
  return { presets, skipped };
}

const sameContent = (a: StylePreset, b: StylePreset): boolean =>
  JSON.stringify(validPreset(a)) === JSON.stringify(validPreset(b));

/** Names of incoming presets that would overwrite a different existing one. */
export function presetConflicts(existing: StylePreset[], incoming: StylePreset[]): string[] {
  return incoming
    .filter((p) => {
      const mine = existing.find((e) => e.name === p.name);
      return !!mine && !sameContent(mine, p);
    })
    .map((p) => p.name);
}

export interface PresetMerge {
  presets: StylePreset[];
  added: number;
  replaced: number;
  /** Imported under a new name because the original was taken. */
  renamed: number;
  /** Already present with identical content. */
  unchanged: number;
}

/**
 * Merge imported presets into the saved list. A name clash with different
 * content either replaces the saved one in place or, for 'keep-both', adds
 * the import as "Name (2)".
 */
export function mergePresets(
  existing: StylePreset[],
  incoming: StylePreset[],
  onConflict: 'replace' | 'keep-both',
): PresetMerge {
  const out = [...existing];
  const result = { added: 0, replaced: 0, renamed: 0, unchanged: 0 };
  for (const p of incoming) {
    const i = out.findIndex((e) => e.name === p.name);
    if (i < 0) {
      out.push(p);
      result.added++;
    } else if (sameContent(out[i], p)) {
      result.unchanged++;
    } else if (onConflict === 'replace') {
      out[i] = p;
      result.replaced++;
    } else {
      let n = 2;
      while (out.some((e) => e.name === `${p.name} (${n})`)) n++;
      out.push({ ...p, name: `${p.name} (${n})` });
      result.renamed++;
    }
  }
  return { presets: out, ...result };
}
