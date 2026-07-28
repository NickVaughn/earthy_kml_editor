import { useMemo } from 'react';
import { useStore } from '@renderer/state/store';

export function StatusBar(): JSX.Element {
  const docs = useStore((s) => s.docs);
  const revision = useStore((s) => s.revision);
  const lon = useStore((s) => s.cursorLon);
  const lat = useStore((s) => s.cursorLat);
  const ellip = useStore((s) => s.cursorHeight);
  const msl = useStore((s) => s.cursorHeightMsl);
  const selection = useStore((s) => s.selection);

  const stats = useMemo(() => {
    let features = 0;
    let folders = 0;
    for (const d of docs) {
      const s = d.stats();
      features += s.features;
      folders += s.folders;
    }
    return { features, folders };
  }, [docs, revision]);

  return (
    <div className="statusbar">
      <span>
        {stats.features.toLocaleString()} features · {stats.folders.toLocaleString()} folders
      </span>
      <span>{selection.length > 0 ? `${selection.length} selected` : ''}</span>
      <span className="coord">
        {lon != null && lat != null
          ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` +
            (msl != null ? ` · ${Math.round(msl)} m MSL` : '') +
            (ellip != null
              ? msl != null
                ? ` (${Math.round(ellip)} m HAE)`
                : ` · ${Math.round(ellip)} m`
              : '')
          : '—'}
      </span>
    </div>
  );
}
