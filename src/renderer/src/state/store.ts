import { create } from 'zustand';
import { KmlDocument } from '@renderer/model/document';
import type { KmlNode } from '@renderer/model/types';
import type { OpenedFile, AppSettings } from '@shared/ipc';

interface AppState {
  doc: KmlDocument;
  /** Bumped whenever the document structure/visibility changes, to force re-render. */
  revision: number;
  filePath: string | null;
  wasKmz: boolean;
  dirty: boolean;

  selection: string[];
  balloonNodeId: string | null;

  settings: AppSettings;
  hasGoogleKey: boolean;

  cursorLon: number | null;
  cursorLat: number | null;

  // actions
  loadOpened(opened: OpenedFile): void;
  newDocument(): void;
  bump(): void;
  setSelection(ids: string[]): void;
  openBalloon(id: string | null): void;
  toggleVisibility(id: string): void;
  setSettings(next: AppSettings): void;
  setHasGoogleKey(v: boolean): void;
  setCursor(lon: number | null, lat: number | null): void;
  markDirty(): void;
  markSaved(path: string, wasKmz: boolean): void;
}

const DEFAULT_SETTINGS: AppSettings = {
  basemap: 'esri',
  googleMapType: 'satellite',
  customXyzUrl: '',
  terrainProvider: 'none',
};

export const useStore = create<AppState>((set, get) => ({
  doc: KmlDocument.empty(),
  revision: 0,
  filePath: null,
  wasKmz: false,
  dirty: false,
  selection: [],
  balloonNodeId: null,
  settings: DEFAULT_SETTINGS,
  hasGoogleKey: false,
  cursorLon: null,
  cursorLat: null,

  loadOpened(opened) {
    const doc = KmlDocument.fromKml(opened.kml);
    doc.path = opened.path;
    doc.wasKmz = opened.wasKmz;
    doc.resources = opened.resources;
    set({
      doc,
      revision: get().revision + 1,
      filePath: opened.path,
      wasKmz: opened.wasKmz,
      dirty: false,
      selection: [],
      balloonNodeId: null,
    });
  },

  newDocument() {
    set({
      doc: KmlDocument.empty(),
      revision: get().revision + 1,
      filePath: null,
      wasKmz: false,
      dirty: false,
      selection: [],
      balloonNodeId: null,
    });
  },

  bump() {
    set({ revision: get().revision + 1 });
  },

  setSelection(ids) {
    set({ selection: ids });
  },

  openBalloon(id) {
    set({ balloonNodeId: id });
  },

  toggleVisibility(id) {
    const node: KmlNode | undefined = get().doc.nodeById(id);
    if (!node) return;
    node.visible = !node.visible;
    set({ revision: get().revision + 1, dirty: true });
  },

  setSettings(next) {
    set({ settings: next });
  },

  setHasGoogleKey(v) {
    set({ hasGoogleKey: v });
  },

  setCursor(lon, lat) {
    set({ cursorLon: lon, cursorLat: lat });
  },

  markDirty() {
    set({ dirty: true });
  },

  markSaved(path, wasKmz) {
    set({ filePath: path, wasKmz, dirty: false });
  },
}));
