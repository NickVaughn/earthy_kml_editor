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
} from 'cesium';
import type { Geometry, Position } from '@renderer/model/types';

export type DrawKind = 'Point' | 'LineString' | 'Polygon';

const DRAW_COLOR = Color.fromCssColorString('#00e5ff');

function cartToLonLat(cart: Cartesian3): Position {
  const c = Cartographic.fromCartesian(cart);
  return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
}

/**
 * Interactive drawing of a Point / LineString / Polygon on the globe. Click to
 * add vertices with a rubber-band preview; double-click or Enter finishes;
 * Esc cancels. A Point finishes on the first click.
 */
export class DrawTool {
  private handler: ScreenSpaceEventHandler;
  private carts: Cartesian3[] = [];
  private floating: Cartesian3 | null = null;
  private entities: Entity[] = [];
  private finished = false;

  constructor(
    private viewer: Viewer,
    private kind: DrawKind,
    private onFinish: (geometry: Geometry) => void,
    private onCancel: () => void,
  ) {
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.install();
    this.buildPreview();
    window.addEventListener('keydown', this.onKey);
  }

  private pickGlobe(pos: Cartesian2): Cartesian3 | null {
    return (
      this.viewer.camera.pickEllipsoid(pos, this.viewer.scene.globe.ellipsoid) ?? null
    );
  }

  private install(): void {
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const c = this.pickGlobe(e.position);
      if (!c) return;
      this.carts.push(c);
      if (this.kind === 'Point') this.finish();
    }, ScreenSpaceEventType.LEFT_CLICK);

    this.handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => {
      this.floating = this.pickGlobe(e.endPosition);
    }, ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => {
      // Double-click fires two LEFT_CLICKs first; drop the duplicate vertex.
      if (this.carts.length > 1) this.carts.pop();
      this.finish();
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }

  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Enter') this.finish();
    else if (ev.key === 'Escape') this.cancel();
  };

  private livePositions(): Cartesian3[] {
    return this.floating ? [...this.carts, this.floating] : [...this.carts];
  }

  private buildPreview(): void {
    if (this.kind !== 'Point') {
      this.entities.push(
        this.viewer.entities.add({
          polyline: {
            positions: new CallbackProperty(() => {
              const p = this.livePositions();
              return this.kind === 'Polygon' && p.length > 2 ? [...p, p[0]] : p;
            }, false),
            width: 2,
            material: DRAW_COLOR,
            clampToGround: true,
          },
        }),
      );
    }
    if (this.kind === 'Polygon') {
      this.entities.push(
        this.viewer.entities.add({
          polygon: {
            hierarchy: new CallbackProperty(
              () => new PolygonHierarchy(this.livePositions()),
              false,
            ),
            material: DRAW_COLOR.withAlpha(0.3),
          },
        }),
      );
    }
  }

  private finish(): void {
    if (this.finished) return;
    const geometry = this.toGeometry();
    if (!geometry) {
      this.cancel();
      return;
    }
    this.finished = true;
    this.teardown();
    this.onFinish(geometry);
  }

  private cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.teardown();
    this.onCancel();
  }

  private toGeometry(): Geometry | null {
    const pts = this.carts.map(cartToLonLat);
    if (this.kind === 'Point') {
      return pts.length >= 1 ? { kind: 'Point', coordinates: pts[0] } : null;
    }
    if (this.kind === 'LineString') {
      return pts.length >= 2
        ? { kind: 'LineString', coordinates: pts, tessellate: true }
        : null;
    }
    // Polygon: need ≥3 vertices; close the ring.
    if (pts.length < 3) return null;
    const ring = [...pts, pts[0]];
    return {
      kind: 'Polygon',
      outerBoundary: ring,
      innerBoundaries: [],
      tessellate: true,
    };
  }

  private teardown(): void {
    window.removeEventListener('keydown', this.onKey);
    this.handler.destroy();
    for (const e of this.entities) this.viewer.entities.remove(e);
    this.entities = [];
  }

  /** External cancel (e.g. switching tools). */
  dispose(): void {
    this.cancel();
  }
}
