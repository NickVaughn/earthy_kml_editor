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
  /**
   * Every column in a delimited-text file, in file order. Only set for
   * CSV-family files, so the import dialog can offer a coordinate-column
   * picker when autodetection misses.
   */
  csvColumns?: string[];
  /**
   * The subset of `csvColumns` that became geometry. They stay available as
   * attributes, but the dialog unchecks them from the balloon by default —
   * repeating a placemark's own coordinates back at the reader is noise.
   */
  csvGeometryColumns?: string[];
}

/**
 * How to read coordinates out of a delimited-text file. CSV carries neither
 * geometry nor a CRS of its own, so both have to be supplied: GDAL is told
 * which columns hold coordinates (or WKT), and the numbers are declared to be
 * in `epsg` before being reprojected to WGS84 for KML.
 */
export interface CsvOptions {
  /** Column holding longitude/easting. Empty = let GDAL autodetect. */
  xField?: string;
  /** Column holding latitude/northing. Empty = let GDAL autodetect. */
  yField?: string;
  /** CRS the file's coordinates are in (default 4326). */
  epsg?: number;
}

/**
 * Columns GDAL will find on its own. Matching is case-insensitive and `*` is a
 * wildcard, so these cover lon/long/longitude/lon_dd and friends.
 */
export const CSV_X_NAMES = 'lon*,x,easting,east,xcoord,x_coord,gpslon*';
export const CSV_Y_NAMES = 'lat*,y,northing,north,ycoord,y_coord,gpslat*';
export const CSV_GEOM_NAMES = 'wkt,geom,geometry,the_geom';

/**
 * GDAL open options for a delimited-text file.
 *
 * `keepGeomColumns` leaves the coordinate columns in the attribute table as
 * well as using them as geometry, which is the default: they are still the
 * file's data, and the import dialog decides what reaches a balloon by
 * unchecking them rather than by never having them. Passing false is how the
 * inspector works out WHICH columns became geometry — the ones that disappear.
 */
export function csvOpenOptions(csv?: CsvOptions, keepGeomColumns = true): string[] {
  return [
    `X_POSSIBLE_NAMES=${csv?.xField || CSV_X_NAMES}`,
    `Y_POSSIBLE_NAMES=${csv?.yField || CSV_Y_NAMES}`,
    `GEOM_POSSIBLE_NAMES=${CSV_GEOM_NAMES}`,
    `KEEP_GEOM_COLUMNS=${keepGeomColumns ? 'YES' : 'NO'}`,
    'AUTODETECT_TYPE=YES',
  ];
}

/** True for formats that need csvOpenOptions to produce any geometry at all. */
export function isDelimitedText(path: string): boolean {
  return ['csv', 'tsv', 'txt'].includes(extensionOf(path));
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
 * What loading a raster as a single overlay will cost, worked out up front
 * without touching pixels: the size it reprojects to, whether we must decode it
 * ourselves first (and the temp disk that needs), so the user can be told
 * before committing to a slow, large operation.
 */
export interface RasterPlan {
  path: string;
  driver: string;
  sourceWidth: number;
  sourceHeight: number;
  bands: number;
  /** [west, south, east, north] in degrees. */
  bounds: [number, number, number, number] | null;
  /** GDAL has no codec for this file; it must be decoded to temp files first. */
  needsDecode: boolean;
  /** Temp disk the decode would use, in bytes (0 when not needed). */
  tempDiskBytes: number;
  /** Size after reprojecting to EPSG:4326, before any GPU-limit downsampling. */
  warpedWidth: number;
  warpedHeight: number;
}

/** An XYZ tile pyramid generated on disk for a large raster. */
export interface TiledRaster {
  path: string;
  /** Cache key; tiles live under `<userData>/tiles/<hash>/{z}/{x}/{y}.png`. */
  hash: string;
  minZoom: number;
  maxZoom: number;
  /** [west, south, east, north] in degrees, for the overlay's LatLonBox. */
  bounds: [number, number, number, number];
  tileCount: number;
  bytes: number;
  ms: number;
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
  | { id: string; type: 'inspectVector'; path: string; csv?: CsvOptions }
  | {
      id: string;
      type: 'convertVector';
      path: string;
      layerName: string;
      csv?: CsvOptions;
    }
  | { id: string; type: 'inspectRaster'; path: string }
  | { id: string; type: 'planRaster'; path: string }
  | { id: string; type: 'convertRaster'; path: string; maxDimension?: number }
  | { id: string; type: 'tileRaster'; path: string; hash: string; cacheDir: string }
  | {
      id: string;
      /** Reproject downloaded coastline polygons to EPSG:3857 + spatial index. */
      type: 'prepareCoastline';
      shpPath: string;
      outDir: string;
    }
  | {
      id: string;
      /** Burn the prepared coastline into a 256x256 land mask for one XYZ tile. */
      type: 'rasterizeMask';
      path: string;
      z: number;
      x: number;
      y: number;
    };

/** Responses from the worker. */
export type GdalResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string }
  | { id: string; progress: GdalProgress };

export const VECTOR_EXTENSIONS = [
  'shp', 'zip', 'geojson', 'json', 'gpkg', 'gpx', 'kml', 'kmz',
  'gml', 'dgn', 'dxf', 'csv', 'tsv', 'txt', 'fgb', 'tab', 'mif',
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
