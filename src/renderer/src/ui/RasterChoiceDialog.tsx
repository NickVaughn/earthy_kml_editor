import type { RasterPlan } from '@shared/gdal';

export type RasterChoice = 'tile' | 'resample' | 'cancel';

export interface RasterChoiceInfo {
  name: string;
  plan: RasterPlan;
  maxTex: number;
  /** True when a single overlay would have to be scaled down to fit the GPU. */
  willResample: boolean;
  finalW: number;
  finalH: number;
}

function fmtBytes(n: number): string {
  return n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(n / 1024 ** 2)} MB`;
}

/**
 * How to bring in a raster that's too big for one GPU texture: build a tile
 * pyramid (full detail, slower, cached on disk) or resample it down to a single
 * overlay (fast, lossy) — the same choice Google Earth offers.
 */
export function RasterChoiceDialog({
  info,
  onChoose,
}: {
  info: RasterChoiceInfo;
  onChoose: (choice: RasterChoice) => void;
}): JSX.Element {
  const { name, plan, maxTex, willResample, finalW, finalH } = info;
  const pct = Math.round((finalW / plan.warpedWidth) * 100);
  const vram = finalW * finalH * 4;

  return (
    <div className="modal-backdrop" onClick={() => onChoose('cancel')}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Import “{name}” <span className="muted">({plan.driver})</span>
        </div>
        <div className="modal-summary">
          {plan.sourceWidth.toLocaleString()}×{plan.sourceHeight.toLocaleString()} px ·{' '}
          {plan.bands} band{plan.bands === 1 ? '' : 's'} · reprojects to{' '}
          {plan.warpedWidth.toLocaleString()}×{plan.warpedHeight.toLocaleString()} px
          {willResample && (
            <>
              , past this GPU's {maxTex.toLocaleString()} px texture limit.
            </>
          )}
          {plan.tempDiskBytes > 0 && (
            <>
              {' '}
              Its compression isn't supported by the bundled GDAL, so it will be decoded
              first using about {fmtBytes(plan.tempDiskBytes)} of temporary disk.
            </>
          )}
        </div>

        <div className="choice-list">
          <button className="choice" onClick={() => onChoose('tile')}>
            <div className="choice-title">Tile it — keep full detail</div>
            <div className="choice-body">
              Builds a zoom pyramid on disk and streams it, so nothing is thrown away and
              video memory stays low no matter how big the image is. Slower to prepare, and
              the tiles are cached locally — they aren't carried inside a saved KMZ.
            </div>
          </button>

          <button className="choice" onClick={() => onChoose('resample')}>
            <div className="choice-title">
              Resample to fit{willResample ? ` — about ${pct}% of full resolution` : ''}
            </div>
            <div className="choice-body">
              {willResample ? (
                <>
                  Scales the image down to {finalW.toLocaleString()}×{finalH.toLocaleString()} px
                  so it fits in one texture. Fast and self-contained — the image is embedded in
                  the document and travels inside a KMZ — but fine detail is lost.
                </>
              ) : (
                <>
                  Draped as a single image, embedded in the document so it travels inside a
                  KMZ. Uses roughly {fmtBytes(vram)} of video memory.
                </>
              )}
            </div>
          </button>
        </div>

        <div className="modal-actions">
          <button onClick={() => onChoose('cancel')}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
