import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '@renderer/state/store';
import { GlobeRenderer } from '@renderer/globe/GlobeRenderer';
import { basemapById } from '@renderer/globe/imagery';
import { resolveBalloonHtml } from '@renderer/model/balloon';
import { lineLength, polygonArea, formatLength, formatArea } from '@renderer/model/measure';
import { TreePanel } from './TreePanel';
import { StylePanel } from './StylePanel';
import { Inspector } from './Inspector';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { Balloon } from './Balloon';

const MODE_HINT: Record<string, string> = {
  'draw-point': 'Click on the map to drop a point · Esc to cancel',
  'draw-line': 'Click to add points · double-click or Enter to finish · Esc to cancel',
  'draw-polygon': 'Click to add vertices · double-click or Enter to finish · Esc to cancel',
  edit: 'Drag handles to move · click a midpoint to add · right-click/Delete to remove · Esc when done',
  measure: 'Click to add points · double-click to finish · Esc to cancel',
};

export function App(): JSX.Element {
  const globeContainer = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeRenderer | null>(null);
  const prevDocRef = useRef<unknown>(null);

  const store = useStore();

  // ---- one-time globe init -------------------------------------------------
  useEffect(() => {
    if (!globeContainer.current || globeRef.current) return;
    const globe = new GlobeRenderer(globeContainer.current, {
      onPick: (id) => {
        useStore.getState().setSelection(id ? [id] : []);
        useStore.getState().openBalloon(id);
      },
      onCoord: (lon, lat) => useStore.getState().setCursor(lon, lat),
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

  // ---- new document / scene rebuild ---------------------------------------
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    if (prevDocRef.current !== store.doc) {
      prevDocRef.current = store.doc;
      globe.setDocument(store.doc); // new file: build + frame
    } else {
      globe.rebuild(); // edit: rebuild, keep camera
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.docId, store.sceneEpoch]);

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
      const node = sel.length === 1 ? s().doc.nodeById(sel[0]) : undefined;
      if (node?.type === 'Placemark' && node.geometry) {
        globe.startEdit(node.id, (g) => s().updateGeometry(node.id, g));
      } else {
        s().setMode('none');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.interactionMode]);

  // ---- file operations -----------------------------------------------------
  const guardDiscard = useCallback((): boolean => {
    if (!useStore.getState().dirty) return true;
    return window.confirm('Discard unsaved changes?');
  }, []);

  const doOpen = useCallback(async () => {
    if (!guardDiscard()) return;
    const opened = await window.api.openFileDialog();
    if (opened) useStore.getState().loadOpened(opened);
  }, [guardDiscard]);

  const openPath = useCallback(async (path: string) => {
    if (!guardDiscard()) return;
    const opened = await window.api.openPath(path);
    if (opened) useStore.getState().loadOpened(opened);
  }, [guardDiscard]);

  const doSave = useCallback(async (forceDialog: boolean) => {
    const st = useStore.getState();
    let path = st.filePath;
    let asKmz = st.wasKmz;
    if (!path || forceDialog) {
      const base = path?.split('/').pop() ?? 'untitled.kml';
      const chosen = await window.api.saveFileDialog(base);
      if (!chosen) return;
      path = chosen.path;
      asKmz = chosen.asKmz;
    }
    const kml = st.doc.serialize();
    const res = await window.api.saveFile({
      path,
      kml,
      asKmz,
      resources: st.doc.resources,
    });
    if (res.ok && res.path) useStore.getState().markSaved(res.path, asKmz);
    else if (!res.ok) alert(`Save failed: ${res.error}`);
  }, []);

  // ---- menu + drop + open-request listeners --------------------------------
  useEffect(() => {
    const offMenu = window.api.onMenuAction((action) => {
      if (action === 'open') doOpen();
      else if (action === 'save') doSave(false);
      else if (action === 'saveAs') doSave(true);
      else if (action === 'undo') useStore.getState().undo();
      else if (action === 'redo') useStore.getState().redo();
    });
    const offOpen = window.api.onOpenRequested((path) => openPath(path));
    const offDrop = window.api.onFileDrop((paths) => {
      const geo = paths.find((p) => /\.(kml|kmz)$/i.test(p));
      if (geo) openPath(geo);
    });
    const offChanged = window.api.onFileChanged((path) => {
      const st = useStore.getState();
      if (path !== st.filePath) return;
      const msg = st.dirty
        ? 'This file changed on disk, but you have unsaved edits. Reload and lose your changes?'
        : 'This file changed on disk. Reload?';
      if (window.confirm(msg)) {
        window.api.openPath(path).then((opened) => {
          if (opened) useStore.getState().loadOpened(opened);
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

  const balloonNode = store.balloonNodeId
    ? store.doc.nodeById(store.balloonNodeId)
    : null;
  const balloonHtml = balloonNode
    ? resolveBalloonHtml(store.doc.data, balloonNode)
    : '';

  return (
    <div className="app">
      <Toolbar
        onOpen={doOpen}
        onSave={() => doSave(false)}
        onSaveAs={() => doSave(true)}
        onChangeBasemap={onChangeBasemap}
      />
      <div className="body">
        <div className="sidebar">
          <TreePanel
            onFlyTo={(id) => globeRef.current?.flyTo(id)}
            onOpenBalloon={(id) => useStore.getState().openBalloon(id)}
          />
          <Inspector />
          <StylePanel />
        </div>
        <div className="globe-wrap">
          <div ref={globeContainer} className="globe" />
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
              resources={store.doc.resources}
              onClose={() => useStore.getState().openBalloon(null)}
            />
          )}
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
