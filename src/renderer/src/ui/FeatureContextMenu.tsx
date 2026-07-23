import { useEffect } from 'react';
import { useStore } from '@renderer/state/store';

interface Props {
  nodeId: string;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Right-click / option-click menu for a feature on the globe: edit its shape,
 * rename, cut/copy/paste (as a sibling), or delete. Mirrors the tree's context
 * menu so both surfaces offer the same actions.
 */
export function FeatureContextMenu({ nodeId, x, y, onClose }: Props): JSX.Element | null {
  const docOf = useStore((s) => s.docOf);
  // Re-resolve when the clipboard or content changes so Paste enables correctly.
  useStore((s) => s.revision);
  const doc = docOf(nodeId);
  const node = doc?.nodeById(nodeId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!doc || !node) return null;

  const s = useStore.getState;
  const canEdit = node.type === 'Placemark' && !!node.geometry;
  const canPaste = doc.clipboardSize > 0;
  const parentId = doc.parentOf(nodeId)?.id ?? doc.root.id;

  const act = (fn: () => void) => (): void => {
    fn();
    onClose();
  };

  const doDelete = (): void => {
    if (window.confirm(`Delete “${node.name || '(unnamed)'}”?`)) s().remove([nodeId]);
  };

  return (
    <>
      <div
        className="ctx-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <ul className="ctx-menu" style={{ left: x, top: y }}>
        {canEdit && <li onClick={act(() => s().setMode('edit'))}>Edit shape</li>}
        <li onClick={act(() => s().requestRename(nodeId))}>Rename</li>
        <li onClick={act(() => s().openRestyle([nodeId]))}>Restyle…</li>
        <li onClick={act(() => s().openDescriptionEditor(nodeId))}>Edit description…</li>
        <li className="sep" />
        <li onClick={act(() => s().cut([nodeId]))}>Cut</li>
        <li onClick={act(() => s().copy([nodeId]))}>Copy</li>
        <li
          className={canPaste ? '' : 'disabled'}
          onClick={canPaste ? act(() => s().paste(parentId)) : undefined}
        >
          Paste
        </li>
        <li className="sep" />
        <li onClick={act(doDelete)}>Delete</li>
      </ul>
    </>
  );
}
