import {
  Viewer,
  ImageryProvider,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Cartographic,
  Math as CesiumMath,
  Cartesian2,
  Cartesian3,
  Color,
  PolylineCollection,
  PointPrimitiveCollection,
  PrimitiveCollection,
  BoundingSphere,
  HeadingPitchRange,
  Material,
  KeyboardEventModifier,
  ImageryLayer,
  SingleTileImageryProvider,
  UrlTemplateImageryProvider,
  Rectangle,
  defined,
  EllipsoidTerrainProvider,
  TerrainProvider,
} from 'cesium';
import type { KmlDocument } from '@renderer/model/document';
import type { Position, Geometry, KmlNode } from '@renderer/model/types';
import { tiledOverlayInfo, tileUrlTemplate } from '@renderer/model/overlays';
import { buildScene, type SceneHandle } from './scene';
import { DrawTool, type DrawKind } from './DrawTool';
import { EditTool } from './EditTool';
import {
  nadirOrientation,
  northUpOrientation,
  type Orientation,
} from './cameraCommands';

export interface GlobeHandlers {
  onPick: (nodeId: string | null) => void;
  onCoord: (lon: number, lat: number) => void;
  /** Right-click / option-click on a feature (nodeId null = empty globe).
   * x/y are viewport (client) coordinates for positioning a menu. */
  onContextMenu: (nodeId: string | null, x: number, y: number) => void;
}

const SELECT_COLOR = Color.fromCssColorString('#00e5ff');

/** A GroundOverlay's <color> alpha byte controls its opacity (default opaque). */
function overlayAlpha(node: KmlNode): number {
  const color = node.overlay?.color;
  if (!color || !/^[0-9a-f]{8}$/i.test(color)) return 1;
  return parseInt(color.slice(0, 2), 16) / 255;
}

export class GlobeRenderer {
  readonly viewer: Viewer;
  private docs: KmlDocument[] = [];
  private scene: SceneHandle | null = null;
  private terrainOn = false;
  private handler: ScreenSpaceEventHandler;
  private selectionLayer = new PrimitiveCollection();
  private selLines = new PolylineCollection();
  private selPoints = new PointPrimitiveCollection();
  private activeTool: { dispose(): void } | null = null;
  private handlers: GlobeHandlers;
  private baseLayer: ImageryLayer | null = null;
  /** Imagery layers for GroundOverlay nodes, by node id. */
  private overlayLayers = new Map<string, { layer: ImageryLayer; href: string }>();
  /** Overlay ids whose image is currently decoding (guards concurrent syncs). */
  private overlayPending = new Set<string>();

  constructor(container: HTMLElement, handlers: GlobeHandlers) {
    this.handlers = handlers;
    this.viewer = new Viewer(container, {
      // Lean: turn off every non-essential widget (PLAN §9).
      timeline: false,
      animation: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      baseLayer: false, // we add imagery ourselves
    });
    this.viewer.scene.globe.showGroundAtmosphere = true;

    this.selectionLayer.add(this.selLines);
    this.selectionLayer.add(this.selPoints);
    this.viewer.scene.primitives.add(this.selectionLayer);

    const gl = this.viewer.scene.canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    console.info(
      `[earthy] globe initialized (WebGL2: ${gl ? 'yes' : 'no'}, renderer: ${
        gl ? gl.getParameter(gl.RENDERER) : 'n/a'
      })`,
    );

    this.handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);

    this.handler.setInputAction((movement: ScreenSpaceEventHandler.MotionEvent) => {
      const cart = this.viewer.camera.pickEllipsoid(
        movement.endPosition,
        this.viewer.scene.globe.ellipsoid,
      );
      if (cart) {
        const c = Cartographic.fromCartesian(cart);
        handlers.onCoord(
          CesiumMath.toDegrees(c.longitude),
          CesiumMath.toDegrees(c.latitude),
        );
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction((click: ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.activeTool) return; // draw/edit tool owns clicks
      const picked = this.viewer.scene.pick(click.position);
      if (defined(picked) && picked.id && typeof picked.id === 'string') {
        handlers.onPick(picked.id);
      } else {
        handlers.onPick(null);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Option-click (Alt + left-click) opens the same feature context menu as a
    // right-click — a convenient alternative on trackpads.
    this.handler.setInputAction((click: ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.activeTool) return;
      this.emitContextMenu(click.position);
    }, ScreenSpaceEventType.LEFT_CLICK, KeyboardEventModifier.ALT);

    // Right-click: pick the feature and surface a context menu. Handled on the
    // DOM so we can suppress the browser's own menu and read client coords.
    this.viewer.scene.canvas.addEventListener('contextmenu', this.onCanvasContextMenu);
  }

  /** Pick the feature at a canvas-space position and emit the context menu. */
  private emitContextMenu(canvasPos: Cartesian2): void {
    const picked = this.viewer.scene.pick(canvasPos);
    const id =
      defined(picked) && picked.id && typeof picked.id === 'string' ? picked.id : null;
    const rect = this.viewer.scene.canvas.getBoundingClientRect();
    this.handlers.onContextMenu(id, rect.left + canvasPos.x, rect.top + canvasPos.y);
  }

  private onCanvasContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
    if (this.activeTool) return; // draw/edit tool owns the canvas
    const rect = this.viewer.scene.canvas.getBoundingClientRect();
    this.emitContextMenu(new Cartesian2(ev.clientX - rect.left, ev.clientY - rect.top));
  };

  async setBasemap(providerPromise: Promise<ImageryProvider>): Promise<void> {
    const provider = await providerPromise;
    // Replace only the base layer — removeAll() would also drop raster overlays.
    const previous = this.baseLayer;
    this.baseLayer = this.viewer.imageryLayers.addImageryProvider(provider);
    this.viewer.imageryLayers.lowerToBottom(this.baseLayer);
    if (previous) this.viewer.imageryLayers.remove(previous, true);
  }

  /** Swap the globe's terrain: a provider for 3D relief, or null for a flat ellipsoid.
   *  Rebuilds the scene so features re-clamp to (or lift off) the new surface. */
  setTerrain(provider: TerrainProvider | null): void {
    this.viewer.scene.terrainProvider = provider ?? new EllipsoidTerrainProvider();
    this.terrainOn = provider !== null;
    this.rebuildScene();
  }

  // ---- GroundOverlay imagery (single image per overlay, no tiling) ---------

  /** Resolve an overlay's href to something Cesium can load, or null. */
  private overlayImageUrl(doc: KmlDocument, href: string): string | null {
    // KMZ/imported images live in the document's resources as data URLs.
    const resource = doc.resources[href];
    if (resource) return resource;
    if (/^(https?:|data:|blob:)/i.test(href)) return href;
    return null; // relative path next to a .kml on disk — not supported yet
  }

  /**
   * Reconcile imagery layers with the GroundOverlay nodes in the open
   * documents: add layers for new overlays, drop them for removed ones, and
   * track visibility. Creating a layer decodes the image, so existing ones are
   * reused unless their href changed.
   */
  async syncGroundOverlays(): Promise<void> {
    const wanted = new Map<string, { node: KmlNode; doc: KmlDocument }>();
    for (const doc of this.docs) {
      for (const node of doc.walk()) {
        if (node.type === 'GroundOverlay' && node.overlay?.href && node.overlay.box) {
          wanted.set(node.id, { node, doc });
        }
      }
    }

    for (const [id, entry] of [...this.overlayLayers]) {
      const w = wanted.get(id);
      if (!w || w.node.overlay?.href !== entry.href) {
        this.viewer.imageryLayers.remove(entry.layer, true);
        this.overlayLayers.delete(id);
      }
    }

    for (const [id, { node, doc }] of wanted) {
      const existing = this.overlayLayers.get(id);
      if (existing) {
        existing.layer.show = doc.isEffectivelyVisible(node);
        existing.layer.alpha = overlayAlpha(node);
        continue;
      }
      if (this.overlayPending.has(id)) continue; // already being created

      const b = node.overlay!.box!;
      const rectangle = Rectangle.fromDegrees(b.west, b.south, b.east, b.north);

      // A tiled raster renders from the local pyramid rather than one image.
      const tiles = tiledOverlayInfo(node);
      if (tiles) {
        const provider = new UrlTemplateImageryProvider({
          url: tileUrlTemplate(tiles.hash),
          rectangle,
          minimumLevel: tiles.minZoom,
          maximumLevel: tiles.maxZoom,
        });
        const layer = this.viewer.imageryLayers.addImageryProvider(provider);
        layer.show = doc.isEffectivelyVisible(node);
        layer.alpha = overlayAlpha(node);
        this.overlayLayers.set(id, { layer, href: node.overlay!.href! });
        continue;
      }

      const url = this.overlayImageUrl(doc, node.overlay!.href!);
      if (!url) {
        console.warn(`[earthy] overlay "${node.name}": cannot resolve ${node.overlay!.href}`);
        continue;
      }
      this.overlayPending.add(id);
      try {
        const provider = await SingleTileImageryProvider.fromUrl(url, { rectangle });
        // The document may have changed while the image decoded.
        if (!this.nodeById(id)) continue;
        const layer = this.viewer.imageryLayers.addImageryProvider(provider);
        layer.show = doc.isEffectivelyVisible(node);
        layer.alpha = overlayAlpha(node);
        this.overlayLayers.set(id, { layer, href: node.overlay!.href! });
      } catch (err) {
        console.error(`[earthy] overlay "${node.name}" failed to load:`, err);
      } finally {
        this.overlayPending.delete(id);
      }
    }
    this.viewer.scene.requestRender();
  }

  /** Fly to a raster overlay's extent. */
  flyToBounds(bounds: [number, number, number, number]): void {
    this.viewer.camera.flyTo({
      destination: Rectangle.fromDegrees(bounds[0], bounds[1], bounds[2], bounds[3]),
      duration: 0.6,
    });
  }

  /** The GPU's maximum texture dimension — the hard ceiling for one overlay. */
  maxTextureSize(): number {
    const gl = this.viewer.scene.canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    return gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0;
  }

  private nodeById(id: string): KmlNode | undefined {
    for (const d of this.docs) {
      const n = d.nodeById(id);
      if (n) return n;
    }
    return undefined;
  }

  /** Replace the set of open documents: rebuild the scene and frame everything. */
  setDocuments(docs: KmlDocument[], frame = true): void {
    this.docs = docs;
    this.rebuildScene();
    this.clearSelection();
    if (frame) this.zoomToAll();
  }

  /** Rebuild the scene after an edit, keeping the camera. */
  rebuild(): void {
    this.rebuildScene();
  }

  private rebuildScene(): void {
    this.scene?.dispose();
    const t0 = performance.now();
    this.scene = buildScene(this.viewer, this.docs, this.terrainOn);
    const ms = performance.now() - t0;
    const features = this.docs.reduce((n, d) => n + d.stats().features, 0);
    console.info(
      `[earthy] scene built: ${features} features (${this.docs.length} doc${
        this.docs.length === 1 ? '' : 's'
      }) in ${ms.toFixed(0)}ms`,
    );
  }

  setNodeShow(id: string, show: boolean): void {
    this.scene?.setNodeShow(id, show);
  }

  /** Re-apply effective visibility across all documents after a toggle. */
  refreshVisibility(): void {
    if (!this.scene) return;
    for (const doc of this.docs) {
      for (const node of doc.placemarksUnder()) {
        this.scene.setNodeShow(node.id, doc.isEffectivelyVisible(node));
      }
    }
  }

  /** Fly to a node — a single feature, or the union of a folder/file's features. */
  flyTo(nodeId: string): void {
    const node = this.nodeById(nodeId);
    if (!node) return;

    // GroundOverlays aren't in the batched scene; frame their LatLonBox.
    const box = node.type === 'GroundOverlay' ? node.overlay?.box : undefined;
    if (box) {
      this.flyToBounds([box.west, box.south, box.east, box.north]);
      return;
    }
    if (!this.scene) return;

    // Gather this node's own bounds (placemark) plus every descendant's.
    const spheres: BoundingSphere[] = [];
    const collect = (n: KmlNode): void => {
      const s = this.scene!.bounds.get(n.id);
      if (s) spheres.push(s);
      for (const c of n.children) collect(c);
    };
    collect(node);
    if (spheres.length === 0) return;

    const union = spheres.reduce(
      (acc, s) => (acc ? BoundingSphere.union(acc, s) : s.clone()),
      null as BoundingSphere | null,
    );
    if (union) {
      this.viewer.camera.flyToBoundingSphere(union, {
        duration: 0.8,
        offset: new HeadingPitchRange(0, -CesiumMath.PI_OVER_TWO, union.radius * 3 + 500),
      });
    }
  }

  zoomToAll(): void {
    if (!this.scene) return;
    const spheres = [...this.scene.bounds.values()];
    if (spheres.length === 0) return;
    const union = spheres.reduce(
      (acc, s) => (acc ? BoundingSphere.union(acc, s) : s.clone()),
      null as BoundingSphere | null,
    );
    if (union) {
      this.viewer.camera.flyToBoundingSphere(union, {
        duration: 1.0,
        offset: new HeadingPitchRange(0, -CesiumMath.PI_OVER_TWO, union.radius * 2.5 + 1000),
      });
    }
  }

  /** Level the camera to look straight down at the screen-centre point. */
  lookNadir(): void {
    this.reorient(nadirOrientation);
  }

  /** Rotate the camera so north is up, pivoting on the screen-centre point. */
  lookNorthUp(): void {
    this.reorient(northUpOrientation);
  }

  private reorient(fn: (o: Orientation) => Orientation): void {
    const cam = this.viewer.camera;
    const scene = this.viewer.scene;
    const canvas = scene.canvas as HTMLCanvasElement;
    const centre = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ground = cam.pickEllipsoid(centre, scene.globe.ellipsoid);

    if (ground) {
      // Pivot about the ground point under the viewport centre.
      const range = Cartesian3.distance(cam.positionWC, ground);
      const t = fn({ heading: cam.heading, pitch: cam.pitch, range });
      cam.flyToBoundingSphere(new BoundingSphere(ground, 1), {
        duration: 0.4,
        offset: new HeadingPitchRange(t.heading, t.pitch, t.range),
      });
    } else {
      // Looking at the sky/horizon: re-orient in place as a fallback.
      const t = fn({ heading: cam.heading, pitch: cam.pitch, range: 0 });
      cam.flyTo({
        destination: cam.positionWC.clone(),
        orientation: { heading: t.heading, pitch: t.pitch, roll: 0 },
        duration: 0.4,
      });
    }
  }

  setSelection(nodeIds: string[]): void {
    this.clearSelection();
    for (const id of nodeIds) {
      const node = this.nodeById(id);
      if (!node?.geometry) continue;
      this.drawSelectionGeometry(node.geometry);
    }
  }

  // ---- draw / edit tools (Phase 3) ----------------------------------------

  get toolActive(): boolean {
    return this.activeTool !== null;
  }

  startDraw(kind: DrawKind, onFinish: (g: Geometry) => void, onCancel: () => void): void {
    this.cancelTool();
    this.clearSelection();
    this.activeTool = new DrawTool(
      this.viewer,
      kind,
      (g) => {
        this.activeTool = null;
        onFinish(g);
      },
      () => {
        this.activeTool = null;
        onCancel();
      },
    );
  }

  /** Begin vertex editing of a node's geometry. Hides its batched render. */
  startEdit(nodeId: string, onCommit: (g: Geometry) => void): void {
    this.cancelTool();
    const node = this.nodeById(nodeId);
    if (!node?.geometry) return;
    this.clearSelection();
    this.scene?.setNodeShow(nodeId, false); // hide static copy while editing
    this.activeTool = new EditTool(this.viewer, node.geometry, onCommit);
  }

  cancelTool(): void {
    this.activeTool?.dispose();
    this.activeTool = null;
  }

  private drawSelectionGeometry(g: import('@renderer/model/types').Geometry): void {
    const line = (positions: Position[], close: boolean) => {
      const carts = positions.map((p) =>
        Cartesian3.fromDegrees(p[0], p[1], (p[2] ?? 0) + 2),
      );
      if (close && carts.length > 0) carts.push(carts[0]);
      if (carts.length >= 2) {
        const pl = this.selLines.add({ positions: carts, width: 4 });
        pl.material = Material.fromType('Color', { color: SELECT_COLOR });
      }
    };
    switch (g.kind) {
      case 'Point':
        this.selPoints.add({
          position: Cartesian3.fromDegrees(
            g.coordinates[0],
            g.coordinates[1],
            (g.coordinates[2] ?? 0) + 2,
          ),
          color: SELECT_COLOR,
          pixelSize: 14,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
        });
        break;
      case 'LineString':
        line(g.coordinates, false);
        break;
      case 'Polygon':
        line(g.outerBoundary, true);
        for (const inner of g.innerBoundaries) line(inner, true);
        break;
      case 'MultiGeometry':
        for (const child of g.geometries) this.drawSelectionGeometry(child);
        break;
    }
  }

  private clearSelection(): void {
    this.selLines.removeAll();
    this.selPoints.removeAll();
  }

  destroy(): void {
    this.viewer.scene.canvas.removeEventListener('contextmenu', this.onCanvasContextMenu);
    this.handler.destroy();
    this.scene?.dispose();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
