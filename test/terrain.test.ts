import { describe, it, expect } from 'vitest';
import { decodeTerrarium, repairVoids } from '@shared/terrain';

/** Build a w×w grid from a function of (x, y). */
function grid(w: number, f: (x: number, y: number) => number): Float32Array {
  const a = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) a[y * w + x] = f(x, y);
  return a;
}

describe('Terrarium decoding', () => {
  it('decodes the documented formula', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(128, 100, 0)).toBe(100);
    expect(decodeTerrarium(127, 156, 0)).toBe(-100);
  });

  it('decodes an all-zero pixel to the void sentinel', () => {
    // RGB(0,0,0) is how the source marks "no data", not an elevation.
    expect(decodeTerrarium(0, 0, 0)).toBe(-32768);
  });
});

describe('void repair', () => {
  it('leaves a clean tile untouched', () => {
    const h = grid(16, (x, y) => x + y);
    const before = Float32Array.from(h);
    expect(repairVoids(h, 16)).toBe(0);
    expect(Array.from(h)).toEqual(Array.from(before));
  });

  it('replaces the sentinel with surrounding terrain', () => {
    const h = grid(16, () => 100);
    h[5 * 16 + 5] = -32768;
    expect(repairVoids(h, 16)).toBeGreaterThan(0);
    expect(h[5 * 16 + 5]).toBeCloseTo(100, 5);
    // Nothing anywhere is left below what could physically be an elevation.
    expect(Math.min(...h)).toBeGreaterThan(-11000);
  });

  it('also swallows the skirt of half-resampled values around a void', () => {
    // The real failure: a void ramps up through nonsense depths into good data.
    const h = grid(16, () => 50);
    h[8 * 16 + 8] = -32768;
    h[8 * 16 + 7] = -20000; // physically impossible, adjacent to the void
    h[8 * 16 + 9] = -3000; // possible in principle, but touching the void
    repairVoids(h, 16);
    expect(h[8 * 16 + 8]).toBeCloseTo(50, 5);
    expect(h[8 * 16 + 7]).toBeCloseTo(50, 5);
    expect(h[8 * 16 + 9]).toBeCloseTo(50, 5);
  });

  it('keeps genuinely deep water when a void sits in it', () => {
    // A void in the abyss must not flood the whole tile up to sea level.
    const h = grid(16, () => -4000);
    h[8 * 16 + 8] = -32768;
    repairVoids(h, 16);
    expect(h[8 * 16 + 8]).toBeCloseTo(-4000, 5);
    expect(Math.max(...h)).toBeCloseTo(-4000, 5);
  });

  it('levels a tile that is nothing but void', () => {
    const h = grid(8, () => -32768);
    repairVoids(h, 8);
    expect(Array.from(h).every((v) => v === 0)).toBe(true);
  });

  it('repairs a void touching the tile edge', () => {
    const h = grid(16, () => 25);
    h[0] = -32768;
    h[15] = -32768;
    h[15 * 16 + 15] = -32768;
    repairVoids(h, 16);
    expect(h[0]).toBeCloseTo(25, 5);
    expect(h[15]).toBeCloseTo(25, 5);
    expect(h[15 * 16 + 15]).toBeCloseTo(25, 5);
  });
});

describe('gradient-seeded void repair (no sentinel present)', () => {
  it('fills a garbage gouge cut into a cliff coast', () => {
    // Measured off South Kona (tile 15/2194/14595): -3800..-5073 directly
    // against a +150 m cliff top, with not one pixel at the -32768 sentinel.
    const h = grid(16, () => 150);
    h[8 * 16 + 8] = -5000;
    h[8 * 16 + 9] = -3800;
    h[8 * 16 + 10] = -800; // ramp of the same gouge, floods via suspect depth
    expect(repairVoids(h, 16)).toBeGreaterThan(0);
    expect(Math.min(...h)).toBeGreaterThan(-500);
    expect(h[8 * 16 + 8]).toBeCloseTo(150, 3);
  });

  it('leaves a coherent coarse-bathymetry plate alone', () => {
    // A constant negative plate against land is wrong-but-smooth source data:
    // its interior has no gradient and its shore edge is far below the bar.
    const h = grid(16, (x) => (x < 8 ? 50 : -153));
    expect(repairVoids(h, 16)).toBe(0);
  });

  it('leaves a genuinely steep real coast alone', () => {
    // +200 m cliff straight into -300 m water: sharp, but physically possible
    // and below both the suspect depth's gradient trigger and the sentinel.
    const h = grid(16, (x) => (x < 8 ? 200 : -300));
    expect(repairVoids(h, 16)).toBe(0);
  });

  it('leaves smooth deep bathymetry alone', () => {
    const h = grid(16, (x, y) => -1200 - 40 * x - 25 * y);
    expect(repairVoids(h, 16)).toBe(0);
  });
});

describe('structural void repair (exact-constant regions)', () => {
  it('removes a floating constant slab (the South Kona "arch")', () => {
    // Measured in tile 15/2195/14589: a patch of exactly 187 m against ground
    // of 1..60 m — rendered as a freestanding wall ~130 m above the terrain.
    const h = grid(16, (x, y) => 40 + x + y);
    for (let y = 4; y <= 7; y++) for (let x = 4; x <= 9; x++) h[y * 16 + x] = 187;
    expect(repairVoids(h, 16)).toBeGreaterThan(0);
    expect(Math.max(...h)).toBeLessThan(80); // filled back to local ground
  });

  it('preserves a lake: constant, but its shores are not below it', () => {
    // A flat 250 m surface set into 260 m ground — constant like the slab, but
    // nothing around it is lower, which is what makes it a lake.
    const h = grid(16, () => 260);
    for (let y = 5; y <= 10; y++) for (let x = 5; x <= 10; x++) h[y * 16 + x] = 250;
    expect(repairVoids(h, 16)).toBe(0);
  });

  it('removes exact-zero pinprick pits punched into high ground', () => {
    // Measured in tile 14/1097/7294: isolated 0 m pixels inside smooth
    // 40..55 m terrain — rendered as 50 m black pits.
    const h = grid(16, (x, y) => 40 + x + y);
    h[5 * 16 + 5] = 0;
    h[9 * 16 + 10] = 0;
    h[9 * 16 + 11] = 0;
    expect(repairVoids(h, 16)).toBe(3);
    expect(Math.min(...h)).toBeGreaterThan(30);
  });

  it('preserves a real beach zero that touches low ground', () => {
    const h = grid(16, (x) => Math.max(0, (x - 8) * 10)); // sea-level flat, then rising
    expect(repairVoids(h, 16)).toBe(0);
  });

  it('does not let garbage pits condemn the flat plain around them', () => {
    // A dead-constant 40 m plain full of 0-pits: the pits are voids, but the
    // plain must not be judged "floating" on the testimony of its own voids.
    const h = grid(16, () => 40);
    h[5 * 16 + 5] = 0;
    h[10 * 16 + 10] = 0;
    repairVoids(h, 16);
    expect(h[5 * 16 + 5]).toBeCloseTo(40, 3);
    expect(h[0]).toBe(40); // the plain itself untouched
  });
});
