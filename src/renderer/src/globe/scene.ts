import {
  Viewer,
  GroundPrimitive,
  GeometryInstance,
  PolygonGeometry,
  PolygonHierarchy,
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
  GroundPolylinePrimitive,
  GroundPolylineGeometry,
  PolylineColorAppearance,
} from 'cesium';
import type { KmlDocument } from '@renderer/model/document';
import type { KmlNode, Geometry, Position } from '@renderer/model/types';
import { kmlToCesium } from './cesiumColor';

// Defaults for features without an explicit style (configurable later).
const DEFAULT_LINE = Color.WHITE;
const DEFAULT_FILL = Color.WHITE.withAlpha(0.5);
const DEFAULT_POINT = Color.WHITE;

function toCartesians(positions: Position[]): Cartesian3[] {
  return positions.map((p) => Cartesian3.fromDegrees(p[0], p[1], p[2] ?? 0));
}

/** A handle that can toggle a node's rendered visibility without a rebuild. */
interface ShowToggle {
  set(show: boolean): void;
}

export interface SceneHandle {
  /** Cartesian bounding sphere per node id, for flyTo. */
  bounds: Map<string, BoundingSphere>;
  /** Toggle a node's visibility across all its primitives. */
  setNodeShow(id: string, show: boolean): void;
  dispose(): void;
}

/**
 * Build the batched Cesium scene for the open documents. When `terrainOn`, point
 * features clamp to the ground (heightReference) and lines drape via a ground
 * primitive, so everything sits on the surface and is occluded by relief instead
 * of hovering at sea level and painting over the terrain. Explicit KML
 * altitudeMode handling (fixed / relative / absolute) lands with the elevation
 * editor; for now terrain-on means clamp-to-ground.
 */
export function buildScene(
  viewer: Viewer,
  docs: KmlDocument[],
  terrainOn: boolean,
): SceneHandle {
  const primitives = new PrimitiveCollection();
  viewer.scene.primitives.add(primitives);

  const polylines = new PolylineCollection();
  const points = new PointPrimitiveCollection();
  const billboards = new BillboardCollection({ scene: viewer.scene });
  const labels = new LabelCollection({ scene: viewer.scene });

  const polygonInstances: GeometryInstance[] = [];
  const groundLineInstances: GeometryInstance[] = [];
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

  // Terrain on → clamp point-like features to the ground; terrain off → NONE
  // (absolute, which on the flat ellipsoid is the same as before).
  const clampRef = terrainOn ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE;
  const groundLine = (
    positions: Cartesian3[],
    width: number,
    color: Color,
    id: string,
    show: boolean,
  ): GeometryInstance =>
    new GeometryInstance({
      geometry: new GroundPolylineGeometry({ positions, width }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(color),
        show: new ShowGeometryInstanceAttribute(show),
      },
      id,
    });

  function addGeometry(
    doc: KmlDocument,
    node: KmlNode,
    g: Geometry,
    startVisible: boolean,
  ): void {
    const style = doc.styleFor(node);
    switch (g.kind) {
      case 'Point': {
        const pos = Cartesian3.fromDegrees(
          g.coordinates[0],
          g.coordinates[1],
          g.coordinates[2] ?? 0,
        );
        accum(node.id, [pos]);
        if (style.icon?.iconHref) {
          const bb = billboards.add({
            position: pos,
            image: style.icon.iconHref,
            scale: style.icon.scale ?? 1,
            color: kmlToCesium(style.icon.color, Color.WHITE),
            show: startVisible,
            id: node.id,
            heightReference: clampRef,
            verticalOrigin: VerticalOrigin.BOTTOM,
          });
          addToggle(node.id, { set: (s) => (bb.show = s) });
        } else {
          const pt = points.add({
            position: pos,
            color: kmlToCesium(style.icon?.color, DEFAULT_POINT),
            pixelSize: 8,
            outlineColor: Color.BLACK,
            outlineWidth: 1,
            show: startVisible,
            id: node.id,
            heightReference: clampRef,
          });
          addToggle(node.id, { set: (s) => (pt.show = s) });
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
            heightReference: clampRef,
          });
          addToggle(node.id, { set: (s) => (lbl.show = s) });
        }
        break;
      }
      case 'LineString': {
        const carts = toCartesians(g.coordinates);
        if (carts.length < 2) break;
        accum(node.id, carts);
        const color = kmlToCesium(style.line?.color, DEFAULT_LINE);
        const width = style.line?.width ?? 2;
        if (terrainOn) {
          // Draped on the terrain surface: follows relief and is occluded by it.
          groundLineInstances.push(groundLine(carts, width, color, node.id, startVisible));
        } else {
          const line = polylines.add({
            positions: carts,
            width,
            material: undefined,
            show: startVisible,
            id: node.id,
          });
          line.material = polylineColorMaterial(color);
          addToggle(node.id, { set: (s) => (line.show = s) });
        }
        break;
      }
      case 'Polygon': {
        const outer = toCartesians(g.outerBoundary);
        if (outer.length < 3) break;
        accum(node.id, outer);
        const holes = g.innerBoundaries.map((r) => new PolygonHierarchy(toCartesians(r)));
        const fill = style.poly?.fill !== false;
        // Always add the fill geometry so the polygon INTERIOR is pickable, even
        // for outline-only polygons — render it transparent when fill is off.
        const fillColor = fill
          ? kmlToCesium(style.poly?.color, DEFAULT_FILL)
          : Color.TRANSPARENT;
        polygonInstances.push(
          new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: new PolygonHierarchy(outer, holes),
              perPositionHeight: false,
            }),
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(fillColor),
              show: new ShowGeometryInstanceAttribute(startVisible),
            },
            id: node.id,
          }),
        );
        if (style.poly?.outline !== false) {
          const ring = [...outer, outer[0]];
          const outlineColor = kmlToCesium(style.line?.color, DEFAULT_LINE);
          const outlineWidth = style.line?.width ?? 1.5;
          if (terrainOn) {
            groundLineInstances.push(
              groundLine(ring, outlineWidth, outlineColor, node.id, startVisible),
            );
          } else {
            const outline = polylines.add({
              positions: ring,
              width: outlineWidth,
              show: startVisible,
              id: node.id,
            });
            outline.material = polylineColorMaterial(outlineColor);
            addToggle(node.id, { set: (s) => (outline.show = s) });
          }
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

  // Build the batched polygon fill as a GroundPrimitive. Draping the fill on
  // the globe surface (rather than a flat Primitive coplanar with the ellipsoid)
  // avoids z-fighting AND makes the polygon INTERIOR reliably pickable via
  // classification — a plain Primitive at height 0 loses the depth test to the
  // globe, so interior picks returned the globe instead of the feature.
  let polygonPrimitive: GroundPrimitive | null = null;
  if (polygonInstances.length > 0) {
    polygonPrimitive = new GroundPrimitive({
      geometryInstances: polygonInstances,
      appearance: new PerInstanceColorAppearance({ translucent: true, closed: false }),
      releaseGeometryInstances: false,
      asynchronous: polygonInstances.length > 200,
    });
    // GroundPrimitives must live in the scene's dedicated groundPrimitives
    // collection — nesting them in a generic PrimitiveCollection prevents the
    // classification pass from rendering the fill.
    viewer.scene.groundPrimitives.add(polygonPrimitive);
    // Register show-toggles for each polygon instance.
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

  // Lines draped on terrain: one batched ground primitive, occluded by relief.
  let groundLinePrimitive: GroundPolylinePrimitive | null = null;
  if (groundLineInstances.length > 0) {
    groundLinePrimitive = new GroundPolylinePrimitive({
      geometryInstances: groundLineInstances,
      appearance: new PolylineColorAppearance(),
      releaseGeometryInstances: false,
      asynchronous: groundLineInstances.length > 200,
    });
    viewer.scene.groundPrimitives.add(groundLinePrimitive);
    for (const inst of groundLineInstances) {
      const id = inst.id as string;
      addToggle(id, {
        set: (s) => {
          if (!groundLinePrimitive || !groundLinePrimitive.ready) return;
          const attr = groundLinePrimitive.getGeometryInstanceAttributes(id);
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
    setNodeShow(id, show) {
      const arr = toggles.get(id);
      if (arr) for (const t of arr) t.set(show);
    },
    dispose() {
      viewer.scene.primitives.remove(primitives); // destroys children
      if (polygonPrimitive) viewer.scene.groundPrimitives.remove(polygonPrimitive);
      if (groundLinePrimitive) viewer.scene.groundPrimitives.remove(groundLinePrimitive);
    },
  };
}

// Lazily import PolylineColorAppearance material helper to avoid circular refs.
import { Material } from 'cesium';
function polylineColorMaterial(color: Color): Material {
  return Material.fromType('Color', { color });
}
