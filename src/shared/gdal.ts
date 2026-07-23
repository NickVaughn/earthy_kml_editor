/** Shared types for the GDAL import pipeline (main worker ↔ renderer). */

export interface FieldInfo {
  name: string;
  /** Inferred from sample values: 'string' | 'number' | 'boolean'. */
  type: string;
  /** A few example values, for the import dialog preview. */
  samples: string[];
}

export interface LayerInfo {
  name: string;
  featureCount: number;
  /** GeoJSON geometry type of the sampled feature (Point/LineString/Polygon/…). */
  geometryType: string | null;
  fields: FieldInfo[];
}

export interface VectorInfo {
  path: string;
  driver: string;
  layers: LayerInfo[];
}

export interface RasterInfo {
  path: string;
  driver: string;
  width: number;
  height: number;
  bands: number;
  /** [west, south, east, north] in degrees, when computable. */
  bounds: [number, number, number, number] | null;
  /** True when the image is large enough to need tiling rather than a single overlay. */
  needsTiling: boolean;
}

/** A converted layer: GeoJSON (EPSG:4326) as a string, plus its layer name. */
export interface ConvertedLayer {
  layerName: string;
  geojson: string;
}

/**
 * A raster warped to EPSG:4326 and encoded as PNG, ready to drape on the globe
 * as a single overlay (no tiling). Carries timings/sizes so the UI can report
 * where single-overlay rendering starts to hurt.
 */
export interface ConvertedRaster {
  path: string;
  /** PNG bytes of the warped image. */
  png: Uint8Array;
  /** Pixel size of the emitted PNG (after any downsampling). */
  width: number;
  height: number;
  /** Pixel size of the source raster. */
  sourceWidth: number;
  sourceHeight: number;
  /** [west, south, east, north] in degrees. */
  bounds: [number, number, number, number];
  /** Milliseconds spent inside GDAL (warp + encode). */
  gdalMs: number;
  /** True when the image was scaled down to honour maxDimension. */
  downsampled: boolean;
}

export interface GdalProgress {
  jobId: string;
  /** 0..1 when known, else null for indeterminate. */
  fraction: number | null;
  message: string;
}

/** Requests sent to the worker. */
export type GdalRequest =
  | { id: string; type: 'inspectVector'; path: string }
  | { id: string; type: 'convertVector'; path: string; layerName: string }
  | { id: string; type: 'inspectRaster'; path: string }
  | { id: string; type: 'convertRaster'; path: string; maxDimension?: number };

/** Responses from the worker. */
export type GdalResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string }
  | { id: string; progress: GdalProgress };

export const VECTOR_EXTENSIONS = [
  'shp', 'zip', 'geojson', 'json', 'gpkg', 'gpx', 'kml', 'kmz',
  'gml', 'dgn', 'dxf', 'csv', 'fgb', 'tab', 'mif',
];

export const RASTER_EXTENSIONS = [
  'tif', 'tiff', 'jp2', 'img', 'vrt', 'png', 'jpg', 'jpeg', 'asc', 'dem',
];

export function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

export function isVectorPath(path: string): boolean {
  return VECTOR_EXTENSIONS.includes(extensionOf(path));
}

export function isRasterPath(path: string): boolean {
  return RASTER_EXTENSIONS.includes(extensionOf(path));
}
