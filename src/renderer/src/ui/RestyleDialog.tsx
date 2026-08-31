import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@renderer/state/store';
import type { KmlNode, KmlStyle } from '@renderer/model/types';
import type { StylePatch } from '@renderer/model/bulkStyle';
import { kmlToHexRgb, kmlToRgba, hexRgbToKml } from '@renderer/model/colors';
import {
  RAMPS,
  rampColor,
  defaultCategories,
  isSequentialRamp,
  placemarkFieldValue,
  NAME_FIELD,
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

/** Common value across an array, or undefined if mixed/empty (indeterminate). */
function common<T>(values: (T | undefined)[]): T | undefined {
  const defined = values.filter((v) => v !== undefined);
  if (defined.length === 0) return undefined;
  const first = defined[0];
  return defined.every((v) => v === first) ? first : undefined;
}

/**
 * Restyle a selection of features/folders. "(single colour)" applies a uniform
 * style patch; picking a field recolours by category (like the import dialog).
 * Opened from the tree/globe context menus.
 */
export function RestyleDialog({
  ids,
  onClose,
}: {
  ids: string[];
  onClose: () => void;
}): JSX.Element | null {
  const docOf = useStore((s) => s.docOf);
  const applyStyleTo = useStore((s) => s.applyStyleTo);
  const restyleByField = useStore((s) => s.restyleByField);
  const revision = useStore((s) => s.revision);

  // Gather the affected placemarks, their current styles, and candidate fields.
  const t = useMemo(() => {
    const nodes: KmlNode[] = [];
    const styles: KmlStyle[] = [];
    const fieldSet = new Set<string>();
    const seen = new Set<string>();
    for (const id of ids) {
      const doc = docOf(id);
      const node = doc?.nodeById(id);
      if (!doc || !node) continue;
      for (const p of doc.placemarksUnder(node)) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        nodes.push(p);
        styles.push(doc.styleFor(p));
        for (const f of p.extendedData?.fields ?? []) fieldSet.add(f.name);
      }
    }
    const kind = (n: KmlNode): string => n.geometry?.kind ?? '';
    return {
      nodes,
      styles,
      fields: [...fieldSet],
      hasPoint: nodes.some((n) => kind(n) === 'Point' || kind(n) === 'MultiGeometry'),
      hasLine: nodes.some((n) => ['LineString', 'Polygon', 'MultiGeometry'].includes(kind(n))),
      hasPoly: nodes.some((n) => kind(n) === 'Polygon' || kind(n) === 'MultiGeometry'),
    };
  }, [ids, docOf, revision]);

  const canCategorize = t.nodes.length > 1;

  // Shared state
  const [field, setField] = useState(''); // '' = single colour

  // Single-colour patch
  const [patch, setPatch] = useState<StylePatch>({});
  const setSub = (k: keyof StylePatch, v: Record<string, unknown>): void =>
    setPatch((p) => ({ ...p, [k]: { ...(p[k] as object), ...v } }));

  // Categorized controls
  const [ramp, setRamp] = useState<RampName>('category');
  const [rampReversed, setRampReversed] = useState(false);
  const [fillMode, setFillMode] = useState<FillMode>('both');
  const [fillOpacity, setFillOpacity] = useState(0.5);
  const [lineOpacity, setLineOpacity] = useState(1);
  const [lineWidth, setLineWidth] = useState(1);
  // undefined = leave each style's existing label size alone.
  const [labelScale, setLabelScale] = useState<number | undefined>(undefined);
  const [categories, setCategories] = useState<CategorySpec[]>([]);
  const [editingCat, setEditingCat] = useState<number | null>(null);

  const distinct = useMemo(() => {
    if (!field) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const n of t.nodes) {
      const v = placemarkFieldValue(n, field);
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }, [field, t.nodes]);

  // Seed category specs when the field (or its set of values) changes. The
  // global knobs below patch the seeded categories in place rather than
  // reseeding, so per-category fine-tuning survives.
  useEffect(() => {
    if (field) {
      setCategories(
        defaultCategories(distinct, { ramp, rampReversed, fillMode, fillOpacity, lineOpacity }),
      );
      setEditingCat(null);
    }
  }, [field, distinct]);

  const patchAllCategories = (p: Partial<CategorySpec>): void =>
    setCategories((prev) => prev.map((c) => ({ ...c, ...p })));

  const changeRamp = (r: RampName, reversed = rampReversed): void => {
    setRamp(r);
    setRampReversed(reversed);
    setCategories((prev) =>
      prev.map((c, i) => ({ ...c, color: rampColor(r, i, prev.length, reversed) })),
    );
  };

  if (t.nodes.length === 0) return null;

  const isPointLayer = t.hasPoint && !t.hasLine && !t.hasPoly;
  const updateCat = (i: number, p: Partial<CategorySpec>): void =>
    setCategories((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...p } : c)));

  const lineColor = common(t.styles.map((s) => s.line?.color));
  const polyColor = common(t.styles.map((s) => s.poly?.color));
  const iconColor = common(t.styles.map((s) => s.icon?.color));
  const iconScale = common(t.styles.map((s) => s.icon?.scale));
  const lineWidthNow = common(t.styles.map((s) => s.line?.width));
  const labelScaleNow = common(t.styles.map((s) => s.label?.scale));

  const singleDirty = Object.keys(patch).length > 0;

  const apply = (): void => {
    if (field) {
      restyleByField(ids, field, categories, lineWidth, labelScale);
    } else {
      if (!singleDirty) return;
      applyStyleTo(ids, patch);
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Restyle{' '}
          <span className="muted">
            ({t.nodes.length.toLocaleString()} feature{t.nodes.length === 1 ? '' : 's'})
          </span>
        </div>

        {canCategorize && (
          <label className="insp-row">
            <span>Colour by</span>
            <select value={field} onChange={(e) => setField(e.target.value)}>
              <option value="">(single colour)</option>
              <option value={NAME_FIELD}>Name</option>
              {t.fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        )}

        {field ? (
          <>
            <label className="insp-row">
              <span>Ramp</span>
              <select value={ramp} onChange={(e) => changeRamp(e.target.value as RampName)}>
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
                  onChange={(e) => changeRamp(ramp, e.target.checked)}
                />
                Reverse ramp
              </label>
            )}
            <label className="insp-row">
              <span>Style</span>
              <select
                value={fillMode}
                onChange={(e) => {
                  const m = e.target.value as FillMode;
                  setFillMode(m);
                  patchAllCategories({ fillMode: m });
                }}
              >
                {FILL_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {fillMode !== 'fill' && (
              <label className="insp-row">
                <span>Outline</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={lineOpacity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setLineOpacity(v);
                    patchAllCategories({ lineOpacity: v });
                  }}
                />
                <span className="opacity-val">{Math.round(lineOpacity * 100)}%</span>
              </label>
            )}
            {fillMode !== 'outline' && (
              <label className="insp-row">
                <span>Fill</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={fillOpacity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setFillOpacity(v);
                    patchAllCategories({ fillOpacity: v });
                  }}
                />
                <span className="opacity-val">{Math.round(fillOpacity * 100)}%</span>
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
            {t.hasPoint && (
              <label className="insp-row">
                <span>Label size</span>
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  placeholder="unchanged"
                  value={labelScale ?? ''}
                  onChange={(e) =>
                    setLabelScale(e.target.value === '' ? undefined : Number(e.target.value))
                  }
                />
                <span className="opacity-val">×</span>
              </label>
            )}

            <div className="modal-summary">
              {categories.length} categor{categories.length === 1 ? 'y' : 'ies'} · click a swatch
              to fine-tune
            </div>
            <div className="cat-list">
              {categories.map((cat, i) => (
                <div key={cat.value} className="cat-row">
                  <button
                    className="cat-swatch-btn"
                    title="Edit style"
                    onClick={() => setEditingCat(editingCat === i ? null : i)}
                  >
                    <StyleSwatch spec={cat} isPoint={isPointLayer} />
                  </button>
                  <span className="cat-row-name cat-row-name-static">{cat.label}</span>
                  <span className="muted cat-row-value" title={cat.value}>
                    {cat.value || '(blank)'}
                  </span>
                  {editingCat === i && (
                    <CategoryEditor
                      spec={cat}
                      isPoint={isPointLayer}
                      onChange={(p) => updateCat(i, p)}
                      onClose={() => setEditingCat(null)}
                    />
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {t.hasPoint && (
              <fieldset className="restyle-group">
                <legend>Point</legend>
                <ColorRow
                  label="Icon"
                  kmlColor={patch.icon?.color ?? iconColor}
                  indeterminate={iconColor === undefined && !patch.icon?.color}
                  onChange={(c) => setSub('icon', { color: c })}
                />
                <label className="insp-row">
                  <span>Scale</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    defaultValue={iconScale ?? 1}
                    onChange={(e) => setSub('icon', { scale: Number(e.target.value) })}
                  />
                </label>
                <label className="insp-row">
                  <span>Label size</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    defaultValue={labelScaleNow ?? 1}
                    onChange={(e) => setSub('label', { scale: Number(e.target.value) })}
                  />
                </label>
              </fieldset>
            )}
            {t.hasLine && (
              <fieldset className="restyle-group">
                <legend>Line</legend>
                <ColorRow
                  label="Colour"
                  kmlColor={patch.line?.color ?? lineColor}
                  indeterminate={lineColor === undefined && !patch.line?.color}
                  onChange={(c) => setSub('line', { color: c })}
                />
                <label className="insp-row">
                  <span>Width</span>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    defaultValue={lineWidthNow ?? 2}
                    onChange={(e) => setSub('line', { width: Number(e.target.value) })}
                  />
                </label>
              </fieldset>
            )}
            {t.hasPoly && (
              <fieldset className="restyle-group">
                <legend>Polygon</legend>
                <ColorRow
                  label="Fill"
                  kmlColor={patch.poly?.color ?? polyColor}
                  indeterminate={polyColor === undefined && !patch.poly?.color}
                  onChange={(c) => setSub('poly', { color: c })}
                />
                <label className="insp-row">
                  <span>Fill</span>
                  <input
                    type="checkbox"
                    defaultChecked={common(t.styles.map((s) => s.poly?.fill)) !== false}
                    onChange={(e) => setSub('poly', { fill: e.target.checked })}
                  />
                </label>
                <label className="insp-row">
                  <span>Outline</span>
                  <input
                    type="checkbox"
                    defaultChecked={common(t.styles.map((s) => s.poly?.outline)) !== false}
                    onChange={(e) => setSub('poly', { outline: e.target.checked })}
                  />
                </label>
              </fieldset>
            )}
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply} disabled={!field && !singleDirty}>
            Apply to {t.nodes.length.toLocaleString()}
          </button>
        </div>
      </div>
    </div>
  );
}

function ColorRow({
  label,
  kmlColor,
  indeterminate,
  onChange,
}: {
  label: string;
  kmlColor: string | undefined;
  indeterminate: boolean;
  onChange: (kml: string) => void;
}): JSX.Element {
  const hex = kmlColor ? kmlToHexRgb(kmlColor) : '#ffffff';
  const alpha = kmlColor ? kmlToRgba(kmlColor).a / 255 : 1;
  return (
    <div className="insp-row">
      <span>{label}</span>
      <input
        type="color"
        value={hex}
        title={indeterminate ? 'Mixed values' : label}
        onChange={(e) => onChange(hexRgbToKml(e.target.value, alpha))}
        style={indeterminate ? { opacity: 0.5 } : undefined}
      />
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        defaultValue={alpha}
        title="Opacity"
        onChange={(e) => onChange(hexRgbToKml(hex, Number(e.target.value)))}
      />
    </div>
  );
}
