/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Keep this file dependency-free (types only) so both sides can import it.
 */

export interface OpenedFile {
  /** Absolute path on disk, or null for an unsaved/blank document. */
  path: string | null;
  /** The KML text (doc.kml contents for KMZ). */
  kml: string;
  /**
   * For KMZ: map of archive-relative resource path -> data URL, so the
   * renderer can resolve local icon/overlay hrefs without touching disk.
   */
  resources: Record<string, string>;
  /** True if the source was a .kmz archive. */
  wasKmz: boolean;
}

export interface SaveRequest {
  path: string;
  kml: string;
  /** When true, write a .kmz zipping kml + resources. */
  asKmz: boolean;
  /** archive-relative path -> data URL, re-packed into the KMZ on save. */
  resources?: Record<string, string>;
  /**
   * Tile pyramids to embed as KML super-overlays, making a tiled raster
   * portable (and renderable in Google Earth) instead of pointing at a local
   * cache. Tiles are streamed straight from the cache into the archive.
   */
  tiled?: { hash: string; name: string }[];
}

export interface GoogleSession {
  session: string;
  expiry: number; // epoch ms
  tileWidth: number;
  tileHeight: number;
  imageFormat: string;
}

export type GoogleMapType = 'satellite' | 'roadmap' | 'terrain';

export interface AppSettings {
  basemap: string; // id of the active basemap
  googleMapType: GoogleMapType;
  customXyzUrl: string;
  /** Whether the globe renders 3D terrain relief (vs a flat ellipsoid). */
  render3DTerrain: boolean;
  /** Id of the active terrain source (see shared/terrain.ts). */
  activeTerrainId: string;
  /**
   * Render the terrain source's sea floor. Off (the default) clamps the ocean
   * at sea level, because the source bathymetry is far coarser than the deepest
   * zoom and decodes to a staircase of flat, tile-sized plates.
   */
  showBathymetry: boolean;
  /**
   * Let terrain occlude vector features. Off (Cesium's default) draws them on
   * top of relief, so a flat feature under a hillside stays visible but appears
   * to slide across it as the camera tilts.
   */
  depthTestAgainstTerrain: boolean;
}

/** The bundled EGM96 geoid grid, parsed in main and sampled in the renderer. */
export interface GeoidGrid {
  width: number;
  height: number;
  /** Geographic position of pixel (0,0) — the grid's NW node. */
  originLon: number;
  originLat: number;
  /** Per-pixel step in degrees; dLat is negative (rows run north→south). */
  dLon: number;
  dLat: number;
  /** Row-major undulation N in metres (row 0 = north). MSL = ellipsoidal − N. */
  values: Float32Array;
}

export interface Api {
  openFileDialog(): Promise<OpenedFile | null>;
  /** Open a specific path (drag-drop, file association, recent files). */
  openPath(path: string): Promise<OpenedFile | null>;
  saveFile(req: SaveRequest): Promise<{ ok: boolean; path?: string; error?: string }>;
  /** `kmzOnly` restricts the dialog to KMZ (documents with embedded imagery). */
  saveFileDialog(
    defaultName: string,
    kmzOnly?: boolean,
  ): Promise<{ path: string; asKmz: boolean } | null>;
  /** Returns null if NGE_GOOGLE_MAPS_API_KEY is not configured. */
  getGoogleSession(mapType: GoogleMapType): Promise<GoogleSession | null>;
  /** The Google tile URL template, with {session}/{key} substituted, {x}{y}{z} left for Cesium. */
  getGoogleTileTemplate(session: string): Promise<string>;
  hasGoogleKey(): Promise<boolean>;
  /** Raw PNG bytes for a terrain tile; main proxies the remote source (dodges CORS). */
  fetchTerrainTile(sourceId: string, z: number, x: number, y: number): Promise<Uint8Array | null>;
  /** Raw bytes of the bundled EGM96 geoid GeoTIFF; the renderer parses them. */
  getGeoidGrid(): Promise<Uint8Array | null>;
  getSettings(): Promise<AppSettings>;
  setSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  getRecentFiles(): Promise<string[]>;
  /** Register a listener for "open this file" events pushed from main (menu/file assoc). */
  onOpenRequested(cb: (path: string) => void): () => void;
  onMenuAction(cb: (action: string) => void): () => void;
  /** Terrain enabled / active-source changed from the native Terrain menu. */
  onTerrainChanged(cb: (settings: AppSettings) => void): () => void;
  /** Native file drag-drop onto the window; yields absolute paths. */
  onFileDrop(cb: (paths: string[]) => void): () => void;
  /** Tell main whether the document has unsaved changes (for the quit guard). */
  setDirty(dirty: boolean): void;

  // ---- GDAL import (Phase 4) ----
  inspectVector(path: string): Promise<import('./gdal').VectorInfo>;
  convertVector(path: string, layerName: string): Promise<import('./gdal').ConvertedLayer>;
  inspectRaster(path: string): Promise<import('./gdal').RasterInfo>;
  /** Abort the running GDAL job (terminates and respawns the worker). */
  cancelGdal(): Promise<void>;
  /** Build (or reuse) an XYZ tile pyramid for a large raster. */
  tileRaster(path: string): Promise<import('./gdal').TiledRaster>;
  /** Size of the local tile cache. */
  tileCacheUsage(): Promise<{ bytes: number; pyramids: number }>;
  /** Delete every cached pyramid (safe once documents are saved as KMZ). */
  clearTileCache(): Promise<void>;
  planRaster(path: string): Promise<import('./gdal').RasterPlan>;
  convertRaster(
    path: string,
    maxDimension?: number,
  ): Promise<import('./gdal').ConvertedRaster>;
  onGdalProgress(cb: (p: import('./gdal').GdalProgress) => void): () => void;
  /** Fires when the currently open file is modified on disk by another program. */
  onFileChanged(cb: (path: string) => void): () => void;
}

declare global {
  interface Window {
    api: Api;
  }
}
