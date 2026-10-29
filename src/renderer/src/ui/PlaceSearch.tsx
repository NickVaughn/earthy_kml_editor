import { useEffect, useRef, useState } from 'react';
import { useStore } from '@renderer/state/store';
import { geocodeSourceLabel, type GeocodeResult } from '@shared/geocode';

/** Window event that focuses the search box (Search ▸ Find Place…, Ctrl+F). */
export const FIND_PLACE_EVENT = 'earthy:find-place';

interface Props {
  onFlyToBounds: (bounds: [number, number, number, number]) => void;
}

/**
 * Place-name search box. Searches on Enter only (Nominatim asks for ≤ 1
 * request/s), flies to the top hit, and lists the rest to pick from.
 */
export function PlaceSearch({ onFlyToBounds }: Props): JSX.Element {
  const source = useStore((s) => s.settings.geocoder);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener(FIND_PLACE_EVENT, focus);
    return () => window.removeEventListener(FIND_PLACE_EVENT, focus);
  }, []);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (r: GeocodeResult) => {
    onFlyToBounds(r.bounds);
    setOpen(false);
  };

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    const id = ++seq.current;
    setBusy(true);
    setStatus(null);
    try {
      const res = await window.api
        .geocode(q, source)
        .catch((err: unknown) => ({
          results: [],
          source,
          error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        }));
      if (id !== seq.current) return;
      setResults(res.results);
      if (res.error) {
        setStatus(res.error);
      } else if (res.results.length === 0) {
        setStatus(`No place matched “${q}”`);
      } else {
        // Say when the answer came from the fallback, not the chosen source.
        setStatus(res.source !== source ? `via ${geocodeSourceLabel(res.source)}` : null);
        onFlyToBounds(res.results[0].bounds);
      }
      setOpen(true);
    } finally {
      if (id === seq.current) setBusy(false);
    }
  };

  return (
    <div className="place-search" ref={rootRef}>
      <input
        ref={inputRef}
        type="search"
        placeholder={`Find place — ${geocodeSourceLabel(source)}`}
        title="Search place names (Enter to search, Ctrl/Cmd+F to focus)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          // Stop Enter/Esc reaching the globe's tools and shortcuts.
          e.stopPropagation();
          if (e.key === 'Enter' && !busy) void search();
          else if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      {open && (results.length > 0 || status) && (
        <div className="place-results">
          {status && <div className="place-status">{status}</div>}
          {results.map((r, i) => (
            <button
              key={`${i}-${r.label}`}
              className="place-result"
              title={r.label}
              onClick={() => pick(r)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
