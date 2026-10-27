import type { Cartesian2, Cartesian3, Viewer } from 'cesium';

/**
 * The globe surface under a screen position, or null over the sky. With
 * terrain on this is the relief, so the point carries its real elevation and
 * the right lon/lat on a tilted view; otherwise the ellipsoid is enough.
 */
export function pickSurface(viewer: Viewer, pos: Cartesian2, terrainOn: boolean): Cartesian3 | null {
  if (terrainOn) {
    const ray = viewer.camera.getPickRay(pos);
    const hit = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
    if (hit) return hit;
  }
  return viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid) ?? null;
}
