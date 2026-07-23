import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from '@renderer/state/store';
import { GlobeRenderer } from '@renderer/globe/GlobeRenderer';
import { basemapById } from '@renderer/globe/imagery';
import { resolveBalloonHtml } from '@renderer/model/balloon';
import { lineLength, polygonArea, formatLength, formatArea } from '@renderer/model/measure';
import { isVectorPath } from '@shared/gdal';
import { useKeybindings } from '@renderer/input/useKeybindings';
import { TreePanel } from './TreePanel';
import { ImportDialog } from './ImportDialog';
import { HelpOverlay } from './HelpOverlay';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { Balloon } from './Balloon';
import { FeatureContextMenu } from './FeatureContextMenu';
import { RestyleDialog } from './RestyleDialog';
import { DescriptionDialog } from './DescriptionDialog';

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
      // Fall back to Esri so the user is never left with a blank globe.
      if (id !== 'esri') await globe.setBasemap(basemapById('esri').build({}));
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
          useStore.getState().setImportStatus(`Reading ${p.split('/').pop()}…`);
          try {
            const info = await window.api.inspectVector(p);
            useStore.getState().setImportStatus(null);
            if (info.layers.length) useStore.getState().setPendingImport({ path: p, info });
            else alert('No readable layers found in that file.');
          } catch (err) {
            useStore.getState().setImportStatus(null);
            alert(`Could not read ${p.split('/').pop()}: ${
              err instanceof Error ? err.message : String(err)
            }`);
          }
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
  }, [doOpen, doSave, openPath]);

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
