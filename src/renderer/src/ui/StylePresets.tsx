import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { StylePreset } from '@shared/stylePresets';
import { NAME_FIELD } from '@renderer/model/geojson';

/**
 * Saved presets, held in one small store so a preset saved from the restyle
 * dialog is immediately offered by the import dialog (which stays mounted).
 * Loaded from settings on first use.
 */
const usePresetStore = create<{ presets: StylePreset[]; loaded: boolean }>(() => ({
  presets: [],
  loaded: false,
}));

export function useStylePresets(): {
  presets: StylePreset[];
  /** Store a preset; false if it would replace one and the user declined. */
  save(preset: StylePreset): Promise<boolean>;
  remove(name: string): Promise<void>;
} {
  const presets = usePresetStore((s) => s.presets);
  useEffect(() => {
    if (usePresetStore.getState().loaded) return;
    usePresetStore.setState({ loaded: true });
    void window.api.getStylePresets().then((p) => usePresetStore.setState({ presets: p }));
  }, []);

  return {
    presets,
    async save(preset) {
      const exists = usePresetStore.getState().presets.some((p) => p.name === preset.name);
      if (exists && !confirm(`Replace the saved preset “${preset.name}”?`)) return false;
      usePresetStore.setState({ presets: await window.api.saveStylePreset(preset) });
      return true;
    },
    async remove(name) {
      usePresetStore.setState({ presets: await window.api.deleteStylePreset(name) });
    },
  };
}

const fieldLabel = (field: string): string => (field === NAME_FIELD ? 'Name' : field);

/** "Preset" row: pick a saved mapping to apply, or delete the picked one. */
export function PresetPicker({
  presets,
  value,
  onPick,
  onDelete,
}: {
  presets: StylePreset[];
  /** Name of the picked preset, '' for none. */
  value: string;
  onPick: (preset: StylePreset | null) => void;
  onDelete: (name: string) => void;
}): JSX.Element | null {
  if (presets.length === 0) return null;
  return (
    <div className="insp-row">
      <span>Preset</span>
      <select
        value={value}
        onChange={(e) => onPick(presets.find((p) => p.name === e.target.value) ?? null)}
      >
        <option value="">(none)</option>
        {presets.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name} — {fieldLabel(p.field)}, {p.categories.length} values
          </option>
        ))}
      </select>
      {value && (
        <button
          className="preset-btn"
          title="Delete this saved preset"
          onClick={() => {
            if (confirm(`Delete the saved preset “${value}”?`)) onDelete(value);
          }}
        >
          Delete
        </button>
      )}
    </div>
  );
}

/**
 * "Save as" row: name the dialog's current mapping and store it. Remount it
 * (via `key`) to reset the suggested name.
 */
export function SavePresetRow({
  defaultName,
  onSave,
}: {
  defaultName: string;
  onSave: (name: string) => Promise<boolean>;
}): JSX.Element {
  const [name, setName] = useState(defaultName);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(''), 2500);
    return () => clearTimeout(t);
  }, [note]);

  const trimmed = name.trim();
  return (
    <div className="insp-row">
      <span>Save as</span>
      <input
        type="text"
        placeholder="preset name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        className="preset-btn"
        disabled={!trimmed}
        title="Save these categories and settings for reuse on another layer"
        onClick={() => void onSave(trimmed).then((ok) => ok && setNote('Saved'))}
      >
        Save preset
      </button>
      {note && <span className="muted preset-note">{note}</span>}
    </div>
  );
}
