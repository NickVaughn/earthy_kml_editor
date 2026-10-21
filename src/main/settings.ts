import Store from 'electron-store';
import type { AppSettings } from '@shared/ipc';
import type { StylePreset } from '@shared/stylePresets';

const DEFAULTS: AppSettings = {
  basemap: 'ion-aerial',
  googleMapType: 'satellite',
  customXyzUrl: '',
  render3DTerrain: false,
  activeTerrainId: 'aws-terrarium',
  showBathymetry: false,
  depthTestAgainstTerrain: false,
  showWaterEffect: true,
};

interface Schema {
  settings: AppSettings;
  recentFiles: string[];
  stylePresets: StylePreset[];
}

const store = new Store<Schema>({
  defaults: { settings: DEFAULTS, recentFiles: [], stylePresets: [] },
});

export function getSettings(): AppSettings {
  return { ...DEFAULTS, ...store.get('settings') };
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...partial };
  store.set('settings', next);
  return next;
}

export function getRecentFiles(): string[] {
  return store.get('recentFiles', []);
}

export function pushRecentFile(path: string): void {
  const current = getRecentFiles().filter((p) => p !== path);
  current.unshift(path);
  store.set('recentFiles', current.slice(0, 12));
}

export function getStylePresets(): StylePreset[] {
  return store.get('stylePresets', []);
}

/** Add a preset, or replace the one with the same name in place. */
export function saveStylePreset(preset: StylePreset): StylePreset[] {
  const current = getStylePresets();
  const i = current.findIndex((p) => p.name === preset.name);
  if (i >= 0) current[i] = preset;
  else current.push(preset);
  store.set('stylePresets', current);
  return current;
}

/** Replace the whole saved list (after merging in an imported file). */
export function setStylePresets(presets: StylePreset[]): void {
  store.set('stylePresets', presets);
}

export function deleteStylePreset(name: string): StylePreset[] {
  const next = getStylePresets().filter((p) => p.name !== name);
  store.set('stylePresets', next);
  return next;
}
