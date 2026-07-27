/**
 * Built-in 3D terrain sources, shared between the main process (which builds the
 * Terrain menu and proxies tile fetches) and the renderer (which turns a source
 * into a Cesium terrain provider). Keep this dependency-free — no electron or
 * cesium imports — so both sides can consume it.
 *
 * All sources are Terrarium-encoded raster-DEM tiles: height in metres is
 *   (R * 256 + G + B / 256) − 32768
 * decoded per pixel. The renderer meshes them on the fly (see globe/terrain.ts).
 */

export interface TerrainSourceDesc {
  /** Stable id; also the host in `earthy-terrain://<id>/<z>/<x>/<y>.png`. */
  id: string;
  /** User-facing name shown in the Terrain menu. */
  label: string;
  /** Remote XYZ tile template, fetched server-side by the main process. */
  urlTemplate: string;
  encoding: 'terrarium';
  /** Deepest zoom the source actually has tiles for; deeper views upsample. */
  maxZoom: number;
  attribution: string;
}

export const BUILTIN_TERRAIN: TerrainSourceDesc[] = [
  {
    id: 'aws-terrarium',
    label: 'AWS Terrain (online)',
    urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium',
    maxZoom: 15,
    attribution: 'Elevation — AWS Terrain Tiles (Mapzen · SRTM/GMTED et al.)',
  },
];

export function terrainSourceById(id: string): TerrainSourceDesc | undefined {
  return BUILTIN_TERRAIN.find((s) => s.id === id);
}
