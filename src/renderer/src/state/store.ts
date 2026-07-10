import { create } from 'zustand';
import { KmlDocument } from '@renderer/model/document';
import type { StylePatch } from '@renderer/model/bulkStyle';
import type { Geometry, KmlStyle } from '@renderer/model/types';
import type { OpenedFile, AppSettings } from '@shared/ipc';

// Default style for newly drawn features: white outline (opaque), white fill
// (~50%). aabbggrr — ffffffff = opaque white, 80ffffff = ~50% white.
function defaultStyle(kind: Geometry['kind']): KmlStyle {
  if (kind === 'Point') return { icon: { color: 'ffffffff', scale: 1 } };
  if (kind === 'LineString') return { line: { color: 'ffffffff', width: 2 } };
  if (kind === 'Polygon')
    return {
      line: { color: 'ffffffff', width: 2 },
      poly: { color: '80ffffff', fill: true, outline: true },
    };
  return {};
}

export type InteractionMode =
  | 'none'
  | 'draw-point'
  | 'draw-line'
  | 'draw-polygon'
  | 'edit'
  | 'measure';

interface AppState {
  /** All open documents (multi-doc workspace). */
  docs: KmlDocument[];
  /** The document targeted by menu save / undo / redo (last interacted). */
  activeDocId: string | null;

  /** Bumps when the SET of open docs changes (open/close/new) → globe reframes. */
  docEpoch: number;
  /** Bumps when rendered content changes (edit/style/add) → globe rebuilds. */
  sceneEpoch: number;
  /** Bumps on visibility-only changes → cheap show/hide. */
  visEpoch: number;
  /** Bumps on every change → re-render React views. */
  revision: number;
  /** True if any open doc has unsaved changes. */
  dirty: boolean;

  selection: string[];
  balloonNodeId: string | null;
  interactionMode: InteractionMode;
  measureResult: string | null;

  settings: AppSettings;
  hasGoogleKey: boolean;
  cursorLon: number | null;
  cursorLat: number | null;

  // lifecycle
  openDoc(opened: OpenedFile): void;
  newDocument(): KmlDocument;
  closeDoc(docId: string): void;
  markSaved(docId: string, path: string, wasKmz: boolean): void;

  // lookups
  docOf(nodeId: string): KmlDocument | undefined;
  activeDoc(): KmlDocument | undefined;
  isRoot(nodeId: string): boolean;

  // view
  setSelection(ids: string[]): void;
  openBalloon(id: string | null): void;
  setSettings(next: AppSettings): void;
  setHasGoogleKey(v: boolean): void;
  setCursor(lon: number | null, lat: number | null): void;

  // mutations
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

  // geometry
  setMode(mode: InteractionMode): void;
  setMeasure(result: string | null): void;
  addPlacemark(geometry: Geometry, name?: string): string;
  updateGeometry(nodeId: string, geometry: Geometry): void;
  setDescription(nodeId: string, description: string): void;
}

const DEFAULT_SETTINGS: AppSettings = {
  basemap: 'esri',
  googleMapType: 'satellite',
  customXyzUrl: '',
  terrainProvider: 'none',
};

export const useStore = create<AppState>((set, get) => {
  const anyDirty = () => get().docs.some((d) => d.dirty);
  const bumpScene = () =>
    set((s) => ({ sceneEpoch: s.sceneEpoch + 1, revision: s.revision + 1, dirty: anyDirty() }));
  const bumpVis = () =>
    set((s) => ({ visEpoch: s.visEpoch + 1, revision: s.revision + 1, dirty: anyDirty() }));
  const bumpMeta = () =>
    set((s) => ({ revision: s.revision + 1, dirty: anyDirty() }));
  const bumpView = () => set((s) => ({ revision: s.revision + 1 }));
  const bumpDocs = (docs: KmlDocument[], activeDocId: string | null) =>
    set((s) => ({
      docs,
      activeDocId,
      docEpoch: s.docEpoch + 1,
      revision: s.revision + 1,
      dirty: docs.some((d) => d.dirty),
    }));

  return {
    docs: [],
    activeDocId: null,
    docEpoch: 0,
    sceneEpoch: 0,
    visEpoch: 0,
    revision: 0,
    dirty: false,
    selection: [],
    balloonNodeId: null,
    interactionMode: 'none',
    measureResult: null,
    settings: DEFAULT_SETTINGS,
    hasGoogleKey: false,
    cursorLon: null,
    cursorLat: null,

    openDoc(opened) {
      const doc = KmlDocument.fromKml(opened.kml);
      doc.path = opened.path;
      doc.wasKmz = opened.wasKmz;
      doc.resources = opened.resources;
      set({ selection: [], balloonNodeId: null, interactionMode: 'none' });
      bumpDocs([...get().docs, doc], doc.id);
    },

    newDocument() {
      const doc = KmlDocument.empty();
      bumpDocs([...get().docs, doc], doc.id);
      return doc;
    },

    closeDoc(docId) {
      const docs = get().docs.filter((d) => d.id !== docId);
      const active = get().activeDocId === docId ? (docs.at(-1)?.id ?? null) : get().activeDocId;
      set((s) => ({ selection: s.selection.filter((id) => get().docOf(id)) }));
      bumpDocs(docs, active);
    },

    markSaved(docId, path, wasKmz) {
      const doc = get().docs.find((d) => d.id === docId);
      if (doc) {
        doc.path = path;
        doc.wasKmz = wasKmz;
        doc.dirty = false;
      }
      set({ dirty: anyDirty(), revision: get().revision + 1 });
    },

    docOf(nodeId) {
      return get().docs.find((d) => d.nodeById(nodeId));
    },
    activeDoc() {
      const { docs, activeDocId } = get();
      return docs.find((d) => d.id === activeDocId) ?? docs.at(-1);
    },
    isRoot(nodeId) {
      return get().docs.some((d) => d.root.id === nodeId);
    },

    setSelection(ids) {
      const active = ids.length ? (get().docOf(ids[0])?.id ?? get().activeDocId) : get().activeDocId;
      set({ selection: ids, activeDocId: active });
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
      const doc = get().docOf(id);
      const node = doc?.nodeById(id);
      if (!doc || !node) return;
      doc.setVisibility(id, !node.visible);
      bumpVis();
    },
    rename(id, name) {
      get().docOf(id)?.rename(id, name);
      bumpScene();
    },
    move(ids, targetId, index) {
      const doc = get().docOf(targetId);
      if (!doc) return;
      // Only move nodes that live in the same document as the target.
      const sameDoc = ids.filter((id) => doc.nodeById(id));
      const moved = doc.move(sameDoc, targetId, index);
      if (moved.length) {
        set({ selection: moved });
        bumpScene();
      }
    },
    remove(ids) {
      let closedAny = false;
      // Group non-root nodes by their document; close docs for root nodes.
      const byDoc = new Map<KmlDocument, string[]>();
      for (const id of ids) {
        if (get().isRoot(id)) {
          const doc = get().docs.find((d) => d.root.id === id);
          if (doc) {
            get().closeDoc(doc.id);
            closedAny = true;
          }
          continue;
        }
        const doc = get().docOf(id);
        if (doc) (byDoc.get(doc) ?? byDoc.set(doc, []).get(doc)!).push(id);
      }
      for (const [doc, nodeIds] of byDoc) doc.delete(nodeIds);
      set({ selection: [] });
      if (byDoc.size) bumpScene();
      else if (!closedAny) bumpView();
    },
    createFolder(parentId) {
      const doc = get().docOf(parentId);
      const folder = doc?.createFolder(parentId);
      if (folder) {
        set({ selection: [folder.id] });
        bumpScene();
      }
    },
    copy(ids) {
      const doc = get().docOf(ids[0]);
      if (!doc) return;
      doc.copy(ids.filter((id) => doc.nodeById(id)));
      bumpView();
    },
    cut(ids) {
      const doc = get().docOf(ids[0]);
      if (!doc) return;
      doc.cut(ids.filter((id) => doc.nodeById(id)));
      set({ selection: [] });
      bumpScene();
    },
    paste(targetId) {
      const doc = get().docOf(targetId);
      const pasted = doc?.paste(targetId);
      if (pasted?.length) {
        set({ selection: pasted });
        bumpScene();
      }
    },
    applyStyle(patch) {
      // Selection may span documents; apply per doc and sum results.
      const byDoc = new Map<KmlDocument, string[]>();
      for (const id of get().selection) {
        const doc = get().docOf(id);
        if (doc) (byDoc.get(doc) ?? byDoc.set(doc, []).get(doc)!).push(id);
      }
      let patched = 0;
      let created = 0;
      for (const [doc, ids] of byDoc) {
        const r = doc.applyStyle(ids, patch);
        patched += r.patched;
        created += r.created;
      }
      if (patched || created) bumpScene();
      return { patched, created };
    },
    undo() {
      if (get().activeDoc()?.undo()) bumpScene();
    },
    redo() {
      if (get().activeDoc()?.redo()) bumpScene();
    },

    setMode(mode) {
      set({ interactionMode: mode });
      if (mode !== 'none') set({ measureResult: null });
    },
    setMeasure(result) {
      set({ measureResult: result });
    },
    addPlacemark(geometry, name) {
      // Target the selection's doc, else the active doc, else a fresh Untitled.
      let doc = get().selection[0] ? get().docOf(get().selection[0]) : get().activeDoc();
      let newDoc = false;
      if (!doc) {
        doc = get().newDocument();
        newDoc = true;
      }
      const parentId = get().selection[0] ?? doc.root.id;
      const id = doc.addPlacemark(parentId, geometry, name, defaultStyle(geometry.kind));
      set({ selection: [id], activeDocId: doc.id });
      if (!newDoc) bumpScene();
      return id;
    },
    updateGeometry(nodeId, geometry) {
      get().docOf(nodeId)?.updateGeometry(nodeId, geometry);
      bumpMeta();
    },
    setDescription(nodeId, description) {
      get().docOf(nodeId)?.setDescription(nodeId, description);
      bumpMeta();
    },
  };
});
