import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * KML super-overlays: the standard, portable way to put a tile pyramid in a
 * KMZ. Each tile gets a small KML holding a `<Region>` (its bounds + a level of
 * detail band), a `<GroundOverlay>` for its image, and `<NetworkLink>`s to the
 * four tiles below it. Google Earth walks that hierarchy natively, loading
 * detail only where you're looking.
 *
 * Our tiles are Web Mercator while `<LatLonBox>` is interpreted as plate
 * carrée. Within one 256px tile that mismatch is sub-pixel over the zoom range
 * we generate (~0.7px at z6, ~0.2px at z8, negligible deeper), which is the
 * same approximation gdal2tiles makes for its mercator profile.
 */

/** Geographic bounds of an XYZ tile. */
export function tileBounds(
  z: number,
  x: number,
  y: number,
): { west: number; east: number; north: number; south: number } {
  const n = 2 ** z;
  const lat = (row: number): number => {
    const t = Math.PI - (2 * Math.PI * row) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  };
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: lat(y),
    south: lat(y + 1),
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tiles present in a pyramid, as a set of "z/x/y" keys plus their zoom range. */
export function readPyramid(dir: string): {
  tiles: Set<string>;
  minZoom: number;
  maxZoom: number;
} {
  const tiles = new Set<string>();
  let minZoom = Infinity;
  let maxZoom = -Infinity;
  if (!existsSync(dir)) return { tiles, minZoom: 0, maxZoom: 0 };
  for (const zName of readdirSync(dir)) {
    const z = Number(zName);
    if (!Number.isInteger(z)) continue;
    const zDir = join(dir, zName);
    for (const xName of readdirSync(zDir)) {
      const x = Number(xName);
      if (!Number.isInteger(x)) continue;
      for (const yFile of readdirSync(join(zDir, xName))) {
        if (!yFile.endsWith('.png')) continue;
        const y = Number(yFile.slice(0, -4));
        if (!Number.isInteger(y)) continue;
        tiles.add(`${z}/${x}/${y}`);
        minZoom = Math.min(minZoom, z);
        maxZoom = Math.max(maxZoom, z);
      }
    }
  }
  if (!tiles.size) return { tiles, minZoom: 0, maxZoom: 0 };
  return { tiles, minZoom, maxZoom };
}

/** Google Earth's LOD band: show a tile once it's ~half a tile across, and
 *  retire it once its children have taken over (leaves never retire). */
const MIN_LOD_PIXELS = 128;
const MAX_LOD_PIXELS = 2048;

function regionXml(
  b: { west: number; east: number; north: number; south: number },
  minLod: number,
  maxLod: number,
  indent: string,
): string {
  return (
    `${indent}<Region>\n` +
    `${indent}  <LatLonAltBox>\n` +
    `${indent}    <north>${b.north}</north>\n` +
    `${indent}    <south>${b.south}</south>\n` +
    `${indent}    <east>${b.east}</east>\n` +
    `${indent}    <west>${b.west}</west>\n` +
    `${indent}  </LatLonAltBox>\n` +
    `${indent}  <Lod>\n` +
    `${indent}    <minLodPixels>${minLod}</minLodPixels>\n` +
    `${indent}    <maxLodPixels>${maxLod}</maxLodPixels>\n` +
    `${indent}  </Lod>\n` +
    `${indent}</Region>\n`
  );
}

/** The KML for one tile: its own overlay plus links to the tiles beneath it. */
export function tileKml(
  z: number,
  x: number,
  y: number,
  tiles: Set<string>,
  maxZoom: number,
): string {
  const b = tileBounds(z, x, y);
  const children: [number, number, number][] = [];
  if (z < maxZoom) {
    for (const cx of [x * 2, x * 2 + 1]) {
      for (const cy of [y * 2, y * 2 + 1]) {
        if (tiles.has(`${z + 1}/${cx}/${cy}`)) children.push([z + 1, cx, cy]);
      }
    }
  }
  // A tile with no children must stay visible however far you zoom in.
  const maxLod = children.length ? MAX_LOD_PIXELS : -1;

  let out =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n` +
    `  <Document>\n` +
    `    <name>${z}/${x}/${y}</name>\n` +
    `    <Style>\n` +
    `      <ListStyle id="hideChildren">\n` +
    `        <listItemType>checkHideChildren</listItemType>\n` +
    `      </ListStyle>\n` +
    `    </Style>\n` +
    regionXml(b, MIN_LOD_PIXELS, maxLod, '    ') +
    `    <GroundOverlay>\n` +
    `      <drawOrder>${z}</drawOrder>\n` +
    `      <Icon><href>${y}.png</href></Icon>\n` +
    `      <LatLonBox>\n` +
    `        <north>${b.north}</north>\n` +
    `        <south>${b.south}</south>\n` +
    `        <east>${b.east}</east>\n` +
    `        <west>${b.west}</west>\n` +
    `      </LatLonBox>\n` +
    `    </GroundOverlay>\n`;

  for (const [cz, cx, cy] of children) {
    const cb = tileBounds(cz, cx, cy);
    out +=
      `    <NetworkLink>\n` +
      `      <name>${cz}/${cx}/${cy}</name>\n` +
      regionXml(cb, MIN_LOD_PIXELS, -1, '      ') +
      `      <Link>\n` +
      // Child KMLs live at ../<cz>/<cx>/<cy>.kml relative to this one.
      `        <href>../../${cz}/${cx}/${cy}.kml</href>\n` +
      `        <viewRefreshMode>onRegion</viewRefreshMode>\n` +
      `      </Link>\n` +
      `    </NetworkLink>\n`;
  }

  return out + `  </Document>\n</kml>\n`;
}

/** The pyramid's entry point: links to whichever tiles sit at the top. */
export function rootKml(name: string, tiles: Set<string>, minZoom: number): string {
  const roots = [...tiles]
    .map((k) => k.split('/').map(Number) as [number, number, number])
    .filter(([z]) => z === minZoom);

  let out =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n` +
    `  <Document>\n` +
    `    <name>${esc(name)}</name>\n` +
    `    <Style>\n` +
    `      <ListStyle id="hideChildren">\n` +
    `        <listItemType>checkHideChildren</listItemType>\n` +
    `      </ListStyle>\n` +
    `    </Style>\n`;
  for (const [z, x, y] of roots) {
    const b = tileBounds(z, x, y);
    out +=
      `    <NetworkLink>\n` +
      `      <name>${z}/${x}/${y}</name>\n` +
      regionXml(b, MIN_LOD_PIXELS, -1, '      ') +
      `      <Link>\n` +
      `        <href>${z}/${x}/${y}.kml</href>\n` +
      `        <viewRefreshMode>onRegion</viewRefreshMode>\n` +
      `      </Link>\n` +
      `    </NetworkLink>\n`;
  }
  return out + `  </Document>\n</kml>\n`;
}
