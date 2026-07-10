import { useStore } from '@renderer/state/store';

/**
 * Edit the selected feature's name and description. Shown only when exactly one
 * placemark is selected.
 */
export function Inspector(): JSX.Element | null {
  const selection = useStore((s) => s.selection);
  const docOf = useStore((s) => s.docOf);
  const revision = useStore((s) => s.revision);
  const rename = useStore((s) => s.rename);
  const setDescription = useStore((s) => s.setDescription);
  void revision; // re-render on model changes

  const node = selection.length === 1 ? docOf(selection[0])?.nodeById(selection[0]) : undefined;
  if (!node || node.type !== 'Placemark') return null;

  return (
    <div className="inspector">
      <div className="inspector-head">Feature</div>
      <label className="insp-row">
        <span>Name</span>
        <input
          type="text"
          value={node.name}
          onChange={(e) => rename(node.id, e.target.value)}
        />
      </label>
      <label className="insp-row insp-desc">
        <span>Description</span>
        <textarea
          rows={3}
          value={node.description ?? ''}
          placeholder="(none)"
          onChange={(e) => setDescription(node.id, e.target.value)}
        />
      </label>
    </div>
  );
}
