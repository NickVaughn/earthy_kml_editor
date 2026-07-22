import type { CategorySpec } from '@renderer/model/geojson';
import type { FillMode } from '@renderer/model/geojson';

const FILL_MODES: { id: FillMode; label: string }[] = [
  { id: 'both', label: 'Outline + fill' },
  { id: 'outline', label: 'Outline only' },
  { id: 'fill', label: 'Fill only' },
];

/**
 * A small swatch previewing a category's style — a dot for point layers, a
 * rectangle for lines/polygons — filled and/or outlined per the spec.
 */
export function StyleSwatch({
  spec,
  isPoint,
}: {
  spec: CategorySpec;
  isPoint: boolean;
}): JSX.Element {
  const showFill = spec.fillMode !== 'outline';
  const showOutline = spec.fillMode !== 'fill';
  const fill = showFill ? hexA(spec.color, spec.fillOpacity) : 'transparent';
  const stroke = showOutline ? hexA(spec.color, spec.lineOpacity) : 'transparent';
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden>
      {isPoint ? (
        <circle cx="11" cy="8" r="5" fill={fill} stroke={stroke} strokeWidth="2" />
      ) : (
        <rect
          x="2"
          y="2"
          width="18"
          height="12"
          rx="2"
          fill={fill}
          stroke={stroke}
          strokeWidth="2"
        />
      )}
    </svg>
  );
}

/** Popover editor for one category's label + outline/fill colours and opacity. */
export function CategoryEditor({
  spec,
  isPoint,
  onChange,
  onClose,
}: {
  spec: CategorySpec;
  isPoint: boolean;
  onChange: (patch: Partial<CategorySpec>) => void;
  onClose: () => void;
}): JSX.Element {
  const showFill = spec.fillMode !== 'outline';
  const showOutline = spec.fillMode !== 'fill';
  return (
    <div className="cat-editor" onClick={(e) => e.stopPropagation()}>
      <div className="cat-editor-head">
        <StyleSwatch spec={spec} isPoint={isPoint} />
        <input
          className="cat-editor-name"
          value={spec.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <button className="cat-editor-close" onClick={onClose}>
          ✕
        </button>
      </div>

      <label className="insp-row">
        <span>Colour</span>
        <input
          type="color"
          value={spec.color}
          onChange={(e) => onChange({ color: e.target.value })}
        />
      </label>

      <label className="insp-row">
        <span>Style</span>
        <select
          value={spec.fillMode}
          onChange={(e) => onChange({ fillMode: e.target.value as FillMode })}
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
            value={spec.lineOpacity}
            onChange={(e) => onChange({ lineOpacity: Number(e.target.value) })}
          />
          <span className="opacity-val">{Math.round(spec.lineOpacity * 100)}%</span>
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
            value={spec.fillOpacity}
            onChange={(e) => onChange({ fillOpacity: Number(e.target.value) })}
          />
          <span className="opacity-val">{Math.round(spec.fillOpacity * 100)}%</span>
        </label>
      )}
    </div>
  );
}

function hexA(hex: string, opacity: number): string {
  const s = hex.replace('#', '');
  return `#${s}${Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, '0')}`;
}
