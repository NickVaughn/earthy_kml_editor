import { describe, it, expect } from 'vitest';
import { iconUrl } from '@renderer/model/overlays';

describe('point icon URL resolution', () => {
  const none: Record<string, string> = {};

  it('upgrades http to https (the app CSP allows https:, not http:)', () => {
    // Google Earth writes KML icon hrefs over plain http; without the upgrade
    // the CSP blocks them and the markers silently never appear.
    expect(iconUrl(none, 'http://maps.google.com/mapfiles/kml/paddle/grn-diamond.png')).toBe(
      'https://maps.google.com/mapfiles/kml/paddle/grn-diamond.png',
    );
  });

  it('upgrades a mixed-case scheme too', () => {
    expect(iconUrl(none, 'HTTP://example.com/pin.png')).toBe('https://example.com/pin.png');
  });

  it('leaves https, data and blob URLs alone', () => {
    expect(iconUrl(none, 'https://example.com/pin.png')).toBe('https://example.com/pin.png');
    expect(iconUrl(none, 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(iconUrl(none, 'blob:abc-123')).toBe('blob:abc-123');
  });

  it('prefers a KMZ-embedded resource over the raw href', () => {
    const resources = { 'files/pin.png': 'data:image/png;base64,EMBEDDED' };
    expect(iconUrl(resources, 'files/pin.png')).toBe('data:image/png;base64,EMBEDDED');
  });

  it('resolves an embedded resource even when the href looks remote', () => {
    const resources = { 'http://example.com/pin.png': 'data:image/png;base64,EMBEDDED' };
    expect(iconUrl(resources, 'http://example.com/pin.png')).toBe('data:image/png;base64,EMBEDDED');
  });

  it('returns null for a bare relative path, so the caller can draw a dot', () => {
    expect(iconUrl(none, 'files/pin.png')).toBeNull();
    expect(iconUrl(none, '../icons/pin.png')).toBeNull();
  });
});
