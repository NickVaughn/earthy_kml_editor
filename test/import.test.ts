import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  geojsonToFolder,
  geojsonGeometry,
  categoryColor,
  defaultCategories,
} from '@renderer/model/geojson';
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

  it('creates one shared style per category when categorized (flat)', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'categorized',
      categoryField: 'ZONE',
      categoryFolders: false, // flat: placemarks directly under the layer folder
    });
    expect(res.styles.length).toBe(2);
    const urls = res.folder.children.map((c) => c.styleUrl);
    expect(new Set(urls).size).toBe(2);
    expect(res.styles[0].poly?.color).toMatch(/^[0-9a-f]{8}$/);
  });

  it('creates a sub-folder per category by default, named by value', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'categorized',
      categoryField: 'ZONE',
    });
    const folders = res.folder.children.filter((c) => c.type === 'Folder');
    expect(folders.map((f) => f.name).sort()).toEqual(['C2', 'R1']);
    expect(folders.every((f) => f.children.length === 1)).toBe(true);
    expect(res.styles.length).toBe(2);
  });

  it('honours explicit category specs (labels + colours override the ramp)', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'categorized',
      categoryField: 'ZONE',
      categories: [
        { value: 'R1', label: 'Residential', color: '#ff0000', fillMode: 'both', fillOpacity: 0.5, lineOpacity: 1 },
        { value: 'C2', label: 'Commercial', color: '#00ff00', fillMode: 'outline', fillOpacity: 0.5, lineOpacity: 1 },
      ],
    });
    // Folders use the custom labels.
    const names = res.folder.children.map((c) => c.name).sort();
    expect(names).toEqual(['Commercial', 'Residential']);
    // Colours come from the specs (aabbggrr): red R1, green C2.
    const red = res.styles.find((s) => s.poly?.color?.endsWith('0000ff'));
    const green = res.styles.find((s) => s.poly?.color?.endsWith('00ff00'));
    expect(red).toBeTruthy();
    expect(green).toBeTruthy();
    // C2 is outline-only.
    expect(green!.poly?.fill).toBe(false);
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

  it('groups features into sub-folders by a field', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'Parcels',
      nameField: 'NAME',
      groupField: 'ZONE',
      styleMode: 'single',
    });
    // Two distinct ZONE values -> two sub-folders, each holding its features.
    expect(res.featureCount).toBe(2);
    expect(res.folder.children.every((c) => c.type === 'Folder')).toBe(true);
    const names = res.folder.children.map((c) => c.name).sort();
    expect(names).toEqual(['C2', 'R1']);
    const r1 = res.folder.children.find((c) => c.name === 'R1')!;
    expect(r1.children[0].name).toBe('Parcel A');
  });

  it('sorts group folders naturally with (blank) last', () => {
    const gj = {
      features: [
        { properties: { G: 'B' }, geometry: { type: 'Point', coordinates: [0, 0] } },
        { properties: { G: '' }, geometry: { type: 'Point', coordinates: [1, 1] } },
        { properties: { G: 'A' }, geometry: { type: 'Point', coordinates: [2, 2] } },
      ],
    };
    const res = geojsonToFolder(gj as never, {
      layerName: 'L',
      groupField: 'G',
      styleMode: 'single',
    });
    expect(res.folder.children.map((c) => c.name)).toEqual(['A', 'B', '(blank)']);
  });

  it('honours the selected colour ramp', () => {
    const viridis = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'categorized',
      categoryField: 'ZONE',
      ramp: 'viridis',
    });
    const category = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'categorized',
      categoryField: 'ZONE',
      ramp: 'category',
    });
    expect(viridis.styles[0].poly?.color).not.toBe(category.styles[0].poly?.color);
    // Ramps produce distinct colours per category.
    expect(viridis.styles[0].poly?.color).not.toBe(viridis.styles[1].poly?.color);
  });

  it('applies fill mode and opacities', () => {
    const outlineOnly = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'single',
      fillMode: 'outline',
      lineOpacity: 1,
    });
    expect(outlineOnly.styles[0].poly?.fill).toBe(false);
    expect(outlineOnly.styles[0].poly?.outline).toBe(true);
    expect(outlineOnly.styles[0].line?.color?.slice(0, 2)).toBe('ff'); // opaque

    const fillOnly = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'single',
      fillMode: 'fill',
      fillOpacity: 0.25,
    });
    expect(fillOnly.styles[0].poly?.fill).toBe(true);
    expect(fillOnly.styles[0].poly?.outline).toBe(false);
    // 0.25 * 255 = 64 = 0x40
    expect(fillOnly.styles[0].poly?.color?.slice(0, 2)).toBe('40');

    const both = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'single',
      fillMode: 'both',
      fillOpacity: 1,
      lineOpacity: 0.5,
    });
    expect(both.styles[0].poly?.fill).toBe(true);
    expect(both.styles[0].poly?.outline).toBe(true);
    expect(both.styles[0].poly?.color?.slice(0, 2)).toBe('ff');
    expect(both.styles[0].line?.color?.slice(0, 2)).toBe('80'); // 0.5 -> 128
  });

  it('nests category folders under a separate group field', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'P',
      groupField: 'OWNER',
      styleMode: 'categorized',
      categoryField: 'ZONE',
      ramp: 'warm',
    });
    // OWNER folders on top, ZONE folders nested, placemarks at the leaves.
    expect(res.folder.children.map((c) => c.name).sort()).toEqual(['Jones', 'Smith']);
    expect(res.styles.length).toBe(2);
    const placemarks: typeof res.folder.children = [];
    const collect = (n: (typeof res.folder.children)[number]): void => {
      if (n.type === 'Placemark') placemarks.push(n);
      n.children.forEach(collect);
    };
    res.folder.children.forEach(collect);
    expect(placemarks.length).toBe(2);
    expect(placemarks.every((p) => !!p.styleUrl)).toBe(true);
    // Depth is layer > OWNER > ZONE > placemark.
    expect(res.folder.children[0].children[0].type).toBe('Folder');
  });

  it('imports layers collapsed (no auto-expanded folders)', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'P',
      groupField: 'ZONE',
      styleMode: 'single',
    });
    expect(res.folder.open).toBe(false);
    expect(res.folder.children.every((c) => c.type !== 'Folder' || c.open === false)).toBe(true);
  });

  it('applies a custom line width to single and categorized styles', () => {
    const single = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'single',
      lineWidth: 4,
    });
    expect(single.styles[0].line?.width).toBe(4);

    const cats = geojsonToFolder(PARCELS, {
      layerName: 'P',
      styleMode: 'categorized',
      categoryField: 'ZONE',
      lineWidth: 3,
    });
    expect(cats.styles.every((s) => s.line?.width === 3)).toBe(true);
  });

  it('renames group folders via groupLabels', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'P',
      groupField: 'ZONE',
      styleMode: 'single',
      groupLabels: { R1: 'Residential', C2: 'Commercial' },
    });
    expect(res.folder.children.map((c) => c.name).sort()).toEqual([
      'Commercial',
      'Residential',
    ]);
  });

  it('collapses to one level when group and colour fields are the same', () => {
    const res = geojsonToFolder(PARCELS, {
      layerName: 'P',
      groupField: 'ZONE',
      styleMode: 'categorized',
      categoryField: 'ZONE',
    });
    // Not double-nested: one folder per ZONE, holding the placemark directly.
    const folders = res.folder.children.filter((c) => c.type === 'Folder');
    expect(folders.map((f) => f.name).sort()).toEqual(['C2', 'R1']);
    expect(folders[0].children[0].type).toBe('Placemark');
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

  it('imports as the document root: names the doc, no wrapper folder', () => {
    const doc = KmlDocument.empty();
    const res = geojsonToFolder(PARCELS, {
      layerName: 'Parcels',
      nameField: 'NAME',
      groupField: 'ZONE',
      styleMode: 'categorized',
      categoryField: 'ZONE',
    });
    doc.importAsRoot(res.folder, res.styles);

    // The document takes the layer's name...
    expect(doc.root.name).toBe('Parcels');
    // ...and the ZONE folders sit directly under the root — no "Parcels" wrapper.
    expect(doc.root.children.every((c) => c.type === 'Folder')).toBe(true);
    expect(doc.root.children.some((c) => c.name === 'Parcels')).toBe(false);
    expect(doc.root.children.map((c) => c.name).sort()).toEqual(['C2', 'R1']);
    expect(doc.placemarksUnder().length).toBe(2);

    // Undo restores the empty, untitled document.
    doc.undo();
    expect(doc.root.name).toBe('Untitled');
    expect(doc.root.children.length).toBe(0);
    expect(serializeKml(doc.data)).not.toContain('nge-cat-');
  });

  it('restyles existing features by a field value, undoably', () => {
    const res = geojsonToFolder(PARCELS, { layerName: 'P', styleMode: 'single' });
    const doc = KmlDocument.empty();
    doc.importAsRoot(res.folder, res.styles);

    // Field discovery from the imported ExtendedData.
    expect(doc.attributeFieldNames([doc.root.id])).toContain('ZONE');
    const values = doc.distinctFieldValues([doc.root.id], 'ZONE');
    expect(values.sort()).toEqual(['C2', 'R1']);

    const before = doc.placemarksUnder().map((p) => p.styleUrl);
    expect(new Set(before).size).toBe(1); // single import style shared by all

    const specs = defaultCategories(values, { ramp: 'category' });
    const n = doc.restyleByField([doc.root.id], 'ZONE', specs, 3);
    expect(n).toBe(2);

    const after = doc.placemarksUnder();
    expect(new Set(after.map((p) => p.styleUrl)).size).toBe(2); // one style per ZONE
    expect(after.every((p) => p.styleUrl?.startsWith('#nge-cat-'))).toBe(true);
    // Line width threaded through into the generated styles.
    const styleId = after[0].styleUrl!.slice(1);
    expect(doc.data.sharedStyles.get(styleId)?.line?.width).toBe(3);

    // Undo restores the original single-style pointers.
    doc.undo();
    expect(doc.placemarksUnder().map((p) => p.styleUrl)).toEqual(before);
    expect(serializeKml(doc.data)).not.toContain('nge-cat-');
  });
});
