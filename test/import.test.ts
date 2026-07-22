import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { geojsonToFolder, geojsonGeometry, categoryColor } from '@renderer/model/geojson';
import { KmlDocument } from '@renderer/model/document';
import { serializeKml } from '@renderer/model/serialize';
import { parseKml } from '@renderer/model/parse';
import { fixture } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const PARCELS = readFileSync(join(here, 'fixtures/vector/parcels.geojson'), 'utf-8');

describe('geojson geometry conversion', () => {
  it('converts Point / LineString / Polygon', () => {
    expect(geojsonGeometry({ type: 'Point', coordinates: [1, 2] as never })).toEqual({
      kind: 'Point',
      coordinates: [1, 2],
    });
    const line = geojsonGeometry({
      type: 'LineString',
      coordinates: [[0, 0], [1, 1]] as never,
    });
    expect(line?.kind).toBe('LineString');
    const poly = geojsonGeometry({
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] as never,
    });
    expect(poly?.kind).toBe('Polygon');
  });

  it('converts Multi* into MultiGeometry and keeps holes', () => {
    const mp = geojsonGeometry({
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[5, 5], [6, 5], [6, 6], [5, 5]]],
      ] as never,
    });
    expect(mp?.kind).toBe('MultiGeometry');
    expect((mp as { geometries: unknown[] }).geometries.length).toBe(2);

    const holed = geojsonGeometry({
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 0]],
        [[2, 2], [3, 2], [3, 3], [2, 2]],
      ] as never,
    });
    expect((holed as { innerBoundaries: unknown[] }).innerBoundaries.length).toBe(1);
  });

  it('rejects unsupported/degenerate geometry', () => {
    expect(geojsonGeometry(null)).toBeNull();
    expect(geojsonGeometry({ type: 'Polygon', coordinates: [[[0, 0]]] as never })).toBeNull();
  });
});

describe('vector import', () => {
  it('names features from a chosen field and builds a description table', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'Parcels',
      nameField: 'NAME',
      descriptionFields: ['OWNER', 'ZONE', 'AREA'],
      styleMode: 'single',
    });
    expect(res.featureCount).toBe(2);
    expect(res.folder.name).toBe('Parcels');
    expect(res.folder.children[0].name).toBe('Parcel A');
    expect(res.folder.children[0].description).toContain('<b>OWNER</b>');
    expect(res.folder.children[0].description).toContain('Smith');
  });

  it('preserves all source attributes as ExtendedData', () => {
    const res = geojsonToFolder(PARCELS, { layerName: 'P', styleMode: 'single' });
    const fields = res.folder.children[0].extendedData?.fields ?? [];
    expect(fields.map((f) => f.name).sort()).toEqual(['AREA', 'NAME', 'OWNER', 'ZONE']);
  });

  it('creates one shared style per category when categorized', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'categorized',
      categoryField: 'ZONE',
    });
    // Two distinct ZONE values -> two styles, each referenced by one feature.
    expect(res.styles.length).toBe(2);
    const urls = res.folder.children.map((c) => c.styleUrl);
    expect(new Set(urls).size).toBe(2);
    expect(res.styles[0].poly?.color).toMatch(/^[0-9a-f]{8}$/);
  });

  it('uses a single shared style when not categorized', () => {
    const res = geojsonToFolder(PARCELS, { layerName: 'P', styleMode: 'single' });
    expect(res.styles.length).toBe(1);
    expect(new Set(res.folder.children.map((c) => c.styleUrl)).size).toBe(1);
  });

  it('generates distinct category colors', () => {
    const colors = [0, 1, 2, 3].map((i) => categoryColor(i, 4));
    expect(new Set(colors).size).toBe(4);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('imports into a document as one undoable step and round-trips to KML', () => {
    const doc = KmlDocument.fromKml(fixture('simple.kml'));
    const before = doc.stats().features;
    const res = geojsonToFolder(PARCELS, {
      layerName: 'Parcels',
      nameField: 'NAME',
      styleMode: 'categorized',
      categoryField: 'ZONE',
    });
    doc.importFolder(doc.root.id, res.folder, res.styles);

    expect(doc.stats().features).toBe(before + 2);
    // Styles registered and resolvable.
    const imported = doc.placemarksUnder().find((p) => p.name === 'Parcel A')!;
    expect(doc.styleFor(imported).poly?.color).toBeTruthy();

    // Survives serialization.
    const out = serializeKml(doc.data);
    expect(out).toContain('Parcel A');
    const re = new KmlDocument(parseKml(out));
    const reimported = re.placemarksUnder().find((p) => p.name === 'Parcel A')!;
    expect(reimported.geometry?.kind).toBe('Polygon');
    expect(re.styleFor(reimported).poly?.color).toBeTruthy();

    // Undo removes both the features and their styles.
    doc.undo();
    expect(doc.stats().features).toBe(before);
    expect(serializeKml(doc.data)).not.toContain('nge-cat-');
  });
});
