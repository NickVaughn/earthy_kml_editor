import { parseKml } from './parse';
import { serializeKml } from './serialize';
import { effectiveStyle } from './style';
import type { KmlDocumentData, KmlNode, KmlStyle } from './types';
import { CONTAINER_TYPES } from './types';

/**
 * The live document model wrapping the parsed data. Phase 1 uses it read-only
 * (load, traverse, resolve styles, serialize). Phase 2 adds mutation + undo.
 */
export class KmlDocument {
  data: KmlDocumentData;
  /** Source file path (null for unsaved). */
  path: string | null = null;
  wasKmz = false;
  resources: Record<string, string> = {};
  dirty = false;

  private index = new Map<string, KmlNode>();

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
        id: 'root',
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
    const walk = (n: KmlNode) => {
      this.index.set(n.id, n);
      for (const c of n.children) walk(c);
    };
    walk(this.data.root);
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
    // Build a parent map lazily is overkill; walk from root tracking ancestry.
    const path = this.pathTo(node.id);
    if (!path) return node.visible;
    return path.every((n) => n.visible);
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
    for (const n of this.walk()) {
      if (n.children.some((c) => c.id === id)) return n;
    }
    return null;
  }

  serialize(): string {
    return serializeKml(this.data);
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
