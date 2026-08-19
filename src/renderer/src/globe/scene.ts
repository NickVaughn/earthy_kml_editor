import {
  Viewer,
  Primitive,
  GeometryInstance,
  PolygonGeometry,
  PolygonHierarchy,
  SimplePolylineGeometry,
  ArcType,
  PerInstanceColorAppearance,
  ColorGeometryInstanceAttribute,
  ShowGeometryInstanceAttribute,
  PolylineCollection,
  PointPrimitiveCollection,
  BillboardCollection,
  LabelCollection,
  PrimitiveCollection,
  Cartesian3,
  Color,
  BoundingSphere,
  DistanceDisplayCondition,
  HorizontalOrigin,
  VerticalOrigin,
  LabelStyle as CesiumLabelStyle,
  HeightReference,
} from 'cesium';
import type { KmlDocument } from '@renderer/model/document';
import type { KmlNode, Geometry, Position } from '@renderer/model/types';
import { geoidHeight } from '@renderer/model/geoid';
import { kmlToCesium } from './cesiumColor';

// Defaults for features without an explicit style (configurable later).
const DEFAULT_LINE = Color.WHITE;
const DEFAULT_FILL = Color.WHITE.withAlpha(0.5);
const DEFAULT_POINT = Color.WHITE;

/** Diameter and outline of a plain (icon-less) point marker, in CSS pixels. */
const DOT_SIZE = 8;
const DOT_OUTLINE = 1;
/** Cache of point-marker images, keyed by CSS colour — one atlas entry each. */
const dotImages = new Map<string, string | null>();

/**
 * A round point marker drawn to a canvas, as a data URL.
 *
 * `PointPrimitive` is the cheap way to draw a dot, but Cesium gives it no
 * `heightReference` — only billboards, labels and models can clamp. So a point
 * that has to follow terrain is drawn as a billboard instead, with this as its
 * image. (Cesium's own `PointVisualizer` makes the same swap.) Rendered at 2x
 * and scaled back down so it stays crisp on a HiDPI display, and cached per
 * colour so every point of one colour shares a single texture-atlas entry.
 */
function dotImage(color: Color): string | null {
  const css = color.toCssColorString();
  const cached = dotImages.get(css);
  if (cached !== undefined) return cached;
  const r = 2; // supersample factor
  const size = (DOT_SIZE + 2 * DOT_OUTLINE) * r;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2D context to draw into: the caller falls back to an unclamped
    // PointPrimitive, which is the old behaviour rather than a missing marker.
    dotImages.set(css, null);
    return null;
  }
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, 2 * Math.PI);
  ctx.fillStyle = 'black';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, (DOT_SIZE * r) / 2, 0, 2 * Math.PI);
  ctx.fillStyle = css;
  ctx.fill();
  const url = canvas.toDataURL('image/png');
  dotImages.set(css, url);
  return url;
}

/** A handle that can toggle a node's rendered visibility without a rebuild. */
interface ShowToggle {
  set(show: boolean): void;
}

/** What the scene actually put on the GPU — the numbers that explain load time. */
export interface SceneStats {
  /** Polygons that needed a triangulated fill (<fill>0</fill> ones don't). */
  fills: number;
  /** Lines batched as hairline GPU LINES: 1 vertex per position. */
  hairlines: number;
  /** Lines that needed PolylineCollection: 4 fat vertices per position. */
  wideLines: number;
  /** Positions on each of those paths. */
  hairlinePositions: number;
  wideLinePositions: number;
}

export interface SceneHandle {
  /** Cartesian bounding sphere per node id, for flyTo. */
  bounds: Map<string, BoundingSphere>;
  stats: SceneStats;
  /** Toggle a node's visibility across all its primitives. */
  setNodeShow(id: string, show: boolean): void;
  dispose(): void;
}

/**
 * A feature renders at its stored altitude only when it explicitly asks to —
 * altitudeMode `absolute` AND a Z present. Everything else renders flat at the
 * ellipsoid (height 0). (KML altitude is MSL; the renderer adds the geoid
 * undulation to reach the ellipsoidal height Cesium positions by.)
 */
function usesStoredZ(g: { altitudeMode?: string }, hasZ: boolean): boolean {
  return g.altitudeMode === 'absolute' && hasZ;
}

/**
 * Build the batched Cesium scene for the open documents.
 *
 * Everything renders as a flat, non-classification primitive: one batched
 * `Primitive` for polygon fills, one `PolylineCollection` for lines and polygon
 * outlines, `heightReference: NONE` for points/labels/billboards. Draped
 * (classification) rendering — `GroundPrimitive` / `GroundPolylinePrimitive` —
 * builds a per-feature stencil shadow volume and costs orders of magnitude more
 * to build and draw; at KML scale (thousands of polygons) it is unusable, so the
 * trade is made in favor of speed and consistency.
 *
 * Exception: points, labels and billboards DO follow terrain, via Cesium's
 * `heightReference`. That is a per-primitive height lookup against the loaded
 * terrain, not a classification shadow volume, so it costs nothing like
 * `GroundPrimitive` and is worth having — an unclamped marker sits at the
 * ellipsoid, gets buried by any relief above it, and (because the globe does
 * not depth-test primitives by default) swims across the landscape as the
 * camera tilts.
 *
 * Consequence: lines and polygon fills still do NOT follow terrain. With 3D
 * terrain on they sit at the ellipsoid and are partly buried by relief. Only
 * `absolute` features with a Z lift off the ellipsoid.
 */
export function buildScene(viewer: Viewer, docs: KmlDocument[]): SceneHandle {
  const primitives = new PrimitiveCollection();
  viewer.scene.primitives.add(primitives);

  const polylines = new PolylineCollection();
  const points = new PointPrimitiveCollection();
  const billboards = new BillboardCollection({ scene: viewer.scene });
  const labels = new LabelCollection({ scene: viewer.scene });

  const polygonInstances: GeometryInstance[] = [];
  const lineInstances: GeometryInstance[] = []; // hairline lines, batched as GPU LINES
  const stats: SceneStats = {
    fills: 0,
    hairlines: 0,
    wideLines: 0,
    hairlinePositions: 0,
    wideLinePositions: 0,
  };
  const bounds = new Map<string, BoundingSphere>();
  const toggles = new Map<string, ShowToggle[]>();
  const cartesianAccum = new Map<string, Cartesian3[]>();

  const addToggle = (id: string, t: ShowToggle) => {
    const arr = toggles.get(id);
    if (arr) arr.push(t);
    else toggles.set(id, [t]);
  };
  const accum = (id: string, carts: Cartesian3[]) => {
    const arr = cartesianAccum.get(id);
    if (arr) arr.push(...carts);
    else cartesianAccum.set(id, [...carts]);
  };

  const labelCond = new DistanceDisplayCondition(0, 2_000_000);

  // A vertex baked to its ellipsoidal position: MSL altitude + geoid undulation.
  // Guard against a non-finite height ever reaching Cesium's geometry packer.
  const geoidCart = (p: Position): Cartesian3 => {
    const h = (p[2] ?? 0) + (geoidHeight(p[0], p[1]) ?? 0);
    return Cartesian3.fromDegrees(p[0], p[1], Number.isFinite(h) ? h : 0);
  };
  // A vertex flattened to the ellipsoid — how everything but `absolute` renders.
  const flatCart = (p: Position): Cartesian3 => Cartesian3.fromDegrees(p[0], p[1], 0);

  /**
   * A plain (non-draped) line at explicit positions.
   *
   * Hairline (width <= 1) lines become batched GPU `LINES` — one vertex per
   * position. Wider lines have to go through `PolylineCollection`, which fakes
   * thickness by expanding every position into a 4-vertex quad carrying its own
   * position, prev and next as RTE-encoded pairs: 18 floats per vertex, ~72x the
   * memory of a hairline vertex, all written by a single-threaded JS loop inside
   * `scene.render()`. On a 4.1M-vertex dataset that is 1.4 GB and minutes of
   * main-thread work, versus 78 MB built in a worker. So only pay it when the
   * style actually asks for a thick line.
   */
  const bakedLine = (
    positions: Cartesian3[],
    width: number,
    color: Color,
    id: string,
    show: boolean,
  ): void => {
    if (width > 1) {
      stats.wideLines++;
      stats.wideLinePositions += positions.length;
      const line = polylines.add({ positions, width, material: undefined, show, id });
      line.material = polylineColorMaterial(color);
      addToggle(id, { set: (s) => (line.show = s) });
      return;
    }
    stats.hairlines++;
    stats.hairlinePositions += positions.length;
    lineInstances.push(
      new GeometryInstance({
        // ArcType.NONE: straight segments between the given positions. The
        // default (GEODESIC) would subdivide every segment along the ellipsoid.
        geometry: new SimplePolylineGeometry({ positions, arcType: ArcType.NONE }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(color),
          show: new ShowGeometryInstanceAttribute(show),
        },
        id,
      }),
    );
  };

  function addGeometry(
    doc: KmlDocument,
    node: KmlNode,
    g: Geometry,
    startVisible: boolean,
  ): void {
    const style = doc.styleFor(node);
    switch (g.kind) {
      case 'Point': {
        const absolute = usesStoredZ(g, g.coordinates[2] !== undefined);
        const pos = absolute ? geoidCart(g.coordinates) : flatCart(g.coordinates);
        // `absolute` carries its own height; everything else clamps to the
        // terrain surface so it never ends up buried under relief.
        const hRef = absolute ? HeightReference.NONE : HeightReference.CLAMP_TO_GROUND;
        const clamped = hRef !== HeightReference.NONE;
        accum(node.id, [pos]);
        if (style.icon?.iconHref) {
          const bb = billboards.add({
            position: pos,
            image: style.icon.iconHref,
            scale: style.icon.scale ?? 1,
            color: kmlToCesium(style.icon.color, Color.WHITE),
            show: startVisible,
            id: node.id,
            heightReference: hRef,
            verticalOrigin: VerticalOrigin.BOTTOM,
          });
          addToggle(node.id, { set: (s) => (bb.show = s) });
        } else {
          const color = kmlToCesium(style.icon?.color, DEFAULT_POINT);
          // Cesium gives PointPrimitive no heightReference, so a dot that must
          // follow terrain has to be a billboard instead (see dotImage).
          const dot = clamped ? dotImage(color) : null;
          if (dot) {
            const bb = billboards.add({
              position: pos,
              image: dot,
              scale: 0.5, // the image is drawn at 2x for HiDPI
              show: startVisible,
              id: node.id,
              heightReference: hRef,
              verticalOrigin: VerticalOrigin.CENTER,
            });
            addToggle(node.id, { set: (s) => (bb.show = s) });
          } else {
            const pt = points.add({
              position: pos,
              color,
              pixelSize: DOT_SIZE,
              outlineColor: Color.BLACK,
              outlineWidth: DOT_OUTLINE,
              show: startVisible,
              id: node.id,
            });
            addToggle(node.id, { set: (s) => (pt.show = s) });
          }
        }
        if (node.name) {
          const lbl = labels.add({
            position: pos,
            text: node.name,
            font: '13px sans-serif',
            fillColor: kmlToCesium(style.label?.color, Color.WHITE),
            style: CesiumLabelStyle.FILL_AND_OUTLINE,
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            scale: style.label?.scale ?? 1,
            pixelOffset: new Cartesian3(0, -18, 0),
            horizontalOrigin: HorizontalOrigin.CENTER,
            distanceDisplayCondition: labelCond,
            show: startVisible,
            id: node.id,
            heightReference: hRef,
          });
          addToggle(node.id, { set: (s) => (lbl.show = s) });
        }
        break;
      }
      case 'LineString': {
        if (g.coordinates.length < 2) break;
        const color = kmlToCesium(style.line?.color, DEFAULT_LINE);
        // Unstyled lines default to a hairline, which is both the app's own
        // default for new features and the cheap batched path above.
        const width = style.line?.width ?? 1;
        const absolute = usesStoredZ(g, g.coordinates.some((p) => p[2] !== undefined));
        const carts = g.coordinates.map(absolute ? geoidCart : flatCart);
        accum(node.id, carts);
        bakedLine(carts, width, color, node.id, startVisible);
        break;
      }
      case 'Polygon': {
        if (g.outerBoundary.length < 3) break;
        const absolute = usesStoredZ(
          g,
          g.outerBoundary.some((p) => p[2] !== undefined),
        );
        const toCart = absolute ? geoidCart : flatCart;
        const outer = g.outerBoundary.map(toCart);
        accum(node.id, outer);
        // <fill>0</fill> means NO fill geometry at all. Building a transparent
        // one anyway (to keep the interior pickable) costs a full triangulation
        // and a vertex buffer per polygon for something nobody can see — on an
        // outline-only dataset that is the entire load time.
        if (style.poly?.fill !== false) {
          stats.fills++;
          const holes = g.innerBoundaries.map((r) => new PolygonHierarchy(r.map(toCart)));
          polygonInstances.push(
            new GeometryInstance({
              geometry: new PolygonGeometry({
                polygonHierarchy: new PolygonHierarchy(outer, holes),
                // Absolute: honor each baked vertex height. Otherwise flat at 0.
                perPositionHeight: absolute,
              }),
              attributes: {
                color: ColorGeometryInstanceAttribute.fromColor(
                  kmlToCesium(style.poly?.color, DEFAULT_FILL),
                ),
                show: new ShowGeometryInstanceAttribute(startVisible),
              },
              id: node.id,
            }),
          );
        }
        if (style.poly?.outline !== false) {
          bakedLine(
            [...outer, outer[0]],
            style.line?.width ?? 1,
            kmlToCesium(style.line?.color, DEFAULT_LINE),
            node.id,
            startVisible,
          );
        }
        break;
      }
      case 'MultiGeometry':
        for (const child of g.geometries) addGeometry(doc, node, child, startVisible);
        break;
    }
  }

  // Walk every open document's placemarks (node ids are globally unique).
  for (const doc of docs) {
    for (const node of doc.placemarksUnder()) {
      if (!node.geometry) continue;
      addGeometry(doc, node, node.geometry, doc.isEffectivelyVisible(node));
    }
  }

  // One batched, flat Primitive for every polygon fill — a single draw call, no
  // classification. Added to our own collection, NOT scene.groundPrimitives.
  let polygonPrimitive: Primitive | null = null;
  if (polygonInstances.length > 0) {
    polygonPrimitive = new Primitive({
      geometryInstances: polygonInstances,
      appearance: new PerInstanceColorAppearance({ translucent: true, closed: false }),
      releaseGeometryInstances: false,
      asynchronous: polygonInstances.length > 200,
    });
    primitives.add(polygonPrimitive);
    for (const inst of polygonInstances) {
      const id = inst.id as string;
      addToggle(id, {
        set: (s) => {
          if (!polygonPrimitive || !polygonPrimitive.ready) return;
          const attr = polygonPrimitive.getGeometryInstanceAttributes(id);
          if (attr) attr.show = ShowGeometryInstanceAttribute.toValue(s, attr.show);
        },
      });
    }
  }

  // One batched Primitive for every hairline line — built in a worker.
  let linePrimitive: Primitive | null = null;
  if (lineInstances.length > 0) {
    linePrimitive = new Primitive({
      geometryInstances: lineInstances,
      appearance: new PerInstanceColorAppearance({ flat: true, translucent: true }),
      releaseGeometryInstances: false,
      asynchronous: lineInstances.length > 200,
    });
    primitives.add(linePrimitive);
    for (const inst of lineInstances) {
      const id = inst.id as string;
      addToggle(id, {
        set: (s) => {
          if (!linePrimitive || !linePrimitive.ready) return;
          const attr = linePrimitive.getGeometryInstanceAttributes(id);
          if (attr) attr.show = ShowGeometryInstanceAttribute.toValue(s, attr.show);
        },
      });
    }
  }

  primitives.add(polylines);
  primitives.add(points);
  primitives.add(billboards);
  primitives.add(labels);

  // Compute per-node bounding spheres for flyTo.
  for (const [id, carts] of cartesianAccum) {
    if (carts.length > 0) bounds.set(id, BoundingSphere.fromPoints(carts));
  }

  return {
    bounds,
    stats,
    setNodeShow(id, show) {
      const arr = toggles.get(id);
      if (arr) for (const t of arr) t.set(show);
    },
    dispose() {
      viewer.scene.primitives.remove(primitives); // destroys children
    },
  };
}

// Solid-color material for the batched polylines.
import { Material } from 'cesium';
function polylineColorMaterial(color: Color): Material {
  return Material.fromType('Color', { color });
}
