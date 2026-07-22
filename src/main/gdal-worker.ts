import { parentPort } from 'node:worker_threads';
import { dirname, join, relative } from 'node:path';
import type {
  GdalRequest,
  VectorInfo,
  LayerInfo,
  FieldInfo,
  RasterInfo,
  ConvertedLayer,
} from '@shared/gdal';

/**
 * GDAL/WASM worker. Runs in a worker_thread so long conversions never block the
 * Electron main process. Communicates via GdalRequest/GdalResponse messages.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyGdal = any;

let gdalPromise: Promise<AnyGdal> | null = null;

function loadGdal(): Promise<AnyGdal> {
  if (gdalPromise) return gdalPromise;
  gdalPromise = (async () => {
    // gdal3.js resolves its asset `path` relative to cwd (it prefixes './'),
    // so we must hand it a RELATIVE path to dist/package.
    const pkgJson = require.resolve('gdal3.js/package.json');
    const distDir = join(dirname(pkgJson), 'dist', 'package');
    const rel = relative(process.cwd(), distDir) || '.';
    const initGdalJs = require('gdal3.js/node');
    return initGdalJs({ path: rel });
  })();
  return gdalPromise;
}

function post(msg: unknown): void {
  parentPort?.postMessage(msg);
}

function progress(id: string, fraction: number | null, message: string): void {
  post({ id, progress: { jobId: id, fraction, message } });
}

/** Normalize gdal3.js's odd error shapes into a readable string. */
function errText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (Array.isArray(e)) {
    const msgs = e.map((x) => (x && typeof x === 'object' ? (x as any).message : String(x)));
    const joined = msgs.filter(Boolean).join('; ');
    return joined || 'GDAL could not read this file (unsupported or corrupt).';
  }
  if (e && typeof e === 'object' && (e as any).message) return String((e as any).message);
  return String(e);
}

/** Run ogr2ogr to GeoJSON in WGS84 and return the parsed result. */
async function toGeoJson(
  Gdal: AnyGdal,
  dataset: unknown,
  extraArgs: string[] = [],
): Promise<{ features: any[] }> {
  const out = await Gdal.ogr2ogr(dataset, [
    '-f',
    'GeoJSON',
    '-t_srs',
    'EPSG:4326',
    ...extraArgs,
  ]);
  const bytes = await Gdal.getFileBytes(out.real ?? out);
  const text = Buffer.from(bytes).toString('utf8');
  const parsed = JSON.parse(text);
  return { features: parsed.features ?? [] };
}

function inferFields(features: any[]): FieldInfo[] {
  const names: string[] = [];
  for (const f of features) for (const k of Object.keys(f?.properties ?? {})) {
    if (!names.includes(k)) names.push(k);
  }
  return names.map((name) => {
    const values = features
      .map((f) => f?.properties?.[name])
      .filter((v) => v !== null && v !== undefined);
    const type = values.length ? typeof values[0] : 'string';
    return {
      name,
      type,
      samples: values.slice(0, 3).map((v) => String(v)),
    };
  });
}

async function inspectVector(id: string, path: string): Promise<VectorInfo> {
  const Gdal = await loadGdal();
  progress(id, null, 'Reading file…');
  const opened = await Gdal.open(path);
  const dataset = opened.datasets[0];
  const info = await Gdal.getInfo(dataset);

  const layers: LayerInfo[] = [];
  for (const layer of info.layers ?? []) {
    // Sample a few features to derive the field schema and geometry type;
    // getInfo alone gives only names/counts.
    let fields: FieldInfo[] = [];
    let geometryType: string | null = null;
    try {
      const sample = await toGeoJson(Gdal, dataset, ['-limit', '5', layer.name]);
      fields = inferFields(sample.features);
      geometryType = sample.features[0]?.geometry?.type ?? null;
    } catch {
      // Sampling is best-effort; the layer is still importable.
    }
    layers.push({
      name: layer.name,
      featureCount: layer.featureCount ?? 0,
      geometryType,
      fields,
    });
  }
  await Gdal.close(dataset).catch(() => undefined);
  return { path, driver: info.driverName ?? 'unknown', layers };
}

async function convertVector(
  id: string,
  path: string,
  layerName: string,
): Promise<ConvertedLayer> {
  const Gdal = await loadGdal();
  progress(id, null, `Converting ${layerName}…`);
  const opened = await Gdal.open(path);
  const dataset = opened.datasets[0];
  const out = await Gdal.ogr2ogr(dataset, [
    '-f',
    'GeoJSON',
    '-t_srs',
    'EPSG:4326',
    ...(layerName ? [layerName] : []),
  ]);
  const bytes = await Gdal.getFileBytes(out.real ?? out);
  const geojson = Buffer.from(bytes).toString('utf8');
  await Gdal.close(dataset).catch(() => undefined);
  return { layerName, geojson };
}

async function inspectRaster(id: string, path: string): Promise<RasterInfo> {
  const Gdal = await loadGdal();
  progress(id, null, 'Reading raster…');
  const opened = await Gdal.open(path);
  const dataset = opened.datasets[0];
  const info: any = await Gdal.getInfo(dataset);
  const width = info?.size?.[0] ?? info?.width ?? 0;
  const height = info?.size?.[1] ?? info?.height ?? 0;
  const bands = (info?.bands?.length ?? info?.bandCount ?? 0) as number;

  // Corner coordinates, when GDAL reports them in WGS84.
  let bounds: [number, number, number, number] | null = null;
  const cc = info?.cornerCoordinates;
  const wgs = info?.wgs84Extent?.coordinates?.[0];
  if (Array.isArray(wgs) && wgs.length >= 4) {
    const lons = wgs.map((p: number[]) => p[0]);
    const lats = wgs.map((p: number[]) => p[1]);
    bounds = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  } else if (cc?.lowerLeft && cc?.upperRight) {
    bounds = [cc.lowerLeft[0], cc.lowerLeft[1], cc.upperRight[0], cc.upperRight[1]];
  }

  await Gdal.close(dataset).catch(() => undefined);
  return {
    path,
    driver: info?.driverShortName ?? info?.driverName ?? 'unknown',
    width,
    height,
    bands,
    bounds,
    needsTiling: width * height > 8192 * 8192,
  };
}

parentPort?.on('message', async (req: GdalRequest) => {
  try {
    let result: unknown;
    switch (req.type) {
      case 'inspectVector':
        result = await inspectVector(req.id, req.path);
        break;
      case 'convertVector':
        result = await convertVector(req.id, req.path, req.layerName);
        break;
      case 'inspectRaster':
        result = await inspectRaster(req.id, req.path);
        break;
      default:
        throw new Error(`Unknown request type`);
    }
    post({ id: req.id, ok: true, result });
  } catch (e) {
    post({ id: req.id, ok: false, error: errText(e) });
  }
});
