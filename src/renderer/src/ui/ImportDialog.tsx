import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@renderer/state/store';
import { withGdalJob, GdalCancelled } from '@renderer/state/gdalJob';
import {
  RAMPS,
  rampColor,
  defaultCategories,
  distinctCategoryValues,
  isSequentialRamp,
  sortSequentialValues,
  type RampName,
  type FillMode,
  type CategorySpec,
} from '@renderer/model/geojson';
import { StyleSwatch, CategoryEditor } from './CategoryEditor';
import { isDelimitedText, type CsvOptions } from '@shared/gdal';

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
  const [rampReversed, setRampReversed] = useState(false);
  const [fillMode, setFillMode] = useState<FillMode>('both');
  const [fillOpacity, setFillOpacity] = useState(0.5);
  const [lineOpacity, setLineOpacity] = useState(1);
  const [lineWidth, setLineWidth] = useState(1);
  // undefined = write no LabelStyle, i.e. the reader's default size.
  const [labelScale, setLabelScale] = useState<number | undefined>(undefined);
  const [categories, setCategories] = useState<CategorySpec[]>([]);
  const [categoryFolders, setCategoryFolders] = useState(true);
  const [editingCat, setEditingCat] = useState<number | null>(null);
  // Custom folder names when grouping by a field other than the colour field.
  const [groupNames, setGroupNames] = useState<{ value: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);

  // Delimited text has no geometry or CRS of its own. GDAL autodetects the
  // usual coordinate column names on the first read; these override it when it
  // misses, and declare what CRS the numbers are in.
  const [xField, setXField] = useState('');
  const [yField, setYField] = useState('');
  const [epsg, setEpsg] = useState(4326);
  const [reinspecting, setReinspecting] = useState(false);

  // Cache the converted GeoJSON so Back → Next doesn't re-run GDAL.
  const cache = useRef<{ layer: string; geojson: string } | null>(null);

  const layer = pending?.info.layers[layerIdx];
  const isPoint = !!layer?.geometryType?.includes('Point');
  const isCsv = !!pending && isDelimitedText(pending.path);
  const csvOptions: CsvOptions | undefined = isCsv
    ? { xField: xField || undefined, yField: yField || undefined, epsg }
    : undefined;
  // Autodetection either found geometry or it didn't; if it didn't, the import
  // would produce placemarks with no location, so block it and say why.
  const csvNeedsColumns = isCsv && !layer?.geometryType;
  const showFill = fillMode !== 'outline';
  const showOutline = fillMode !== 'fill';

  // Folders come from `groupField`; colours from `categoryField`. When they
  // differ, category labels on page 2 no longer name the folders, so folder
  // names get their own page and page-2 labels become read-only.
  const hasCategories = !!categoryField;
  const needsFolderPage = !!groupField && groupField !== categoryField;
  const folderNameEditable = !groupField || groupField === categoryField;

  // Coordinate columns stay in the attribute table (they are the file's data),
  // but they are not balloon material: repeating a placemark's own coordinates
  // back at the reader is noise. Uncheck them whenever the set changes — which
  // includes the moment the user picks different ones. Checking them again
  // afterwards is a deliberate act and survives, since the set has not moved.
  const geomColumnKey = (pending?.info.csvGeometryColumns ?? []).join('|');
  useEffect(() => {
    if (!geomColumnKey) return;
    const geom = geomColumnKey.split('|');
    setDescFields((prev) => prev.filter((f) => !geom.includes(f)));
  }, [geomColumnKey]);

  const categoryPreview = useMemo(() => {
    if (!layer || !categoryField) return [];
    const f = layer.fields.find((x) => x.name === categoryField);
    const values = f ? [...new Set(f.samples)] : [];
    // Sequential ramps map an ORDER, so preview (and later seed) the values
    // sorted; the qualitative palette keeps first-seen order.
    return isSequentialRamp(ramp) ? sortSequentialValues(values) : values;
  }, [layer, categoryField, ramp]);

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

  // Cache key includes the CSV options: changing a coordinate column or the
  // EPSG changes the geometry, so the cached GeoJSON must not be reused.
  const convertKey = `${layer.name}|${xField}|${yField}|${epsg}`;
  const convert = async (): Promise<string> => {
    if (cache.current?.layer === convertKey) return cache.current.geojson;
    const converted = await withGdalJob(`Converting ${layer.name}…`, () =>
      window.api.convertVector(pending.path, layer.name, csvOptions),
    );
    cache.current = { layer: convertKey, geojson: converted.geojson };
    return converted.geojson;
  };

  /**
   * Re-read the file with the chosen coordinate columns, so the summary line,
   * the field list and the geometry type all reflect what will be imported.
   */
  const reinspect = async (next: { x?: string; y?: string; epsg?: number }): Promise<void> => {
    const x = next.x ?? xField;
    const y = next.y ?? yField;
    const code = next.epsg ?? epsg;
    setXField(x);
    setYField(y);
    setEpsg(code);
    cache.current = null;
    setReinspecting(true);
    try {
      const info = await window.api.inspectVector(pending.path, {
        xField: x || undefined,
        yField: y || undefined,
        epsg: code,
      });
      if (info.layers.length) setPending({ path: pending.path, info });
    } catch (err) {
      alert(`Could not re-read the file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReinspecting(false);
    }
  };

  const goToCategories = async (): Promise<void> => {
    setBusy(true);
    setImportStatus(`Reading ${layer.name}…`);
    try {
      const geojson = await convert();
      let values = distinctCategoryValues(geojson, categoryField);
      if (isSequentialRamp(ramp)) values = sortSequentialValues(values);
      setCategories(
        defaultCategories(values, { ramp, rampReversed, fillMode, fillOpacity, lineOpacity }),
      );
      setImportStatus(null);
      setStep(2);
    } catch (err) {
      setImportStatus(null);
      if (err instanceof GdalCancelled) return;
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
      if (err instanceof GdalCancelled) return;
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
        rampReversed,
        fillMode,
        fillOpacity,
        lineOpacity,
        lineWidth,
        labelScale,
      });
      setImportStatus(`Imported ${count.toLocaleString()} features from ${layer.name}`);
      setTimeout(() => useStore.getState().setImportStatus(null), 4000);
      close();
    } catch (err) {
      setImportStatus(null);
      if (err instanceof GdalCancelled) return;
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

        {isCsv && (
          <fieldset className="restyle-group">
            <legend>Coordinates</legend>
            <div className="modal-summary">
              {csvNeedsColumns
                ? 'No coordinate columns detected — pick them below.'
                : `Detected ${layer.geometryType ?? 'geometry'} from this file's columns.`}
            </div>
            <label className="insp-row">
              <span>Longitude / X</span>
              <select
                value={xField}
                disabled={reinspecting}
                onChange={(e) => void reinspect({ x: e.target.value })}
              >
                <option value="">(auto-detect)</option>
                {(pending.info.csvColumns ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="insp-row">
              <span>Latitude / Y</span>
              <select
                value={yField}
                disabled={reinspecting}
                onChange={(e) => void reinspect({ y: e.target.value })}
              >
                <option value="">(auto-detect)</option>
                {(pending.info.csvColumns ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="insp-row">
              <span>EPSG</span>
              <input
                type="number"
                min="1024"
                max="32767"
                step="1"
                value={epsg}
                disabled={reinspecting}
                onChange={(e) => setEpsg(Number(e.target.value) || 4326)}
                onBlur={(e) => void reinspect({ epsg: Number(e.target.value) || 4326 })}
              />
              <span className="opacity-val">
                {epsg === 4326 ? 'lon/lat' : 'projected'}
              </span>
            </label>
            <div className="modal-summary">
              The CRS these coordinates are in. KML is always WGS84, so anything
              other than 4326 is reprojected on import.
            </div>
          </fieldset>
        )}

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
            {isSequentialRamp(ramp) && (
              <label className="field-check">
                <input
                  type="checkbox"
                  checked={rampReversed}
                  onChange={(e) => setRampReversed(e.target.checked)}
                />
                Reverse ramp
              </label>
            )}
            {categoryPreview.length > 0 && (
              <div className="cat-preview">
                {categoryPreview.map((v, i) => (
                  <span key={v} className="cat-chip">
                    <i
                      style={{
                        background: rampColor(ramp, i, categoryPreview.length, rampReversed),
                      }}
                    />
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
        {isPoint && (
          <label className="insp-row">
            <span>Label size</span>
            <input
              type="number"
              min="0"
              max="10"
              step="0.1"
              placeholder="default"
              value={labelScale ?? ''}
              onChange={(e) =>
                setLabelScale(e.target.value === '' ? undefined : Number(e.target.value))
              }
            />
            <span className="opacity-val">×</span>
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
          <div className="field-col">
            <div className="field-actions">
              <button
                onClick={() =>
                  setDescFields(
                    layer.fields
                      .map((f) => f.name)
                      .filter((n) => !(pending.info.csvGeometryColumns ?? []).includes(n)),
                  )
                }
              >
                Check all
              </button>
              <button onClick={() => setDescFields([])}>Uncheck all</button>
            </div>
            {layer.fields.map((f) => {
              const isGeom = (pending.info.csvGeometryColumns ?? []).includes(f.name);
              return (
                <label key={f.name} className="field-check">
                  <input
                    type="checkbox"
                    checked={descFields.includes(f.name)}
                    onChange={() => toggleDesc(f.name)}
                  />
                  {f.name}
                  {isGeom && <span className="muted"> · coordinate</span>}
                </label>
              );
            })}
          </div>
        </div>

        <div className="modal-actions">
          {csvNeedsColumns && (
            <span className="muted">Pick coordinate columns to continue</span>
          )}
          <button onClick={close} disabled={busy}>
            Cancel
          </button>
          {hasCategories ? (
            <button
              className="primary"
              onClick={goToCategories}
              disabled={busy || csvNeedsColumns}
            >
              {busy ? 'Reading…' : 'Next: categories →'}
            </button>
          ) : needsFolderPage ? (
            <button
              className="primary"
              onClick={goToFolders}
              disabled={busy || csvNeedsColumns}
            >
              {busy ? 'Reading…' : 'Next: folders →'}
            </button>
          ) : (
            <button className="primary" onClick={runImport} disabled={busy || csvNeedsColumns}>
              {busy ? 'Importing…' : `Import ${layer.featureCount.toLocaleString()} features`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
