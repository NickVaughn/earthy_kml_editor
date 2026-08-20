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
  GroundPrimitive,
  GroundPolylinePrimitive,
  GroundPolylineGeometry,
  PolylineColorAppearance,
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
import { iconUrl } from '@renderer/model/overlays';
import { kmlToCesium } from './cesiumColor';

// Defaults for features without an explicit style (configurable later).
const DEFAULT_LINE = Color.WHITE;
const DEFAULT_FILL = Color.WHITE.withAlpha(0.5);
const DEFAULT_POINT = Color.WHITE;

/**
 * Vertex budget above which a document gives up draping and renders flat.
 *
 * Draping is classification: Cesium builds a stencil shadow volume per geometry,
 * which is what makes it follow terrain with no heights computed at all — and
 * what makes it cost. The cost tracks vertices. For reference, 191 polygons drape
 * in ~110 ms, an 824k-vertex document in seconds, and a 4.16M-vertex one takes
 * minutes and leaves the app unresponsive.
 *
 * Applied PER DOCUMENT, not to the scene: a scene-wide budget means opening one
 * oversized file silently drops every other open document to flat, which looks
 * like a regression in a file that was fine a moment ago.
 */
export const DRAPE_VERTEX_BUDGET = 1_000_000;

/** Positions in a geometry, for the drape budget. Cheap: no Cartesians built. */
function vertexCount(g: Geometry): number {
  switch (g.kind) {
    case 'Point':
      return 1;
    case 'LineString':
      return g.coordinates.length;
    case 'Polygon':
      return (
        g.outerBoundary.length +
        g.innerBoundaries.reduce((n, ring) => n + ring.length, 0)
      );
    case 'MultiGeometry':
      return g.geometries.reduce((n, child) => n + vertexCount(child), 0);
  }
}

/** Diameter and outline of a plain (icon-less) point marker, in CSS pixels. */
const DOT_SIZE = 8;
const DOT_OUTLINE = 1;
/** Point-marker images, keyed by their full appearance — one atlas entry each. */
const dotImages = new Map<string, string | null>();

/**
 * A round point marker drawn to a canvas, as a data URL.
 *
 * `PointPrimitive` is the cheap way to draw a dot, but Cesium gives it no
 * `heightReference` — only billboards, labels and models can clamp. So a point
 * that has to follow terrain is drawn as a billboard instead, with this as its
 * image. (Cesium's own `PointVisualizer` makes the same swap.) Rendered at 2x
 * and scaled back down so it stays crisp on a HiDPI display, and cached by
 * appearance so every dot that looks alike shares one texture-atlas entry.
 *
 * A null `fill` leaves the centre transparent, giving a ring. The selection
 * halo uses that: a filled halo and the marker it marks are two co-located
 * billboards in different collections with depth testing off, so which one
 * wins is decided by a distance sort between equal distances — it flips as the
 * camera moves, and the halo appears to flicker. A ring cannot overlap the
 * marker's pixels at all, so there is nothing to sort.
 *
 * `DOT_SCALE` is the billboard scale that returns it to `pixelSize` on screen.
 */
export const DOT_SCALE = 0.5; // inverse of the 2x supersample below

export function dotImage(
  fill: Color | null,
  pixelSize = DOT_SIZE,
  outline: Color = Color.BLACK,
  outlineWidth = DOT_OUTLINE,
): string | null {
  const fillCss = fill ? fill.toCssColorString() : 'none';
  const outlineCss = outline.toCssColorString();
  const key = `${fillCss}|${pixelSize}|${outlineCss}|${outlineWidth}`;
  const cached = dotImages.get(key);
  if (cached !== undefined) return cached;
  const r = 2; // supersample factor; DOT_SCALE undoes it
  const size = (pixelSize + 2 * outlineWidth) * r;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // No 2D context to draw into: the caller falls back to an unclamped
    // PointPrimitive, which is the old behaviour rather than a missing marker.
    dotImages.set(key, null);
    return null;
  }
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, 2 * Math.PI);
  ctx.fillStyle = outlineCss;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, (pixelSize * r) / 2, 0, 2 * Math.PI);
  if (fill) {
    ctx.fillStyle = fillCss;
    ctx.fill();
  } else {
    // Punch the centre out, so the marker underneath shows through.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }
  const url = canvas.toDataURL('image/png');
  dotImages.set(key, url);
  return url;
}

/** A handle that can toggle a node's rendered visibility without a rebuild. */
interface ShowToggle {
  set(show: boolean): void;
}

/** What the scene actually put on the GPU — the numbers that explain load time. */
export interface SceneStats {
  /** Positions across every geometry — what the drape budget is spent on. */
  vertices: number;
  /** Documents rendered flat because they alone exceeded the drape budget. */
  drapeSkipped: { label: string; vertices: number }[];
  /** Classification is unavailable on this GPU: nothing can drape at all. */
  drapeUnsupported: boolean;
  /** Polygons that needed a triangulated fill (<fill>0</fill> ones don't). */
  fills: number;
  /** Lines batched as hairline GPU LINES: 1 vertex per position. */
  hairlines: number;
  /** Lines that needed PolylineCollection: 4 fat vertices per position. */
  wideLines: number;
  /** Positions on each of those paths. */
  hairlinePositions: number;
  wideLinePositions: number;
  /** Draped counterparts: classification fills and lines. */
  groundFills: number;
  groundLines: number;
}

export interface SceneHandle {
  /** Cartesian bounding sphere per node id, for flyTo. */
  bounds: Map<string, BoundingSphere>;
  stats: SceneStats;
  /** Whether this document's lines and fills drape, or render flat at sea level. */
  isDraped(doc: KmlDocument): boolean;
  /** Toggle a node's visibility across all its primitives. */
  setNodeShow(id: string, show: boolean): void;
  dispose(): void;
}

/**
 * A feature renders at its stored altitude only when it explicitly asks to —
 * altitudeMode `absolute` AND a Z present. Everything else renders at ground
 * level, which is sea level where there is no terrain under it.
 */
export function usesStoredZ(g: { altitudeMode?: string }, hasZ: boolean): boolean {
  return g.altitudeMode === 'absolute' && hasZ;
}

/**
 * Ellipsoidal height for an MSL altitude, which is the datum Cesium positions
 * in: h = H + N. KML altitudes are orthometric, and so is the terrain (see
 * globe/terrain.ts), so everything the renderer places goes through here.
 *
 * Note height 0 is NOT sea level — it is the ellipsoid, which sits ~19 m below
 * the sea off Hawai'i and ~30 m above it over California. Placing "flat"
 * geometry at 0 rather than at N is what put features under the water.
 *
 * Guards against a non-finite height ever reaching Cesium's geometry packer.
 */
export function ellipsoidalHeight(lon: number, lat: number, mslAltitude: number): number {
  const h = mslAltitude + (geoidHeight(lon, lat) ?? 0);
  return Number.isFinite(h) ? h : 0;
}

/** The MSL altitude a vertex renders at: its own Z if `absolute`, else ground. */
export function mslAltitudeOf(p: Position, absolute: boolean): number {
  return absolute ? (p[2] ?? 0) : 0;
}

/** A vertex at the height the resolver rule gives it. */
export function renderCart(p: Position, absolute: boolean): Cartesian3 {
  return Cartesian3.fromDegrees(
    p[0],
    p[1],
    ellipsoidalHeight(p[0], p[1], mslAltitudeOf(p, absolute)),
  );
}

/**
 * Build the batched Cesium scene for the open documents.
 *
 * Points, labels and billboards follow terrain via `heightReference`, a cheap
 * per-primitive height lookup. Lines and polygon fills follow it by draping —
 * `GroundPolylinePrimitive` and `GroundPrimitive`, Cesium's classification
 * primitives, which project the geometry onto the surface on the GPU. Draping
 * needs no heights at all: stored Z is ignored, nothing is sampled, nothing is
 * downloaded, and the result stays right as terrain refines.
 *
 * What it costs is build time — a stencil shadow volume per geometry, scaling
 * with vertices — so past DRAPE_VERTEX_BUDGET the scene falls back to flat
 * primitives at sea level and reports that it did. Flat geometry does not
 * follow terrain: it is buried by relief, and because the globe does not
 * depth-test primitives by default it also appears to swim across the landscape
 * as the camera tilts.
 *
 * `absolute` features are never draped — they have a real altitude to honour.
 */
export function buildScene(viewer: Viewer, docs: KmlDocument[]): SceneHandle {
  const primitives = new PrimitiveCollection();
  viewer.scene.primitives.add(primitives);
  // Classification primitives live in their own collection, rendered in the
  // globe's classification pass rather than with ordinary primitives.
  const groundPrimitives = new PrimitiveCollection();
  viewer.scene.groundPrimitives.add(groundPrimitives);

  // Decide flat vs draped up front, per document: it changes what every
  // geometry builds, and one huge file must not drag the others down with it.
  const supported =
    GroundPrimitive.isSupported(viewer.scene) &&
    GroundPolylinePrimitive.isSupported(viewer.scene);
  const drapeSkipped: SceneStats['drapeSkipped'] = [];
  const drapedDocs = new Set<KmlDocument>();
  let vertices = 0;
  for (const doc of docs) {
    let n = 0;
    for (const node of doc.placemarksUnder()) {
      if (node.geometry) n += vertexCount(node.geometry);
    }
    vertices += n;
    if (!supported) continue;
    if (n > DRAPE_VERTEX_BUDGET) {
      drapeSkipped.push({ label: doc.path?.split(/[\\/]/).pop() ?? doc.root.name, vertices: n });
    } else {
      drapedDocs.add(doc);
    }
  }

  const polylines = new PolylineCollection();
  const points = new PointPrimitiveCollection();
  const billboards = new BillboardCollection({ scene: viewer.scene });
  const labels = new LabelCollection({ scene: viewer.scene });

  const polygonInstances: GeometryInstance[] = [];
  const lineInstances: GeometryInstance[] = []; // hairline lines, batched as GPU LINES
  const groundPolygonInstances: GeometryInstance[] = [];
  const groundLineInstances: GeometryInstance[] = [];
  const stats: SceneStats = {
    vertices,
    drapeSkipped,
    drapeUnsupported: !supported,
    fills: 0,
    hairlines: 0,
    wideLines: 0,
    hairlinePositions: 0,
    wideLinePositions: 0,
    groundFills: 0,
    groundLines: 0,
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

  // A vertex at its own MSL altitude, and one at sea level. Both go through the
  // geoid — see ellipsoidalHeight for why sea level is not height 0.
  const geoidCart = (p: Position): Cartesian3 => renderCart(p, true);
  const flatCart = (p: Position): Cartesian3 => renderCart(p, false);

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
  /**
   * A line draped on the surface. Positions are a footprint only — Cesium
   * classifies against whatever terrain is loaded, so heights are ignored.
   * Segments follow geodesics, the default, because a draped line should track
   * the surface rather than cut a chord across it.
   */
  const groundLine = (
    positions: Cartesian3[],
    width: number,
    color: Color,
    id: string,
    show: boolean,
  ): void => {
    stats.groundLines++;
    groundLineInstances.push(
      new GeometryInstance({
        geometry: new GroundPolylineGeometry({ positions, width }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(color),
          show: new ShowGeometryInstanceAttribute(show),
        },
        id,
      }),
    );
  };

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
    drape: boolean,
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
        // A marker sits ON the ground, so the only thing that can occlude it is
        // the ground it is glued to — a depth tie the buffer resolves per pixel
        // and per camera angle, which reads as markers flickering out as the
        // view tilts. Opt clamped ones out of the depth test entirely.
        const noDepth = clamped ? Number.POSITIVE_INFINITY : 0;
        accum(node.id, [pos]);
        const icon = style.icon?.iconHref ? iconUrl(doc.resources, style.icon.iconHref) : null;
        if (icon) {
          const bb = billboards.add({
            position: pos,
            image: icon,
            scale: style.icon?.scale ?? 1,
            color: kmlToCesium(style.icon?.color, Color.WHITE),
            show: startVisible,
            id: node.id,
            heightReference: hRef,
            disableDepthTestDistance: noDepth,
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
              scale: DOT_SCALE,
              show: startVisible,
              id: node.id,
              heightReference: hRef,
              disableDepthTestDistance: noDepth,
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
            disableDepthTestDistance: noDepth,
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
        if (drape && !absolute) groundLine(carts, width, color, node.id, startVisible);
        else bakedLine(carts, width, color, node.id, startVisible);
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
          const holes = g.innerBoundaries.map((r) => new PolygonHierarchy(r.map(toCart)));
          const hierarchy = new PolygonHierarchy(outer, holes);
          const fillColor = ColorGeometryInstanceAttribute.fromColor(
            kmlToCesium(style.poly?.color, DEFAULT_FILL),
          );
          if (drape && !absolute) {
            stats.groundFills++;
            groundPolygonInstances.push(
              new GeometryInstance({
                // No height: GroundPrimitive uses the footprint and classifies
                // against the surface.
                geometry: new PolygonGeometry({ polygonHierarchy: hierarchy }),
                attributes: {
                  color: fillColor,
                  show: new ShowGeometryInstanceAttribute(startVisible),
                },
                id: node.id,
              }),
            );
          } else {
            stats.fills++;
            polygonInstances.push(
              new GeometryInstance({
                geometry: new PolygonGeometry({
                  polygonHierarchy: hierarchy,
                  // Absolute: honor each baked vertex height. Otherwise one flat
                  // plane — and with perPositionHeight off, PolygonGeometry
                  // ignores the vertex heights and uses `height`, so sea level
                  // has to be passed in explicitly. N varies far more slowly
                  // than a polygon is wide, so one sample per ring is plenty.
                  perPositionHeight: absolute,
                  height: absolute
                    ? undefined
                    : ellipsoidalHeight(g.outerBoundary[0][0], g.outerBoundary[0][1], 0),
                }),
                attributes: {
                  color: fillColor,
                  show: new ShowGeometryInstanceAttribute(startVisible),
                },
                id: node.id,
              }),
            );
          }
        }
        if (style.poly?.outline !== false) {
          const ring = [...outer, outer[0]];
          const w = style.line?.width ?? 1;
          const c = kmlToCesium(style.line?.color, DEFAULT_LINE);
          if (drape && !absolute) groundLine(ring, w, c, node.id, startVisible);
          else bakedLine(ring, w, c, node.id, startVisible);
        }
        break;
      }
      case 'MultiGeometry':
        for (const child of g.geometries) addGeometry(doc, node, child, startVisible, drape);
        break;
    }
  }

  // Walk every open document's placemarks (node ids are globally unique).
  for (const doc of docs) {
    const drape = drapedDocs.has(doc);
    for (const node of doc.placemarksUnder()) {
      if (!node.geometry) continue;
      addGeometry(doc, node, node.geometry, doc.isEffectivelyVisible(node), drape);
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

  // The draped counterparts: one classification primitive each, in the ground
  // collection. Show toggles work the same way — per-instance attributes.
  let groundPolygonPrimitive: GroundPrimitive | null = null;
  if (groundPolygonInstances.length > 0) {
    groundPolygonPrimitive = new GroundPrimitive({
      geometryInstances: groundPolygonInstances,
      // GroundPrimitive defaults to no appearance at all; KML fills are usually
      // translucent, so say so explicitly as the pre-Phase-5 code did.
      appearance: new PerInstanceColorAppearance({ translucent: true, closed: false }),
      releaseGeometryInstances: false,
      asynchronous: groundPolygonInstances.length > 200,
    });
    groundPrimitives.add(groundPolygonPrimitive);
    for (const inst of groundPolygonInstances) {
      const id = inst.id as string;
      addToggle(id, {
        set: (sh) => {
          if (!groundPolygonPrimitive || !groundPolygonPrimitive.ready) return;
          const attr = groundPolygonPrimitive.getGeometryInstanceAttributes(id);
          if (attr) attr.show = ShowGeometryInstanceAttribute.toValue(sh, attr.show);
        },
      });
    }
  }

  let groundLinePrimitive: GroundPolylinePrimitive | null = null;
  if (groundLineInstances.length > 0) {
    groundLinePrimitive = new GroundPolylinePrimitive({
      geometryInstances: groundLineInstances,
      appearance: new PolylineColorAppearance(),
      releaseGeometryInstances: false,
      asynchronous: groundLineInstances.length > 200,
    });
    groundPrimitives.add(groundLinePrimitive);
    for (const inst of groundLineInstances) {
      const id = inst.id as string;
      addToggle(id, {
        set: (sh) => {
          if (!groundLinePrimitive || !groundLinePrimitive.ready) return;
          const attr = groundLinePrimitive.getGeometryInstanceAttributes(id);
          if (attr) attr.show = ShowGeometryInstanceAttribute.toValue(sh, attr.show);
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
    isDraped: (doc) => drapedDocs.has(doc),
    setNodeShow(id, show) {
      const arr = toggles.get(id);
      if (arr) for (const t of arr) t.set(show);
    },
    dispose() {
      viewer.scene.primitives.remove(primitives); // destroys children
      viewer.scene.groundPrimitives.remove(groundPrimitives);
    },
  };
}

// Solid-color material for the batched polylines.
import { Material } from 'cesium';
function polylineColorMaterial(color: Color): Material {
  return Material.fromType('Color', { color });
}
