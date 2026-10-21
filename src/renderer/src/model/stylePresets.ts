import type { StylePreset, CategorySpec, FillMode, RampName } from '@shared/stylePresets';
import { defaultCategories, rampColor } from './geojson';

/** The dialog-wide controls that patch every category at once. */
export interface CategoryKnobs {
  ramp: RampName;
  rampReversed: boolean;
  fillMode: FillMode;
  fillOpacity: number;
  lineOpacity: number;
}

export interface PresetMatch {
  categories: CategorySpec[];
  /** Layer values the preset had a style for. */
  matched: number;
  /** Layer values the preset did not know, styled from its ramp instead. */
  added: number;
}

/**
 * Canonical form of a numeric value, so class codes match across formats that
 * write them differently ("11" in a CSV, "11.0" from a DBF real field).
 */
function numericKey(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : undefined;
}

/**
 * Category specs for a layer's `values` from a saved preset. A value the
 * preset knows takes its saved colour, label and opacities; one it does not
 * gets a ramp colour the preset does not assign. Values the preset has
 * but the layer lacks are dropped.
 *
 * `knobs` are the dialog's current dialog-wide controls. Any that differ from
 * the preset's win over every category, the same way changing them patches
 * all categories in the restyle dialog — so changing the ramp after picking a
 * preset recolours, and changing an opacity applies everywhere.
 */
export function categoriesFromPreset(
  values: string[],
  preset: StylePreset,
  knobs: CategoryKnobs = preset,
): PresetMatch {
  const exact = new Map<string, CategorySpec>();
  const numeric = new Map<string, CategorySpec>();
  for (const c of preset.categories) {
    exact.set(c.value, c);
    const k = numericKey(c.value);
    if (k !== undefined && !numeric.has(k)) numeric.set(k, c);
  }

  const fresh = defaultCategories(values, preset);
  const saved = fresh.map((c) => {
    const k = numericKey(c.value);
    return exact.get(c.value) ?? (k !== undefined ? numeric.get(k) : undefined);
  });
  const matched = saved.filter(Boolean).length;

  // A new value's positional ramp colour may already belong to a saved one
  // (the palette restarts for every mapping), so hand new values ramp colours
  // the preset does not assign at all — even to values absent here, since that
  // colour means that class on other layers. Positional once those run out.
  const used = new Set(preset.categories.map((c) => c.color.toLowerCase()));
  const total = preset.categories.length + values.length - matched;
  const spare = [
    ...new Set(
      Array.from({ length: total }, (_, j) =>
        rampColor(preset.ramp, j, total, preset.rampReversed),
      ),
    ),
  ].filter((c) => !used.has(c.toLowerCase()));

  let nextSpare = 0;
  const seeded = fresh.map((c, i) => {
    const s = saved[i];
    // Keep the layer's own raw value: that is what styling matches on.
    if (s) return { ...s, value: c.value };
    return nextSpare < spare.length ? { ...c, color: spare[nextSpare++] } : c;
  });

  const recolour = knobs.ramp !== preset.ramp || knobs.rampReversed !== preset.rampReversed;
  const categories = seeded.map((c, i) => ({
    ...c,
    ...(recolour ? { color: rampColor(knobs.ramp, i, seeded.length, knobs.rampReversed) } : {}),
    ...(knobs.fillMode !== preset.fillMode ? { fillMode: knobs.fillMode } : {}),
    ...(knobs.fillOpacity !== preset.fillOpacity ? { fillOpacity: knobs.fillOpacity } : {}),
    ...(knobs.lineOpacity !== preset.lineOpacity ? { lineOpacity: knobs.lineOpacity } : {}),
  }));

  return { categories, matched, added: values.length - matched };
}

/** One-line summary of how a preset fitted a layer, for the dialogs. */
export function describeMatch(name: string, m: PresetMatch): string {
  const total = m.matched + m.added;
  const base = `Preset “${name}”: ${m.matched} of ${total} value${total === 1 ? '' : 's'} matched`;
  return m.added ? `${base}, ${m.added} new from the ramp.` : `${base}.`;
}
