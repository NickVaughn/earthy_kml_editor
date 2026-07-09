import { Color } from 'cesium';
import { kmlToRgba } from '@renderer/model/colors';

/** Convert an aabbggrr KML color to a Cesium Color. */
export function kmlToCesium(kml: string | undefined, fallback: Color): Color {
  if (!kml) return fallback;
  const { r, g, b, a } = kmlToRgba(kml);
  return Color.fromBytes(r, g, b, a);
}
