import { describe, it, expect } from 'vitest';
import { InstanceShow, type InstanceShowTarget } from '@renderer/globe/instanceShow';

/** A batched primitive stand-in: attributes exist only once it is ready. */
class FakePrimitive implements InstanceShowTarget {
  ready = false;
  private readonly attrs = new Map<string, { show: Uint8Array }>();

  constructor(ids: string[]) {
    for (const id of ids) this.attrs.set(id, { show: new Uint8Array([1]) });
  }

  getGeometryInstanceAttributes(id: string): { show: Uint8Array } | undefined {
    if (!this.ready) throw new Error('not ready'); // as Cesium's DeveloperError
    return this.attrs.get(id);
  }

  shown(id: string): boolean {
    return this.attrs.get(id)!.show[0] === 1;
  }
}

describe('InstanceShow', () => {
  it('applies at once to a ready primitive', () => {
    const prim = new FakePrimitive(['a']);
    prim.ready = true;
    new InstanceShow().set(prim, 'a', false);
    expect(prim.shown('a')).toBe(false);
  });

  it('holds a change made while building and applies it once ready', () => {
    const show = new InstanceShow();
    const prim = new FakePrimitive(['a', 'b']);
    show.set(prim, 'a', false);
    show.flush(); // still building: nothing to do yet
    prim.ready = true;
    expect(prim.shown('a')).toBe(true);
    show.flush();
    expect(prim.shown('a')).toBe(false);
    expect(prim.shown('b')).toBe(true);
  });

  it('keeps only the latest change per instance', () => {
    const show = new InstanceShow();
    const prim = new FakePrimitive(['a']);
    show.set(prim, 'a', false);
    show.set(prim, 'a', true);
    show.set(prim, 'a', false);
    prim.ready = true;
    show.flush();
    expect(prim.shown('a')).toBe(false);
  });

  it('flushes each primitive when it, not another, is ready', () => {
    const show = new InstanceShow();
    const early = new FakePrimitive(['a']);
    const late = new FakePrimitive(['b']);
    show.set(early, 'a', false);
    show.set(late, 'b', false);
    early.ready = true;
    show.flush();
    expect(early.shown('a')).toBe(false);
    late.ready = true;
    show.flush();
    expect(late.shown('b')).toBe(false);
  });
});
