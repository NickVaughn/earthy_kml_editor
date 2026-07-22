import { useMemo, useState } from 'react';
import { useStore } from '@renderer/state/store';
import { rampColor, RAMPS, type RampName, type FillMode } from '@renderer/model/geojson';

const FILL_MODES: { id: FillMode; label: string }[] = [
  { id: 'both', label: 'Outline + fill' },
  { id: 'outline', label: 'Outline only' },
  { id: 'fill', label: 'Fill only' },
];

/**
 * Options for importing an OGR vector layer: which layer, which attribute
 * becomes the feature name, which attributes appear in the balloon, and whether
 * to colour features by a category field.
 */
export function ImportDialog(): JSX.Element | null {
  const pending = useStore((s) => s.pendingImport);
  const setPending = useStore((s) => s.setPendingImport);
  const setImportStatus = useStore((s) => s.setImportStatus);
  const importGeoJson = useStore((s) => s.importGeoJson);

  const [layerIdx, setLayerIdx] = useState(0);
  const [nameField, setNameField] = useState('');
  const [descFields, setDescFields] = useState<string[]>([]);
  const [groupField, setGroupField] = useState('');
  const [categoryField, setCategoryField] = useState('');
  const [ramp, setRamp] = useState<RampName>('category');
  const [fillMode, setFillMode] = useState<FillMode>('both');
  const [fillOpacity, setFillOpacity] = useState(0.5);
  const [lineOpacity, setLineOpacity] = useState(1);
  const [busy, setBusy] = useState(false);

  const layer = pending?.info.layers[layerIdx];
  const showFill = fillMode === 'fill' || fillMode === 'both';
  const showOutline = fillMode === 'outline' || fillMode === 'both';

  // Distinct values preview for the chosen category field (from samples).
  const categoryPreview = useMemo(() => {
    if (!layer || !categoryField) return [];
    const f = layer.fields.find((x) => x.name === categoryField);
    return f ? [...new Set(f.samples)] : [];
  }, [layer, categoryField]);

  if (!pending || !layer) return null;

  const close = (): void => {
    setPending(null);
    setLayerIdx(0);
    setNameField('');
    setDescFields([]);
    setGroupField('');
    setCategoryField('');
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    setImportStatus(`Importing ${layer.name}…`);
    try {
      const converted = await window.api.convertVector(pending.path, layer.name);
      const count = importGeoJson(converted.geojson, {
        layerName: layer.name,
        nameField: nameField || undefined,
        descriptionFields: descFields.length ? descFields : undefined,
        groupField: groupField || undefined,
        styleMode: categoryField ? 'categorized' : 'single',
        categoryField: categoryField || undefined,
        ramp,
        fillMode,
        fillOpacity,
        lineOpacity,
      });
      setImportStatus(`Imported ${count.toLocaleString()} features from ${layer.name}`);
      setTimeout(() => useStore.getState().setImportStatus(null), 4000);
      close();
    } catch (err) {
      setImportStatus(null);
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleDesc = (name: string): void =>
    setDescFields((prev) =>
      prev.includes(name) ? prev.filter((f) => f !== name) : [...prev, name],
    );

  const fileName = pending.path.split('/').pop();

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Import “{fileName}” <span className="muted">({pending.info.driver})</span>
        </div>

        {pending.info.layers.length > 1 && (
          <label className="insp-row">
            <span>Layer</span>
            <select value={layerIdx} onChange={(e) => setLayerIdx(Number(e.target.value))}>
              {pending.info.layers.map((l, i) => (
                <option key={l.name} value={i}>
                  {l.name} ({l.featureCount.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="modal-summary">
          {layer.featureCount.toLocaleString()} features
          {layer.geometryType ? ` · ${layer.geometryType}` : ''} ·{' '}
          {layer.fields.length} attributes
        </div>

        <label className="insp-row">
          <span>Name from</span>
          <select value={nameField} onChange={(e) => setNameField(e.target.value)}>
            <option value="">(no name)</option>
            {layer.fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
                {f.samples[0] ? ` — e.g. ${f.samples[0]}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="insp-row">
          <span>Group into</span>
          <select value={groupField} onChange={(e) => setGroupField(e.target.value)}>
            <option value="">(no sub-folders)</option>
            {layer.fields.map((f) => (
              <option key={f.name} value={f.name}>
                folders by {f.name}
              </option>
            ))}
          </select>
        </label>

        <label className="insp-row">
          <span>Colour by</span>
          <select value={categoryField} onChange={(e) => setCategoryField(e.target.value)}>
            <option value="">(single colour)</option>
            {layer.fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        {categoryField && (
          <label className="insp-row">
            <span>Ramp</span>
            <select value={ramp} onChange={(e) => setRamp(e.target.value as RampName)}>
              {RAMPS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {categoryPreview.length > 0 && (
          <div className="cat-preview">
            {categoryPreview.map((v, i) => (
              <span key={v} className="cat-chip">
                <i style={{ background: rampColor(ramp, i, categoryPreview.length) }} />
                {v || '(blank)'}
              </span>
            ))}
            <span className="muted"> …one style per distinct value</span>
          </div>
        )}

        <label className="insp-row">
          <span>Style</span>
          <select
            value={fillMode}
            onChange={(e) => setFillMode(e.target.value as FillMode)}
          >
            {FILL_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        {showOutline && (
          <label className="insp-row">
            <span>Outline</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={lineOpacity}
              onChange={(e) => setLineOpacity(Number(e.target.value))}
            />
            <span className="opacity-val">{Math.round(lineOpacity * 100)}%</span>
          </label>
        )}
        {showFill && (
          <label className="insp-row">
            <span>Fill</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={fillOpacity}
              onChange={(e) => setFillOpacity(Number(e.target.value))}
            />
            <span className="opacity-val">{Math.round(fillOpacity * 100)}%</span>
          </label>
        )}

        <div className="insp-row insp-desc">
          <span>Balloon</span>
          <div className="field-list">
            {layer.fields.map((f) => (
              <label key={f.name} className="field-check">
                <input
                  type="checkbox"
                  checked={descFields.includes(f.name)}
                  onChange={() => toggleDesc(f.name)}
                />
                {f.name}
              </label>
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={run} disabled={busy}>
            {busy ? 'Importing…' : `Import ${layer.featureCount.toLocaleString()} features`}
          </button>
        </div>
      </div>
    </div>
  );
}
