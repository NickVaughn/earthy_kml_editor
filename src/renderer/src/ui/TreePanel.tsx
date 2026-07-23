import {
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  createContext,
  useContext,
} from 'react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';
import { useStore } from '@renderer/state/store';
import type { KmlDocument } from '@renderer/model/document';
import type { Geometry, KmlNode } from '@renderer/model/types';
import { kmlToCss } from '@renderer/model/colors';

const RowCtx = createContext<(e: React.MouseEvent, id: string) => void>(() => {});

// Horizontal offset (px) from a row's indent edge to its checkbox: the twisty
// (14px) plus the checkbox margin. The drop cursor is shifted by this so the
// line left-aligns with the checkboxes at the target depth, making "into folder"
// vs "sibling" unambiguous.
const CHECKBOX_OFFSET = 16;

/** Custom drop indicator aligned to the checkbox column. */
function MoveCursor({ top, left, indent }: { top: number; left: number; indent: number }): JSX.Element {
  return (
    <div
      className="drop-cursor"
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        top: top - 1,
        left: left + CHECKBOX_OFFSET,
        right: indent,
      }}
    >
      <div className="drop-cursor-dot" />
      <div className="drop-cursor-line" />
    </div>
  );
}

interface Props {
  onFlyTo: (id: string) => void;
  onOpenBalloon: (id: string) => void;
  onSave: (docId: string) => void;
  onSaveAs: (docId: string) => void;
}

const ICON: Record<string, string> = {
  Document: '🗂',
  Folder: '📁',
  Placemark: '📍',
  GroundOverlay: '🖼',
  ScreenOverlay: '🖼',
  NetworkLink: '🔗',
  Unknown: '❓',
};

/** Reduce a (possibly multi-) geometry to the glyph kind that best represents it. */
function primaryKind(g: Geometry): 'Point' | 'LineString' | 'Polygon' {
  if (g.kind === 'MultiGeometry') {
    const kinds = g.geometries.map(primaryKind);
    if (kinds.includes('Polygon')) return 'Polygon';
    if (kinds.includes('LineString')) return 'LineString';
    return 'Point';
  }
  return g.kind;
}

/**
 * A small swatch that mirrors the feature's effective style (colour + shape),
 * so the tree reads like the map. Containers fall back to their emoji glyph.
 */
function FeatureIcon({ node, doc }: { node: KmlNode; doc?: KmlDocument }): JSX.Element {
  if (node.type !== 'Placemark' || !node.geometry) {
    return <span className="tree-icon">{ICON[node.type] ?? '•'}</span>;
  }
  const style = doc?.styleFor(node);
  const lineColor = kmlToCss(style?.line?.color ?? 'ffffffff');
  const kind = primaryKind(node.geometry);
  let glyph: JSX.Element;
  if (kind === 'Point') {
    const fill = kmlToCss(style?.icon?.color ?? 'ffffffff');
    glyph = <circle cx="7" cy="7" r="4" fill={fill} stroke="rgba(0,0,0,0.35)" strokeWidth="1" />;
  } else if (kind === 'LineString') {
    glyph = (
      <path
        d="M1.5 10.5 L5 4.5 L9 8 L12.5 2.5"
        fill="none"
        stroke={lineColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  } else {
    const showFill = style?.poly?.fill !== false;
    const showOutline = style?.poly?.outline !== false;
    const fill = showFill ? kmlToCss(style?.poly?.color ?? '80ffffff') : 'none';
    glyph = (
      <rect
        x="2"
        y="2.5"
        width="10"
        height="9"
        rx="1.5"
        fill={fill}
        stroke={showOutline ? lineColor : 'none'}
        strokeWidth="1.5"
      />
    );
  }
  return (
    <svg className="tree-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {glyph}
    </svg>
  );
}

function Row({ node, style, dragHandle }: NodeRendererProps<KmlNode>): JSX.Element {
  const data = node.data;
  const selection = useStore((s) => s.selection);
  const toggleVisibility = useStore((s) => s.toggleVisibility);
  const doc = useStore((s) => s.docOf(data.id));
  // Re-resolve the style swatch whenever rendered content changes.
  useStore((s) => s.sceneEpoch);
  const dirtyRoot = useStore((s) => {
    const d = s.docs.find((doc) => doc.root.id === data.id);
    return d ? d.dirty : false;
  });
  const openMenu = useContext(RowCtx);
  const isSelected = selection.includes(data.id);

  return (
    <div
      className={`tree-row${isSelected ? ' selected' : ''}`}
      style={style}
      ref={dragHandle}
      onContextMenu={(e) => openMenu(e, data.id)}
    >
      <span
        className="twisty"
        onClick={(e) => {
          e.stopPropagation();
          if (!node.isLeaf) node.toggle();
        }}
      >
        {node.isLeaf ? '' : node.isOpen ? '▾' : '▸'}
      </span>
      <input
        type="checkbox"
        checked={data.visible}
        onChange={(e) => {
          e.stopPropagation();
          toggleVisibility(data.id);
        }}
        onClick={(e) => e.stopPropagation()}
        title="Visibility"
      />
      <FeatureIcon node={data} doc={doc} />
      {node.isEditing ? (
        <input
          className="tree-rename"
          autoFocus
          defaultValue={data.name}
          onBlur={(e) => node.submit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') node.submit(e.currentTarget.value);
            if (e.key === 'Escape') node.reset();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="tree-name">
          {data.name || <em>(unnamed)</em>}
          {dirtyRoot ? ' •' : ''}
        </span>
      )}
    </div>
  );
}

interface MenuState {
  x: number;
  y: number;
  nodeId: string;
}

export function TreePanel({ onFlyTo, onOpenBalloon, onSave, onSaveAs }: Props): JSX.Element {
  const docs = useStore((s) => s.docs);
  const docEpoch = useStore((s) => s.docEpoch);
  const revision = useStore((s) => s.revision);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const st = useStore;
  const treeRef = useRef<TreeApi<KmlNode> | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Track which container ids we've already applied an initial open/closed state
  // to, so re-seeding (on file open/close/new) never clobbers manual toggles.
  const seeded = useRef<Set<string>>(new Set());
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    let changed = false;
    for (const d of docs) {
      for (const n of d.walk()) {
        if (n.type === 'Placemark' || seeded.current.has(n.id)) continue;
        seeded.current.add(n.id);
        // A document root defaults to open; other folders open only when the KML
        // explicitly said so (<open>1</open>). Everything else starts collapsed.
        const shouldOpen = d.root.id === n.id ? n.open !== false : n.open === true;
        if (shouldOpen) {
          tree.open(n.id, false);
          changed = true;
        }
      }
    }
    if (changed) tree.redrawList();
  }, [docs, docEpoch]);

  // Reveal the selected feature: expand its ancestor folders and scroll it into
  // view (scrollTo opens parents on the way). Handy when selecting on the globe.
  useEffect(() => {
    const id = selection[0];
    if (id) treeRef.current?.scrollTo(id);
  }, [selection]);

  // Honour a rename request (e.g. from the globe menu) by starting inline edit.
  const renameRequestId = useStore((s) => s.renameRequestId);
  useEffect(() => {
    if (!renameRequestId) return;
    const tree = treeRef.current;
    if (tree) {
      setSelection([renameRequestId]);
      tree.edit(renameRequestId);
    }
    st.getState().requestRename(null);
  }, [renameRequestId, setSelection, st]);

  // Measure available height so the Tree (which needs an explicit height) fills
  // whatever space the sidebar gives it, even as the style panel appears.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(400);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTreeHeight(el.clientHeight));
    ro.observe(el);
    setTreeHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => docs.map((d) => d.root), [docs, docEpoch, revision]);

  const onMove = useCallback(
    (args: { dragIds: string[]; parentId: string | null; index: number }) => {
      // Null parent = top level; land in the dragged nodes' own document root.
      const target = args.parentId ?? st.getState().docOf(args.dragIds[0])?.root.id;
      if (target) st.getState().move(args.dragIds, target, args.index);
    },
    [st],
  );

  const onRename = useCallback(
    (args: { id: string; name: string }) => st.getState().rename(args.id, args.name),
    [st],
  );

  // Where a paste/new-folder should land: a selected container, else the parent
  // of the selection, else the selection's document root, else the first doc.
  const containerTarget = useCallback((): string | undefined => {
    const s = st.getState();
    const sel = s.selection[0];
    if (!sel) return s.docs[0]?.root.id;
    const doc = s.docOf(sel);
    if (!doc) return s.docs[0]?.root.id;
    const node = doc.nodeById(sel);
    if (node && doc.isContainer(node)) return node.id;
    return doc.parentOf(sel)?.id ?? doc.root.id;
  }, [st]);

  const openMenu = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (!st.getState().selection.includes(nodeId)) setSelection([nodeId]);
      setMenu({ x: e.clientX, y: e.clientY, nodeId });
    },
    [setSelection, st],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  // Confirm before deleting real items. Root ids (close file) skip this and fall
  // through to remove(), which runs its own discard-changes confirmation.
  const confirmRemove = useCallback(
    (ids: string[]) => {
      const s = st.getState();
      const items = ids.filter((id) => !s.isRoot(id));
      if (items.length) {
        const label =
          items.length === 1
            ? `“${s.docOf(items[0])?.nodeById(items[0])?.name || '(unnamed)'}”`
            : `${items.length} items`;
        if (!window.confirm(`Delete ${label}?`)) return;
      }
      s.remove(ids);
    },
    [st],
  );

  const menuAction = useCallback(
    (action: string) => {
      const s = st.getState();
      const sel = s.selection;
      const target = containerTarget();
      switch (action) {
        case 'zoom':
          onFlyTo(menu!.nodeId);
          break;
        case 'newFolder':
          if (target) s.createFolder(target);
          break;
        case 'rename': {
          const n = treeRef.current?.get(menu!.nodeId);
          n?.edit();
          break;
        }
        case 'delete':
          confirmRemove(sel);
          break;
        case 'restyle':
          s.openRestyle(sel.length ? sel : [menu!.nodeId]);
          break;
        case 'editDesc':
          s.openDescriptionEditor(menu!.nodeId);
          break;
        case 'checkAll':
          s.setChildrenVisibility(menu!.nodeId, true, false);
          break;
        case 'uncheckAll':
          s.setChildrenVisibility(menu!.nodeId, false, false);
          break;
        case 'checkAllRec':
          s.setChildrenVisibility(menu!.nodeId, true, true);
          break;
        case 'uncheckAllRec':
          s.setChildrenVisibility(menu!.nodeId, false, true);
          break;
        case 'cut':
          s.cut(sel);
          break;
        case 'copy':
          s.copy(sel);
          break;
        case 'paste':
          if (target) s.paste(target);
          break;
        case 'save':
        case 'saveAs': {
          const doc = s.docs.find((d) => d.root.id === menu!.nodeId);
          if (doc) (action === 'save' ? onSave : onSaveAs)(doc.id);
          break;
        }
        case 'close': {
          const doc = s.docs.find((d) => d.root.id === menu!.nodeId);
          if (doc) {
            if (!doc.dirty || window.confirm('Close this file and discard unsaved changes?')) {
              s.closeDoc(doc.id);
            }
          }
          break;
        }
      }
      closeMenu();
    },
    [menu, containerTarget, closeMenu, confirmRemove, st, onSave, onSaveAs, onFlyTo],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const s = st.getState();
      // Only the Delete key removes items — Backspace must not (too easy to hit).
      if (e.key === 'Delete') {
        if (s.selection.length) {
          e.preventDefault();
          confirmRemove(s.selection);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') s.copy(s.selection);
      else if ((e.metaKey || e.ctrlKey) && e.key === 'x') s.cut(s.selection);
      else if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        const t = containerTarget();
        if (t) s.paste(t);
      }
    },
    [containerTarget, confirmRemove, st],
  );

  return (
    <div className="tree-panel" onKeyDown={onKeyDown} onClick={closeMenu}>
      <div className="tree-toolbar">
        <button
          title="New folder"
          disabled={docs.length === 0}
          onClick={() => {
            const t = containerTarget();
            if (t) st.getState().createFolder(t);
          }}
        >
          ＋📁
        </button>
        <button
          title="Delete"
          disabled={selection.length === 0}
          onClick={() => confirmRemove(selection)}
        >
          🗑
        </button>
        <span className="tree-count">{selection.length ? `${selection.length} selected` : ''}</span>
      </div>
      <div className="tree-scroll" ref={scrollRef}>
      <RowCtx.Provider value={openMenu}>
        <Tree<KmlNode>
          ref={treeRef as never}
          data={data}
          idAccessor="id"
          childrenAccessor={(n) => (n.type === 'Placemark' ? null : n.children)}
          openByDefault={false}
          width="100%"
          height={treeHeight}
          rowHeight={26}
          indent={22}
          renderCursor={MoveCursor}
          onSelect={(nodes) => setSelection(nodes.map((n) => n.data.id))}
          onMove={onMove}
          onRename={onRename}
          onActivate={(node) => {
            onFlyTo(node.data.id);
            if (node.data.type === 'Placemark') onOpenBalloon(node.data.id);
          }}
        >
          {Row}
        </Tree>
      </RowCtx.Provider>
      </div>

      {menu &&
        (() => {
          const isRoot = docs.some((d) => d.root.id === menu.nodeId);
          const menuDoc = docs.find((d) => d.nodeById(menu.nodeId));
          const menuNode = menuDoc?.nodeById(menu.nodeId);
          const isContainer = !!menuNode && !!menuDoc && menuDoc.isContainer(menuNode);
          const isFeature = menuNode?.type === 'Placemark';
          const canPaste = !!menuDoc && menuDoc.clipboardSize > 0;
          return (
            <ul className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
              <li onClick={() => menuAction('zoom')}>Zoom to</li>
              <li className="sep" />
              {isContainer && (
                <>
                  <li onClick={() => menuAction('checkAll')}>Check all</li>
                  <li onClick={() => menuAction('uncheckAll')}>Uncheck all</li>
                  <li onClick={() => menuAction('checkAllRec')}>Check all (recursive)</li>
                  <li onClick={() => menuAction('uncheckAllRec')}>Uncheck all (recursive)</li>
                  <li className="sep" />
                </>
              )}
              {isRoot && (
                <>
                  <li onClick={() => menuAction('save')}>Save</li>
                  <li onClick={() => menuAction('saveAs')}>Save As…</li>
                  <li onClick={() => menuAction('close')}>Close File</li>
                  <li className="sep" />
                </>
              )}
              <li onClick={() => menuAction('newFolder')}>New Folder</li>
              <li onClick={() => menuAction('rename')}>Rename</li>
              {(isFeature || isContainer) && (
                <li onClick={() => menuAction('restyle')}>Restyle…</li>
              )}
              {isFeature && (
                <li onClick={() => menuAction('editDesc')}>Edit description…</li>
              )}
              <li className="sep" />
              <li onClick={() => menuAction('cut')}>Cut</li>
              <li onClick={() => menuAction('copy')}>Copy</li>
              <li
                className={canPaste ? '' : 'disabled'}
                onClick={() => canPaste && menuAction('paste')}
              >
                Paste
              </li>
              <li className="sep" />
              <li onClick={() => menuAction('delete')}>
                {isRoot ? 'Close File' : 'Delete'}
              </li>
            </ul>
          );
        })()}
    </div>
  );
}
