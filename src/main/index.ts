import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import { join } from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import type { MenuItemConstructorOptions } from 'electron';
import { readGeoFile, writeGeoFile } from './kmz';
import {
  getGoogleSession,
  googleTileTemplate,
  hasGoogleKey,
} from './google';
import {
  getSettings,
  setSettings,
  getRecentFiles,
  pushRecentFile,
} from './settings';
import {
  inspectVector,
  convertVector,
  inspectRaster,
  planRaster,
  convertRaster,
  cancelGdal,
  shutdownGdal,
} from './gdal';
import type { SaveRequest, GoogleMapType } from '@shared/ipc';

let mainWindow: BrowserWindow | null = null;
/** A path passed on the command line / via file association before the window is ready. */
let pendingOpenPath: string | null = null;

// Unsaved-changes quit guard.
let isDirty = false;
let forceClose = false;

// External-change watcher for the currently open file.
let watcher: FSWatcher | null = null;
let watchedPath: string | null = null;
let selfWriteUntil = 0; // ignore our own saves until this timestamp
let changeTimer: NodeJS.Timeout | null = null;

function watchFile(path: string): void {
  if (watcher && watchedPath === path) return;
  watcher?.close();
  watchedPath = path;
  try {
    watcher = watch(path, () => {
      if (Date.now() < selfWriteUntil) return; // our own save
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        mainWindow?.webContents.send('file-externally-changed', path);
      }, 300);
    });
  } catch {
    watcher = null;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a1a',
    title: 'Earthy',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // Give the page keyboard focus immediately, so shortcuts (u/n/…) work on
    // fresh launch without first clicking into the window or opening a file.
    mainWindow?.webContents.focus();
    if (pendingOpenPath) {
      mainWindow?.webContents.send('open-requested', pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  // Opt-in smoke test: pipe renderer diagnostics to stdout and auto-quit.
  // Enable with NGE_SMOKE=<ms>. Used by the Phase 1 boot check, not in normal use.
  if (process.env.NGE_SMOKE) {
    const wc = mainWindow.webContents;
    wc.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    wc.on('render-process-gone', (_e, details) =>
      console.log(`[render-process-gone] ${JSON.stringify(details)}`),
    );
    wc.on('did-fail-load', (_e, code, desc) =>
      console.log(`[did-fail-load] ${code} ${desc}`),
    );
    wc.on('did-finish-load', () => console.log('[smoke] renderer did-finish-load'));
    if (process.env.NGE_SMOKE_KML) {
      wc.once('did-finish-load', () => {
        setTimeout(
          () => wc.send('open-requested', process.env.NGE_SMOKE_KML),
          1500,
        );
      });
    }
    const ms = Number(process.env.NGE_SMOKE) || 8000;
    setTimeout(() => {
      console.log('[smoke] timeout reached, quitting');
      app.quit();
    }, ms);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Unsaved-changes guard on window close.
  mainWindow.on('close', (e) => {
    if (!isDirty || forceClose) return;
    e.preventDefault();
    dialog
      .showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['Cancel', 'Discard changes'],
        defaultId: 0,
        cancelId: 0,
        message: 'You have unsaved changes. Discard them and close?',
      })
      .then(({ response }) => {
        if (response === 1) {
          forceClose = true;
          mainWindow?.close();
        }
      });
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function sendMenu(action: string): void {
  mainWindow?.webContents.send('menu-action', action);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('saveAs') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenu('redo') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.handle('open-file-dialog', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'KML / KMZ', extensions: ['kml', 'kmz'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const opened = await readGeoFile(res.filePaths[0]);
    pushRecentFile(res.filePaths[0]);
    watchFile(res.filePaths[0]);
    return opened;
  });

  ipcMain.handle('open-path', async (_e, path: string) => {
    const opened = await readGeoFile(path);
    pushRecentFile(path);
    watchFile(path);
    return opened;
  });

  ipcMain.handle('save-file', async (_e, req: SaveRequest) => {
    try {
      selfWriteUntil = Date.now() + 1500; // suppress our own change event
      await writeGeoFile(req.path, req.kml, req.asKmz, req.resources ?? {});
      pushRecentFile(req.path);
      watchFile(req.path);
      return { ok: true, path: req.path };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.on('set-dirty', (_e, dirty: boolean) => {
    isDirty = dirty;
  });

  ipcMain.handle('gdal-inspect-vector', (_e, path: string) => inspectVector(path));
  ipcMain.handle('gdal-convert-vector', (_e, path: string, layerName: string) =>
    convertVector(path, layerName),
  );
  ipcMain.handle('gdal-inspect-raster', (_e, path: string) => inspectRaster(path));
  ipcMain.handle('gdal-cancel', () => cancelGdal());
  ipcMain.handle('gdal-plan-raster', (_e, path: string) => planRaster(path));
  ipcMain.handle('gdal-convert-raster', (_e, path: string, maxDimension?: number) =>
    convertRaster(path, maxDimension),
  );

  ipcMain.handle('save-file-dialog', async (_e, defaultName: string, kmzOnly?: boolean) => {
    // A document with embedded imagery can only be written losslessly as KMZ,
    // so don't offer KML as a choice at all in that case.
    const res = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultName,
      filters: kmzOnly
        ? [{ name: 'KMZ', extensions: ['kmz'] }]
        : [
            { name: 'KML', extensions: ['kml'] },
            { name: 'KMZ', extensions: ['kmz'] },
          ],
    });
    if (res.canceled || !res.filePath) return null;
    // Some platforms let the extension be typed away; honour kmzOnly regardless.
    const asKmz = kmzOnly || res.filePath.toLowerCase().endsWith('.kmz');
    const path = kmzOnly && !res.filePath.toLowerCase().endsWith('.kmz')
      ? `${res.filePath}.kmz`
      : res.filePath;
    return { path, asKmz };
  });

  ipcMain.handle('get-google-session', (_e, mapType: GoogleMapType) =>
    getGoogleSession(mapType),
  );
  ipcMain.handle('get-google-tile-template', (_e, session: string) =>
    googleTileTemplate(session),
  );
  ipcMain.handle('has-google-key', () => hasGoogleKey());

  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('set-settings', (_e, partial) => setSettings(partial));
  ipcMain.handle('get-recent-files', () => getRecentFiles());
}

// Capture a path passed as an argv (Windows/Linux file association).
function argvPath(argv: string[]): string | null {
  const candidate = argv.find((a) => /\.(kml|kmz)$/i.test(a));
  return candidate ?? null;
}

// macOS "open with" before ready.
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('open-requested', path);
  } else {
    pendingOpenPath = path;
  }
});

app.whenReady().then(() => {
  pendingOpenPath = argvPath(process.argv.slice(1)) ?? pendingOpenPath;
  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  shutdownGdal();
  if (process.platform !== 'darwin') app.quit();
});
