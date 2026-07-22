import { useStore, type InteractionMode } from '@renderer/state/store';
import { BASEMAPS } from '@renderer/globe/imagery';

interface Props {
  onOpen: () => void;
  onChangeBasemap: (id: string) => void;
}

export function Toolbar({ onOpen, onChangeBasemap }: Props): JSX.Element {
  const settings = useStore((s) => s.settings);
  const hasGoogleKey = useStore((s) => s.hasGoogleKey);
  const docCount = useStore((s) => s.docs.length);
  const mode = useStore((s) => s.interactionMode);
  const setMode = useStore((s) => s.setMode);
  const selection = useStore((s) => s.selection);
  const docOf = useStore((s) => s.docOf);

  const selNode = selection.length === 1 ? docOf(selection[0])?.nodeById(selection[0]) : undefined;
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

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button onClick={onOpen}>Open…</button>
        <span className="filename">
          {docCount === 0
            ? 'No files open'
            : `${docCount} file${docCount === 1 ? '' : 's'} — right-click a file to save`}
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
        <button
          className="help-btn"
          title="Keyboard shortcuts (?)"
          onClick={() => useStore.getState().setHelpOpen(true)}
        >
          ⌨
        </button>
      </div>
    </div>
  );
}
