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
  KeyboardEventModifier,
} from 'cesium';
import type { Geometry, Position } from '@renderer/model/types';

export type DrawKind = 'Point' | 'LineString' | 'Polygon';

const DRAW_COLOR = Color.fromCssColorString('#00e5ff');

function cartToLonLat(cart: Cartesian3): Position {
  const c = Cartographic.fromCartesian(cart);
  return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
}

/** Freehand sampling cadence: drop a vertex once the cursor has moved this far
 * (screen pixels) from the last sample. Small enough to feel continuous, large
 * enough not to flood the geometry with points. */
const FREEHAND_SAMPLE_PX = 12;

/**
 * Interactive drawing of a Point / LineString / Polygon on the globe. Click to
 * add vertices with a rubber-band preview; double-click or Enter finishes;
 * Esc cancels; Backspace removes the last vertex. Hold Shift and drag to sketch
 * a run of vertices freehand along the cursor path. A Point finishes on the
 * first click.
 */
export class DrawTool {
  private handler: ScreenSpaceEventHandler;
  private carts: Cartesian3[] = [];
  private floating: Cartesian3 | null = null;
  private entities: Entity[] = [];
  private finished = false;
  private freehand = false;
  private lastSample: Cartesian2 | null = null;

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

  private setCamera(enabled: boolean): void {
    this.viewer.scene.screenSpaceCameraController.enableInputs = enabled;
  }

  private onMove = (e: ScreenSpaceEventHandler.MotionEvent): void => {
    if (this.freehand) {
      this.sampleFreehand(e.endPosition);
      return;
    }
    this.floating = this.pickGlobe(e.endPosition);
  };

  private install(): void {
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      const c = this.pickGlobe(e.position);
      if (!c) return;
      this.carts.push(c);
      if (this.kind === 'Point') this.finish();
    }, ScreenSpaceEventType.LEFT_CLICK);

    this.handler.setInputAction(this.onMove, ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => {
      // Double-click fires two LEFT_CLICKs first; drop the duplicate vertex.
      if (this.carts.length > 1) this.carts.pop();
      this.finish();
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    // Shift-drag: sketch a run of vertices along the cursor path. Only lines and
    // polygons take multiple vertices, so freehand is a no-op for points.
    if (this.kind !== 'Point') {
      // Cesium routes events by exact modifier: while Shift is held the move
      // events go to the SHIFT handler only, so the freehand sampler must be
      // registered there too (not just on the unmodified MOUSE_MOVE above).
      this.handler.setInputAction(this.onMove, ScreenSpaceEventType.MOUSE_MOVE, KeyboardEventModifier.SHIFT);

      this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
        const c = this.pickGlobe(e.position);
        if (!c) return;
        this.freehand = true;
        this.setCamera(false); // stop the drag from spinning the globe
        this.carts.push(c);
        this.lastSample = e.position.clone();
      }, ScreenSpaceEventType.LEFT_DOWN, KeyboardEventModifier.SHIFT);

      this.handler.setInputAction(() => this.endFreehand(), ScreenSpaceEventType.LEFT_UP, KeyboardEventModifier.SHIFT);
      // Releasing Shift mid-drag routes LEFT_UP to the unmodified handler.
      this.handler.setInputAction(() => this.endFreehand(), ScreenSpaceEventType.LEFT_UP);
    }
  }

  private sampleFreehand(screen: Cartesian2): void {
    if (this.lastSample && Cartesian2.distance(screen, this.lastSample) < FREEHAND_SAMPLE_PX) {
      this.floating = this.pickGlobe(screen);
      return;
    }
    const c = this.pickGlobe(screen);
    if (!c) return;
    this.carts.push(c);
    this.lastSample = screen.clone();
    this.floating = c;
  }

  private endFreehand(): void {
    if (!this.freehand) return;
    this.freehand = false;
    this.lastSample = null;
    this.setCamera(true);
  }

  /** Remove the most recently placed vertex (Backspace during drawing). */
  private undoLastVertex(): void {
    if (this.carts.length > 0) this.carts.pop();
  }

  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Enter') this.finish();
    else if (ev.key === 'Escape') this.cancel();
    else if (ev.key === 'Backspace' || ev.key === 'Delete') {
      ev.preventDefault(); // Backspace would otherwise navigate back
      this.undoLastVertex();
    }
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
    this.setCamera(true); // in case we tore down mid freehand-drag
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
