import { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { getGeoidGrid } from './geoid';
import {
  inspectVector,
  convertVector,
  inspectRaster,
  planRaster,
  convertRaster,
  tileRaster,
  tilesRoot,
  tileCacheUsage,
  clearTileCache,
  cancelGdal,
  shutdownGdal,
} from './gdal';
import type { SaveRequest, GoogleMapType, AppSettings } from '@shared/ipc';
import { BUILTIN_TERRAIN, terrainSourceById } from '../shared/terrain';

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

/** 1×1 transparent PNG, served where a pyramid has no tile. */
const EMPTY_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Serve generated raster tiles to the renderer as
 * `earthy-tiles://<hash>/<z>/<x>/<y>.png`. Paths are resolved strictly inside
 * the tile cache so a crafted URL can't read elsewhere on disk.
 */
function registerTileProtocol(): void {
  protocol.handle('earthy-tiles', async (request) => {
    try {
      const url = new URL(request.url);
      const root = tilesRoot();
      const target = normalize(join(root, url.hostname, decodeURIComponent(url.pathname)));
      if (target !== root && !target.startsWith(root + sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      return await net.fetch(pathToFileURL(target).toString());
    } catch {
      // Cesium asks for tiles outside the pyramid's coverage; answer with a
      // transparent tile instead of an error so it doesn't log for every miss.
      return new Response(EMPTY_TILE, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
  });
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

function sendTerrain(settings: AppSettings): void {
  mainWindow?.webContents.send('terrain-changed', settings);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const settings = getSettings();
  const terrainItems: MenuItemConstructorOptions[] = [
    {
      label: 'Render 3D terrain',
      type: 'checkbox',
      checked: settings.render3DTerrain,
      enabled: BUILTIN_TERRAIN.length > 0,
      click: () => {
        const next = setSettings({ render3DTerrain: !getSettings().render3DTerrain });
        sendTerrain(next);
        buildMenu();
      },
    },
    { type: 'separator' },
    ...BUILTIN_TERRAIN.map(
      (s): MenuItemConstructorOptions => ({
        label: s.label,
        type: 'radio',
        checked: settings.activeTerrainId === s.id,
        click: () => {
          const next = setSettings({ activeTerrainId: s.id });
          sendTerrain(next);
          buildMenu();
        },
      }),
    ),
  ];
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
        { label: 'Clear Tile Cache…', click: () => sendMenu('clearTiles') },
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
    {
      label: 'Terrain',
      submenu: terrainItems,
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
    const opened = await readGeoFile(res.filePaths[0], tilesRoot());
    pushRecentFile(res.filePaths[0]);
    watchFile(res.filePaths[0]);
    return opened;
  });

  ipcMain.handle('open-path', async (_e, path: string) => {
    const opened = await readGeoFile(path, tilesRoot());
    pushRecentFile(path);
    watchFile(path);
    return opened;
  });

  ipcMain.handle('save-file', async (_e, req: SaveRequest) => {
    try {
      selfWriteUntil = Date.now() + 1500; // suppress our own change event
      await writeGeoFile(
        req.path,
        req.kml,
        req.asKmz,
        req.resources ?? {},
        req.tiled ?? [],
        tilesRoot(),
      );
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
  ipcMain.handle('gdal-tile-raster', (_e, path: string) => tileRaster(path));
  ipcMain.handle('tile-cache-usage', () => tileCacheUsage());
  ipcMain.handle('tile-cache-clear', () => clearTileCache());
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

  ipcMain.handle(
    'fetch-terrain-tile',
    async (_e, sourceId: string, z: number, x: number, y: number) => {
      const desc = terrainSourceById(sourceId);
      if (!desc) return null;
      const remote = desc.urlTemplate
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      const res = await net.fetch(remote);
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    },
  );

  ipcMain.handle('get-geoid-grid', () => getGeoidGrid());

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

// Must be declared before the app is ready, or the renderer can't load tiles.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'earthy-tiles',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

app.whenReady().then(() => {
  pendingOpenPath = argvPath(process.argv.slice(1)) ?? pendingOpenPath;
  registerTileProtocol();
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
