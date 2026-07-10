import { describe, it, expect } from 'vitest';
import { KmlDocument } from '@renderer/model/document';
import { parseKml } from '@renderer/model/parse';
import { serializeKml } from '@renderer/model/serialize';
import { fixture, generatePolygonKml } from './helpers';

function load(name: string): KmlDocument {
  return KmlDocument.fromKml(fixture(name));
}

describe('structural mutations', () => {
  it('creates a folder and undoes it', () => {
    const doc = load('simple.kml');
    const before = doc.stats().folders;
    const folder = doc.createFolder(doc.root.id, 0, 'Fresh')!;
    expect(folder).toBeTruthy();
    expect(doc.nodeById(folder.id)).toBeTruthy();
    expect(doc.stats().folders).toBe(before + 1);
    doc.undo();
    expect(doc.nodeById(folder.id)).toBeUndefined();
    expect(doc.stats().folders).toBe(before);
  });

  it('renames with undo/redo', () => {
    const doc = load('simple.kml');
    const pt = doc.placemarksUnder().find((p) => p.name === 'Origin')!;
    doc.rename(pt.id, 'Renamed');
    expect(pt.name).toBe('Renamed');
    doc.undo();
    expect(pt.name).toBe('Origin');
    doc.redo();
    expect(pt.name).toBe('Renamed');
  });

  it('moves a placemark between folders and reflects it on save', () => {
    const doc = load('simple.kml');
    const points = doc.walk(doc.root);
    const folders = [...doc.walk()].filter((n) => n.type === 'Folder');
    const shapes = folders.find((f) => f.name === 'Shapes')!;
    const pointsFolder = folders.find((f) => f.name === 'Points')!;
    const origin = doc.placemarksUnder().find((p) => p.name === 'Origin')!;
    void points;

    expect(pointsFolder.children.map((c) => c.name)).toContain('Origin');
    doc.move([origin.id], shapes.id, 0);
    expect(pointsFolder.children.map((c) => c.name)).not.toContain('Origin');
    expect(shapes.children[0].name).toBe('Origin');

    // Round-trips through save.
    const reparsed = parseKml(serializeKml(doc.data));
    const model = new KmlDocument(reparsed);
    const shapes2 = [...model.walk()].find((n) => n.name === 'Shapes')!;
    expect(shapes2.children.map((c) => c.name)).toContain('Origin');
  });

  it('refuses to move a folder into its own descendant', () => {
    const doc = load('simple.kml');
    const shapes = [...doc.walk()].find((n) => n.name === 'Shapes')!;
    const child = shapes.children[0]; // a placemark; use a nested folder instead
    // Make a nested folder to attempt the illegal move.
    const inner = doc.createFolder(shapes.id, 0, 'Inner')!;
    const moved = doc.move([shapes.id], inner.id, 0);
    expect(moved).toEqual([]); // illegal, skipped
    void child;
  });

  it('deletes and undoes, restoring structure', () => {
    const doc = load('simple.kml');
    const poly = doc.placemarksUnder().find((p) => p.name === 'A polygon')!;
    const parent = doc.parentOf(poly.id)!;
    const before = parent.children.length;
    doc.delete([poly.id]);
    expect(doc.nodeById(poly.id)).toBeUndefined();
    doc.undo();
    const parent2 = [...doc.walk()].find((n) => n.name === 'Shapes')!;
    expect(parent2.children.length).toBe(before);
    expect(parent2.children.some((c) => c.name === 'A polygon')).toBe(true);
  });

  it('copy/paste duplicates a subtree with fresh ids', () => {
    const doc = load('simple.kml');
    const shapes = [...doc.walk()].find((n) => n.name === 'Shapes')!;
    doc.copy([shapes.id]);
    const pasted = doc.paste(doc.root.id);
    expect(pasted.length).toBe(1);
    const copy = doc.nodeById(pasted[0])!;
    expect(copy.name).toBe('Shapes');
    expect(copy.id).not.toBe(shapes.id);
    // Two folders named Shapes now.
    expect([...doc.walk()].filter((n) => n.name === 'Shapes').length).toBe(2);
  });
});

describe('bulk style', () => {
  it('patches a shared style in place for a whole folder (one style, no forks)', () => {
    const doc = KmlDocument.fromKml(generatePolygonKml(5000));
    const res = doc.applyStyle([doc.root.id], { poly: { color: 'ff0000ff' } });
    expect(res.patched).toBe(1);
    expect(res.created).toBe(0);

    const out = serializeKml(doc.data);
    // Exactly one <Style … in the document.
    expect((out.match(/<Style\b/g) ?? []).length).toBe(1);
    expect(out).toContain('ff0000ff');
    // The shared style object was updated.
    expect(doc.data.sharedStyles.get('s')?.poly?.color).toBe('ff0000ff');
  });

  it('applies to 5000 features quickly', () => {
    const doc = KmlDocument.fromKml(generatePolygonKml(5000));
    const t0 = performance.now();
    doc.applyStyle([doc.root.id], { poly: { color: 'ff112233' } });
    const ms = performance.now() - t0;
    console.log(`applyStyle 5000: ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(1000);
  });

  it('undo restores the original style', () => {
    const doc = KmlDocument.fromKml(generatePolygonKml(1000));
    const original = doc.data.sharedStyles.get('s')!.poly!.color;
    doc.applyStyle([doc.root.id], { poly: { color: 'ffabcdef' } });
    expect(doc.data.sharedStyles.get('s')!.poly!.color).toBe('ffabcdef');
    doc.undo();
    expect(doc.data.sharedStyles.get('s')!.poly!.color).toBe(original);
  });

  it('forks a new style when only some users are selected', () => {
    // Two folders share style #s; style only one of them.
    const base = generatePolygonKml(4); // 4 polys in one folder, all #s
    const doc = KmlDocument.fromKml(base);
    const grid = [...doc.walk()].find((n) => n.name === 'Grid')!;
    const half = grid.children.slice(0, 2).map((c) => c.id);
    const res = doc.applyStyle(half, { poly: { color: 'ff000000' } });
    expect(res.created).toBe(1);
    expect(res.patched).toBe(0);
    // Now two shared styles exist.
    const out = serializeKml(doc.data);
    expect((out.match(/<Style\b/g) ?? []).length).toBe(2);
    // Undo removes the fork.
    doc.undo();
    const out2 = serializeKml(doc.data);
    expect((out2.match(/<Style\b/g) ?? []).length).toBe(1);
  });

  it('survives an undo/redo/undo cycle without leaking styles', () => {
    const doc = KmlDocument.fromKml(generatePolygonKml(4));
    const grid = [...doc.walk()].find((n) => n.name === 'Grid')!;
    const half = grid.children.slice(0, 2).map((c) => c.id);
    doc.applyStyle(half, { poly: { color: 'ff000000' } });
    doc.undo();
    doc.redo();
    doc.undo();
    const out = serializeKml(doc.data);
    expect((out.match(/<Style\b/g) ?? []).length).toBe(1);
  });
});
