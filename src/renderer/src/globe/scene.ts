import {
  Viewer,
  Primitive,
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
} from 'cesium';
import type { KmlDocument } from '@renderer/model/document';
import type { KmlNode, Geometry, Position } from '@renderer/model/types';
import { kmlToCesium } from './cesiumColor';

const DEFAULT_LINE = Color.YELLOW;
const DEFAULT_FILL = Color.CYAN.withAlpha(0.4);
const DEFAULT_POINT = Color.YELLOW;

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

export function buildScene(viewer: Viewer, doc: KmlDocument): SceneHandle {
  const primitives = new PrimitiveCollection();
  viewer.scene.primitives.add(primitives);

  const polylines = new PolylineCollection();
  const points = new PointPrimitiveCollection();
  const billboards = new BillboardCollection({ scene: viewer.scene });
  const labels = new LabelCollection({ scene: viewer.scene });

  const polygonInstances: GeometryInstance[] = [];
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

  function addGeometry(node: KmlNode, g: Geometry, startVisible: boolean): void {
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
          });
          addToggle(node.id, { set: (s) => (lbl.show = s) });
        }
        break;
      }
      case 'LineString': {
        const carts = toCartesians(g.coordinates);
        if (carts.length < 2) break;
        accum(node.id, carts);
        const line = polylines.add({
          positions: carts,
          width: style.line?.width ?? 2,
          material: undefined,
          show: startVisible,
          id: node.id,
        });
        // Use per-line color via Material.
        line.material = polylineColorMaterial(
          kmlToCesium(style.line?.color, DEFAULT_LINE),
        );
        addToggle(node.id, { set: (s) => (line.show = s) });
        break;
      }
      case 'Polygon': {
        const outer = toCartesians(g.outerBoundary);
        if (outer.length < 3) break;
        accum(node.id, outer);
        const holes = g.innerBoundaries.map((r) => new PolygonHierarchy(toCartesians(r)));
        const fill = style.poly?.fill !== false;
        if (fill) {
          const instance = new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: new PolygonHierarchy(outer, holes),
              perPositionHeight: false,
            }),
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(
                kmlToCesium(style.poly?.color, DEFAULT_FILL),
              ),
              show: new ShowGeometryInstanceAttribute(startVisible),
            },
            id: node.id,
          });
          polygonInstances.push(instance);
        }
        if (style.poly?.outline !== false) {
          const ring = [...outer, outer[0]];
          const outline = polylines.add({
            positions: ring,
            width: style.line?.width ?? 1.5,
            show: startVisible,
            id: node.id,
          });
          outline.material = polylineColorMaterial(
            kmlToCesium(style.line?.color, DEFAULT_LINE),
          );
          addToggle(node.id, { set: (s) => (outline.show = s) });
        }
        break;
      }
      case 'MultiGeometry':
        for (const child of g.geometries) addGeometry(node, child, startVisible);
        break;
    }
  }

  // Walk placemarks, honoring effective (ancestor-aware) visibility.
  for (const node of doc.placemarksUnder()) {
    if (!node.geometry) continue;
    const visible = doc.isEffectivelyVisible(node);
    addGeometry(node, node.geometry, visible);
  }

  // Build the single batched polygon primitive.
  let polygonPrimitive: Primitive | null = null;
  if (polygonInstances.length > 0) {
    polygonPrimitive = new Primitive({
      geometryInstances: polygonInstances,
      appearance: new PerInstanceColorAppearance({ translucent: true, closed: false }),
      releaseGeometryInstances: false,
      asynchronous: polygonInstances.length > 200,
    });
    primitives.add(polygonPrimitive);
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
    },
  };
}

// Lazily import PolylineColorAppearance material helper to avoid circular refs.
import { Material } from 'cesium';
function polylineColorMaterial(color: Color): Material {
  return Material.fromType('Color', { color });
}
