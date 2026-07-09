import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '@renderer/state/store';
import { GlobeRenderer } from '@renderer/globe/GlobeRenderer';
import { basemapById } from '@renderer/globe/imagery';
import { TreePanel } from './TreePanel';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { Balloon } from './Balloon';

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

  // ---- react to document changes ------------------------------------------
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    if (prevDocRef.current !== store.doc) {
      prevDocRef.current = store.doc;
      globe.setDocument(store.doc);
    } else {
      globe.refreshVisibility();
    }
  }, [store.doc, store.revision]);

  // ---- selection highlight -------------------------------------------------
  useEffect(() => {
    globeRef.current?.setSelection(store.selection);
  }, [store.selection]);

  // ---- file operations -----------------------------------------------------
  const doOpen = useCallback(async () => {
    const opened = await window.api.openFileDialog();
    if (opened) useStore.getState().loadOpened(opened);
  }, []);

  const openPath = useCallback(async (path: string) => {
    const opened = await window.api.openPath(path);
    if (opened) useStore.getState().loadOpened(opened);
  }, []);

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
    });
    const offOpen = window.api.onOpenRequested((path) => openPath(path));
    const offDrop = window.api.onFileDrop((paths) => {
      const geo = paths.find((p) => /\.(kml|kmz)$/i.test(p));
      if (geo) openPath(geo);
    });
    return () => {
      offMenu();
      offOpen();
      offDrop();
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
        </div>
        <div className="globe-wrap">
          <div ref={globeContainer} className="globe" />
          {balloonNode && (
            <Balloon
              node={balloonNode}
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
