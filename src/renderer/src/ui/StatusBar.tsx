import { useMemo } from 'react';
import { useStore } from '@renderer/state/store';

export function StatusBar(): JSX.Element {
  const doc = useStore((s) => s.doc);
  const revision = useStore((s) => s.revision);
  const lon = useStore((s) => s.cursorLon);
  const lat = useStore((s) => s.cursorLat);
  const selection = useStore((s) => s.selection);

  const stats = useMemo(() => doc.stats(), [doc, revision]);

  return (
    <div className="statusbar">
      <span>
        {stats.features.toLocaleString()} features · {stats.folders.toLocaleString()} folders
      </span>
      <span>{selection.length > 0 ? `${selection.length} selected` : ''}</span>
      <span className="coord">
        {lon != null && lat != null
          ? `${lat.toFixed(5)}, ${lon.toFixed(5)}`
          : '—'}
      </span>
    </div>
  );
}
