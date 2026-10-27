import {
  ArcType,
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Entity,
  Math as CesiumMath,
  PolygonHierarchy,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
  defined,
} from 'cesium';
import type { Position } from '@renderer/model/types';
import { circleRing, groundLength, lineLength } from '@renderer/model/measure';
import {
  is3DShape,
  isClosedShape,
  isTwoPointShape,
  type RulerReading,
  type RulerShape,
} from '@renderer/model/ruler';
import { isTypingTarget } from '@renderer/input/typing';
import { squareMarker, HANDLE_SIZE } from './handles';
import { pickSurface } from './pick';

/** Google Earth draws its ruler in yellow, which also tells it apart from drawing (cyan). */
const RULER_COLOR = Color.fromCssColorString('#ffd400');
/**
 * Just short of opaque, so Cesium draws these in its translucent pass, which
 * writes no depth: the 3D tabs pick points from the depth buffer, and must not
 * pick the ruler's own lines and handles.
 */
const RULER_LINE_3D = RULER_COLOR.withAlpha(0.99);
const HANDLE_TINT = Color.WHITE.withAlpha(0.99);
const FILL = RULER_COLOR.withAlpha(0.2);
/** Ground length is resampled at most this often while points move. */
const GROUND_THROTTLE_MS = 100;
/** A second click this soon and this close is the rest of a double-click, not a new point. */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 6;

type Phase = 'idle' | 'drawing' | 'done';

export interface RulerCallbacks {
  onChange(reading: RulerReading): void;
  /** Esc with nothing measured: close the ruler. */
  onExit(): void;
}

const scratchCarto = new Cartographic();

function toPosition(c: Cartesian3): Position {
  const g = Cartographic.fromCartesian(c, undefined, scratchCarto);
  return [CesiumMath.toDegrees(g.longitude), CesiumMath.toDegrees(g.latitude), g.height];
}

/**
 * The ruler, after Google Earth's: click points to measure a line, path,
 * polygon or circle on the ground, or a path or polygon in 3D. While a
 * measurement is under way its last point follows the cursor; afterwards its
 * points can be dragged, and a fresh click starts the next one.
 *
 *   - line / circle: two clicks (start and end, or centre and edge)
 *   - path / polygon: click points; double-click, Enter, or clicking the last
 *     point (or a polygon's first) finishes
 *   - Backspace / Delete or right-click a point removes it; Esc clears, and
 *     closes the ruler when there is nothing to clear
 *
 * With mouse navigation on, dragging the globe still moves the camera; off,
 * the mouse only places points. Readings go to `onChange`; the numbers
 * themselves are worked out in model/ruler.ts.
 */
export class RulerTool {
  private handler: ScreenSpaceEventHandler;
  private points: Cartesian3[] = [];
  private floating: Cartesian3 | null = null;
  private phase: Phase = 'idle';
  private preview: Entity[] = [];
  private handles: Entity[] = [];
  /** The handle pressed, while the button is down. */
  private grabbed = -1;
  /** The handle just released, for the click that follows; whether it moved. */
  private released = -1;
  private moved = false;
  /** The last click on the globe, to recognise the second half of a double-click. */
  private lastClick: { time: number; pos: Cartesian2 } | null = null;
  private ground: number | null = null;
  private groundTimer: number | null = null;
  private removeTileListener: () => void;
  private disposed = false;

  constructor(
    private viewer: Viewer,
    private shape: RulerShape,
    private mouseNav: boolean,
    private terrainOn: () => boolean,
    private callbacks: RulerCallbacks,
  ) {
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.install();
    this.buildPreview();
    this.setCamera(mouseNav);
    window.addEventListener('keydown', this.onKey);
    viewer.scene.canvas.addEventListener('pointerdown', this.onCanvasDown);
    // Terrain refines as tiles stream in: resample the ground once it settles.
    this.removeTileListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener(
      (queued: number) => {
        if (queued === 0 && this.points.length > 0) this.scheduleGround();
      },
    );
    this.emit();
  }

  setMouseNavigation(on: boolean): void {
    this.mouseNav = on;
    if (this.grabbed < 0) this.setCamera(on);
  }

  clear(): void {
    this.points = [];
    this.floating = null;
    this.phase = 'idle';
    this.ground = null;
    this.syncHandles();
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.groundTimer !== null) window.clearTimeout(this.groundTimer);
    this.setCamera(true);
    window.removeEventListener('keydown', this.onKey);
    this.viewer.scene.canvas.removeEventListener('pointerdown', this.onCanvasDown);
    this.removeTileListener();
    this.handler.destroy();
    for (const e of [...this.preview, ...this.handles]) this.viewer.entities.remove(e);
  }

  private setCamera(enabled: boolean): void {
    this.viewer.scene.screenSpaceCameraController.enableInputs = enabled;
  }

  /** The point under the cursor: anything visible for the 3D tabs, else the globe surface. */
  private pick(pos: Cartesian2): Cartesian3 | null {
    const scene = this.viewer.scene;
    if (is3DShape(this.shape) && scene.pickPositionSupported) {
      const hit = scene.pickPosition(pos);
      // Markers drawn with depth testing off sit on the near plane, so a hit
      // right at the camera is a marker, not a surface: fall through.
      const near = (this.viewer.camera.frustum as { near?: number }).near ?? 1;
      if (defined(hit) && Cartesian3.distance(hit, this.viewer.camera.positionWC) > 2 * near) {
        return hit;
      }
    }
    return pickSurface(this.viewer, pos, this.terrainOn());
  }

  private handleAt(pos: Cartesian2): number {
    const picked = this.viewer.scene.pick(pos);
    return defined(picked) && picked.id instanceof Entity ? this.handles.indexOf(picked.id) : -1;
  }

  private install(): void {
    const h = this.handler;
    h.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      this.grabbed = this.handleAt(e.position);
      this.released = -1;
      this.moved = false;
      if (this.grabbed >= 0) this.setCamera(false); // drag the point, not the globe
    }, ScreenSpaceEventType.LEFT_DOWN);

    h.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => {
      if (this.grabbed >= 0) {
        const c = this.pick(e.endPosition);
        if (!c) return;
        this.points[this.grabbed] = c;
        this.moved = true;
        this.emit();
      } else if (this.phase === 'drawing') {
        this.floating = this.pick(e.endPosition);
        this.emit();
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    h.setInputAction(() => {
      if (this.grabbed < 0) return;
      // Cesium follows a short press-and-release with a click; remember the
      // handle so that click is not taken as a new point.
      this.released = this.grabbed;
      this.grabbed = -1;
      this.setCamera(this.mouseNav);
    }, ScreenSpaceEventType.LEFT_UP);

    h.setInputAction(
      (e: ScreenSpaceEventHandler.PositionedEvent) => this.onClick(e.position),
      ScreenSpaceEventType.LEFT_CLICK,
    );
    h.setInputAction(() => this.onDoubleClick(), ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    h.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
      this.removePoint(this.handleAt(e.position));
    }, ScreenSpaceEventType.RIGHT_CLICK);
  }

  private onClick(pos: Cartesian2): void {
    const handle = this.released;
    this.released = -1;
    if (handle >= 0) {
      if (!this.moved) this.clickHandle(handle);
      return;
    }
    // A double-click is a gesture, not two points: its second click is dropped
    // (a path takes the double-click itself as "finish").
    const now = performance.now();
    const last = this.lastClick;
    this.lastClick = { time: now, pos: pos.clone() };
    if (last && now - last.time < DOUBLE_CLICK_MS && Cartesian2.distance(pos, last.pos) < DOUBLE_CLICK_PX) {
      return;
    }
    const c = this.pick(pos);
    if (!c) return;
    if (this.phase !== 'drawing') {
      // A click after a finished measurement starts the next one.
      this.points = [c];
      this.phase = 'drawing';
      this.floating = null;
      this.ground = null;
    } else {
      this.points.push(c);
      if (isTwoPointShape(this.shape) && this.points.length >= 2) {
        this.finish();
        return;
      }
    }
    this.syncHandles();
    this.emit();
  }

  private onDoubleClick(): void {
    if (this.phase !== 'drawing' || isTwoPointShape(this.shape)) return;
    // A slow double-click can land its second click as a point of its own.
    const n = this.points.length;
    if (n > 1 && Cartesian3.distance(this.points[n - 1], this.points[n - 2]) < 1e-3) {
      this.points.pop();
    }
    this.finish();
  }

  /** A click on a point without dragging it: the last point ends a path; a polygon's first closes it. */
  private clickHandle(i: number): void {
    if (this.phase !== 'drawing' || isTwoPointShape(this.shape)) return;
    const closes = isClosedShape(this.shape) && i === 0 && this.points.length >= 3;
    if (closes || i === this.points.length - 1) this.finish();
  }

  private finish(): void {
    this.phase = 'done';
    this.floating = null;
    this.syncHandles();
    this.emit();
  }

  private removePoint(i: number): void {
    if (i < 0 || i >= this.points.length) return;
    this.points.splice(i, 1);
    if (this.points.length === 0) {
      this.clear();
      return;
    }
    // A line or circle with a point gone is under way again.
    if (isTwoPointShape(this.shape)) this.phase = 'drawing';
    this.syncHandles();
    this.emit();
  }

  /**
   * Cesium cancels the pointer-down default once a tool listens for it, so a
   * click on the globe would leave focus in whatever field had it (the unit
   * menu, a rename in the tree) and the ruler's keys would never arrive.
   */
  private onCanvasDown = (): void => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body) el.blur();
  };

  private onKey = (ev: KeyboardEvent): void => {
    // Only keys aimed at the globe: not while renaming in the tree or typing in a field.
    const el = ev.target instanceof Element ? ev.target : null;
    if (el && el !== document.body && (!el.closest('.globe-wrap') || isTypingTarget(el))) return;
    if (ev.key === 'Enter') {
      if (this.phase === 'drawing' && !isTwoPointShape(this.shape) && this.points.length > 0) {
        this.finish();
      }
    } else if (ev.key === 'Escape') {
      if (this.phase === 'idle') this.callbacks.onExit();
      else this.clear();
    } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
      ev.preventDefault(); // Backspace would otherwise navigate back
      this.removePoint(this.points.length - 1);
    }
  };

  /** The committed points, plus the cursor while a measurement is under way. */
  private live(): Cartesian3[] {
    return this.phase === 'drawing' && this.floating ? [...this.points, this.floating] : this.points;
  }

  private reading(): RulerReading {
    return {
      shape: this.shape,
      points: this.live().map(toPosition),
      live: this.phase === 'drawing' && this.floating !== null,
      groundLength: this.ground,
    };
  }

  private emit(): void {
    if (this.disposed) return;
    this.callbacks.onChange(this.reading());
    this.scheduleGround();
  }

  /**
   * Sample the terrain profile, at most every GROUND_THROTTLE_MS: it takes a
   * few hundred height lookups, too many to repeat on every mouse move. The
   * timer reads the points when it fires, so the last change is always covered.
   */
  private scheduleGround(): void {
    if ((this.shape !== 'line' && this.shape !== 'path') || this.groundTimer !== null) return;
    this.groundTimer = window.setTimeout(() => {
      this.groundTimer = null;
      if (this.disposed) return;
      this.ground = this.sampleGround();
      this.callbacks.onChange(this.reading());
    }, GROUND_THROTTLE_MS);
  }

  private sampleGround(): number {
    const pts = this.live().map(toPosition);
    // On the flat globe the ground is the map.
    if (!this.terrainOn()) return lineLength(pts);
    // The terrain as drawn: the tiles already loaded, as Google Earth measures it.
    const globe = this.viewer.scene.globe;
    return groundLength(pts, (lon, lat) =>
      globe.getHeight(Cartographic.fromDegrees(lon, lat, 0, scratchCarto)),
    );
  }

  // ---- drawing ------------------------------------------------------------

  private circlePositions(): Cartesian3[] {
    const p = this.live();
    if (p.length < 2) return [];
    const ring = circleRing(toPosition(p[0]), toPosition(p[1]));
    return [...ring, ring[0]].map((q) => Cartesian3.fromDegrees(q[0], q[1]));
  }

  private outline(): Cartesian3[] {
    if (this.shape === 'circle') return this.circlePositions();
    const p = this.live();
    return isClosedShape(this.shape) && p.length > 2 ? [...p, p[0]] : p;
  }

  private buildPreview(): void {
    const three = is3DShape(this.shape);
    const line = (positions: () => Cartesian3[]): Entity =>
      this.viewer.entities.add({
        polyline: three
          ? {
              positions: new CallbackProperty(positions, false),
              width: 3,
              material: RULER_LINE_3D,
              // Straight 3D segments, still visible where they pass behind relief.
              arcType: ArcType.NONE,
              depthFailMaterial: RULER_COLOR.withAlpha(0.4),
            }
          : {
              positions: new CallbackProperty(positions, false),
              width: 3,
              material: RULER_COLOR,
              clampToGround: true,
            },
      });

    this.preview.push(line(() => this.outline()));
    if (this.shape === 'circle') this.preview.push(line(() => this.live()));
    if (isClosedShape(this.shape) || this.shape === 'circle') {
      this.preview.push(
        this.viewer.entities.add({
          polygon: {
            hierarchy: new CallbackProperty(() => {
              const p = this.shape === 'circle' ? this.circlePositions() : this.live();
              return p.length >= 3 ? new PolygonHierarchy(p) : undefined;
            }, false),
            material: FILL,
            perPositionHeight: three,
          },
        }),
      );
    }
  }

  /** One square handle per committed point; the cursor point has none. */
  private syncHandles(): void {
    while (this.handles.length > this.points.length) {
      this.viewer.entities.remove(this.handles.pop()!);
    }
    while (this.handles.length < this.points.length) {
      const i = this.handles.length;
      this.handles.push(
        this.viewer.entities.add({
          position: new CallbackPositionProperty(() => this.points[i], false),
          billboard: {
            image: squareMarker('#ffffff', '#ffd400'),
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            color: HANDLE_TINT,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
  }
}
