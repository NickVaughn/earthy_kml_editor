import { describe, it, expect } from 'vitest';
import {
  kmlToRgba,
  rgbaToKml,
  kmlToHexRgb,
  hexRgbToKml,
  kmlToCss,
} from '@renderer/model/colors';

describe('KML color (aabbggrr) conversion', () => {
  it('parses opaque red (ff0000ff)', () => {
    // aa=ff bb=00 gg=00 rr=ff  => red, opaque
    expect(kmlToRgba('ff0000ff')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('parses half-transparent blue (7fff0000)', () => {
    // aa=7f bb=ff gg=00 rr=00 => blue, ~50% alpha
    expect(kmlToRgba('7fff0000')).toEqual({ r: 0, g: 0, b: 255, a: 127 });
  });

  it('round-trips rgba -> kml -> rgba', () => {
    const c = { r: 12, g: 34, b: 56, a: 200 };
    expect(kmlToRgba(rgbaToKml(c))).toEqual(c);
  });

  it('is a fixed point kml -> rgba -> kml', () => {
    for (const s of ['ff0000ff', '00ffffff', '7f3c1a90', 'abcdef01']) {
      expect(rgbaToKml(kmlToRgba(s))).toBe(s);
    }
  });

  it('converts to #rrggbb for color inputs', () => {
    expect(kmlToHexRgb('ff0000ff')).toBe('#ff0000');
    expect(kmlToHexRgb('ffff8800')).toBe('#0088ff');
  });

  it('combines hex + alpha back to kml', () => {
    expect(hexRgbToKml('#ff0000', 1)).toBe('ff0000ff');
    // 0.5 * 255 = 127.5, which rounds to 128 (0x80).
    expect(hexRgbToKml('#0088ff', 0.5)).toBe('80ff8800');
  });

  it('produces css rgba', () => {
    expect(kmlToCss('ff0000ff')).toBe('rgba(255, 0, 0, 1.000)');
  });

  it('falls back to white on malformed input', () => {
    expect(kmlToRgba('nope')).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });
});
