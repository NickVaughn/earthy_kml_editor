import { useEffect, useState } from 'react';
import {
  DEFAULT_MAX_ZOOM,
  isTileTemplate,
  normalizeTileTemplate,
  tileTemplateError,
  type TileLayerSpec,
} from '@renderer/model/tileLayers';
import { parseCapabilities, type ServiceLayer } from '@renderer/model/wmts';

/** A zoom field's value as a level, or null if it isn't one. */
function zoomOf(text: string): number | null {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 30 ? n : null;
}

/** A short default name for a template: its host. */
function hostOf(url: string): string {
  return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1].replace(/^\{s\}\./, '') ?? 'Tile layer';
}

/**
 * File ▸ Add Tile Layer…: point at a web tileset, either a URL template with
 * {z}/{x}/{y} placeholders or a WMTS/WMS capabilities document, and add it to the
 * layer list as a streamed overlay.
 */
export function TileLayerDialog({
  onAdd,
  onClose,
}: {
  onAdd: (layer: { name: string; tiles: TileLayerSpec }) => void;
  onClose: () => void;
}): JSX.Element {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [minZoom, setMinZoom] = useState('0');
  const [maxZoom, setMaxZoom] = useState(String(DEFAULT_MAX_ZOOM));
  /** Layers read from a capabilities document, and which is chosen. */
  const [layers, setLayers] = useState<ServiceLayer[] | null>(null);
  const [layerId, setLayerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const trimmed = url.trim();
  const template = isTileTemplate(trimmed);
  const usable = layers?.filter((l) => l.tiles) ?? [];
  const layer = usable.find((l) => l.id === layerId);

  const changeUrl = (next: string): void => {
    setUrl(next);
    setLayers(null);
    setError(null);
  };

  const readCapabilities = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let found: ServiceLayer[];
      try {
        found = parseCapabilities(await window.api.fetchText(trimmed), trimmed);
      } catch (err) {
        // A bare WMS endpoint: ask it for its capabilities.
        if (/[?&]request=/i.test(trimmed)) throw err;
        const ask = `${trimmed}${trimmed.includes('?') ? '&' : '?'}SERVICE=WMS&REQUEST=GetCapabilities`;
        found = parseCapabilities(await window.api.fetchText(ask), ask);
      }
      const first = found.find((l) => l.tiles);
      if (!first) {
        const why = found[0]?.error ?? 'it lists no layers';
        throw new Error(`No usable layers: ${why}.`);
      }
      setLayers(found);
      setLayerId(first.id);
      if (!name.trim()) setName(first.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseLayer = (id: string): void => {
    // Follow the layer's title unless the name was typed by hand.
    const titles = usable.map((l) => l.title);
    if (!name.trim() || titles.includes(name)) {
      setName(usable.find((l) => l.id === id)?.title ?? name);
    }
    setLayerId(id);
  };

  const zMin = zoomOf(minZoom);
  const zMax = zoomOf(maxZoom);
  const templateError = template
    ? tileTemplateError(trimmed) ??
      (zMin === null || zMax === null || zMin > zMax
        ? 'Zoom levels must be whole numbers, minimum ≤ maximum'
        : null)
    : null;
  const ready = template ? !templateError : !!layer;

  const add = (): void => {
    if (template && zMin !== null && zMax !== null) {
      const tiles = { url: normalizeTileTemplate(trimmed), minZoom: zMin, maxZoom: zMax };
      onAdd({ name: name.trim() || hostOf(tiles.url), tiles });
    } else if (layer?.tiles) {
      onAdd({ name: name.trim() || layer.title, tiles: layer.tiles });
    }
  };

  const skipped = layers?.filter((l) => !l.tiles) ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) add();
          else if (!template && trimmed && !busy) void readCapabilities();
        }}
      >
        <div className="modal-head">Add Tile Layer</div>
        <div className="modal-summary">
          A tile URL with <code>{'{z}'}</code>, <code>{'{x}'}</code> and <code>{'{y}'}</code>{' '}
          placeholders, or the URL of a WMTS or WMS service (its capabilities document). Tiles
          must be Web Mercator. Use <code>{'{-y}'}</code> for TMS (bottom-up) rows.
        </div>

        <label className="insp-row">
          <span>URL</span>
          <input
            type="text"
            autoFocus
            spellCheck={false}
            value={url}
            placeholder="https://example.com/tiles/{z}/{x}/{y}.png"
            onChange={(e) => changeUrl(e.target.value)}
          />
        </label>

        {trimmed && !template && !layers && (
          <div className="insp-row">
            <span />
            <button type="button" disabled={busy} onClick={() => void readCapabilities()}>
              {busy ? 'Reading…' : 'Read service layers'}
            </button>
          </div>
        )}

        {layers && (
          <label className="insp-row">
            <span>Layer</span>
            <select value={layerId} onChange={(e) => chooseLayer(e.target.value)}>
              {usable.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          </label>
        )}

        {(template || layers) && (
          <label className="insp-row">
            <span>Name</span>
            <input
              type="text"
              value={name}
              placeholder={template ? hostOf(trimmed) : layer?.title}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}

        {template && (
          <label className="insp-row">
            <span>Zoom levels</span>
            <input type="text" value={minZoom} onChange={(e) => setMinZoom(e.target.value)} />
            <span className="tile-zoom-to">to</span>
            <input type="text" value={maxZoom} onChange={(e) => setMaxZoom(e.target.value)} />
          </label>
        )}

        {template && (
          <div className="modal-summary">
            The levels the server actually has. Past either end the nearest level is
            stretched or shrunk to fit, so the layer stays visible at every zoom.
          </div>
        )}
        {layer?.tiles && (
          <div className="modal-summary">
            {layer.service === 'WMS'
              ? 'WMS — drawn by the server at every zoom'
              : `WMTS · zoom ${layer.tiles.minZoom}–${layer.tiles.maxZoom}`}
            {layer.tiles.bounds &&
              ` · ${layer.tiles.bounds.map((v) => v.toFixed(3)).join(', ')} (W, S, E, N)`}
            {skipped.length > 0 &&
              ` · ${skipped.length} other layer${skipped.length === 1 ? '' : 's'} skipped: ` +
                `${skipped[0].error}`}
          </div>
        )}
        {(error || (template && templateError)) && (
          <div className="modal-summary tile-error">{error ?? templateError}</div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            Add
          </button>
        </div>
      </form>
    </div>
  );
}
