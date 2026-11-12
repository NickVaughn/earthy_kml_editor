/**
 * Place-name labels: a transparent imagery layer drawn over whatever basemap
 * is active, toggled from View ▸ Show Place Labels. Two sources:
 *
 * - Google via Cesium ion — the default. A transparent roadmap overlay (place
 *   names plus roads, as on Google Hybrid) streamed through the same ion
 *   Google Maps 2D asset as the default basemap, so it needs the ion token.
 * - Esri World Boundaries and Places — keyless. Place and water-body names and
 *   admin boundaries; the fallback without a token or if ion fails.
 *
 * The provider builders live in the renderer (`globe/imagery.ts`); this list is
 * shared so main can build the menu from it.
 */

export type LabelSource = 'ion' | 'esri';

export const LABEL_SOURCES: {
  id: LabelSource;
  /** Menu label. */
  label: string;
  needsIonKey: boolean;
}[] = [
  { id: 'ion', label: 'Google Labels and Roads (Cesium ion)', needsIonKey: true },
  { id: 'esri', label: 'Esri Boundaries and Places', needsIonKey: false },
];

export function labelSourceLabel(id: LabelSource): string {
  return LABEL_SOURCES.find((s) => s.id === id)?.label ?? id;
}

/**
 * The source actually drawn: the chosen one, or Esri when the choice needs an
 * ion token that isn't configured (a missing key is an expected state, so this
 * falls back quietly).
 */
export function effectiveLabelSource(chosen: LabelSource, hasIonKey: boolean): LabelSource {
  const def = LABEL_SOURCES.find((s) => s.id === chosen);
  if (!def || (def.needsIonKey && !hasIonKey)) return 'esri';
  return def.id;
}
