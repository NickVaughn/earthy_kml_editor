import Store from 'electron-store';
import type { AppSettings } from '@shared/ipc';

const DEFAULTS: AppSettings = {
  basemap: 'esri',
  googleMapType: 'satellite',
  customXyzUrl: '',
  render3DTerrain: false,
  activeTerrainId: 'aws-terrarium',
  showBathymetry: false,
  depthTestAgainstTerrain: false,
};

interface Schema {
  settings: AppSettings;
  recentFiles: string[];
}

const store = new Store<Schema>({
  defaults: { settings: DEFAULTS, recentFiles: [] },
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
