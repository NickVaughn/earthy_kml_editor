import { Rectangle, RectangleCollisionChecker } from 'cesium';

// Cesium ships RectangleCollisionChecker (an rbush wrapper) from its index but
// marks it @private, so it is missing from the type declarations.
declare module 'cesium' {
  class RectangleCollisionChecker {
    constructor();
    insert(id: string, rectangle: Rectangle): void;
    remove(id: string, rectangle: Rectangle): void;
    collides(rectangle: Rectangle): boolean;
  }
}

/**
 * Overlap-aware batching for draped polygon fills.
 *
 * A GroundPrimitive classifies every instance it holds in one stencil pass and
 * one colour pass. The colour pass draws wherever the stencil is non-zero and
 * zeroes it as it goes (ClassificationPrimitive's getColorRenderState), so at a
 * pixel covered by two instances of the same primitive only the FIRST fragment
 * rasterised paints: there is no alpha blending between them, and the winner is
 * whichever instance's shadow volume reaches the pixel first — its footprint
 * from straight above, but its side walls once the camera tilts, so the
 * boundary between two fills wanders with the view and one spills past its own
 * outline. Cesium's entity layer avoids all of this by never batching instances
 * whose bounding rectangles intersect (StaticGroundGeometryColorBatch), and so
 * does this: instances go first-fit into batches of pairwise disjoint
 * rectangles, each batch its own primitive. Separate primitives classify in
 * turn, so where they overlap they blend like any translucent geometry.
 *
 * Batches also respect a vertex cap, for the same reason the plain chunking
 * does (see DRAPE_FILL_CHUNK_VERTICES in scene.ts).
 *
 * Batches draw in order, so first-fit alone decides which of two overlapping
 * fills ends up on top. Groups (one per open file) pin that down where it
 * matters: an instance never goes into a batch at or before the last one
 * holding an overlapping instance from an earlier group, so a later file
 * always paints over an earlier one. Within a group, placement is first-fit as
 * before — strict order there would give a chain of touching polygons (any
 * habitat map) a batch apiece.
 */
export interface DrapeBatch<T> {
  items: T[];
  vertices: number;
}

/** One group's share of a batch, with its own index for the overlap test. */
interface Segment {
  group: number;
  checker: RectangleCollisionChecker;
}

export class DrapeBatcher<T> {
  readonly batches: DrapeBatch<T>[] = [];
  private readonly segments: Segment[][] = [];
  private group = 0;

  constructor(private readonly vertexCap: number) {}

  /** Start the next group: what is added from now on draws over what came before. */
  nextGroup(): void {
    this.group++;
  }

  /** Place one instance in the first batch it fits — by vertices and by not
   *  touching any rectangle already there — after every batch with an
   *  overlapping instance from an earlier group, or open a new one. */
  add(item: T, id: string, rectangle: Rectangle, vertices: number): void {
    let floor = 0;
    for (let i = this.batches.length - 1; i >= 0; i--) {
      if (this.segments[i].some((s) => s.group < this.group && s.checker.collides(rectangle))) {
        floor = i + 1;
        break;
      }
    }
    for (let i = floor; i < this.batches.length; i++) {
      const batch = this.batches[i];
      if (batch.vertices + vertices > this.vertexCap) continue;
      if (this.segments[i].some((s) => s.checker.collides(rectangle))) continue;
      batch.items.push(item);
      batch.vertices += vertices;
      this.insert(i, id, rectangle);
      return;
    }
    this.segments.push([]);
    this.batches.push({ items: [item], vertices });
    this.insert(this.batches.length - 1, id, rectangle);
  }

  private insert(batch: number, id: string, rectangle: Rectangle): void {
    const segs = this.segments[batch];
    let seg = segs[segs.length - 1];
    if (seg?.group !== this.group) {
      seg = { group: this.group, checker: new RectangleCollisionChecker() };
      segs.push(seg);
    }
    seg.checker.insert(id, rectangle);
  }
}
