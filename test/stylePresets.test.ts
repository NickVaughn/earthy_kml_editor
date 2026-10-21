import { describe, it, expect } from 'vitest';
import { categoriesFromPreset, describeMatch } from '@renderer/model/stylePresets';
import { defaultCategories, rampColor } from '@renderer/model/geojson';
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
      { value: 'water', label: 'Water', color: '#1e90ff', fillMode: 'both', fillOpacity: 0.4, lineOpacity: 0.8 },
      { value: '11', label: 'Open water', color: '#0000ff', fillMode: 'both', fillOpacity: 0.5, lineOpacity: 1 },
    ],
    ...over,
  };
}

describe('categoriesFromPreset', () => {
  it('takes saved styles and labels for values the preset knows', () => {
    const m = categoriesFromPreset(['water', 'forest'], preset());
    expect(m.matched).toBe(2);
    expect(m.added).toBe(0);
    expect(m.categories.map((c) => c.label)).toEqual(['Water', 'Forest']);
    expect(m.categories[1]).toMatchObject({ color: '#228b22', fillMode: 'fill', fillOpacity: 0.7 });
  });

  it('seeds values the preset lacks from its ramp', () => {
    const m = categoriesFromPreset(['forest', 'urban', 'water'], preset());
    expect(m.matched).toBe(2);
    expect(m.added).toBe(1);
    const fresh = defaultCategories(['urban'], preset())[0];
    expect(m.categories[1]).toEqual(fresh);
  });

  it('gives a new value a ramp colour the preset does not assign', () => {
    // Saved from a 3-value layer, so it holds the first three palette colours.
    const p = preset({ categories: defaultCategories(['a', 'b', 'c'], preset()) });
    // Positionally, 'new' would take the third colour, which is c's; b's is
    // free on this layer but still means b on others.
    const m = categoriesFromPreset(['a', 'c', 'new'], p);
    expect(m.categories.map((c) => c.color)).toEqual([
      rampColor('category', 0, 3),
      rampColor('category', 2, 3),
      rampColor('category', 3, 4),
    ]);
  });

  it('drops preset values the layer does not have', () => {
    const m = categoriesFromPreset(['forest'], preset());
    expect(m.categories.map((c) => c.value)).toEqual(['forest']);
  });

  it('matches numeric codes written differently, keeping the layer value', () => {
    const m = categoriesFromPreset(['11.0'], preset());
    expect(m.matched).toBe(1);
    expect(m.categories[0]).toMatchObject({ value: '11.0', label: 'Open water', color: '#0000ff' });
  });

  it('does not treat a blank as the number zero', () => {
    const p = preset({
      categories: [
        { value: '0', label: 'Zero', color: '#000000', fillMode: 'both', fillOpacity: 0.5, lineOpacity: 1 },
      ],
    });
    expect(categoriesFromPreset([''], p).matched).toBe(0);
  });

  it('lets dialog-wide settings changed since picking win over every category', () => {
    const p = preset();
    const values = ['forest', 'water'];
    const m = categoriesFromPreset(values, p, {
      ramp: 'viridis',
      rampReversed: false,
      fillMode: p.fillMode,
      fillOpacity: 0.2,
      lineOpacity: p.lineOpacity,
    });
    expect(m.categories.map((c) => c.color)).toEqual([
      rampColor('viridis', 0, 2),
      rampColor('viridis', 1, 2),
    ]);
    expect(m.categories.every((c) => c.fillOpacity === 0.2)).toBe(true);
    // Unchanged settings keep each category's saved value.
    expect(m.categories.map((c) => c.fillMode)).toEqual(['fill', 'both']);
    expect(m.categories.map((c) => c.label)).toEqual(['Forest', 'Water']);
  });
});

describe('describeMatch', () => {
  it('reports matched and new values', () => {
    expect(describeMatch('LC', { categories: [], matched: 3, added: 1 })).toBe(
      'Preset “LC”: 3 of 4 values matched, 1 new from the ramp.',
    );
    expect(describeMatch('LC', { categories: [], matched: 1, added: 0 })).toBe(
      'Preset “LC”: 1 of 1 value matched.',
    );
  });
});
