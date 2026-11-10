import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@renderer/state/store';
import { serializeKml } from '@renderer/model/serialize';
import { fixture } from './helpers';

const EMPTY_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Target</name>
  <Folder><name>Bucket</name></Folder>
</Document></kml>`;

function openTwo() {
  const s = useStore.getState();
  s.openDoc({ path: '/a.kml', kml: fixture('simple.kml'), resources: {}, wasKmz: false });
  s.openDoc({ path: '/b.kml', kml: EMPTY_KML, resources: {}, wasKmz: false });
  const [docA, docB] = useStore.getState().docs;
  return { docA, docB };
}

describe('cross-document drag', () => {
  beforeEach(() => {
    useStore.setState({ docs: [], activeDocId: null, selection: [] });
  });

  it('moves a feature from one document into another', () => {
    const { docA, docB } = openTwo();
    const line = docA.placemarksUnder().find((p) => p.name === 'A line')!;
    const beforeA = docA.stats().features;

    useStore.getState().move([line.id], docB.root.id, 0);

    // Gone from the source, present in the target (as a fresh node).
    expect(docA.placemarksUnder().some((p) => p.name === 'A line')).toBe(false);
    expect(docA.stats().features).toBe(beforeA - 1);
    const moved = docB.placemarksUnder().find((p) => p.name === 'A line');
    expect(moved).toBeTruthy();
    expect(moved!.id).not.toBe(line.id);
  });

  it('carries the referenced shared style into the target document', () => {
    const { docA, docB } = openTwo();
    const line = docA.placemarksUnder().find((p) => p.name === 'A line')!;
    expect(line.styleUrl).toBe('#redLine');
    expect(docB.data.sharedStyles.has('redLine')).toBe(false);

    useStore.getState().move([line.id], docB.root.id, 0);

    // The style came along, so the feature still resolves its styling.
    expect(docB.data.sharedStyles.has('redLine')).toBe(true);
    const moved = docB.placemarksUnder().find((p) => p.name === 'A line')!;
    expect(docB.styleFor(moved).line?.color).toBe('ff0000ff');
    // And it serializes into the target file.
    expect(serializeKml(docB.data)).toContain('id="redLine"');
  });

  it('undoes a cross-document move as a single step', () => {
    const { docA, docB } = openTwo();
    const line = docA.placemarksUnder().find((p) => p.name === 'A line')!;
    const parentBefore = docA.parentOf(line.id)!.id;

    useStore.getState().move([line.id], docB.root.id, 0);
    expect(docB.placemarksUnder().some((p) => p.name === 'A line')).toBe(true);

    // The compound entry lives on the target document.
    expect(docB.canUndo).toBe(true);
    docB.undo();

    expect(docB.placemarksUnder().some((p) => p.name === 'A line')).toBe(false);
    const restored = docA.placemarksUnder().find((p) => p.name === 'A line');
    expect(restored).toBeTruthy();
    expect(docA.parentOf(restored!.id)!.id).toBe(parentBefore);
  });

  it('redo re-applies the transfer', () => {
    const { docA, docB } = openTwo();
    const line = docA.placemarksUnder().find((p) => p.name === 'A line')!;
    useStore.getState().move([line.id], docB.root.id, 0);
    docB.undo();
    docB.redo();
    expect(docB.placemarksUnder().some((p) => p.name === 'A line')).toBe(true);
    expect(docA.placemarksUnder().some((p) => p.name === 'A line')).toBe(false);
  });

  it('moves multiple features and marks the source dirty', () => {
    const { docA, docB } = openTwo();
    const ids = docA.placemarksUnder().map((p) => p.id);
    useStore.getState().move(ids, docB.root.id, 0);
    expect(docA.stats().features).toBe(0);
    expect(docB.stats().features).toBe(ids.length);
    expect(docA.dirty).toBe(true);
    expect(docB.dirty).toBe(true);
  });

  it('still moves normally within a single document', () => {
    const { docA } = openTwo();
    const folders = [...docA.walk()].filter((n) => n.type === 'Folder');
    const shapes = folders.find((f) => f.name === 'Shapes')!;
    const origin = docA.placemarksUnder().find((p) => p.name === 'Origin')!;
    useStore.getState().move([origin.id], shapes.id, 0);
    expect(shapes.children[0].name).toBe('Origin');
  });
});

describe('file reordering', () => {
  beforeEach(() => {
    useStore.setState({ docs: [], activeDocId: null, selection: [] });
  });

  function openThree() {
    const s = useStore.getState();
    for (const path of ['/a.kml', '/b.kml', '/c.kml']) {
      s.openDoc({ path, kml: EMPTY_KML, resources: {}, wasKmz: false });
    }
    return useStore.getState().docs;
  }
  const paths = (): (string | null)[] => useStore.getState().docs.map((d) => d.path);

  it('moves files to the drop slot, counting the dragged rows', () => {
    const [a, , c] = openThree();
    useStore.getState().reorderDocs([a.root.id], 2); // between b and c
    expect(paths()).toEqual(['/b.kml', '/a.kml', '/c.kml']);
    useStore.getState().reorderDocs([c.root.id], 0);
    expect(paths()).toEqual(['/c.kml', '/b.kml', '/a.kml']);
    // Several at once keep their list order, wherever they were picked from.
    useStore.getState().reorderDocs([a.root.id, c.root.id], 3);
    expect(paths()).toEqual(['/b.kml', '/c.kml', '/a.kml']);
  });

  it('redraws without dirtying files or reframing the camera', () => {
    const [a] = openThree();
    const before = useStore.getState();
    useStore.getState().reorderDocs([a.root.id], 3);
    const after = useStore.getState();
    expect(after.sceneEpoch).toBe(before.sceneEpoch + 1);
    expect(after.docEpoch).toBe(before.docEpoch);
    expect(after.dirty).toBe(false);
    expect(after.docs.some((d) => d.dirty)).toBe(false);
    expect(after.selection).toEqual([a.root.id]);
  });

  it('does nothing when the order would not change', () => {
    const [a] = openThree();
    const before = useStore.getState();
    useStore.getState().reorderDocs([a.root.id], 1); // just below itself
    expect(useStore.getState().docs).toBe(before.docs);
    expect(useStore.getState().sceneEpoch).toBe(before.sceneEpoch);
  });
});
