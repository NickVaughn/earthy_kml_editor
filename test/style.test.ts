import { describe, it, expect } from 'vitest';
import { parseKml } from '@renderer/model/parse';
import { KmlDocument } from '@renderer/model/document';
import { effectiveStyle } from '@renderer/model/style';
import { fixture } from './helpers';

describe('style resolver', () => {
  const doc = parseKml(fixture('styles-torture.kml'));

  function placemark(name: string) {
    const model = new KmlDocument(doc);
    return model.placemarksUnder().find((p) => p.name === name)!;
  }

  it('resolves a StyleMap to its normal pair', () => {
    const p = placemark('Mapped point');
    const s = effectiveStyle(doc, p);
    expect(s.icon?.color).toBe('ff00ff00'); // green normalPoint
    expect(s.icon?.scale).toBe(1.2);
  });

  it('lets inline style override the shared style per property', () => {
    const p = placemark('Inline override');
    const s = effectiveStyle(doc, p);
    expect(s.icon?.scale).toBe(2.0); // inline wins
    expect(s.icon?.color).toBe('ff00ff00'); // inherited from normalPoint
  });

  it('returns empty style for dangling styleUrl', () => {
    const p = placemark('Dangling styleUrl');
    const s = effectiveStyle(doc, p);
    expect(s.icon).toBeUndefined();
    expect(s.line).toBeUndefined();
  });

  it('resolves shared line/poly style from simple.kml', () => {
    const simple = parseKml(fixture('simple.kml'));
    const model = new KmlDocument(simple);
    const line = model.placemarksUnder().find((p) => p.name === 'A line')!;
    const s = effectiveStyle(simple, line);
    expect(s.line?.color).toBe('ff0000ff');
    expect(s.line?.width).toBe(3);
    expect(s.poly?.color).toBe('7f0000ff');
  });
});
