/**
 * Pure camera-orientation math (Cesium-free, unit-testable). Both operations
 * pivot around the ground point at the centre of the screen, so the feature you
 * are looking at stays centred rather than sliding out of view.
 */

export interface Orientation {
  heading: number; // radians
  pitch: number; // radians (−π/2 = straight down)
  range: number; // metres from the pivot point
}

export const NADIR_PITCH = -Math.PI / 2;

/** Level the view straight down, keeping heading and distance. */
export function nadirOrientation(cur: Orientation): Orientation {
  return { heading: cur.heading, pitch: NADIR_PITCH, range: cur.range };
}

/** Square up so north is up, keeping tilt and distance. */
export function northUpOrientation(cur: Orientation): Orientation {
  return { heading: 0, pitch: cur.pitch, range: cur.range };
}
