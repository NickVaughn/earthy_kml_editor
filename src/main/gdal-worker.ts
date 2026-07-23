import { parentPort } from 'node:worker_threads';
import { dirname, join, relative } from 'node:path';
import type {
  GdalRequest,
  VectorInfo,
  LayerInfo,
  FieldInfo,
  RasterInfo,
  ConvertedLayer,
  ConvertedRaster,
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

/** WGS84 [west, south, east, north] from a gdalinfo -json payload, if derivable. */
function boundsFromInfo(info: any): [number, number, number, number] | null {
  const wgs = info?.wgs84Extent?.coordinates?.[0];
  if (Array.isArray(wgs) && wgs.length >= 4) {
    const lons = wgs.map((p: number[]) => p[0]);
    const lats = wgs.map((p: number[]) => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }
  const cc = info?.cornerCoordinates;
  if (cc?.lowerLeft && cc?.upperRight) {
    return [cc.lowerLeft[0], cc.lowerLeft[1], cc.upperRight[0], cc.upperRight[1]];
  }
  return null;
}

async function inspectRaster(id: string, path: string): Promise<RasterInfo> {
  const Gdal = await loadGdal();
  progress(id, null, 'Reading raster…');
  const opened = await Gdal.open(path);
  const dataset = opened.datasets[0];
  // Note: getInfo() returns only {width,height,bandCount,…} — the corner and
  // WGS84 extent fields live in gdalinfo's -json payload, so use that.
  const info: any = await Gdal.gdalinfo(dataset, ['-json']);
  const width = info?.size?.[0] ?? 0;
  const height = info?.size?.[1] ?? 0;
  const bands = (info?.bands?.length ?? 0) as number;

  await Gdal.close(dataset).catch(() => undefined);
  return {
    path,
    driver: info?.driverShortName ?? 'unknown',
    width,
    height,
    bands,
    bounds: boundsFromInfo(info),
    needsTiling: width * height > 8192 * 8192,
  };
}

/**
 * Warp a raster to EPSG:4326 and encode it as a PNG for use as ONE Cesium
 * overlay (no tile pyramid). Deliberately unbounded by default so we can find
 * out empirically how large a single overlay can go before it hurts.
 */
async function convertRaster(
  id: string,
  path: string,
  maxDimension?: number,
): Promise<ConvertedRaster> {
  const Gdal = await loadGdal();
  progress(id, null, 'Reading raster…');
  const opened = await Gdal.open(path);
  const src = opened.datasets[0];
  const srcInfo: any = await Gdal.gdalinfo(src, ['-json']);
  const sourceWidth = srcInfo?.size?.[0] ?? 0;
  const sourceHeight = srcInfo?.size?.[1] ?? 0;

  const t0 = Date.now();
  progress(id, null, 'Reprojecting to EPSG:4326…');
  // -dstalpha keeps the area outside the (possibly rotated) footprint transparent.
  const warped = await Gdal.gdalwarp(src, [
    '-t_srs',
    'EPSG:4326',
    '-of',
    'GTiff',
    '-dstalpha',
  ]);
  const wOpened = await Gdal.open(warped.real ?? warped);
  const wds = wOpened.datasets[0];
  const wInfo: any = await Gdal.gdalinfo(wds, ['-json']);

  let width = wInfo?.size?.[0] ?? 0;
  let height = wInfo?.size?.[1] ?? 0;
  const bounds = boundsFromInfo(wInfo);
  if (!bounds) throw new Error('Raster has no usable georeferencing.');

  const args: string[] = ['-of', 'PNG'];

  // PNG takes at most 4 bands; keep the first three plus the alpha we just added.
  const bandTypes: string[] = (wInfo?.bands ?? []).map((b: any) => b.colorInterpretation === 'Alpha' ? 'Alpha' : b.type);
  const bandCount = (wInfo?.bands ?? []).length;
  if (bandCount > 4) {
    args.push('-b', '1', '-b', '2', '-b', '3', '-b', String(bandCount));
  }

  // PNG only stores Byte/UInt16 — rescale anything else into 8-bit.
  const nonByte = (wInfo?.bands ?? []).some(
    (b: any) => b.type !== 'Byte' && b.colorInterpretation !== 'Alpha',
  );
  if (nonByte) args.push('-ot', 'Byte', '-scale');
  void bandTypes;

  let downsampled = false;
  if (maxDimension && Math.max(width, height) > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    args.push('-outsize', String(width), String(height));
    downsampled = true;
  }

  progress(id, null, `Encoding ${width}×${height} PNG…`);
  const out = await Gdal.gdal_translate(wds, args);
  const png = await Gdal.getFileBytes(out.real ?? out);
  const gdalMs = Date.now() - t0;

  await Gdal.close(src).catch(() => undefined);
  await Gdal.close(wds).catch(() => undefined);

  return {
    path,
    png,
    width,
    height,
    sourceWidth,
    sourceHeight,
    bounds,
    gdalMs,
    downsampled,
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
      case 'convertRaster':
        result = await convertRaster(req.id, req.path, req.maxDimension);
        break;
      default:
        throw new Error(`Unknown request type`);
    }
    post({ id: req.id, ok: true, result });
  } catch (e) {
    post({ id: req.id, ok: false, error: errText(e) });
  }
});
