import { parentPort } from 'node:worker_threads';
import { dirname, join, relative } from 'node:path';
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type {
  GdalRequest,
  VectorInfo,
  LayerInfo,
  FieldInfo,
  RasterInfo,
  ConvertedLayer,
  ConvertedRaster,
  RasterPlan,
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

/**
 * Remove temp directories left behind by a previous run. Cancelling a job
 * terminates this worker outright, so the `finally` that would have cleaned up
 * never runs; each fresh worker tidies up after the last one.
 */
function sweepStaleTempDirs(): void {
  try {
    const dir = tmpdir();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('earthy-raster-') && !name.startsWith('earthy-plan-')) continue;
      const full = join(dir, name);
      // Leave anything recent alone — another worker could still be using it.
      if (Date.now() - statSync(full).mtimeMs < 60 * 60 * 1000) continue;
      rmSync(full, { recursive: true, force: true });
    }
  } catch {
    // Best-effort housekeeping; never let it break startup.
  }
}
sweepStaleTempDirs();

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

/**
 * A genuine runtime `import()`. geotiff is ESM-only and this worker is bundled
 * to CJS, where rollup would rewrite a plain `import()` into `require()` —
 * which Electron's Node 20 cannot use on an ESM package. Hiding it inside
 * `new Function` keeps it a real dynamic import.
 */
const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<AnyGdal>;

/** JS typed-array name → VRT dataType + bytes per sample. */
const VRT_DTYPE: Record<string, [string, number]> = {
  Int8Array: ['Int8', 1],
  Uint8Array: ['Byte', 1],
  Int16Array: ['Int16', 2],
  Uint16Array: ['UInt16', 2],
  Int32Array: ['Int32', 4],
  Uint32Array: ['UInt32', 4],
  Float32Array: ['Float32', 4],
  Float64Array: ['Float64', 8],
};

/** Roughly how much decoded imagery to hold in memory at once while streaming. */
const STRIP_BYTES = 64 * 1024 * 1024;

interface GeotiffHeader {
  image: AnyGdal;
  width: number;
  height: number;
  bands: number;
  bytesPerPixel: number;
  epsg: number;
  originX: number;
  originY: number;
  resX: number;
  resY: number;
}

/**
 * Read a TIFF's header with geotiff.js — dimensions and georeferencing only, no
 * pixel decoding, so this stays cheap enough for a pre-flight estimate.
 */
async function readGeotiffHeader(path: string): Promise<GeotiffHeader> {
  // geotiff pulls in `web-worker`, which — when loaded inside a worker_thread —
  // tries to bootstrap itself AS the worker and destructures an undefined
  // `workerData`. It skips all that if a global `Worker` already exists, and we
  // never use geotiff's decoder Pool, so a stub is enough.
  const g = globalThis as { Worker?: unknown };
  if (typeof g.Worker !== 'function') {
    g.Worker = class WorkerStub {
      constructor() {
        throw new Error('geotiff decoder pool is not used in Earthy');
      }
    };
  }
  const { fromFile } = await esmImport('geotiff');
  const tiff = await fromFile(path);
  const image = await tiff.getImage();
  const geoKeys = await image.getGeoKeys();
  const epsg = geoKeys?.ProjectedCSTypeGeoKey ?? geoKeys?.GeographicTypeGeoKey;
  if (!epsg) {
    throw new Error(
      'This file uses a compression GDAL cannot read here, and it has no EPSG code we can fall back on.',
    );
  }
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  return {
    image,
    width: image.getWidth(),
    height: image.getHeight(),
    bands: image.getSamplesPerPixel(),
    bytesPerPixel: image.getBytesPerPixel(),
    epsg,
    originX,
    originY,
    resX,
    resY,
  };
}

/** A VRT carrying only dimensions + georeferencing — no pixel source. Enough
 *  for GDAL to compute a warp's output size without reading any data. */
function metadataVrt(h: GeotiffHeader): string {
  const bandXml = Array.from(
    { length: h.bands },
    (_, i) => `  <VRTRasterBand dataType="Byte" band="${i + 1}"/>`,
  ).join('\n');
  return (
    `<VRTDataset rasterXSize="${h.width}" rasterYSize="${h.height}">\n` +
    `  <SRS>EPSG:${h.epsg}</SRS>\n` +
    `  <GeoTransform>${h.originX}, ${h.resX}, 0, ${h.originY}, 0, ${h.resY}</GeoTransform>\n` +
    `${bandXml}\n</VRTDataset>\n`
  );
}

/** Output size of warping `dataset` to EPSG:4326, computed via a warped VRT
 *  (metadata only — GDAL does not touch pixels for `-of VRT`). */
async function predictWarpSize(Gdal: AnyGdal, dataset: unknown): Promise<[number, number]> {
  const warped = await Gdal.gdalwarp(dataset, [
    '-t_srs',
    'EPSG:4326',
    '-of',
    'VRT',
    '-dstalpha',
  ]);
  const wds = (await Gdal.open(warped.real ?? warped)).datasets[0];
  const info: any = await Gdal.gdalinfo(wds, ['-json']);
  await Gdal.close(wds).catch(() => undefined);
  return [info?.size?.[0] ?? 0, info?.size?.[1] ?? 0];
}

/**
 * Work out what loading this raster will cost before doing any of it: the
 * reprojected size, and whether we must decode it ourselves (and how much temp
 * disk that takes).
 */
async function planRaster(id: string, path: string): Promise<RasterPlan> {
  const Gdal = await loadGdal();
  progress(id, null, 'Inspecting raster…');

  try {
    const opened = await Gdal.open(path);
    const ds = opened.datasets?.[0];
    if (!ds) throw new Error(errText(opened.errors) || 'GDAL could not open this file.');
    const info: any = await Gdal.gdalinfo(ds, ['-json']);
    const [warpedWidth, warpedHeight] = await predictWarpSize(Gdal, ds);
    await Gdal.close(ds).catch(() => undefined);
    return {
      path,
      driver: info?.driverShortName ?? 'unknown',
      sourceWidth: info?.size?.[0] ?? 0,
      sourceHeight: info?.size?.[1] ?? 0,
      bands: info?.bands?.length ?? 0,
      bounds: boundsFromInfo(info),
      needsDecode: false,
      tempDiskBytes: 0,
      warpedWidth,
      warpedHeight,
    };
  } catch (e) {
    if (!isMissingCodec(errText(e))) throw e;
  }

  // Unsupported codec: read the header ourselves and predict from a
  // metadata-only VRT, still without decoding a single pixel.
  const h = await readGeotiffHeader(path);
  const dir = mkdtempSync(join(tmpdir(), 'earthy-plan-'));
  const vrtPath = join(dir, 'meta.vrt');
  writeFileSync(vrtPath, metadataVrt(h));
  try {
    const ds = (await Gdal.open(vrtPath)).datasets[0];
    const [warpedWidth, warpedHeight] = await predictWarpSize(Gdal, ds);
    const info: any = await Gdal.gdalinfo(ds, ['-json']);
    await Gdal.close(ds).catch(() => undefined);
    return {
      path,
      driver: 'GTiff (unsupported codec)',
      sourceWidth: h.width,
      sourceHeight: h.height,
      bands: h.bands,
      bounds: boundsFromInfo(info),
      needsDecode: true,
      tempDiskBytes: h.width * h.height * h.bytesPerPixel,
      warpedWidth,
      warpedHeight,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Decode a TIFF whose compression GDAL/WASM lacks a codec for (JPEG, ZSTD, …)
 * using geotiff.js, then re-expose the pixels as a headerless raw file plus a
 * VRT that GDAL *can* open. Rows are streamed in strips so a large image never
 * has to fit in memory all at once.
 *
 * Returns the paths to hand `Gdal.open` (VRT first, raw as its sidecar) and the
 * temp directory to delete afterwards.
 */
async function decodeViaGeotiff(
  id: string,
  path: string,
): Promise<{ paths: string[]; dir: string }> {
  const header = await readGeotiffHeader(path);
  const { image, width, height, bands, originX, originY, resX, resY, epsg } = header;

  const dir = mkdtempSync(join(tmpdir(), 'earthy-raster-'));
  const rawName = 'source.raw';
  const rawPath = join(dir, rawName);
  writeFileSync(rawPath, Buffer.alloc(0));

  const bytesPerPixel = header.bytesPerPixel;
  const rowsPerStrip = Math.max(1, Math.floor(STRIP_BYTES / Math.max(1, width * bytesPerPixel)));
  let dataType = 'Byte';
  let sampleBytes = 1;

  for (let top = 0; top < height; top += rowsPerStrip) {
    const bottom = Math.min(height, top + rowsPerStrip);
    const strip = await image.readRasters({
      window: [0, top, width, bottom],
      interleave: true,
    });
    const mapped = VRT_DTYPE[strip.constructor.name];
    if (!mapped) throw new Error(`Unsupported sample type ${strip.constructor.name}`);
    [dataType, sampleBytes] = mapped;
    appendFileSync(rawPath, Buffer.from(strip.buffer, strip.byteOffset, strip.byteLength));
    progress(id, bottom / height, `Decoding ${Math.round((bottom / height) * 100)}%…`);
  }

  // Band-interleaved-by-pixel: each band starts one sample further in, and the
  // stride between pixels is the full pixel width.
  const pixelOffset = bands * sampleBytes;
  const lineOffset = width * pixelOffset;
  const bandXml = Array.from({ length: bands }, (_, i) =>
    [
      `  <VRTRasterBand dataType="${dataType}" band="${i + 1}" subClass="VRTRawRasterBand">`,
      `    <SourceFilename relativeToVRT="1">${rawName}</SourceFilename>`,
      `    <ImageOffset>${i * sampleBytes}</ImageOffset>`,
      `    <PixelOffset>${pixelOffset}</PixelOffset>`,
      `    <LineOffset>${lineOffset}</LineOffset>`,
      `    <ByteOrder>LSB</ByteOrder>`,
      `  </VRTRasterBand>`,
    ].join('\n'),
  ).join('\n');

  const vrtPath = join(dir, 'source.vrt');
  writeFileSync(
    vrtPath,
    `<VRTDataset rasterXSize="${width}" rasterYSize="${height}">\n` +
      `  <SRS>EPSG:${epsg}</SRS>\n` +
      `  <GeoTransform>${originX}, ${resX}, 0, ${originY}, 0, ${resY}</GeoTransform>\n` +
      `${bandXml}\n</VRTDataset>\n`,
  );

  return { paths: [vrtPath, rawPath], dir };
}

/** True for GDAL errors that mean "libtiff has no codec for this compression". */
function isMissingCodec(message: string): boolean {
  return /missing codec|compression support is not configured/i.test(message);
}

/**
 * Open a raster, transparently falling back to the geotiff.js decode path when
 * GDAL/WASM lacks the codec. Callers must invoke `cleanup()` when done.
 */
async function openRaster(
  Gdal: AnyGdal,
  id: string,
  path: string,
): Promise<{ dataset: unknown; cleanup: () => void }> {
  try {
    const opened = await Gdal.open(path);
    const dataset = opened.datasets?.[0];
    if (dataset) return { dataset, cleanup: () => undefined };
    throw new Error(errText(opened.errors) || 'GDAL could not open this file.');
  } catch (e) {
    const msg = errText(e);
    if (!isMissingCodec(msg)) throw e;
    progress(id, null, 'Unsupported TIFF codec — decoding directly…');
    const { paths, dir } = await decodeViaGeotiff(id, path);
    const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
    try {
      const opened = await Gdal.open(paths);
      const dataset = opened.datasets?.[0];
      if (!dataset) throw new Error(errText(opened.errors) || 'Could not open decoded raster.');
      return { dataset, cleanup };
    } catch (inner) {
      cleanup();
      throw inner;
    }
  }
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
  const { dataset, cleanup } = await openRaster(Gdal, id, path);
  try {
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
  } finally {
    cleanup();
  }
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
  const { dataset: src, cleanup } = await openRaster(Gdal, id, path);
  try {
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
  } finally {
    cleanup();
  }
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
      case 'planRaster':
        result = await planRaster(req.id, req.path);
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
