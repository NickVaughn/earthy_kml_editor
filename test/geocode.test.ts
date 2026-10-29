import { describe, it, expect } from 'vitest';
import { MIN_SPAN_DEG, padBounds, parseNominatim, parsePelias } from '@shared/geocode';

describe('padBounds', () => {
  it('leaves a large box alone', () => {
    expect(padBounds([-112.5, 34.9, -111.4, 35.6])).toEqual([-112.5, 34.9, -111.4, 35.6]);
  });
  it('widens a point to the minimum span about its centre', () => {
    const [w, s, e, n] = padBounds([-111.65, 35.2, -111.65, 35.2]);
    expect(e - w).toBeCloseTo(MIN_SPAN_DEG);
    expect(n - s).toBeCloseTo(MIN_SPAN_DEG);
    expect((w + e) / 2).toBeCloseTo(-111.65);
    expect((s + n) / 2).toBeCloseTo(35.2);
  });
  it('clamps latitude at the poles', () => {
    const [, s, , n] = padBounds([0, 89.995, 0, 89.995]);
    expect(n).toBe(90);
    expect(s).toBeCloseTo(89.985);
  });
});

describe('parseNominatim', () => {
  it('reads jsonv2 items, reordering the bounding box to W,S,E,N', () => {
    const r = parseNominatim([
      {
        display_name: 'Flagstaff, Coconino County, Arizona, United States',
        boundingbox: ['35.1', '35.3', '-111.8', '-111.5'],
        lat: '35.2',
        lon: '-111.65',
      },
    ]);
    expect(r).toEqual([
      {
        label: 'Flagstaff, Coconino County, Arizona, United States',
        bounds: [-111.8, 35.1, -111.5, 35.3],
      },
    ]);
  });
  it('falls back to lat/lon when the box is missing, and pads it', () => {
    const r = parseNominatim([{ display_name: 'Somewhere', lat: '10', lon: '20' }]);
    expect(r).toHaveLength(1);
    const [w, s, e, n] = r[0].bounds;
    expect(e - w).toBeCloseTo(MIN_SPAN_DEG);
    expect(n - s).toBeCloseTo(MIN_SPAN_DEG);
  });
  it('drops items with no usable location or name', () => {
    expect(parseNominatim([{ display_name: 'x' }, { lat: '1', lon: '2' }, null, 'junk'])).toEqual(
      [],
    );
    expect(parseNominatim({ not: 'an array' })).toEqual([]);
  });
});

describe('parsePelias', () => {
  it('reads a FeatureCollection with bbox', () => {
    const r = parsePelias({
      features: [
        {
          type: 'Feature',
          bbox: [-111.8, 35.1, -111.5, 35.3],
          geometry: { type: 'Point', coordinates: [-111.65, 35.2] },
          properties: { label: 'Flagstaff, AZ, USA', name: 'Flagstaff' },
        },
      ],
    });
    expect(r).toEqual([{ label: 'Flagstaff, AZ, USA', bounds: [-111.8, 35.1, -111.5, 35.3] }]);
  });
  it('uses the point geometry and name when bbox and label are missing', () => {
    const r = parsePelias({
      features: [
        { geometry: { type: 'Point', coordinates: [20, 10] }, properties: { name: 'Pt' } },
      ],
    });
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe('Pt');
    expect((r[0].bounds[0] + r[0].bounds[2]) / 2).toBeCloseTo(20);
  });
  it('tolerates garbage', () => {
    expect(parsePelias(null)).toEqual([]);
    expect(parsePelias({ features: [{}, null] })).toEqual([]);
  });
});
