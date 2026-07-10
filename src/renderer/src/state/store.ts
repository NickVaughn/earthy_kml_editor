import { create } from 'zustand';
import { KmlDocument } from '@renderer/model/document';
import type { StylePatch } from '@renderer/model/bulkStyle';
import type { OpenedFile, AppSettings } from '@shared/ipc';

interface AppState {
  doc: KmlDocument;
  /** Increments only when a new document is loaded (identity change). */
  docId: number;
  /** Increments when the rendered scene must be rebuilt (structure/style/geometry). */
  sceneEpoch: number;
  /** Increments when only visibility changed (cheap show/hide, no rebuild). */
  visEpoch: number;
  /** Increments on every change, to re-render React views (tree, status bar). */
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

  // lifecycle
  loadOpened(opened: OpenedFile): void;
  newDocument(): void;
  markSaved(path: string, wasKmz: boolean): void;

  // view
  setSelection(ids: string[]): void;
  openBalloon(id: string | null): void;
  setSettings(next: AppSettings): void;
  setHasGoogleKey(v: boolean): void;
  setCursor(lon: number | null, lat: number | null): void;

  // mutations (route through the model, then bump the right epoch)
  toggleVisibility(id: string): void;
  rename(id: string, name: string): void;
  move(ids: string[], targetId: string, index?: number): void;
  remove(ids: string[]): void;
  createFolder(parentId: string): void;
  copy(ids: string[]): void;
  cut(ids: string[]): void;
  paste(targetId: string): void;
  applyStyle(patch: StylePatch): { patched: number; created: number };
  undo(): void;
  redo(): void;
}

const DEFAULT_SETTINGS: AppSettings = {
  basemap: 'esri',
  googleMapType: 'satellite',
  customXyzUrl: '',
  terrainProvider: 'none',
};

export const useStore = create<AppState>((set, get) => {
  const bumpScene = () =>
    set((s) => ({ sceneEpoch: s.sceneEpoch + 1, revision: s.revision + 1, dirty: true }));
  const bumpVis = () =>
    set((s) => ({ visEpoch: s.visEpoch + 1, revision: s.revision + 1, dirty: true }));
  const bumpView = () => set((s) => ({ revision: s.revision + 1 }));

  return {
    doc: KmlDocument.empty(),
    docId: 0,
    sceneEpoch: 0,
    visEpoch: 0,
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
      set((s) => ({
        doc,
        docId: s.docId + 1,
        sceneEpoch: s.sceneEpoch + 1,
        revision: s.revision + 1,
        filePath: opened.path,
        wasKmz: opened.wasKmz,
        dirty: false,
        selection: [],
        balloonNodeId: null,
      }));
    },

    newDocument() {
      set((s) => ({
        doc: KmlDocument.empty(),
        docId: s.docId + 1,
        sceneEpoch: s.sceneEpoch + 1,
        revision: s.revision + 1,
        filePath: null,
        wasKmz: false,
        dirty: false,
        selection: [],
        balloonNodeId: null,
      }));
    },

    markSaved(path, wasKmz) {
      get().doc.path = path;
      get().doc.wasKmz = wasKmz;
      get().doc.dirty = false;
      set({ filePath: path, wasKmz, dirty: false });
    },

    setSelection(ids) {
      set({ selection: ids });
    },
    openBalloon(id) {
      set({ balloonNodeId: id });
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

    toggleVisibility(id) {
      const node = get().doc.nodeById(id);
      if (!node) return;
      get().doc.setVisibility(id, !node.visible);
      bumpVis();
    },
    rename(id, name) {
      get().doc.rename(id, name);
      bumpScene(); // labels may change
    },
    move(ids, targetId, index) {
      const moved = get().doc.move(ids, targetId, index);
      if (moved.length) {
        set({ selection: moved });
        bumpScene();
      }
    },
    remove(ids) {
      get().doc.delete(ids);
      set({ selection: [] });
      bumpScene();
    },
    createFolder(parentId) {
      const folder = get().doc.createFolder(parentId);
      if (folder) {
        set({ selection: [folder.id] });
        bumpScene();
      }
    },
    copy(ids) {
      get().doc.copy(ids);
      bumpView(); // enable paste UI
    },
    cut(ids) {
      get().doc.cut(ids);
      set({ selection: [] });
      bumpScene();
    },
    paste(targetId) {
      const pasted = get().doc.paste(targetId);
      if (pasted.length) {
        set({ selection: pasted });
        bumpScene();
      }
    },
    applyStyle(patch) {
      const res = get().doc.applyStyle(get().selection, patch);
      if (res.patched || res.created) bumpScene();
      return res;
    },
    undo() {
      if (get().doc.undo()) bumpScene();
    },
    redo() {
      if (get().doc.redo()) bumpScene();
    },
  };
});
