import {
  Viewer,
  ImageryProvider,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Cartographic,
  Math as CesiumMath,
  Cartesian3,
  Color,
  PolylineCollection,
  PointPrimitiveCollection,
  PrimitiveCollection,
  BoundingSphere,
  HeadingPitchRange,
  Material,
  defined,
} from 'cesium';
import type { KmlDocument } from '@renderer/model/document';
import type { Position } from '@renderer/model/types';
import { buildScene, type SceneHandle } from './scene';

export interface GlobeHandlers {
  onPick: (nodeId: string | null) => void;
  onCoord: (lon: number, lat: number) => void;
}

const SELECT_COLOR = Color.fromCssColorString('#00e5ff');

export class GlobeRenderer {
  readonly viewer: Viewer;
  private doc: KmlDocument | null = null;
  private scene: SceneHandle | null = null;
  private handler: ScreenSpaceEventHandler;
  private selectionLayer = new PrimitiveCollection();
  private selLines = new PolylineCollection();
  private selPoints = new PointPrimitiveCollection();

  constructor(container: HTMLElement, handlers: GlobeHandlers) {
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
      `[nge] globe initialized (WebGL2: ${gl ? 'yes' : 'no'}, renderer: ${
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
      const picked = this.viewer.scene.pick(click.position);
      if (defined(picked) && picked.id && typeof picked.id === 'string') {
        handlers.onPick(picked.id);
      } else {
        handlers.onPick(null);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  async setBasemap(providerPromise: Promise<ImageryProvider>): Promise<void> {
    const provider = await providerPromise;
    this.viewer.imageryLayers.removeAll();
    this.viewer.imageryLayers.addImageryProvider(provider);
  }

  /** Load a new document: build the scene and frame it. */
  setDocument(doc: KmlDocument): void {
    this.doc = doc;
    this.rebuildScene();
    this.clearSelection();
    this.zoomToAll();
  }

  /** Rebuild the scene for the current document after an edit, keeping the camera. */
  rebuild(): void {
    if (!this.doc) return;
    this.rebuildScene();
  }

  private rebuildScene(): void {
    if (!this.doc) return;
    this.scene?.dispose();
    const t0 = performance.now();
    this.scene = buildScene(this.viewer, this.doc);
    const ms = performance.now() - t0;
    console.info(
      `[nge] scene built: ${this.doc.stats().features} features in ${ms.toFixed(0)}ms`,
    );
  }

  setNodeShow(id: string, show: boolean): void {
    this.scene?.setNodeShow(id, show);
  }

  /** Re-apply effective visibility for a node and its descendants after a toggle. */
  refreshVisibility(): void {
    if (!this.doc || !this.scene) return;
    for (const node of this.doc.placemarksUnder()) {
      this.scene.setNodeShow(node.id, this.doc.isEffectivelyVisible(node));
    }
  }

  flyTo(nodeId: string): void {
    const sphere = this.scene?.bounds.get(nodeId);
    if (sphere) {
      this.viewer.camera.flyToBoundingSphere(sphere, {
        duration: 0.8,
        offset: new HeadingPitchRange(0, -CesiumMath.PI_OVER_TWO, sphere.radius * 4 + 1000),
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

  setSelection(nodeIds: string[]): void {
    this.clearSelection();
    if (!this.doc) return;
    for (const id of nodeIds) {
      const node = this.doc.nodeById(id);
      if (!node?.geometry) continue;
      this.drawSelectionGeometry(node.geometry);
    }
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
    this.handler.destroy();
    this.scene?.dispose();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
