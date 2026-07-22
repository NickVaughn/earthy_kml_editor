import { useMemo, useRef, useState } from 'react';
import { useStore } from '@renderer/state/store';
import {
  RAMPS,
  rampColor,
  defaultCategories,
  distinctCategoryValues,
  type RampName,
  type FillMode,
  type CategorySpec,
} from '@renderer/model/geojson';
import { StyleSwatch, CategoryEditor } from './CategoryEditor';

const FILL_MODES: { id: FillMode; label: string }[] = [
  { id: 'both', label: 'Outline + fill' },
  { id: 'outline', label: 'Outline only' },
  { id: 'fill', label: 'Fill only' },
];

export function ImportDialog(): JSX.Element | null {
  const pending = useStore((s) => s.pendingImport);
  const setPending = useStore((s) => s.setPendingImport);
  const setImportStatus = useStore((s) => s.setImportStatus);
  const importGeoJson = useStore((s) => s.importGeoJson);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [layerIdx, setLayerIdx] = useState(0);
  const [nameField, setNameField] = useState('');
  const [descFields, setDescFields] = useState<string[]>([]);
  const [groupField, setGroupField] = useState('');
  const [categoryField, setCategoryField] = useState('');
  const [ramp, setRamp] = useState<RampName>('category');
  const [fillMode, setFillMode] = useState<FillMode>('both');
  const [fillOpacity, setFillOpacity] = useState(0.5);
  const [lineOpacity, setLineOpacity] = useState(1);
  const [lineWidth, setLineWidth] = useState(1);
  const [categories, setCategories] = useState<CategorySpec[]>([]);
  const [categoryFolders, setCategoryFolders] = useState(true);
  const [editingCat, setEditingCat] = useState<number | null>(null);
  // Custom folder names when grouping by a field other than the colour field.
  const [groupNames, setGroupNames] = useState<{ value: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);

  // Cache the converted GeoJSON so Back → Next doesn't re-run GDAL.
  const cache = useRef<{ layer: string; geojson: string } | null>(null);

  const layer = pending?.info.layers[layerIdx];
  const isPoint = !!layer?.geometryType?.includes('Point');
  const showFill = fillMode !== 'outline';
  const showOutline = fillMode !== 'fill';

  // Folders come from `groupField`; colours from `categoryField`. When they
  // differ, category labels on page 2 no longer name the folders, so folder
  // names get their own page and page-2 labels become read-only.
  const hasCategories = !!categoryField;
  const needsFolderPage = !!groupField && groupField !== categoryField;
  const folderNameEditable = !groupField || groupField === categoryField;

  const categoryPreview = useMemo(() => {
    if (!layer || !categoryField) return [];
    const f = layer.fields.find((x) => x.name === categoryField);
    return f ? [...new Set(f.samples)] : [];
  }, [layer, categoryField]);

  if (!pending || !layer) return null;

  const close = (): void => {
    setPending(null);
    setStep(1);
    setLayerIdx(0);
    setNameField('');
    setDescFields([]);
    setGroupField('');
    setCategoryField('');
    setCategories([]);
    setGroupNames([]);
    setEditingCat(null);
    cache.current = null;
  };

  const convert = async (): Promise<string> => {
    if (cache.current?.layer === layer.name) return cache.current.geojson;
    const converted = await window.api.convertVector(pending.path, layer.name);
    cache.current = { layer: layer.name, geojson: converted.geojson };
    return converted.geojson;
  };

  const goToCategories = async (): Promise<void> => {
    setBusy(true);
    setImportStatus(`Reading ${layer.name}…`);
    try {
      const geojson = await convert();
      const values = distinctCategoryValues(geojson, categoryField);
      setCategories(defaultCategories(values, { ramp, fillMode, fillOpacity, lineOpacity }));
      setImportStatus(null);
      setStep(2);
    } catch (err) {
      setImportStatus(null);
      alert(`Could not read categories: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const goToFolders = async (): Promise<void> => {
    setBusy(true);
    setImportStatus(`Reading ${layer.name}…`);
    try {
      const geojson = await convert();
      const values = distinctCategoryValues(geojson, groupField);
      setGroupNames(values.map((value) => ({ value, label: value.trim() || '(blank)' })));
      setImportStatus(null);
      setStep(3);
    } catch (err) {
      setImportStatus(null);
      alert(`Could not read folders: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (): Promise<void> => {
    setBusy(true);
    setImportStatus(`Importing ${layer.name}…`);
    try {
      const geojson = await convert();
      const count = importGeoJson(geojson, {
        layerName: layer.name,
        nameField: nameField || undefined,
        descriptionFields: descFields.length ? descFields : undefined,
        groupField: groupField || undefined,
        groupLabels: needsFolderPage
          ? Object.fromEntries(groupNames.map((g) => [g.value, g.label]))
          : undefined,
        styleMode: categoryField ? 'categorized' : 'single',
        categoryField: categoryField || undefined,
        categories: hasCategories ? categories : undefined,
        categoryFolders,
        ramp,
        fillMode,
        fillOpacity,
        lineOpacity,
        lineWidth,
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

  const updateCat = (i: number, patch: Partial<CategorySpec>): void =>
    setCategories((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const fileName = pending.path.split('/').pop();

  // ---- Page 2: per-category fine-tuning -----------------------------------
  if (step === 2) {
    return (
      <div className="modal-backdrop" onClick={() => setEditingCat(null)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            Categories — {categoryField}{' '}
            <span className="muted">({categories.length})</span>
          </div>
          <div className="modal-summary">
            {folderNameEditable ? 'Rename or restyle' : 'Restyle'} each value. Click a swatch
            to edit its colours.
            {!folderNameEditable && (
              <> Folder names are set on the next page.</>
            )}
          </div>

          <label className="field-check" style={{ margin: '2px 0 8px' }}>
            <input
              type="checkbox"
              checked={categoryFolders}
              onChange={(e) => setCategoryFolders(e.target.checked)}
            />
            Group features into a folder per category
          </label>

          <div className="cat-list">
            {categories.map((cat, i) => (
              <div key={cat.value} className="cat-row">
                <button
                  className="cat-swatch-btn"
                  title="Edit style"
                  onClick={() => setEditingCat(editingCat === i ? null : i)}
                >
                  <StyleSwatch spec={cat} isPoint={isPoint} />
                </button>
                {folderNameEditable ? (
                  <input
                    className="cat-row-name"
                    value={cat.label}
                    onChange={(e) => updateCat(i, { label: e.target.value })}
                  />
                ) : (
                  <span className="cat-row-name cat-row-name-static">{cat.label}</span>
                )}
                <span className="muted cat-row-value" title={cat.value}>
                  {cat.value || '(blank)'}
                </span>
                {editingCat === i && (
                  <CategoryEditor
                    spec={cat}
                    isPoint={isPoint}
                    onChange={(patch) => updateCat(i, patch)}
                    onClose={() => setEditingCat(null)}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="modal-actions">
            <button onClick={() => setStep(1)} disabled={busy}>
              ← Back
            </button>
            {needsFolderPage ? (
              <button className="primary" onClick={goToFolders} disabled={busy}>
                {busy ? 'Reading…' : 'Next: folders →'}
              </button>
            ) : (
              <button className="primary" onClick={runImport} disabled={busy}>
                {busy ? 'Importing…' : `Import ${layer.featureCount.toLocaleString()} features`}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- Page 3: folder names -----------------------------------------------
  if (step === 3) {
    return (
      <div className="modal-backdrop" onClick={close}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            Folders — {groupField} <span className="muted">({groupNames.length})</span>
          </div>
          <div className="modal-summary">
            Rename the folder created for each value of “{groupField}”.
          </div>

          <div className="cat-list">
            {groupNames.map((g, i) => (
              <div key={g.value} className="cat-row">
                <input
                  className="cat-row-name"
                  value={g.label}
                  onChange={(e) =>
                    setGroupNames((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)),
                    )
                  }
                />
                <span className="muted cat-row-value" title={g.value}>
                  {g.value || '(blank)'}
                </span>
              </div>
            ))}
          </div>

          <div className="modal-actions">
            <button onClick={() => setStep(hasCategories ? 2 : 1)} disabled={busy}>
              ← Back
            </button>
            <button className="primary" onClick={runImport} disabled={busy}>
              {busy ? 'Importing…' : `Import ${layer.featureCount.toLocaleString()} features`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Page 1: setup -------------------------------------------------------
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Import “{fileName}” <span className="muted">({pending.info.driver})</span>
        </div>

        {pending.info.layers.length > 1 && (
          <label className="insp-row">
            <span>Layer</span>
            <select
              value={layerIdx}
              onChange={(e) => {
                setLayerIdx(Number(e.target.value));
                cache.current = null;
              }}
            >
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
          {layer.geometryType ? ` · ${layer.geometryType}` : ''} · {layer.fields.length}{' '}
          attributes
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

        {categoryField ? (
          <>
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
            {categoryPreview.length > 0 && (
              <div className="cat-preview">
                {categoryPreview.map((v, i) => (
                  <span key={v} className="cat-chip">
                    <i style={{ background: rampColor(ramp, i, categoryPreview.length) }} />
                    {v || '(blank)'}
                  </span>
                ))}
                <span className="muted"> …fine-tune each on the next page</span>
              </div>
            )}
          </>
        ) : null}

        <label className="insp-row">
          <span>Style</span>
          <select value={fillMode} onChange={(e) => setFillMode(e.target.value as FillMode)}>
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
        <label className="insp-row">
          <span>Line width</span>
          <input
            type="number"
            min="0.5"
            max="20"
            step="0.5"
            value={lineWidth}
            onChange={(e) => setLineWidth(Math.max(0.5, Number(e.target.value) || 1))}
          />
          <span className="opacity-val">px</span>
        </label>
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
          <div className="field-col">
            <div className="field-actions">
              <button onClick={() => setDescFields(layer.fields.map((f) => f.name))}>
                Check all
              </button>
              <button onClick={() => setDescFields([])}>Uncheck all</button>
            </div>
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
          {hasCategories ? (
            <button className="primary" onClick={goToCategories} disabled={busy}>
              {busy ? 'Reading…' : 'Next: categories →'}
            </button>
          ) : needsFolderPage ? (
            <button className="primary" onClick={goToFolders} disabled={busy}>
              {busy ? 'Reading…' : 'Next: folders →'}
            </button>
          ) : (
            <button className="primary" onClick={runImport} disabled={busy}>
              {busy ? 'Importing…' : `Import ${layer.featureCount.toLocaleString()} features`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
