import { ShowGeometryInstanceAttribute } from 'cesium';

/** The part of a batched Cesium primitive that per-instance show/hide uses. */
export interface InstanceShowTarget {
  readonly ready: boolean;
  getGeometryInstanceAttributes(id: string): { show?: Uint8Array } | undefined;
}

/**
 * Show/hide for single instances inside batched primitives.
 *
 * Large batches build in web workers, and until a primitive is ready its
 * per-instance attributes do not exist. A change made in that window is held
 * here and applied by `flush()` once the primitive is ready. Dropping it would
 * leave those features drawn as they were built: a file unchecked while its
 * scene was still building (just opened, edited or reordered) stayed partly
 * on the globe, one batch-shaped patch per primitive that was not ready yet.
 */
export class InstanceShow {
  private readonly pending = new Map<InstanceShowTarget, Map<string, boolean>>();

  set(prim: InstanceShowTarget, id: string, show: boolean): void {
    if (prim.ready) {
      apply(prim, id, show);
      return;
    }
    let changes = this.pending.get(prim);
    if (!changes) this.pending.set(prim, (changes = new Map()));
    changes.set(id, show); // the latest change wins
  }

  /** Apply held changes to the primitives that have become ready since. */
  flush(): void {
    for (const [prim, changes] of this.pending) {
      if (!prim.ready) continue;
      for (const [id, show] of changes) apply(prim, id, show);
      this.pending.delete(prim);
    }
  }
}

/**
 * Instance ids for batched geometry, one per part.
 *
 * Cesium finds an instance's attributes by scanning for its id and stopping at
 * the first match, then caches that by id, so instances sharing an id in one
 * primitive all answer to the first. A multi-part placemark (MultiGeometry)
 * makes one instance per part, and parts that do not overlap share a batch:
 * hiding the placemark hid one part and left the rest drawn. So the first part
 * keeps the node id and the others get `<node id>~<n>`; `nodeIdOf` maps any of
 * them back, for picks. (Node ids are `n` plus base-36 digits, never `~`.)
 */
export function instanceIds(): (nodeId: string) => string {
  const parts = new Map<string, number>();
  return (nodeId) => {
    const n = parts.get(nodeId) ?? 0;
    parts.set(nodeId, n + 1);
    return n === 0 ? nodeId : `${nodeId}~${n}`;
  };
}

/** The node an instance id from `instanceIds` belongs to. */
export function nodeIdOf(instanceId: string): string {
  const i = instanceId.indexOf('~');
  return i < 0 ? instanceId : instanceId.slice(0, i);
}

function apply(prim: InstanceShowTarget, id: string, show: boolean): void {
  const attr = prim.getGeometryInstanceAttributes(id);
  if (attr) attr.show = ShowGeometryInstanceAttribute.toValue(show, attr.show);
}
