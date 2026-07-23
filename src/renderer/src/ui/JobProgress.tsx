import { useStore } from '@renderer/state/store';
import { cancelGdalJob } from '@renderer/state/gdalJob';

/**
 * Progress for the running GDAL job, with a way out. Long imports (warping a
 * large raster, decoding an unsupported codec) can take minutes, so the user
 * needs to see movement and be able to stop.
 */
export function JobProgress(): JSX.Element | null {
  const job = useStore((s) => s.gdalJob);
  if (!job) return null;

  const pct = job.fraction === null ? null : Math.round(job.fraction * 100);

  return (
    <div className="job-progress">
      <div className="job-row">
        <span className="job-message">{job.message}</span>
        {pct !== null && <span className="job-pct">{pct}%</span>}
        <button className="job-cancel" onClick={() => void cancelGdalJob()}>
          Cancel
        </button>
      </div>
      <div className={`job-bar${pct === null ? ' indeterminate' : ''}`}>
        <div className="job-bar-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}
