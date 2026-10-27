import { useRef, useState } from 'react';
import { useStore } from '@renderer/state/store';
import type { AppSettings } from '@shared/ipc';
import {
  RULER_SHAPES,
  LENGTH_UNITS,
  AREA_UNITS,
  rulerShapeInfo,
  rulerRows,
  rulerGeometry,
  committedPoints,
  formatLength,
  formatArea,
  formatQuantity,
  type RulerRow,
} from '@renderer/model/ruler';

interface Props {
  onSave: () => void;
  onClear: () => void;
}

/**
 * Keep a click on the panel's controls from taking keyboard focus, so Enter,
 * Esc and Backspace go on reaching the ruler instead of the button.
 */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault();

const ROW_TIPS: Record<string, string> = {
  'Map Length': 'Distance along the ellipsoid, as on a map',
  'Ground Length':
    'Distance along the terrain, rising and falling with the relief — the same as the map length while 3D terrain is off',
  Heading: 'Direction from the start towards the end, clockwise from north',
};

/** Google Earth's Ruler window: a tab per kind of measurement, live readings, Save and Clear. */
export function RulerPanel({ onSave, onClear }: Props): JSX.Element {
  const shape = useStore((s) => s.rulerShape);
  const setShape = useStore((s) => s.setRulerShape);
  const reading = useStore((s) => s.rulerReading);
  const settings = useStore((s) => s.settings);

  // Dragged by its title bar, kept inside the globe.
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const update = (patch: Partial<AppSettings>): void => {
    const s = useStore.getState();
    s.setSettings({ ...s.settings, ...patch });
    void window.api.setSettings(patch);
  };

  const info = rulerShapeInfo(shape);
  const rows = rulerRows(reading, shape);
  const mine = reading?.shape === shape ? reading : null;
  const canSave = !!mine && rulerGeometry(shape, committedPoints(mine), () => 0) !== null;
  const canClear = !!mine && mine.points.length > 0;

  const value = (row: RulerRow): string => {
    if (row.value === null) return '…';
    if (row.quantity === 'length') return formatLength(row.value, settings.rulerLengthUnit);
    if (row.quantity === 'area') return formatArea(row.value, settings.rulerAreaUnit);
    return formatQuantity(row.value);
  };

  // The unit menu sits on the first row of its kind, as in Google Earth.
  const seen = new Set<string>();
  const unit = (row: RulerRow): JSX.Element | null => {
    if (row.quantity === 'heading') return <span className="ruler-unit-text">degrees</span>;
    if (seen.has(row.quantity)) return null;
    seen.add(row.quantity);
    return row.quantity === 'length' ? (
      <select
        value={settings.rulerLengthUnit}
        onChange={(e) => update({ rulerLengthUnit: e.target.value })}
      >
        {LENGTH_UNITS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </select>
    ) : (
      <select value={settings.rulerAreaUnit} onChange={(e) => update({ rulerAreaUnit: e.target.value })}>
        {AREA_UNITS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </select>
    );
  };

  const onHeadDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, left: offset.x, top: offset.y };
  };
  const onHeadMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    const panel = panelRef.current;
    const area = panel?.offsetParent as HTMLElement | null;
    if (!d || !panel || !area) return;
    // The panel's resting place is 12 px in from the top left; keep it on screen.
    const maxX = area.clientWidth - panel.offsetWidth - 12;
    const maxY = area.clientHeight - e.currentTarget.offsetHeight - 12;
    setOffset({
      x: Math.min(Math.max(d.left + e.clientX - d.x, -12), maxX),
      y: Math.min(Math.max(d.top + e.clientY - d.y, -12), maxY),
    });
  };
  const onHeadUp = (): void => {
    drag.current = null;
  };

  return (
    <div
      ref={panelRef}
      className="ruler"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <div
        className="ruler-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
      >
        <span className="ruler-title">Ruler</span>
        <button
          className="ruler-close"
          title="Close the ruler (Esc)"
          onMouseDown={keepFocus}
          onClick={() => useStore.getState().setMode('none')}
        >
          ✕
        </button>
      </div>
      <div className="ruler-tabs">
        {RULER_SHAPES.map((s) => (
          <button
            key={s.id}
            className={s.id === shape ? 'active' : ''}
            onMouseDown={keepFocus}
            onClick={() => setShape(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="ruler-body">
        <div className="ruler-blurb">{info.blurb}</div>
        <div className="ruler-rows">
          {rows.map((row) => (
            <div key={row.label} className="ruler-row" title={ROW_TIPS[row.label]}>
              <span className="ruler-label">{row.label}:</span>
              <span className="ruler-value">{value(row)}</span>
              <span className="ruler-unit">{unit(row)}</span>
            </div>
          ))}
        </div>
        <div className="ruler-hint">{info.hint} · Esc to clear</div>
      </div>
      <div className="ruler-foot">
        <label
          className="ruler-nav"
          title="On: drag to move the globe while measuring. Off: the mouse only places points."
          onMouseDown={keepFocus}
        >
          <input
            type="checkbox"
            checked={settings.rulerMouseNav}
            onChange={(e) => update({ rulerMouseNav: e.target.checked })}
          />
          Mouse Navigation
        </label>
        <button
          disabled={!canSave}
          title="Add this measurement to the open file as a feature"
          onMouseDown={keepFocus}
          onClick={onSave}
        >
          Save
        </button>
        <button disabled={!canClear} onMouseDown={keepFocus} onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}
