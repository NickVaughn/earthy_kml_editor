import { describe, it, expect } from 'vitest';
import {
  presetFileText,
  parsePresetFile,
  validPreset,
  presetConflicts,
  mergePresets,
} from '@shared/presetFile';
import { POINT_ICONS } from '@shared/icons';
import type { StylePreset } from '@shared/stylePresets';

function preset(over: Partial<StylePreset> = {}): StylePreset {
  return {
    name: 'Land cover',
    field: 'class',
    ramp: 'category',
    rampReversed: false,
    fillMode: 'both',
    fillOpacity: 0.5,
    lineOpacity: 1,
    lineWidth: 2,
    categories: [
      { value: 'forest', label: 'Forest', color: '#228b22', fillMode: 'fill', fillOpacity: 0.7, lineOpacity: 1 },
    ],
    ...over,
  };
}

const fileWith = (presets: unknown[]): string =>
  JSON.stringify({ format: 'earthy-style-presets', version: 1, presets });

describe('preset files', () => {
  it('round-trips presets through the file text', () => {
    const presets = [preset(), preset({ name: 'Other', labelScale: 1.5, iconHref: POINT_ICONS[0].href })];
    expect(parsePresetFile(presetFileText(presets))).toEqual({ presets, skipped: 0 });
  });

  it('rejects files that are not preset files, with a readable reason', () => {
    expect(() => parsePresetFile('not json')).toThrow('not valid JSON');
    expect(() => parsePresetFile('{"type":"FeatureCollection"}')).toThrow('not an Earthy style presets');
    expect(() =>
      parsePresetFile(JSON.stringify({ format: 'earthy-style-presets', version: 2, presets: [] })),
    ).toThrow('newer version');
  });

  it('skips damaged entries and repeated names, keeping the rest', () => {
    const bad = { ...preset({ name: 'Bad' }), fillOpacity: 3 };
    const r = parsePresetFile(fileWith([preset(), bad, preset(), 'junk']));
    expect(r.presets.map((p) => p.name)).toEqual(['Land cover']);
    expect(r.skipped).toBe(3);
  });
});

describe('validPreset', () => {
  it('rejects a preset with any unusable category rather than applying part of it', () => {
    const p = preset();
    const broken = { ...p, categories: [...p.categories, { ...p.categories[0], color: 'red' }] };
    expect(validPreset(broken)).toBeNull();
    expect(validPreset({ ...p, categories: [] })).toBeNull();
    expect(validPreset({ ...p, ramp: 'plasma' })).toBeNull();
    expect(validPreset({ ...p, name: '  ' })).toBeNull();
  });

  it('keeps only known fields, trims the name and lower-cases colours', () => {
    const p = preset();
    const raw = {
      ...p,
      name: ' Land cover ',
      extra: 'dropped',
      categories: [{ ...p.categories[0], color: '#228B22', note: 'dropped' }],
    };
    expect(validPreset(raw)).toEqual(p);
  });

  it('drops icons Earthy does not offer, and canonicalises ones it does', () => {
    expect(validPreset(preset({ iconHref: 'https://example.com/x.png' }))?.iconHref).toBeUndefined();
    const lookalike = 'https://example.com/' + POINT_ICONS[0].href.split('/').pop();
    expect(validPreset(preset({ iconHref: lookalike }))?.iconHref).toBe(POINT_ICONS[0].href);
  });
});

describe('merging imported presets', () => {
  const mine = [preset(), preset({ name: 'Roads', field: 'type' })];

  it('adds new names and ignores identical copies', () => {
    const m = mergePresets(mine, [preset(), preset({ name: 'Soils' })], 'replace');
    expect(m.presets.map((p) => p.name)).toEqual(['Land cover', 'Roads', 'Soils']);
    expect(m).toMatchObject({ added: 1, unchanged: 1, replaced: 0, renamed: 0 });
  });

  it('reports only clashes whose content differs', () => {
    const theirs = [preset(), preset({ name: 'Roads', lineWidth: 4 })];
    expect(presetConflicts(mine, theirs)).toEqual(['Roads']);
  });

  it('replaces a clash in place, or keeps both under a numbered name', () => {
    const theirs = [preset({ name: 'Roads', lineWidth: 4 })];
    const replaced = mergePresets(mine, theirs, 'replace');
    expect(replaced.presets[1].lineWidth).toBe(4);
    expect(replaced.replaced).toBe(1);

    const both = mergePresets([...mine, preset({ name: 'Roads (2)' })], theirs, 'keep-both');
    expect(both.presets.map((p) => p.name)).toEqual(['Land cover', 'Roads', 'Roads (2)', 'Roads (3)']);
    expect(both.renamed).toBe(1);
  });
});
