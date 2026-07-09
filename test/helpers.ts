import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(here, 'fixtures', name), 'utf-8');
}

/** Generate a KML string with `count` small square polygons in a grid. */
export function generatePolygonKml(count: number): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document><name>Big</name>',
    '<Style id="s"><PolyStyle><color>7f00ff00</color></PolyStyle></Style>',
    '<Folder><name>Grid</name>',
  ];
  const cols = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const gx = (i % cols) * 0.01 - 120;
    const gy = Math.floor(i / cols) * 0.01 + 30;
    const c = `${gx},${gy} ${gx + 0.008},${gy} ${gx + 0.008},${gy + 0.008} ${gx},${gy + 0.008} ${gx},${gy}`;
    parts.push(
      `<Placemark><name>P${i}</name><styleUrl>#s</styleUrl>` +
        `<Polygon><outerBoundaryIs><LinearRing><coordinates>${c}</coordinates>` +
        `</LinearRing></outerBoundaryIs></Polygon></Placemark>`,
    );
  }
  parts.push('</Folder></Document></kml>');
  return parts.join('\n');
}
