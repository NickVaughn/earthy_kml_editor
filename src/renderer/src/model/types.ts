/**
 * The NGE KML document model. See PLAN.md §4.
 *
 * Design goal: **round-trip fidelity**. Anything we don't explicitly model is
 * preserved as raw XML (`unknownChildren`) or raw attributes (`attrs`) and
 * re-emitted verbatim, so saving never silently drops data.
 */

export type KmlNodeType =
  | 'Document'
  | 'Folder'
  | 'Placemark'
  | 'GroundOverlay'
  | 'NetworkLink'
  | 'ScreenOverlay'
  | 'Unknown';

export const CONTAINER_TYPES: ReadonlySet<KmlNodeType> = new Set([
  'Document',
  'Folder',
]);

// ---- Geometry -------------------------------------------------------------

export type Position = [lon: number, lat: number, alt?: number];

export type AltitudeMode =
  | 'clampToGround'
  | 'relativeToGround'
  | 'absolute'
  | undefined;

export interface PointGeometry {
  kind: 'Point';
  coordinates: Position;
  altitudeMode?: AltitudeMode;
  extrude?: boolean;
}

export interface LineGeometry {
  kind: 'LineString';
  coordinates: Position[];
  altitudeMode?: AltitudeMode;
  tessellate?: boolean;
  extrude?: boolean;
}

export interface LinearRing {
  coordinates: Position[];
}

export interface PolygonGeometry {
  kind: 'Polygon';
  outerBoundary: Position[];
  innerBoundaries: Position[][];
  altitudeMode?: AltitudeMode;
  tessellate?: boolean;
  extrude?: boolean;
}

export interface MultiGeometry {
  kind: 'MultiGeometry';
  geometries: Geometry[];
}

export type Geometry =
  | PointGeometry
  | LineGeometry
  | PolygonGeometry
  | MultiGeometry;

// ---- Styles ---------------------------------------------------------------

export interface IconStyle {
  color?: string; // aabbggrr
  scale?: number;
  heading?: number;
  iconHref?: string;
  /** Preserve unmodeled children of <IconStyle> (e.g. hotSpot). */
  raw?: string[];
}

export interface LabelStyle {
  color?: string;
  scale?: number;
}

export interface LineStyle {
  color?: string;
  width?: number;
}

export interface PolyStyle {
  color?: string;
  fill?: boolean;
  outline?: boolean;
}

export interface KmlStyle {
  id?: string;
  icon?: IconStyle;
  label?: LabelStyle;
  line?: LineStyle;
  poly?: PolyStyle;
  /**
   * BalloonStyle <text> template, extracted for display. Serialization still
   * comes from `raw`, so this is display-only (not written back).
   */
  balloonText?: string;
  /** Unmodeled sub-styles (BalloonStyle, ListStyle, …) preserved verbatim. */
  raw?: string[];
}

export interface StyleMapPair {
  key: string; // "normal" | "highlight"
  styleUrl?: string;
  inlineStyle?: KmlStyle;
}

export interface KmlStyleMap {
  id?: string;
  pairs: StyleMapPair[];
}

/**
 * A shared (id'd) Style or StyleMap defined directly inside a container. Stored
 * in the model (not as raw XML) so it can be edited and re-serialized. The same
 * object is also referenced from KmlDocumentData.sharedStyles for resolution.
 */
export type SharedStyleEntry =
  | { kind: 'Style'; style: KmlStyle }
  | { kind: 'StyleMap'; map: KmlStyleMap };

// ---- Nodes ----------------------------------------------------------------

export interface KmlNode {
  /** Stable internal id (not the KML id attribute). */
  id: string;
  /** Original id="" attribute, preserved for styleUrl resolution + round-trip. */
  kmlId?: string;
  type: KmlNodeType;
  name: string;
  description?: string;
  /** CDATA-wrapped description content is flagged so we re-emit as CDATA. */
  descriptionCdata?: boolean;
  visible: boolean;
  open?: boolean;
  children: KmlNode[];

  geometry?: Geometry;
  styleUrl?: string;
  inlineStyle?: KmlStyle;
  inlineStyleMap?: KmlStyleMap;
  /** Container-level shared styles (Document/Folder), in document order. */
  styles?: SharedStyleEntry[];
  /** ExtendedData: raw XML for round-trip + parsed name/value fields for display. */
  extendedData?: { raw: string; fields?: ExtendedDataField[] };

  /** For GroundOverlay / ScreenOverlay / NetworkLink: the whole element as raw XML. */
  rawElement?: string;

  /** Raw XML of unmodeled child elements, re-emitted verbatim after known ones. */
  unknownChildren: string[];
  /** Unmodeled attributes on this element (id is modeled separately). */
  attrs: Record<string, string>;
}

/** One name/value pair from a placemark's ExtendedData (Data or SchemaData). */
export interface ExtendedDataField {
  name: string;
  value: string;
}

export interface KmlDocumentData {
  /** The root node (a Document or, for headless KML, a synthetic container). */
  root: KmlNode;
  /** Schema SimpleField name → displayName, for default ExtendedData tables. */
  schemaDisplayNames?: Map<string, string>;
  /** Top-level shared styles/maps by id (without leading '#'). */
  sharedStyles: Map<string, KmlStyle>;
  sharedStyleMaps: Map<string, KmlStyleMap>;
  /** Namespace + attribute declarations from <kml> to re-emit. */
  kmlAttrs: Record<string, string>;
  /** Order of top-level shared style ids as originally encountered. */
  sharedOrder: string[];
}
