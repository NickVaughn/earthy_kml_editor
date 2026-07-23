import { useStore } from '@renderer/state/store';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mp(w: number, h: number): string {
  return `${((w * h) / 1e6).toFixed(1)} MP`;
}

interface Props {
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
  onZoom: (bounds: [number, number, number, number]) => void;
}

/**
 * Lists raster overlays draped on the globe, with the cost of each: pixel
 * dimensions, PNG payload, GDAL warp time and GPU upload time. This is the
 * readout for figuring out how far the single-overlay (no tiling) approach
 * stretches before it gets sluggish.
 */
export function RasterPanel({ onRemove, onToggle, onZoom }: Props): JSX.Element | null {
  const rasters = useStore((s) => s.rasters);
  if (rasters.length === 0) return null;

  const totalBytes = rasters.reduce((n, r) => n + r.bytes, 0);
  // RGBA texture memory is 4 bytes/px regardless of how well the PNG compressed.
  const totalTexture = rasters.reduce((n, r) => n + r.width * r.height * 4, 0);

  return (
    <div className="raster-panel">
      <div className="raster-head">
        Rasters <span className="muted">({rasters.length})</span>
        <span className="raster-total muted">
          {mb(totalBytes)} png · ~{mb(totalTexture)} vram
        </span>
      </div>
      {rasters.map((r) => (
        <div key={r.id} className="raster-row">
          <input
            type="checkbox"
            checked={r.visible}
            title="Visibility"
            onChange={() => onToggle(r.id)}
          />
          <button
            className="raster-name"
            title={`${r.path}\nZoom to extent`}
            onClick={() => onZoom(r.bounds)}
          >
            {r.name}
          </button>
          <button className="raster-remove" title="Remove" onClick={() => onRemove(r.id)}>
            ✕
          </button>
          <div className="raster-stats muted">
            {r.width.toLocaleString()}×{r.height.toLocaleString()} ({mp(r.width, r.height)})
            {r.downsampled && (
              <span
                className="raster-warn"
                title={
                  `Source was ${r.sourceWidth.toLocaleString()}×${r.sourceHeight.toLocaleString()} px. ` +
                  `It exceeded this GPU's maximum texture size, so it was resampled down ` +
                  `to fit in a single overlay — fine detail has been lost.`
                }
              >
                {' '}
                · ⚠ resampled to fit GPU limit
              </span>
            )}
            <br />
            {mb(r.bytes)} png · ~{mb(r.width * r.height * 4)} vram
            <br />
            warp {Math.round(r.gdalMs)} ms · upload {Math.round(r.uploadMs)} ms
          </div>
        </div>
      ))}
    </div>
  );
}
