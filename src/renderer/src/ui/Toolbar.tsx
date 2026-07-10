import { useStore, type InteractionMode } from '@renderer/state/store';
import { BASEMAPS } from '@renderer/globe/imagery';

interface Props {
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onChangeBasemap: (id: string) => void;
}

export function Toolbar({ onOpen, onSave, onSaveAs, onChangeBasemap }: Props): JSX.Element {
  const settings = useStore((s) => s.settings);
  const hasGoogleKey = useStore((s) => s.hasGoogleKey);
  const dirty = useStore((s) => s.dirty);
  const filePath = useStore((s) => s.filePath);
  const mode = useStore((s) => s.interactionMode);
  const setMode = useStore((s) => s.setMode);
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);

  const selNode = selection.length === 1 ? doc.nodeById(selection[0]) : undefined;
  const canEdit = !!(selNode?.type === 'Placemark' && selNode.geometry);

  const tool = (m: InteractionMode, label: string, title: string, disabled = false) => (
    <button
      className={`tool${mode === m ? ' active' : ''}`}
      title={title}
      disabled={disabled}
      onClick={() => setMode(mode === m ? 'none' : m)}
    >
      {label}
    </button>
  );

  const fileName = filePath ? filePath.split('/').pop() : 'Untitled';

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button onClick={onOpen}>Open…</button>
        <button onClick={onSave}>Save</button>
        <button onClick={onSaveAs}>Save As…</button>
        <span className="filename">
          {fileName}
          {dirty ? ' •' : ''}
        </span>
      </div>
      <div className="toolbar-tools">
        {tool('draw-point', '📍', 'Add point')}
        {tool('draw-line', '〜', 'Draw line')}
        {tool('draw-polygon', '⬡', 'Draw polygon')}
        {tool('edit', '✎', canEdit ? 'Edit vertices' : 'Select one feature to edit', !canEdit)}
        {tool('measure', '📏', 'Measure distance / area')}
      </div>
      <div className="toolbar-right">
        <label className="basemap-label">Basemap</label>
        <select
          value={settings.basemap}
          onChange={(e) => onChangeBasemap(e.target.value)}
        >
          {BASEMAPS.map((b) => (
            <option
              key={b.id}
              value={b.id}
              disabled={b.needsGoogleKey && !hasGoogleKey}
            >
              {b.label}
              {b.needsGoogleKey && !hasGoogleKey ? ' (no key)' : ''}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
