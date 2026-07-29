import { parseKml } from './parse';
import { serializeKml } from './serialize';
import { effectiveStyle } from './style';
import { nextId } from './ids';
import { applyBulkStyle, type StylePatch } from './bulkStyle';
import { buildStyle, placemarkFieldValue, type CategorySpec } from './geojson';
import { tileMarkerExtendedData, tiledOverlayInfo } from './overlays';
import type {
  KmlDocumentData,
  KmlNode,
  KmlStyle,
  Geometry,
  SharedStyleEntry,
  LatLonBox,
} from './types';
import { CONTAINER_TYPES } from './types';

interface UndoEntry {
  label: string;
  undo(): void;
  redo(): void;
}

/** Which geometry kinds a style sub-tab applies to. */
export type StyleTarget = 'icon' | 'label' | 'line' | 'poly';

/** The set of concrete geometry kinds within a geometry (flattening MultiGeometry). */
function geometryKinds(g: Geometry, into: Set<string> = new Set()): Set<string> {
  if (g.kind === 'MultiGeometry') {
    for (const child of g.geometries) geometryKinds(child, into);
  } else {
    into.add(g.kind);
  }
  return into;
}

/**
 * The live document model wrapping the parsed data. Phase 1 uses it read-only
 * (load, traverse, resolve styles, serialize). Phase 2 adds mutation + undo.
 */
export class KmlDocument {
  /** Stable id for this open document (workspace tracking, multi-doc). */
  readonly id = nextId();
  data: KmlDocumentData;
  /** Source file path (null for unsaved). */
  path: string | null = null;
  wasKmz = false;
  resources: Record<string, string> = {};
  dirty = false;

  private index = new Map<string, KmlNode>();
  private parents = new Map<string, KmlNode | null>();
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private clipboard: KmlNode[] = [];

  constructor(data: KmlDocumentData) {
    this.data = data;
    this.reindex();
  }

  static fromKml(kml: string): KmlDocument {
    return new KmlDocument(parseKml(kml));
  }

  static empty(): KmlDocument {
    return new KmlDocument({
      root: {
        id: nextId(), // unique per doc — multiple "Untitled" files must not collide
        type: 'Document',
        name: 'Untitled',
        visible: true,
        children: [],
        unknownChildren: [],
        attrs: {},
      },
      sharedStyles: new Map(),
      sharedStyleMaps: new Map(),
      kmlAttrs: {},
      sharedOrder: [],
    });
  }

  reindex(): void {
    this.index.clear();
    this.parents.clear();
    const walk = (n: KmlNode, parent: KmlNode | null) => {
      this.index.set(n.id, n);
      this.parents.set(n.id, parent);
      for (const c of n.children) walk(c, n);
    };
    walk(this.data.root, null);
  }

  get root(): KmlNode {
    return this.data.root;
  }

  nodeById(id: string): KmlNode | undefined {
    return this.index.get(id);
  }

  /** Depth-first walk over all nodes (root first). */
  *walk(from: KmlNode = this.data.root): Generator<KmlNode> {
    yield from;
    for (const c of from.children) yield* this.walk(c);
  }

  /** All placemarks under a node (or whole doc), recursively. */
  placemarksUnder(node: KmlNode = this.data.root): KmlNode[] {
    const out: KmlNode[] = [];
    for (const n of this.walk(node)) {
      if (n.type === 'Placemark' && n.geometry) out.push(n);
    }
    return out;
  }

  isContainer(node: KmlNode): boolean {
    return CONTAINER_TYPES.has(node.type);
  }

  styleFor(node: KmlNode): KmlStyle {
    return effectiveStyle(this.data, node);
  }

  /** Effective visibility: false if the node or any ancestor is hidden. */
  isEffectivelyVisible(node: KmlNode): boolean {
    // Walk UP via the parent index — O(depth). Descending from the root instead
    // (pathTo) is O(nodes) per call, which is O(n²) over a whole document and
    // shows up as seconds of load time on a large KML.
    for (let n: KmlNode | null = node; n; n = this.parents.get(n.id) ?? null) {
      if (!n.visible) return false;
    }
    return true;
  }

  /** Ancestor chain from root to the node (inclusive), or null if not found. */
  pathTo(id: string): KmlNode[] | null {
    const result: KmlNode[] = [];
    const dfs = (n: KmlNode): boolean => {
      result.push(n);
      if (n.id === id) return true;
      for (const c of n.children) if (dfs(c)) return true;
      result.pop();
      return false;
    };
    return dfs(this.data.root) ? result : null;
  }

  parentOf(id: string): KmlNode | null {
    return this.parents.get(id) ?? null;
  }

  // ---- undo / redo ---------------------------------------------------------

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  private pushUndo(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    entry.undo();
    this.redoStack.push(entry);
    this.reindex();
    this.dirty = true;
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    entry.redo();
    this.undoStack.push(entry);
    this.reindex();
    this.dirty = true;
    return true;
  }

  /** Structural edit: snapshot affected containers' children before/after. */
  private structuralEdit(
    label: string,
    containerIds: string[],
    mutate: () => void,
  ): void {
    const ids = [...new Set(containerIds)];
    const snap = (): Map<string, KmlNode[]> =>
      new Map(ids.map((id) => [id, [...(this.nodeById(id)?.children ?? [])]]));
    const before = snap();
    mutate();
    const after = snap();
    const restore = (state: Map<string, KmlNode[]>) => {
      for (const [id, arr] of state) {
        const node = this.nodeById(id);
        if (node) node.children = [...arr];
      }
    };
    this.pushUndo({ label, undo: () => restore(before), redo: () => restore(after) });
    this.reindex();
  }

  private propEdit<T>(label: string, get: () => T, set: (v: T) => void, next: T): void {
    const prev = get();
    this.pushUndo({ label, undo: () => set(prev), redo: () => set(next) });
    set(next);
  }

  // ---- structural mutations ------------------------------------------------

  /** True if `maybeAncestor` is the same node as, or an ancestor of, `node`. */
  private isAncestorOrSelf(maybeAncestor: KmlNode, node: KmlNode): boolean {
    const path = this.pathTo(node.id);
    return path ? path.includes(maybeAncestor) : false;
  }

  createFolder(parentId: string, index?: number, name = 'New Folder'): KmlNode | null {
    const parent = this.nodeById(parentId);
    if (!parent || !this.isContainer(parent)) return null;
    const folder: KmlNode = {
      id: nextId(),
      type: 'Folder',
      name,
      visible: true,
      open: true,
      children: [],
      unknownChildren: [],
      attrs: {},
    };
    const at = index ?? parent.children.length;
    this.structuralEdit('New Folder', [parentId], () => {
      parent.children.splice(at, 0, folder);
    });
    return folder;
  }

  rename(id: string, name: string): void {
    const node = this.nodeById(id);
    if (!node) return;
    this.propEdit('Rename', () => node.name, (v) => (node.name = v), name);
  }

  /**
   * Apply a batch of `visible` flags as ONE undoable step. Nodes already at the
   * requested value are dropped, so an unchanged command pushes no undo entry.
   */
  private applyVisibility(label: string, changes: Map<KmlNode, boolean>): boolean {
    const targets = [...changes].filter(([n, v]) => n.visible !== v);
    if (targets.length === 0) return false;
    const before = targets.map(([n]) => n.visible);
    const apply = (restore: boolean[] | null): void => {
      targets.forEach(([n, v], i) => {
        n.visible = restore ? restore[i] : v;
      });
    };
    this.pushUndo({ label, undo: () => apply(before), redo: () => apply(null) });
    apply(null);
    return true;
  }

  /**
   * Fold the ancestors a visibility change implies into `changes`.
   *
   * Showing something is pointless while an ancestor is hidden, so showing
   * opens the whole chain up to the root. Hiding walks up too, but stops at the
   * first ancestor that still has a visible child — that folder is holding
   * something the user can still see, so it stays checked. Once one ancestor
   * stops, every ancestor above it has a visible child too (that very folder),
   * so there is nothing left to do.
   *
   * Pending entries in `changes` count as already applied, so a command that
   * hides a folder and its subtree sees the folder as hidden when it looks at
   * the parent's children.
   */
  private includeAncestors(
    node: KmlNode,
    visible: boolean,
    changes: Map<KmlNode, boolean>,
  ): void {
    for (let p = this.parentOf(node.id); p; p = this.parentOf(p.id)) {
      if (visible) {
        changes.set(p, true);
      } else {
        if (p.children.some((c) => changes.get(c) ?? c.visible)) return;
        changes.set(p, false);
      }
    }
  }

  setVisibility(id: string, visible: boolean): void {
    const node = this.nodeById(id);
    if (!node) return;
    const changes = new Map<KmlNode, boolean>([[node, visible]]);
    this.includeAncestors(node, visible, changes);
    this.applyVisibility('Visibility', changes);
  }

  /**
   * Show/hide a container AND its contents as one undoable step. `recurse` false
   * touches only the immediate children; true touches the whole subtree. Either
   * way the folder itself follows — checking a folder's contents while leaving
   * the folder unchecked would show nothing. Ancestors follow per
   * {@link includeAncestors}. Returns false if there was nothing to change.
   */
  setChildrenVisibility(folderId: string, visible: boolean, recurse: boolean): boolean {
    const folder = this.nodeById(folderId);
    if (!folder || !this.isContainer(folder)) return false;
    const targets = recurse
      ? [...this.walk(folder)]
      : [folder, ...folder.children];
    const changes = new Map<KmlNode, boolean>(targets.map((n) => [n, visible]));
    this.includeAncestors(folder, visible, changes);
    return this.applyVisibility(visible ? 'Show items' : 'Hide items', changes);
  }

  delete(ids: string[]): void {
    const nodes = ids
      .map((id) => this.nodeById(id))
      .filter((n): n is KmlNode => !!n && n !== this.data.root);
    if (nodes.length === 0) return;
    const parents = nodes
      .map((n) => this.parentOf(n.id))
      .filter((p): p is KmlNode => !!p);
    this.structuralEdit('Delete', parents.map((p) => p.id), () => {
      for (const n of nodes) {
        const p = this.parentOf(n.id);
        if (!p) continue;
        const i = p.children.indexOf(n);
        if (i >= 0) p.children.splice(i, 1);
      }
    });
  }

  /**
   * Move nodes into `targetId` at `index`. Nodes that would move into their own
   * subtree are skipped. Returns the ids actually moved.
   */
  move(ids: string[], targetId: string, index?: number): string[] {
    const target = this.nodeById(targetId);
    if (!target || !this.isContainer(target)) return [];
    const nodes = ids
      .map((id) => this.nodeById(id))
      .filter((n): n is KmlNode => !!n && n !== this.data.root)
      .filter((n) => !this.isAncestorOrSelf(n, target));
    if (nodes.length === 0) return [];

    const affected = new Set<string>([targetId]);
    for (const n of nodes) {
      const p = this.parentOf(n.id);
      if (p) affected.add(p.id);
    }

    this.structuralEdit('Move', [...affected], () => {
      for (const n of nodes) {
        const p = this.parentOf(n.id);
        if (!p) continue;
        const i = p.children.indexOf(n);
        if (i >= 0) p.children.splice(i, 1);
      }
      const at = Math.max(0, Math.min(index ?? target.children.length, target.children.length));
      target.children.splice(at, 0, ...nodes);
    });
    return nodes.map((n) => n.id);
  }

  // ---- cross-document transfer ---------------------------------------------

  /**
   * Remove nodes WITHOUT recording undo, returning the removed nodes plus
   * apply/revert closures. Used to compose a cross-document move into a single
   * undo entry (see `pushExternalUndo`).
   */
  detach(ids: string[]): { nodes: KmlNode[]; revert(): void; apply(): void } {
    const records: { node: KmlNode; parent: KmlNode; index: number }[] = [];
    for (const id of ids) {
      const node = this.nodeById(id);
      if (!node || node === this.data.root) continue;
      const parent = this.parentOf(id);
      if (!parent) continue;
      records.push({ node, parent, index: parent.children.indexOf(node) });
    }
    const apply = (): void => {
      for (const r of records) {
        const i = r.parent.children.indexOf(r.node);
        if (i >= 0) r.parent.children.splice(i, 1);
      }
      this.reindex();
    };
    const revert = (): void => {
      // Re-insert in ascending original index so positions restore correctly.
      for (const r of [...records].sort((a, b) => a.index - b.index)) {
        r.parent.children.splice(Math.min(r.index, r.parent.children.length), 0, r.node);
      }
      this.reindex();
    };
    apply();
    return { nodes: records.map((r) => r.node), revert, apply };
  }

  /** Insert nodes WITHOUT recording undo; counterpart to `detach`. */
  attach(
    parentId: string,
    index: number | undefined,
    nodes: KmlNode[],
  ): { revert(): void; apply(): void } {
    const found = this.nodeById(parentId) ?? this.data.root;
    const container = this.isContainer(found)
      ? found
      : (this.parentOf(found.id) ?? this.data.root);
    const apply = (): void => {
      const at = Math.max(
        0,
        Math.min(index ?? container.children.length, container.children.length),
      );
      container.children.splice(at, 0, ...nodes);
      this.reindex();
    };
    const revert = (): void => {
      for (const n of nodes) {
        const i = container.children.indexOf(n);
        if (i >= 0) container.children.splice(i, 1);
      }
      this.reindex();
    };
    apply();
    return { revert, apply };
  }

  /** Record an undo entry for an externally-composed operation. */
  pushExternalUndo(label: string, undo: () => void, redo: () => void): void {
    this.pushUndo({ label, undo, redo });
  }

  /** Deep clone a subtree with fresh internal ids (for transfer/import). */
  cloneNode(node: KmlNode): KmlNode {
    return this.cloneSubtree(node);
  }

  /**
   * Copy the shared styles that `nodes` reference from `source` into this
   * document, repointing their styleUrls. Without this, features dragged
   * between files would lose their styling. Identical existing ids are reused;
   * conflicting ones are imported under a fresh id.
   */
  importStylesFrom(source: KmlDocument, nodes: KmlNode[]): void {
    const mapping = new Map<string, string>();
    const localId = (url?: string): string | undefined =>
      url && url.startsWith('#') ? url.slice(1) : undefined;

    const ensure = (srcId: string): string | undefined => {
      const seen = mapping.get(srcId);
      if (seen) return seen;
      const srcStyle = source.data.sharedStyles.get(srcId);
      const srcMap = source.data.sharedStyleMaps.get(srcId);
      if (!srcStyle && !srcMap) return undefined;

      const existing =
        this.data.sharedStyles.get(srcId) ?? this.data.sharedStyleMaps.get(srcId);
      let targetId = srcId;
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(srcStyle ?? srcMap)) {
          mapping.set(srcId, srcId);
          return srcId;
        }
        targetId = `${srcId}-${nextId()}`;
      }
      mapping.set(srcId, targetId); // set before recursing (cycle guard)

      if (srcStyle) {
        const clone = structuredClone(srcStyle);
        clone.id = targetId;
        this.data.sharedStyles.set(targetId, clone);
        (this.data.root.styles ??= []).push({ kind: 'Style', style: clone });
        this.data.sharedOrder.push(targetId);
      } else if (srcMap) {
        const clone = structuredClone(srcMap);
        clone.id = targetId;
        for (const pair of clone.pairs) {
          const ref = localId(pair.styleUrl);
          if (ref) {
            const t = ensure(ref);
            if (t) pair.styleUrl = `#${t}`;
          }
        }
        this.data.sharedStyleMaps.set(targetId, clone);
        (this.data.root.styles ??= []).push({ kind: 'StyleMap', map: clone });
        this.data.sharedOrder.push(targetId);
      }
      return targetId;
    };

    const walkNode = (n: KmlNode): void => {
      const ref = localId(n.styleUrl);
      if (ref) {
        const t = ensure(ref);
        if (t && t !== ref) n.styleUrl = `#${t}`;
      }
      for (const c of n.children) walkNode(c);
    };
    for (const n of nodes) walkNode(n);
  }

  // ---- clipboard -----------------------------------------------------------

  private cloneSubtree(node: KmlNode): KmlNode {
    const clone = structuredClone(node);
    const reid = (n: KmlNode) => {
      n.id = nextId();
      for (const c of n.children) reid(c);
    };
    reid(clone);
    return clone;
  }

  copy(ids: string[]): void {
    this.clipboard = ids
      .map((id) => this.nodeById(id))
      .filter((n): n is KmlNode => !!n && n !== this.data.root)
      .map((n) => this.cloneSubtree(n));
  }

  cut(ids: string[]): void {
    this.copy(ids);
    this.delete(ids);
  }

  get clipboardSize(): number {
    return this.clipboard.length;
  }

  paste(targetId: string, index?: number): string[] {
    const target = this.nodeById(targetId);
    if (!target || !this.isContainer(target) || this.clipboard.length === 0) return [];
    // Clone again so repeated pastes get fresh ids.
    const fresh = this.clipboard.map((n) => this.cloneSubtree(n));
    const at = index ?? target.children.length;
    this.structuralEdit('Paste', [targetId], () => {
      target.children.splice(at, 0, ...fresh);
    });
    return fresh.map((n) => n.id);
  }

  // ---- geometry creation / editing (Phase 3) -------------------------------

  /**
   * Add a new placemark with the given geometry under `parentId` (or the nearest
   * container / root). Returns the new node id.
   */
  addPlacemark(
    parentId: string | null,
    geometry: Geometry,
    name = 'New Placemark',
    inlineStyle?: KmlStyle,
  ): string {
    let parent = parentId ? this.nodeById(parentId) : this.data.root;
    if (parent && !this.isContainer(parent)) parent = this.parentOf(parent.id) ?? undefined;
    if (!parent) parent = this.data.root;
    const node: KmlNode = {
      id: nextId(),
      type: 'Placemark',
      name,
      visible: true,
      children: [],
      unknownChildren: [],
      attrs: {},
      geometry: structuredClone(geometry),
      inlineStyle: inlineStyle ? structuredClone(inlineStyle) : undefined,
    };
    const container = parent;
    this.structuralEdit('Add Feature', [container.id], () => {
      container.children.push(node);
    });
    return node.id;
  }

  /** Replace a placemark's geometry (vertex edits, moves). Undoable. */
  updateGeometry(nodeId: string, geometry: Geometry): void {
    const node = this.nodeById(nodeId);
    if (!node) return;
    const prev = node.geometry ? structuredClone(node.geometry) : undefined;
    const next = structuredClone(geometry);
    node.geometry = next;
    this.pushUndo({
      label: 'Edit Geometry',
      undo: () => {
        node.geometry = prev;
      },
      redo: () => {
        node.geometry = structuredClone(next);
      },
    });
  }

  /** Register/unregister a set of shared styles on the root (for import undo). */
  private styleRegistrar(styles: KmlStyle[]): { add(): void; remove(): void } {
    const entries: SharedStyleEntry[] = styles
      .filter((s) => !!s.id)
      .map((style) => ({ kind: 'Style', style }));
    return {
      add: () => {
        for (const e of entries) {
          const id = e.kind === 'Style' ? e.style.id! : e.map.id!;
          if (e.kind === 'Style') this.data.sharedStyles.set(id, e.style);
          (this.data.root.styles ??= []).push(e);
          if (!this.data.sharedOrder.includes(id)) this.data.sharedOrder.push(id);
        }
      },
      remove: () => {
        for (const e of entries) {
          const id = e.kind === 'Style' ? e.style.id! : e.map.id!;
          this.data.sharedStyles.delete(id);
          const list = this.data.root.styles;
          if (list) {
            const i = list.indexOf(e);
            if (i >= 0) list.splice(i, 1);
          }
          const oi = this.data.sharedOrder.indexOf(id);
          if (oi >= 0) this.data.sharedOrder.splice(oi, 1);
        }
      },
    };
  }

  /**
   * Insert an imported layer (folder + its shared styles) as ONE undoable
   * operation. Used by the GDAL vector import.
   */
  importFolder(parentId: string | null, folder: KmlNode, styles: KmlStyle[]): string {
    let parent = parentId ? this.nodeById(parentId) : this.data.root;
    if (parent && !this.isContainer(parent)) parent = this.parentOf(parent.id) ?? undefined;
    const container = parent ?? this.data.root;

    const s = this.styleRegistrar(styles);
    s.add();
    const att = this.attach(container.id, undefined, [folder]);
    this.pushExternalUndo(
      'Import layer',
      () => {
        att.revert();
        s.remove();
      },
      () => {
        s.add();
        att.apply();
      },
    );
    return folder.id;
  }

  /**
   * Import a built layer AS the document itself: the layer's name becomes the
   * document name and its contents live directly under the root — no wrapper
   * folder. Used when importing into a fresh, empty document.
   */
  importAsRoot(folder: KmlNode, styles: KmlStyle[]): void {
    const root = this.data.root;
    const s = this.styleRegistrar(styles);
    const prevName = root.name;
    const prevChildren = [...root.children];
    const incoming = [...folder.children];

    const apply = (): void => {
      root.name = folder.name;
      root.children = [...prevChildren, ...incoming];
      s.add();
      this.reindex();
    };
    const revert = (): void => {
      root.name = prevName;
      root.children = [...prevChildren];
      s.remove();
      this.reindex();
    };
    apply();
    this.pushExternalUndo('Import layer', revert, apply);
  }

  /**
   * Add an imported raster as a GroundOverlay node, storing its image as a
   * document resource (so a KMZ save embeds it). One undoable step.
   */
  addGroundOverlay(
    parentId: string | null,
    o: { name: string; href: string; dataUrl: string; box: LatLonBox },
  ): string {
    let parent = parentId ? this.nodeById(parentId) : this.data.root;
    if (parent && !this.isContainer(parent)) parent = this.parentOf(parent.id) ?? undefined;
    const container = parent ?? this.data.root;

    const node: KmlNode = {
      id: nextId(),
      type: 'GroundOverlay',
      name: o.name,
      visible: true,
      children: [],
      unknownChildren: [],
      attrs: {},
      overlay: { href: o.href, box: { ...o.box } },
    };

    const addResource = (): void => {
      this.resources[o.href] = o.dataUrl;
    };
    const removeResource = (): void => {
      delete this.resources[o.href];
    };

    addResource();
    const att = this.attach(container.id, undefined, [node]);
    this.pushExternalUndo(
      'Add image overlay',
      () => {
        att.revert();
        removeResource();
      },
      () => {
        addResource();
        att.apply();
      },
    );
    return node.id;
  }

  /**
   * Add a large raster as a *tiled* GroundOverlay: the node references the
   * source file and carries a marker naming its local tile pyramid, so no
   * image is embedded in the document. One undoable step.
   */
  addTiledOverlay(
    parentId: string | null,
    o: {
      name: string;
      sourcePath: string;
      box: LatLonBox;
      marker: { hash: string; minZoom: number; maxZoom: number };
    },
  ): string {
    let parent = parentId ? this.nodeById(parentId) : this.data.root;
    if (parent && !this.isContainer(parent)) parent = this.parentOf(parent.id) ?? undefined;
    const container = parent ?? this.data.root;

    const node: KmlNode = {
      id: nextId(),
      type: 'GroundOverlay',
      name: o.name,
      visible: true,
      children: [],
      unknownChildren: [],
      attrs: {},
      overlay: { href: o.sourcePath, box: { ...o.box } },
      extendedData: tileMarkerExtendedData(o.marker),
    };

    const att = this.attach(container.id, undefined, [node]);
    this.pushExternalUndo('Add tiled overlay', att.revert, att.apply);
    return node.id;
  }

  /** Set a placemark's description (inspector). Undoable. */
  setDescription(nodeId: string, description: string | undefined): void {
    const node = this.nodeById(nodeId);
    if (!node) return;
    const cdata = node.descriptionCdata;
    this.propEdit(
      'Description',
      () => node.description,
      (v) => {
        node.description = v;
        // A plain edit drops CDATA framing; re-added only if it contains markup.
        node.descriptionCdata = v ? /[<&]/.test(v) : cdata;
      },
      description,
    );
  }

  // ---- bulk style ----------------------------------------------------------

  /**
   * Resolve a tree selection to the placemarks a style patch should touch:
   * containers expand to descendant placemarks, filtered by which geometry
   * kinds the patched sub-styles apply to.
   */
  styleTargets(selectionIds: string[], subs: StyleTarget[]): KmlNode[] {
    const wantsPoint = subs.includes('icon') || subs.includes('label');
    const wantsLine = subs.includes('line');
    const wantsPoly = subs.includes('poly');
    const keep = (n: KmlNode): boolean => {
      if (n.type !== 'Placemark' || !n.geometry) return false;
      const kinds = geometryKinds(n.geometry);
      if (subs.includes('label')) return true; // labels apply to anything named
      if (wantsPoint && kinds.has('Point')) return true;
      if (wantsLine && (kinds.has('LineString') || kinds.has('Polygon'))) return true;
      if (wantsPoly && kinds.has('Polygon')) return true;
      return false;
    };
    const out: KmlNode[] = [];
    const seen = new Set<string>();
    for (const id of selectionIds) {
      const node = this.nodeById(id);
      if (!node) continue;
      for (const n of this.walk(node)) {
        if (keep(n) && !seen.has(n.id)) {
          seen.add(n.id);
          out.push(n);
        }
      }
    }
    return out;
  }

  /** Placemarks (with geometry) under a set of nodes, de-duplicated. */
  private targetPlacemarks(ids: string[]): KmlNode[] {
    const out: KmlNode[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const node = this.nodeById(id);
      if (!node) continue;
      for (const p of this.placemarksUnder(node)) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          out.push(p);
        }
      }
    }
    return out;
  }

  /** Distinct ExtendedData field names across the placemarks under `ids`. */
  attributeFieldNames(ids: string[]): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const n of this.targetPlacemarks(ids)) {
      for (const f of n.extendedData?.fields ?? []) {
        if (!seen.has(f.name)) {
          seen.add(f.name);
          names.push(f.name);
        }
      }
    }
    return names;
  }

  /** Distinct values of a field across the placemarks under `ids` (first-seen). */
  distinctFieldValues(ids: string[], field: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const n of this.targetPlacemarks(ids)) {
      const v = placemarkFieldValue(n, field);
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  /**
   * Recolour the placemarks under `ids` by a field value: one shared style per
   * category spec, re-pointing each placemark's styleUrl. Like the categorized
   * import, but applied to existing features. One undoable step.
   */
  restyleByField(
    ids: string[],
    field: string,
    specs: CategorySpec[],
    lineWidth?: number,
  ): number {
    const targets = this.targetPlacemarks(ids);
    if (targets.length === 0 || specs.length === 0) return 0;

    const valueToId = new Map<string, string>();
    const styles: KmlStyle[] = specs.map((spec) => {
      const id = `earthy-cat-${nextId()}`;
      valueToId.set(spec.value, id);
      return buildStyle(id, spec.color, {
        fillMode: spec.fillMode,
        fillOpacity: spec.fillOpacity,
        lineOpacity: spec.lineOpacity,
        lineWidth,
      });
    });
    const reg = this.styleRegistrar(styles);
    const snap = targets.map((n) => ({
      node: n,
      url: n.styleUrl,
      inline: n.inlineStyle ? structuredClone(n.inlineStyle) : undefined,
    }));

    const apply = (): void => {
      reg.add();
      for (const n of targets) {
        const id = valueToId.get(placemarkFieldValue(n, field));
        if (id) {
          n.styleUrl = `#${id}`;
          n.inlineStyle = undefined; // let the shared category style win
        }
      }
    };
    const revert = (): void => {
      reg.remove();
      for (const s of snap) {
        s.node.styleUrl = s.url;
        s.node.inlineStyle = s.inline;
      }
    };
    apply();
    this.pushExternalUndo('Restyle by field', revert, apply);
    return targets.filter((n) => valueToId.has(placemarkFieldValue(n, field))).length;
  }

  applyStyle(selectionIds: string[], patch: StylePatch): { patched: number; created: number } {
    const subs = (['icon', 'label', 'line', 'poly'] as StyleTarget[]).filter(
      (k) => patch[k],
    );
    if (this.styleTargets(selectionIds, subs).length === 0) {
      return { patched: 0, created: 0 };
    }
    const run = () =>
      applyBulkStyle(this.data, this.styleTargets(selectionIds, subs), patch);
    const first = run();
    // redo re-runs the op (minting fresh fork ids), so keep the inverse current.
    let inverse = first.undo;
    this.pushUndo({
      label: 'Style',
      undo: () => inverse(),
      redo: () => {
        inverse = run().undo;
      },
    });
    return { patched: first.patched, created: first.created };
  }

  serialize(opts?: import('./serialize').SerializeOptions): string {
    return serializeKml(this.data, opts);
  }

  /** Tile pyramids referenced by this document, for embedding in a KMZ. */
  tiledOverlays(): { hash: string; name: string }[] {
    const out: { hash: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const n of this.walk()) {
      const marker = tiledOverlayInfo(n);
      if (marker && !seen.has(marker.hash)) {
        seen.add(marker.hash);
        out.push({ hash: marker.hash, name: n.name || 'Raster' });
      }
    }
    return out;
  }

  /** Total node + placemark counts, for the status bar. */
  stats(): { features: number; folders: number; total: number } {
    let features = 0;
    let folders = 0;
    let total = 0;
    for (const n of this.walk()) {
      total++;
      if (n.type === 'Placemark') features++;
      else if (n.type === 'Folder' || n.type === 'Document') folders++;
    }
    return { features, folders, total };
  }
}
