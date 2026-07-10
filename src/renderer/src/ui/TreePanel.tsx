import {
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  createContext,
  useContext,
} from 'react';
import { Tree, type NodeRendererProps, type NodeApi } from 'react-arborist';
import { useStore } from '@renderer/state/store';
import type { KmlNode } from '@renderer/model/types';

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

function geometryIcon(node: KmlNode): string {
  if (node.type !== 'Placemark' || !node.geometry) return ICON[node.type] ?? '•';
  switch (node.geometry.kind) {
    case 'Point':
      return '📍';
    case 'LineString':
      return '➰';
    case 'Polygon':
      return '⬡';
    case 'MultiGeometry':
      return '❖';
  }
}

function Row({ node, style, dragHandle }: NodeRendererProps<KmlNode>): JSX.Element {
  const data = node.data;
  const selection = useStore((s) => s.selection);
  const toggleVisibility = useStore((s) => s.toggleVisibility);
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
      <span className="tree-icon">{geometryIcon(data)}</span>
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
  const treeRef = useRef<{ get(id: string): NodeApi<KmlNode> | null } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

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

  const menuAction = useCallback(
    (action: string) => {
      const s = st.getState();
      const sel = s.selection;
      const target = containerTarget();
      switch (action) {
        case 'newFolder':
          if (target) s.createFolder(target);
          break;
        case 'rename': {
          const n = treeRef.current?.get(menu!.nodeId);
          n?.edit();
          break;
        }
        case 'delete':
          s.remove(sel);
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
    [menu, containerTarget, closeMenu, st, onSave, onSaveAs],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const s = st.getState();
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.selection.length) {
          e.preventDefault();
          s.remove(s.selection);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') s.copy(s.selection);
      else if ((e.metaKey || e.ctrlKey) && e.key === 'x') s.cut(s.selection);
      else if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        const t = containerTarget();
        if (t) s.paste(t);
      }
    },
    [containerTarget, st],
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
          onClick={() => st.getState().remove(selection)}
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
          openByDefault
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
          const canPaste = !!menuDoc && menuDoc.clipboardSize > 0;
          return (
            <ul className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
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
