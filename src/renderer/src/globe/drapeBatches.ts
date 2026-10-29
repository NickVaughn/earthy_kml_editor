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
 */
export interface DrapeBatch<T> {
  items: T[];
  vertices: number;
}

export class DrapeBatcher<T> {
  readonly batches: DrapeBatch<T>[] = [];
  private readonly checkers: RectangleCollisionChecker[] = [];

  constructor(private readonly vertexCap: number) {}

  /** Place one instance in the first batch it fits — by vertices and by not
   *  touching any rectangle already there — or open a new one. */
  add(item: T, id: string, rectangle: Rectangle, vertices: number): void {
    for (let i = 0; i < this.batches.length; i++) {
      const batch = this.batches[i];
      if (batch.vertices + vertices > this.vertexCap) continue;
      if (this.checkers[i].collides(rectangle)) continue;
      batch.items.push(item);
      batch.vertices += vertices;
      this.checkers[i].insert(id, rectangle);
      return;
    }
    const checker = new RectangleCollisionChecker();
    checker.insert(id, rectangle);
    this.checkers.push(checker);
    this.batches.push({ items: [item], vertices });
  }
}
