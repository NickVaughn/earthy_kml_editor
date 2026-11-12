import { describe, it, expect } from 'vitest';
import { LABEL_SOURCES, effectiveLabelSource, labelSourceLabel } from '@shared/labels';

describe('effectiveLabelSource', () => {
  it('keeps ion when a token is configured', () => {
    expect(effectiveLabelSource('ion', true)).toBe('ion');
  });
  it('falls back to Esri without a token', () => {
    expect(effectiveLabelSource('ion', false)).toBe('esri');
  });
  it('keeps Esri either way', () => {
    expect(effectiveLabelSource('esri', true)).toBe('esri');
    expect(effectiveLabelSource('esri', false)).toBe('esri');
  });
  it('falls back to Esri for an unknown stored id', () => {
    expect(effectiveLabelSource('bing' as never, true)).toBe('esri');
  });
});

describe('LABEL_SOURCES', () => {
  it('has a keyless source to fall back to', () => {
    expect(LABEL_SOURCES.find((s) => s.id === 'esri')?.needsIonKey).toBe(false);
  });
  it('labels each source', () => {
    for (const s of LABEL_SOURCES) expect(labelSourceLabel(s.id)).toBe(s.label);
  });
});
