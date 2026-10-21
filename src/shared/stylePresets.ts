/**
 * Saved field-style mappings ("style presets"): a colour-by-field setup from
 * the import or restyle dialog, kept in the app's settings so it can be
 * applied to another layer or import. Dependency-free, so main and the
 * renderer can both import it.
 */

/** How a feature's polygon/line styling is drawn. */
export const FILL_MODE_NAMES = ['outline', 'fill', 'both'] as const;
export type FillMode = (typeof FILL_MODE_NAMES)[number];

export const RAMP_NAMES = [
  'category',
  'rainbow',
  'viridis',
  'turbo',
  'warm',
  'cool',
  'grayscale',
] as const;
export type RampName = (typeof RAMP_NAMES)[number];

/** A per-category style + label the user can fine-tune before import. */
export interface CategorySpec {
  /** Raw field value this category matches. */
  value: string;
  /** Display name — becomes the sub-folder name. */
  label: string;
  color: string; // #rrggbb
  fillMode: FillMode;
  fillOpacity: number; // 0..1
  lineOpacity: number; // 0..1
}

export interface StylePreset {
  /** User-given name; presets are keyed by it. */
  name: string;
  /** Field the mapping was made on; preselected when a layer has it. */
  field: string;
  ramp: RampName;
  rampReversed: boolean;
  fillMode: FillMode;
  fillOpacity: number;
  lineOpacity: number;
  lineWidth: number;
  /** Absent = the reader's default (import) or each style's own (restyle). */
  labelScale?: number;
  /** Point icon href; absent when the mapping was made on a non-point layer. */
  iconHref?: string;
  /** Per-value styles, matched to another layer's values by raw value. */
  categories: CategorySpec[];
}
