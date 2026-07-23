import { useState } from 'react';
import { useStore } from '@renderer/state/store';

/**
 * Edit one feature's <description>. Opened from a feature's context menu
 * (replacing the always-on inspector panel).
 */
export function DescriptionDialog({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}): JSX.Element | null {
  const docOf = useStore((s) => s.docOf);
  const setDescription = useStore((s) => s.setDescription);
  const node = docOf(nodeId)?.nodeById(nodeId);
  const [text, setText] = useState(node?.description ?? '');

  if (!node) return null;

  const save = (): void => {
    setDescription(nodeId, text);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Description — {node.name || <span className="muted">(unnamed)</span>}
        </div>
        <div className="modal-summary">
          HTML is allowed; it renders in the feature’s balloon.
        </div>
        <textarea
          className="desc-editor"
          autoFocus
          rows={10}
          value={text}
          placeholder="(none)"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
