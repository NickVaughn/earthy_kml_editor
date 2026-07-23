import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '@renderer/state/store';
import { GlobeRenderer } from '@renderer/globe/GlobeRenderer';
import { basemapById } from '@renderer/globe/imagery';
import { resolveBalloonHtml } from '@renderer/model/balloon';
import { lineLength, polygonArea, formatLength, formatArea } from '@renderer/model/measure';
import { isVectorPath, isRasterPath } from '@shared/gdal';
import { useKeybindings } from '@renderer/input/useKeybindings';
import { withGdalJob, GdalCancelled, gdalJobActive } from '@renderer/state/gdalJob';
import { TreePanel } from './TreePanel';
import { ImportDialog } from './ImportDialog';
import { HelpOverlay } from './HelpOverlay';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { Balloon } from './Balloon';
import { FeatureContextMenu } from './FeatureContextMenu';
import { RasterPanel } from './RasterPanel';
import { JobProgress } from './JobProgress';
import { RestyleDialog } from './RestyleDialog';
import { DescriptionDialog } from './DescriptionDialog';

/** Show a transient message in the status strip. */
function flash(message: string, ms = 5000): void {
  useStore.getState().setImportStatus(message);
  setTimeout(() => {
    if (useStore.getState().importStatus === message) {
      useStore.getState().setImportStatus(null);
    }
  }, ms);
}

/** Temp-disk usage worth warning about before committing to a decode. */
const BIG_TEMP_DISK = 512 * 1024 * 1024;

function fmtBytes(n: number): string {
  return n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(n / 1024 ** 2)} MB`;
}

/**
 * Spell out what loading a raster will cost — resampling for the GPU limit and
 * temporary disk for an unsupported codec — and let the user back out. Returns
 * false only if they cancel; stays silent for unremarkable files so routine
 * loads aren't nagged.
 */
function confirmRasterCost(
  name: string,
  plan: import('@shared/gdal').RasterPlan,
  o: { maxTex: number; willResample: boolean; finalW: number; finalH: number },
): boolean {
  if (!o.willResample && plan.tempDiskBytes < BIG_TEMP_DISK) return true;

  const lines = [
    `${name} is ${plan.sourceWidth.toLocaleString()}×${plan.sourceHeight.toLocaleString()} px, ` +
      `${plan.bands} band${plan.bands === 1 ? '' : 's'}.`,
    '',
  ];
  if (o.willResample) {
    const pct = Math.round((o.finalW / plan.warpedWidth) * 100);
    lines.push(
      `Reprojected it becomes ${plan.warpedWidth.toLocaleString()}×${plan.warpedHeight.toLocaleString()} px, ` +
        `which is past this GPU's maximum texture size of ${o.maxTex.toLocaleString()} px.`,
      `To fit in a single overlay it must be RESAMPLED down to ` +
        `${o.finalW.toLocaleString()}×${o.finalH.toLocaleString()} px — about ${pct}% of full ` +
        `resolution — so fine detail will be lost. (Tiled rendering would avoid this.)`,
      '',
    );
  }
  if (plan.tempDiskBytes > 0) {
    lines.push(
      `Its compression isn't supported by the bundled GDAL, so Earthy will decode it first, ` +
        `using about ${fmtBytes(plan.tempDiskBytes)} of temporary disk space ` +
        `(freed once loading finishes).`,
      '',
    );
  }
  lines.push(
    `It will occupy roughly ${fmtBytes(o.finalW * o.finalH * 4)} of video memory.`,
    '',
    'Continue?',
  );
  return window.confirm(lines.join('\n'));
}

const MODE_HINT: Record<string, string> = {
  'draw-point': 'Click on the map to drop a point · Esc to cancel',
  'draw-line':
    'Click to add points · Shift-drag to sketch freehand · Backspace to undo · double-click or Enter to finish · Esc to cancel',
  'draw-polygon':
    'Click to add vertices · Shift-drag to sketch freehand · Backspace to undo · double-click or Enter to finish · Esc to cancel',
  edit: 'Drag handles to move · click a midpoint to add · right-click/Delete to remove · Esc when done',
  measure: 'Click to add points · double-click to finish · Esc to cancel',
};

export function App(): JSX.Element {
  const globeContainer = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeRenderer | null>(null);
  const [featureMenu, setFeatureMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);

  const store = useStore();
  useKeybindings(globeRef);

  // ---- one-time globe init -------------------------------------------------
  useEffect(() => {
    if (!globeContainer.current || globeRef.current) return;
    const globe = new GlobeRenderer(globeContainer.current, {
      onPick: (id) => {
        setFeatureMenu(null);
        useStore.getState().setSelection(id ? [id] : []);
        useStore.getState().openBalloon(id);
      },
      onCoord: (lon, lat) => useStore.getState().setCursor(lon, lat),
      onContextMenu: (id, x, y) => {
        if (!id) {
          setFeatureMenu(null);
          return;
        }
        const s = useStore.getState();
        if (!s.selection.includes(id)) s.setSelection([id]);
        setFeatureMenu({ nodeId: id, x, y });
      },
    });
    globeRef.current = globe;
    return () => {
      globe.destroy();
      globeRef.current = null;
    };
  }, []);

  // ---- GDAL progress: feed the worker's reports into the progress bar -----
  useEffect(() => {
    return window.api.onGdalProgress((p) => {
      if (!gdalJobActive()) return;
      useStore.getState().setGdalJob({ message: p.message, fraction: p.fraction });
    });
  }, []);

  // ---- initial settings + key probe ---------------------------------------
  useEffect(() => {
    (async () => {
      const [settings, hasKey] = await Promise.all([
        window.api.getSettings(),
        window.api.hasGoogleKey(),
      ]);
      useStore.getState().setSettings(settings);
      useStore.getState().setHasGoogleKey(hasKey);
      await applyBasemap(settings.basemap);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyBasemap = useCallback(async (id: string) => {
    const globe = globeRef.current;
    if (!globe) return;
    const { settings } = useStore.getState();
    const def = basemapById(id);
    try {
      await globe.setBasemap(
        def.build({ customUrl: settings.customXyzUrl, googleMapType: settings.googleMapType }),
      );
    } catch (err) {
      console.error('Basemap failed:', err);
      // Fall back to Esri so the user is never left with a blank globe — but say
      // so, otherwise the chosen basemap just looks identical to Esri.
      if (id !== 'esri') {
        const why = err instanceof Error ? err.message : String(err);
        flash(`“${def.label}” failed to load — showing Esri World Imagery instead. ${why}`, 12000);
        await globe.setBasemap(basemapById('esri').build({}));
      }
    }
  }, []);

  // ---- open/close a document: rebuild + frame -----------------------------
  useEffect(() => {
    globeRef.current?.setDocuments(useStore.getState().docs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.docEpoch]);

  // ---- content edit: rebuild, keep the camera -----------------------------
  useEffect(() => {
    if (store.sceneEpoch === 0) return;
    globeRef.current?.rebuild();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sceneEpoch]);

  // ---- visibility-only updates (no rebuild) -------------------------------
  useEffect(() => {
    globeRef.current?.refreshVisibility();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.visEpoch]);

  // ---- selection highlight -------------------------------------------------
  useEffect(() => {
    globeRef.current?.setSelection(store.selection);
  }, [store.selection]);

  // ---- report dirty state to main (quit guard) ----------------------------
  useEffect(() => {
    window.api.setDirty(store.dirty);
  }, [store.dirty]);

  // ---- interaction mode drives the globe draw/edit tools ------------------
  const prevModeRef = useRef<string>('none');
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const mode = store.interactionMode;
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    const s = () => useStore.getState();

    // Leaving edit mode: rebuild the scene to restore the (hidden) edited feature.
    if (prev === 'edit' && mode !== 'edit') globe.rebuild();

    if (mode === 'none') {
      globe.cancelTool();
      return;
    }
    if (mode === 'draw-point' || mode === 'draw-line' || mode === 'draw-polygon') {
      const kind =
        mode === 'draw-point' ? 'Point' : mode === 'draw-line' ? 'LineString' : 'Polygon';
      globe.startDraw(
        kind,
        (g) => {
          s().addPlacemark(g);
          s().setMode('none');
        },
        () => s().setMode('none'),
      );
    } else if (mode === 'measure') {
      globe.startDraw(
        'LineString',
        (g) => {
          const coords = g.kind === 'LineString' ? g.coordinates : [];
          let text = `Length: ${formatLength(lineLength(coords))}`;
          if (coords.length >= 3) text += ` · Area: ${formatArea(polygonArea(coords))}`;
          s().setMeasure(text);
          s().setMode('none');
        },
        () => s().setMode('none'),
      );
    } else if (mode === 'edit') {
      const sel = s().selection;
      const node = sel.length === 1 ? s().docOf(sel[0])?.nodeById(sel[0]) : undefined;
      if (node?.type === 'Placemark' && node.geometry) {
        globe.startEdit(node.id, (g) => s().updateGeometry(node.id, g));
      } else {
        s().setMode('none');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.interactionMode]);

  // ---- raster overlays (single image, no tiling) --------------------------
  const loadRaster = useCallback(async (path: string) => {
    const globe = globeRef.current;
    if (!globe) return;
    const name = path.split('/').pop() ?? path;
    const st = useStore.getState();
    try {
      // Work out the whole cost first — reprojected size, whether the codec
      // forces a decode, and the temp disk that needs — without touching pixels.
      st.setImportStatus(null);
      const plan = await withGdalJob(`Inspecting ${name}…`, () =>
        window.api.planRaster(path),
      );
      if (!plan.bounds) {
        st.setImportStatus(null);
        alert(`${name} has no georeferencing Earthy can read, so it can't be placed.`);
        return;
      }

      // One overlay is one GPU texture, so the GPU's max dimension is a hard
      // ceiling. Downsample to fit rather than failing the upload outright.
      const maxTex = globe.maxTextureSize() || 8192;
      const warpedMax = Math.max(plan.warpedWidth, plan.warpedHeight);
      const willResample = warpedMax > maxTex;
      const scale = willResample ? maxTex / warpedMax : 1;
      const finalW = Math.round(plan.warpedWidth * scale);
      const finalH = Math.round(plan.warpedHeight * scale);

      if (!confirmRasterCost(name, plan, { maxTex, willResample, finalW, finalH })) {
        st.setImportStatus(null);
        return;
      }

      const t0 = performance.now();
      const conv = await withGdalJob(
        `Warping ${name} (${plan.sourceWidth.toLocaleString()}×${plan.sourceHeight.toLocaleString()})…`,
        () => window.api.convertRaster(path, maxTex),
      );
      const ipcMs = performance.now() - t0 - conv.gdalMs;

      st.setImportStatus(`Uploading ${conv.width.toLocaleString()}×${conv.height.toLocaleString()}…`);
      const id = `raster-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      const { uploadMs } = await globe.addRasterOverlay(id, conv.png, conv.bounds);

      st.addRaster({
        id,
        name,
        path,
        width: conv.width,
        height: conv.height,
        sourceWidth: conv.sourceWidth,
        sourceHeight: conv.sourceHeight,
        bounds: conv.bounds,
        bytes: conv.png.byteLength,
        gdalMs: conv.gdalMs,
        uploadMs,
        downsampled: conv.downsampled,
        visible: true,
      });
      globe.flyToBounds(conv.bounds);

      // Console line is the detailed record for the perf experiment.
      console.info(
        `[earthy] raster "${name}": source ${plan.sourceWidth}×${plan.sourceHeight}, ` +
          `drawn ${conv.width}×${conv.height} (${((conv.width * conv.height) / 1e6).toFixed(1)} MP), ` +
          `png ${(conv.png.byteLength / 1048576).toFixed(1)} MB, ` +
          `~${((conv.width * conv.height * 4) / 1048576).toFixed(1)} MB vram, ` +
          `gdal ${Math.round(conv.gdalMs)} ms, ipc ${Math.round(ipcMs)} ms, ` +
          `upload ${Math.round(uploadMs)} ms` +
          (conv.downsampled ? ` (downsampled to fit MAX_TEXTURE_SIZE ${maxTex})` : ''),
      );
      flash(
        `${name}: ${conv.width.toLocaleString()}×${conv.height.toLocaleString()} · ` +
          `warp ${Math.round(conv.gdalMs)} ms · upload ${Math.round(uploadMs)} ms` +
          (conv.downsampled ? ' · ⚠ resampled to fit GPU limit' : ''),
        8000,
      );
    } catch (err) {
      st.setImportStatus(null);
      if (err instanceof GdalCancelled) {
        flash(`Cancelled loading ${name}.`);
        return;
      }
      alert(`Could not load ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // ---- file operations -----------------------------------------------------
  // Opening adds a document to the workspace (multi-doc), so no discard guard.
  const doOpen = useCallback(async () => {
    const opened = await window.api.openFileDialog();
    if (opened) useStore.getState().openDoc(opened);
  }, []);

  const openPath = useCallback(async (path: string) => {
    const opened = await window.api.openPath(path);
    if (opened) useStore.getState().openDoc(opened);
  }, []);

  const doSave = useCallback(async (forceDialog: boolean, docId?: string) => {
    const st = useStore.getState();
    const doc = docId ? st.docs.find((d) => d.id === docId) : st.activeDoc();
    if (!doc) return;
    let path = doc.path;
    let asKmz = doc.wasKmz;
    if (!path || forceDialog) {
      const base = path?.split('/').pop() ?? `${doc.root.name || 'untitled'}.kml`;
      const chosen = await window.api.saveFileDialog(base);
      if (!chosen) return;
      path = chosen.path;
      asKmz = chosen.asKmz;
    }
    const res = await window.api.saveFile({
      path,
      kml: doc.serialize(),
      asKmz,
      resources: doc.resources,
    });
    if (res.ok && res.path) st.markSaved(doc.id, res.path, asKmz);
    else if (!res.ok) alert(`Save failed: ${res.error}`);
  }, []);

  // ---- menu + drop + open-request listeners --------------------------------
  useEffect(() => {
    const offMenu = window.api.onMenuAction((action) => {
      if (action === 'new') {
        const doc = useStore.getState().newDocument();
        useStore.getState().requestRename(doc.root.id);
      } else if (action === 'open') doOpen();
      else if (action === 'save') doSave(false);
      else if (action === 'saveAs') doSave(true);
      else if (action === 'undo') useStore.getState().undo();
      else if (action === 'redo') useStore.getState().redo();
    });
    const offOpen = window.api.onOpenRequested((path) => openPath(path));
    const offDrop = window.api.onFileDrop(async (paths) => {
      for (const p of paths) {
        if (/\.(kml|kmz)$/i.test(p)) {
          openPath(p);
        } else if (isVectorPath(p)) {
          // Any other OGR-readable vector: inspect, then offer import options.
          try {
            const info = await withGdalJob(`Reading ${p.split('/').pop()}…`, () =>
              window.api.inspectVector(p),
            );
            useStore.getState().setImportStatus(null);
            if (info.layers.length) useStore.getState().setPendingImport({ path: p, info });
            else alert('No readable layers found in that file.');
          } catch (err) {
            useStore.getState().setImportStatus(null);
            if (err instanceof GdalCancelled) {
              flash(`Cancelled reading ${p.split('/').pop()}.`);
            } else {
              alert(`Could not read ${p.split('/').pop()}: ${
                err instanceof Error ? err.message : String(err)
              }`);
            }
          }
        } else if (isRasterPath(p)) {
          await loadRaster(p);
        } else {
          // Don't swallow the drop silently — say why nothing happened.
          flash(`Unsupported file type: ${p.split('/').pop()}`);
        }
      }
    });
    const offChanged = window.api.onFileChanged((path) => {
      const st = useStore.getState();
      const doc = st.docs.find((d) => d.path === path);
      if (!doc) return;
      const msg = doc.dirty
        ? 'This file changed on disk, but you have unsaved edits. Reload and lose your changes?'
        : 'This file changed on disk. Reload?';
      if (window.confirm(msg)) {
        window.api.openPath(path).then((opened) => {
          if (opened) {
            useStore.getState().closeDoc(doc.id);
            useStore.getState().openDoc(opened);
          }
        });
      }
    });
    return () => {
      offMenu();
      offOpen();
      offDrop();
      offChanged();
    };
  }, [doOpen, doSave, openPath, loadRaster]);

  const onChangeBasemap = useCallback(
    async (id: string) => {
      const next = await window.api.setSettings({ basemap: id });
      useStore.getState().setSettings(next);
      await applyBasemap(id);
    },
    [applyBasemap],
  );

  const balloonDoc = store.balloonNodeId ? store.docOf(store.balloonNodeId) : undefined;
  const balloonNode = balloonDoc?.nodeById(store.balloonNodeId!) ?? null;
  const balloonHtml =
    balloonNode && balloonDoc ? resolveBalloonHtml(balloonDoc.data, balloonNode) : '';

  return (
    <div className="app">
      <Toolbar onOpen={doOpen} onChangeBasemap={onChangeBasemap} />
      <div className="body">
        <div className="sidebar">
          <TreePanel
            onFlyTo={(id) => globeRef.current?.flyTo(id)}
            onOpenBalloon={(id) => useStore.getState().openBalloon(id)}
            onSave={(docId) => doSave(false, docId)}
            onSaveAs={(docId) => doSave(true, docId)}
          />
          <RasterPanel
            onToggle={(id) => {
              useStore.getState().toggleRasterVisible(id);
              const r = useStore.getState().rasters.find((x) => x.id === id);
              if (r) globeRef.current?.setRasterVisible(id, r.visible);
            }}
            onRemove={(id) => {
              globeRef.current?.removeRasterOverlay(id);
              useStore.getState().removeRaster(id);
            }}
            onZoom={(bounds) => globeRef.current?.flyToBounds(bounds)}
          />
        </div>
        <div className="globe-wrap">
          <div ref={globeContainer} className="globe" />
          {store.docs.length === 0 && (
            <div className="empty-hint">
              Open a KML/KMZ (⌘O) or drag one in — you can open several at once.
            </div>
          )}
          {store.interactionMode !== 'none' && (
            <div className="mode-hint">
              {MODE_HINT[store.interactionMode]}
              <button onClick={() => useStore.getState().setMode('none')}>Done</button>
            </div>
          )}
          {store.measureResult && (
            <div className="measure-readout">
              {store.measureResult}
              <button onClick={() => useStore.getState().setMeasure(null)}>✕</button>
            </div>
          )}
          {balloonNode && (
            <Balloon
              node={balloonNode}
              html={balloonHtml}
              resources={balloonDoc?.resources ?? {}}
              onClose={() => useStore.getState().openBalloon(null)}
            />
          )}
          <JobProgress />
          {featureMenu && (
            <FeatureContextMenu
              nodeId={featureMenu.nodeId}
              x={featureMenu.x}
              y={featureMenu.y}
              onClose={() => setFeatureMenu(null)}
            />
          )}
        </div>
      </div>
      {store.importStatus && <div className="import-status">{store.importStatus}</div>}
      <ImportDialog />
      {store.restyleIds && (
        <RestyleDialog
          key={store.restyleIds.join(',')}
          ids={store.restyleIds}
          onClose={() => useStore.getState().openRestyle(null)}
        />
      )}
      {store.descEditId && (
        <DescriptionDialog
          key={store.descEditId}
          nodeId={store.descEditId}
          onClose={() => useStore.getState().openDescriptionEditor(null)}
        />
      )}
      <HelpOverlay />
      <StatusBar />
    </div>
  );
}
