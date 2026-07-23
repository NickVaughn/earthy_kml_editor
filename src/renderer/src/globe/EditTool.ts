import {
  Viewer,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CallbackProperty,
  PolygonHierarchy,
  Math as CesiumMath,
  Entity,
  defined,
} from 'cesium';
import type { Geometry, Position } from '@renderer/model/types';
import { vertexMarker, HANDLE_SIZE } from './handles';

const HANDLE_OUTLINE = Color.fromCssColorString('#00e5ff');
const MIDPOINT = Color.fromCssColorString('#00e5ff').withAlpha(0.6);

function cartToLonLat(cart: Cartesian3): Position {
  const c = Cartographic.fromCartesian(cart);
  return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
}
function lonLatToCart(p: Position): Cartesian3 {
  return Cartesian3.fromDegrees(p[0], p[1], 0);
}
function midpoint(a: Cartesian3, b: Cartesian3): Cartesian3 {
  return Cartesian3.midpoint(a, b, new Cartesian3());
}

type Kind = 'Point' | 'LineString' | 'Polygon';

/**
 * Vertex editing for a selected Point / LineString / Polygon:
 *   - drag a vertex handle to move it
 *   - click a midpoint handle to insert a vertex there
 *   - Delete / right-click a vertex to remove it
 *   - drag the feature body to move the whole thing
 * Commits via onCommit(geometry) at the end of each gesture (undoable upstream).
 */
export class EditTool {
  private handler: ScreenSpaceEventHandler;
  private kind: Kind;
  private working: Cartesian3[] = [];
  private holes: Position[][] = [];
  private orig: Geometry;
  private vertexHandles: Entity[] = [];
  private midHandles: Entity[] = [];
  private preview: Entity[] = [];
  private drag: { kind: 'vertex'; index: number } | { kind: 'body'; last: Cartesian3 } | null =
    null;
  private disposed = false;

  constructor(
    private viewer: Viewer,
    geometry: Geometry,
    private onCommit: (geometry: Geometry) => void,
  ) {
    this.orig = geometry;
    this.kind = (geometry.kind === 'MultiGeometry' ? 'Point' : geometry.kind) as Kind;
    this.working = this.readWorking(geometry);
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.buildPreview();
    this.rebuildHandles();
    this.install();
    window.addEventListener('keydown', this.onKey);
  }

  private readWorking(g: Geometry): Cartesian3[] {
    if (g.kind === 'Point') return [lonLatToCart(g.coordinates)];
    if (g.kind === 'LineString') return g.coordinates.map(lonLatToCart);
    if (g.kind === 'Polygon') {
      this.holes = g.innerBoundaries;
      // Drop the closing duplicate vertex for editing.
      const ring = g.outerBoundary.slice();
      if (ring.length > 1 && samePos(ring[0], ring[ring.length - 1])) ring.pop();
      return ring.map(lonLatToCart);
    }
    return [];
  }

  private currentGeometry(): Geometry {
    const pts = this.working.map(cartToLonLat);
    if (this.kind === 'Point') return { ...this.orig, kind: 'Point', coordinates: pts[0] };
    if (this.kind === 'LineString')
      return { ...this.orig, kind: 'LineString', coordinates: pts };
    return {
      ...this.orig,
      kind: 'Polygon',
      outerBoundary: [...pts, pts[0]],
      innerBoundaries: this.holes,
    };
  }

  private pickGlobe(pos: Cartesian2): Cartesian3 | null {
    return this.viewer.camera.pickEllipsoid(pos, this.viewer.scene.globe.ellipsoid) ?? null;
  }

  private buildPreview(): void {
    if (this.kind === 'Point') return;
    this.preview.push(
      this.viewer.entities.add({
        polyline: {
          positions: new CallbackProperty(() => {
            return this.kind === 'Polygon'
              ? [...this.working, this.working[0]]
              : this.working;
          }, false),
          width: 2,
          material: HANDLE_OUTLINE,
          clampToGround: true,
        },
      }),
    );
    if (this.kind === 'Polygon') {
      this.preview.push(
        this.viewer.entities.add({
          polygon: {
            hierarchy: new CallbackProperty(
              () => new PolygonHierarchy(this.working),
              false,
            ),
            material: HANDLE_OUTLINE.withAlpha(0.25),
          },
        }),
      );
    }
  }

  private rebuildHandles(): void {
    for (const e of this.vertexHandles) this.viewer.entities.remove(e);
    for (const e of this.midHandles) this.viewer.entities.remove(e);
    this.vertexHandles = [];
    this.midHandles = [];

    this.working.forEach((_, i) => {
      this.vertexHandles.push(
        this.viewer.entities.add({
          position: new CallbackProperty(() => this.working[i], false) as never,
          billboard: {
            image: vertexMarker(),
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    });

    // Midpoints (line/polygon only).
    if (this.kind !== 'Point') {
      const segs = this.kind === 'Polygon' ? this.working.length : this.working.length - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % this.working.length;
        this.midHandles.push(
          this.viewer.entities.add({
            position: new CallbackProperty(
              () => midpoint(this.working[i], this.working[j]),
              false,
            ) as never,
            point: {
              pixelSize: 8,
              color: MIDPOINT,
              outlineColor: Color.WHITE,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        );
      }
    }
  }

  private setCamera(enabled: boolean): void {
    this.viewer.scene.screenSpaceCameraController.enableInputs = enabled;
  }

  private install(): void {
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = this.viewer.scene.pick(e.position);
      if (defined(picked) && picked.id instanceof Entity) {
        const vi = this.vertexHandles.indexOf(picked.id);
        if (vi >= 0) {
          this.drag = { kind: 'vertex', index: vi };
          this.setCamera(false);
          return;
        }
        const mi = this.midHandles.indexOf(picked.id);
        if (mi >= 0) {
          // Insert a new vertex after index mi and start dragging it.
          const insertAt = mi + 1;
          const j = (mi + 1) % this.working.length;
          this.working.splice(insertAt, 0, midpoint(this.working[mi], this.working[j]));
          this.rebuildHandles();
          this.drag = { kind: 'vertex', index: insertAt };
          this.setCamera(false);
          return;
        }
        if (this.preview.includes(picked.id)) {
          const c = this.pickGlobe(e.position);
          if (c) {
            this.drag = { kind: 'body', last: c };
            this.setCamera(false);
          }
        }
      }
    }, ScreenSpaceEventType.LEFT_DOWN);

    this.handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => {
      if (!this.drag) return;
      const c = this.pickGlobe(e.endPosition);
      if (!c) return;
      if (this.drag.kind === 'vertex') {
        this.working[this.drag.index] = c;
      } else {
        const delta = Cartesian3.subtract(c, this.drag.last, new Cartesian3());
        this.working = this.working.map((p) => Cartesian3.add(p, delta, new Cartesian3()));
        this.drag.last = c;
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => {
      if (!this.drag) return;
      this.drag = null;
      this.setCamera(true);
      this.rebuildHandles();
      this.onCommit(this.currentGeometry());
    }, ScreenSpaceEventType.LEFT_UP);

    // Right-click a vertex to delete it.
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = this.viewer.scene.pick(e.position);
      if (defined(picked) && picked.id instanceof Entity) {
        const vi = this.vertexHandles.indexOf(picked.id);
        if (vi >= 0) this.deleteVertex(vi);
      }
    }, ScreenSpaceEventType.RIGHT_CLICK);
  }

  private minVertices(): number {
    return this.kind === 'Polygon' ? 3 : this.kind === 'LineString' ? 2 : 1;
  }

  private deleteVertex(index: number): void {
    if (this.working.length <= this.minVertices()) return;
    this.working.splice(index, 1);
    this.rebuildHandles();
    this.onCommit(this.currentGeometry());
  }

  private onKey = (ev: KeyboardEvent): void => {
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.drag?.kind === 'vertex') {
      this.deleteVertex(this.drag.index);
      this.drag = null;
      this.setCamera(true);
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setCamera(true);
    window.removeEventListener('keydown', this.onKey);
    this.handler.destroy();
    for (const e of [...this.vertexHandles, ...this.midHandles, ...this.preview]) {
      this.viewer.entities.remove(e);
    }
  }
}

function samePos(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
