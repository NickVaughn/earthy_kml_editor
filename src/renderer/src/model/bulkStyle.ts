import type {
  KmlDocumentData,
  KmlNode,
  KmlStyle,
  IconStyle,
  LabelStyle,
  LineStyle,
  PolyStyle,
} from './types';
import { effectiveStyle } from './style';
import { nextId } from './ids';

/**
 * A partial style change to apply in bulk. Only the sub-styles present are
 * touched; within each, only defined properties are written.
 */
export interface StylePatch {
  icon?: Partial<IconStyle>;
  label?: Partial<LabelStyle>;
  line?: Partial<LineStyle>;
  poly?: Partial<PolyStyle>;
}

type SubKey = 'icon' | 'label' | 'line' | 'poly';

function patchedSubs(patch: StylePatch): SubKey[] {
  return (['icon', 'label', 'line', 'poly'] as SubKey[]).filter((k) => patch[k]);
}

/** Merge a patch into a style object in place. */
function applyPatchTo(style: KmlStyle, patch: StylePatch): void {
  for (const k of patchedSubs(patch)) {
    style[k] = { ...(style[k] as object), ...(patch[k] as object) } as never;
  }
}

function cloneStyle(s: KmlStyle | undefined): KmlStyle {
  return s ? structuredClone(s) : {};
}

/** Replace all own keys of `target` with those from `snapshot` (identity kept). */
function restoreInPlace(target: Record<string, unknown>, snapshot: Record<string, unknown>): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, structuredClone(snapshot));
}

function freshStyleId(doc: KmlDocumentData): string {
  let id = '';
  do {
    id = `nge-${nextId()}`;
  } while (doc.sharedStyles.has(id) || doc.sharedStyleMaps.has(id));
  return id;
}

/** Count how many placemarks in the whole doc reference `#id` via styleUrl. */
function countStyleUrlRefs(root: KmlNode, id: string): number {
  const target = `#${id}`;
  let n = 0;
  const walk = (node: KmlNode) => {
    if (node.type === 'Placemark' && node.styleUrl === target) n++;
    for (const c of node.children) walk(c);
  };
  walk(root);
  return n;
}

export interface BulkStyleResult {
  /** Number of shared styles patched in place. */
  patched: number;
  /** Number of new shared styles created. */
  created: number;
  /** Reverse the entire operation. */
  undo(): void;
}

/**
 * Apply `patch` to every placemark in `targets`. Where all users of a shared
 * style are within the target set, the shared style is patched in place (keeps
 * the file lean — one <Style> updated, not N). Otherwise a new shared style is
 * forked for the group. Returns an inverse for undo. See PLAN §4.3.
 */
export function applyBulkStyle(
  doc: KmlDocumentData,
  targets: KmlNode[],
  patch: StylePatch,
): BulkStyleResult {
  const subs = patchedSubs(patch);
  const undoers: Array<() => void> = [];
  let patched = 0;
  let created = 0;

  // Group targets by their current styleUrl string.
  const groups = new Map<string, KmlNode[]>();
  for (const node of targets) {
    const key = node.styleUrl ?? '';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(node);
  }

  for (const [styleUrl, group] of groups) {
    const refId = styleUrl.startsWith('#') ? styleUrl.slice(1) : '';
    const sharedStyle = refId ? doc.sharedStyles.get(refId) : undefined;
    const allUsersSelected =
      !!sharedStyle && countStyleUrlRefs(doc.root, refId) === group.length;

    if (sharedStyle && allUsersSelected) {
      // Patch the shared style in place — everyone updates at once.
      const before = structuredClone(sharedStyle) as Record<string, unknown>;
      applyPatchTo(sharedStyle, patch);
      undoers.push(() => restoreInPlace(sharedStyle as Record<string, unknown>, before));
      patched++;
    } else {
      // Fork a new shared style from the group's representative effective style.
      const base = cloneStyle(effectiveStyle(doc, group[0]));
      applyPatchTo(base, patch);
      const id = freshStyleId(doc);
      base.id = id;
      doc.sharedStyles.set(id, base);
      doc.root.styles = doc.root.styles ?? [];
      doc.root.styles.push({ kind: 'Style', style: base });
      doc.sharedOrder.push(id);
      created++;

      // Re-point group members; clear inline sub-styles the patch covers so the
      // shared style wins.
      const pointerUndo: Array<() => void> = [];
      for (const node of group) {
        const oldUrl = node.styleUrl;
        const oldInline = node.inlineStyle ? structuredClone(node.inlineStyle) : undefined;
        node.styleUrl = `#${id}`;
        if (node.inlineStyle) {
          for (const k of subs) delete (node.inlineStyle as Record<string, unknown>)[k];
          if (Object.keys(node.inlineStyle).length === 0) node.inlineStyle = undefined;
        }
        pointerUndo.push(() => {
          node.styleUrl = oldUrl;
          node.inlineStyle = oldInline;
        });
      }
      undoers.push(() => {
        for (const u of pointerUndo) u();
        // Remove the forked shared style.
        doc.sharedStyles.delete(id);
        const idx = doc.root.styles!.findIndex(
          (e) => e.kind === 'Style' && e.style === base,
        );
        if (idx >= 0) doc.root.styles!.splice(idx, 1);
        const oidx = doc.sharedOrder.indexOf(id);
        if (oidx >= 0) doc.sharedOrder.splice(oidx, 1);
      });
    }
  }

  return {
    patched,
    created,
    undo() {
      // Reverse in reverse order.
      for (let i = undoers.length - 1; i >= 0; i--) undoers[i]();
    },
  };
}
