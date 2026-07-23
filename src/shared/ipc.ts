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
  terrainProvider: 'none' | 'maptiler' | 'ion';
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
  getSettings(): Promise<AppSettings>;
  setSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  getRecentFiles(): Promise<string[]>;
  /** Register a listener for "open this file" events pushed from main (menu/file assoc). */
  onOpenRequested(cb: (path: string) => void): () => void;
  onMenuAction(cb: (action: string) => void): () => void;
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
