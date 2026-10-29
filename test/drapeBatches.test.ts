import { describe, it, expect } from 'vitest';
import { Rectangle } from 'cesium';
import { DrapeBatcher } from '@renderer/globe/drapeBatches';

const rect = (w: number, s: number, e: number, n: number): Rectangle =>
  Rectangle.fromDegrees(w, s, e, n);

describe('DrapeBatcher', () => {
  it('shares a batch between fills whose rectangles do not touch', () => {
    const b = new DrapeBatcher<string>(1000);
    b.add('a', 'a', rect(0, 0, 1, 1), 4);
    b.add('b', 'b', rect(2, 2, 3, 3), 4);
    expect(b.batches).toEqual([{ items: ['a', 'b'], vertices: 8 }]);
  });

  it('splits overlapping fills into separate batches', () => {
    const b = new DrapeBatcher<string>(1000);
    b.add('green', 'g', rect(0, 0, 2, 2), 10);
    b.add('white', 'w', rect(1, 1, 3, 3), 5); // overlaps green
    b.add('red', 'r', rect(2.5, 0, 4, 0.5), 6); // overlaps neither
    b.add('other', 'o', rect(1.5, 1.5, 1.8, 1.8), 4); // inside both
    expect(b.batches.map((x) => x.items)).toEqual([
      ['green', 'red'],
      ['white'],
      ['other'],
    ]);
  });

  it('treats touching rectangles as overlapping (shared edge)', () => {
    const b = new DrapeBatcher<string>(1000);
    b.add('a', 'a', rect(0, 0, 1, 1), 4);
    b.add('b', 'b', rect(1, 0, 2, 1), 4);
    expect(b.batches.length).toBe(2);
  });

  it('opens a new batch when the vertex cap would be exceeded', () => {
    const b = new DrapeBatcher<string>(10);
    b.add('a', 'a', rect(0, 0, 1, 1), 6);
    b.add('b', 'b', rect(2, 2, 3, 3), 6); // disjoint, but 12 > 10
    b.add('c', 'c', rect(4, 4, 5, 5), 4); // fits the first batch again
    expect(b.batches.map((x) => x.items)).toEqual([['a', 'c'], ['b']]);
  });
});
