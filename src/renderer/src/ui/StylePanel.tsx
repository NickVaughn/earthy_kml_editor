import { useMemo, useState, useCallback } from 'react';
import { useStore } from '@renderer/state/store';
import type { KmlNode, KmlStyle } from '@renderer/model/types';
import type { StylePatch } from '@renderer/model/bulkStyle';
import { kmlToHexRgb, kmlToRgba, hexRgbToKml } from '@renderer/model/colors';

const ICON_PRESETS: { label: string; href: string }[] = [
  { label: 'Yellow pin', href: 'http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png' },
  { label: 'Red pin', href: 'http://maps.google.com/mapfiles/kml/pushpin/red-pushpin.png' },
  { label: 'Blue pin', href: 'http://maps.google.com/mapfiles/kml/pushpin/blue-pushpin.png' },
  { label: 'Green pin', href: 'http://maps.google.com/mapfiles/kml/pushpin/grn-pushpin.png' },
  { label: 'White circle', href: 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png' },
];

/** Common value across an array, or undefined if mixed/empty (indeterminate). */
function common<T>(values: (T | undefined)[]): T | undefined {
  const defined = values.filter((v) => v !== undefined);
  if (defined.length === 0) return undefined;
  const first = defined[0];
  return defined.every((v) => v === first) ? first : undefined;
}

interface Selected {
  placemarks: KmlNode[];
  styles: KmlStyle[];
  hasPoint: boolean;
  hasLine: boolean;
  hasPoly: boolean;
}

export function StylePanel(): JSX.Element | null {
  const docs = useStore((s) => s.docs);
  const docOf = useStore((s) => s.docOf);
  const selection = useStore((s) => s.selection);
  const revision = useStore((s) => s.revision);
  const applyStyle = useStore((s) => s.applyStyle);

  const sel: Selected = useMemo(() => {
    const placemarks: KmlNode[] = [];
    const styles: KmlStyle[] = [];
    const seen = new Set<string>();
    for (const id of selection) {
      const doc = docOf(id);
      const node = doc?.nodeById(id);
      if (!doc || !node) continue;
      for (const n of doc.walk(node)) {
        if (n.type === 'Placemark' && n.geometry && !seen.has(n.id)) {
          seen.add(n.id);
          placemarks.push(n);
          styles.push(doc.styleFor(n));
        }
      }
    }
    const kinds = (n: KmlNode): string => n.geometry?.kind ?? '';
    return {
      placemarks,
      styles,
      hasPoint: placemarks.some((p) => kinds(p) === 'Point' || kinds(p) === 'MultiGeometry'),
      hasLine: placemarks.some((p) =>
        ['LineString', 'Polygon', 'MultiGeometry'].includes(kinds(p)),
      ),
      hasPoly: placemarks.some((p) => kinds(p) === 'Polygon' || kinds(p) === 'MultiGeometry'),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, revision, docs]);

  const [patch, setPatch] = useState<StylePatch>({});

  const setSub = useCallback((k: keyof StylePatch, v: Record<string, unknown>) => {
    setPatch((p) => ({ ...p, [k]: { ...(p[k] as object), ...v } }));
  }, []);

  const apply = useCallback(() => {
    if (Object.keys(patch).length === 0) return;
    const res = applyStyle(patch);
    setPatch({});
    void res;
  }, [patch, applyStyle]);

  if (sel.placemarks.length === 0) return null;

  const lineColor = common(sel.styles.map((s) => s.line?.color));
  const lineWidth = common(sel.styles.map((s) => s.line?.width));
  const polyColor = common(sel.styles.map((s) => s.poly?.color));
  const iconColor = common(sel.styles.map((s) => s.icon?.color));
  const iconScale = common(sel.styles.map((s) => s.icon?.scale));

  const dirty = Object.keys(patch).length > 0;

  return (
    <div className="style-panel">
      <div className="style-head">
        Style — {sel.placemarks.length.toLocaleString()} feature
        {sel.placemarks.length === 1 ? '' : 's'}
      </div>

      {sel.hasPoint && (
        <fieldset>
          <legend>Point</legend>
          <ColorRow
            label="Icon"
            kmlColor={patch.icon?.color ?? iconColor}
            indeterminate={iconColor === undefined && !patch.icon?.color}
            onChange={(c) => setSub('icon', { color: c })}
          />
          <label className="style-row">
            <span>Scale</span>
            <input
              type="number"
              step="0.1"
              min="0"
              defaultValue={iconScale ?? 1}
              onChange={(e) => setSub('icon', { scale: Number(e.target.value) })}
            />
          </label>
          <label className="style-row">
            <span>Icon</span>
            <select onChange={(e) => e.target.value && setSub('icon', { iconHref: e.target.value })}>
              <option value="">(keep)</option>
              {ICON_PRESETS.map((i) => (
                <option key={i.href} value={i.href}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}

      {sel.hasLine && (
        <fieldset>
          <legend>Line</legend>
          <ColorRow
            label="Color"
            kmlColor={patch.line?.color ?? lineColor}
            indeterminate={lineColor === undefined && !patch.line?.color}
            onChange={(c) => setSub('line', { color: c })}
          />
          <label className="style-row">
            <span>Width</span>
            <input
              type="number"
              step="0.5"
              min="0"
              defaultValue={lineWidth ?? 2}
              onChange={(e) => setSub('line', { width: Number(e.target.value) })}
            />
          </label>
        </fieldset>
      )}

      {sel.hasPoly && (
        <fieldset>
          <legend>Polygon</legend>
          <ColorRow
            label="Fill"
            kmlColor={patch.poly?.color ?? polyColor}
            indeterminate={polyColor === undefined && !patch.poly?.color}
            onChange={(c) => setSub('poly', { color: c })}
          />
          <label className="style-row">
            <span>Fill</span>
            <input
              type="checkbox"
              defaultChecked={common(sel.styles.map((s) => s.poly?.fill)) !== false}
              onChange={(e) => setSub('poly', { fill: e.target.checked })}
            />
          </label>
          <label className="style-row">
            <span>Outline</span>
            <input
              type="checkbox"
              defaultChecked={common(sel.styles.map((s) => s.poly?.outline)) !== false}
              onChange={(e) => setSub('poly', { outline: e.target.checked })}
            />
          </label>
        </fieldset>
      )}

      <button className="apply-btn" disabled={!dirty} onClick={apply}>
        Apply to {sel.placemarks.length.toLocaleString()}
      </button>
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
    <div className="style-row">
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
