import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api } from '@shared/ipc';

const api: Api = {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openPath: (path) => ipcRenderer.invoke('open-path', path),
  saveFile: (req) => ipcRenderer.invoke('save-file', req),
  saveFileDialog: (defaultName, kmzOnly) =>
    ipcRenderer.invoke('save-file-dialog', defaultName, kmzOnly),
  getGoogleSession: (mapType) => ipcRenderer.invoke('get-google-session', mapType),
  getGoogleTileTemplate: (session) =>
    ipcRenderer.invoke('get-google-tile-template', session),
  hasGoogleKey: () => ipcRenderer.invoke('has-google-key'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('set-settings', partial),
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  onOpenRequested: (cb) => {
    const listener = (_e: unknown, path: string) => cb(path);
    ipcRenderer.on('open-requested', listener);
    return () => ipcRenderer.removeListener('open-requested', listener);
  },
  onMenuAction: (cb) => {
    const listener = (_e: unknown, action: string) => cb(action);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  },
  setDirty: (dirty) => ipcRenderer.send('set-dirty', dirty),
  inspectVector: (path) => ipcRenderer.invoke('gdal-inspect-vector', path),
  convertVector: (path, layerName) =>
    ipcRenderer.invoke('gdal-convert-vector', path, layerName),
  inspectRaster: (path) => ipcRenderer.invoke('gdal-inspect-raster', path),
  cancelGdal: () => ipcRenderer.invoke('gdal-cancel'),
  tileRaster: (path) => ipcRenderer.invoke('gdal-tile-raster', path),
  planRaster: (path) => ipcRenderer.invoke('gdal-plan-raster', path),
  convertRaster: (path, maxDimension) =>
    ipcRenderer.invoke('gdal-convert-raster', path, maxDimension),
  onGdalProgress: (cb) => {
    const listener = (_e: unknown, p: import('@shared/gdal').GdalProgress) => cb(p);
    ipcRenderer.on('gdal-progress', listener);
    return () => ipcRenderer.removeListener('gdal-progress', listener);
  },
  onFileChanged: (cb) => {
    const listener = (_e: unknown, path: string) => cb(path);
    ipcRenderer.on('file-externally-changed', listener);
    return () => ipcRenderer.removeListener('file-externally-changed', listener);
  },
  onFileDrop: (cb) => {
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths: string[] = [];
      for (const f of Array.from(files)) {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
      }
      if (paths.length) cb(paths);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDragOver);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDragOver);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
