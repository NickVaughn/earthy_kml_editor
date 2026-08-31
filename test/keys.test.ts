import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module reaches for electron's app/shell at import time; a GUI-less test
// only cares about resolution order, so stub the surface it touches.
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-earthy-test' },
  shell: { openPath: async () => '' },
}));

const ENV = ['EARTHY_ION_TOKEN', 'CESIUM_ION_TOKEN'];

describe('API key resolution', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('reads the environment first', async () => {
    const { apiKey } = await import('../src/main/keys');
    process.env.EARTHY_ION_TOKEN = 'from-env';
    expect(apiKey('EARTHY_ION_TOKEN', 'CESIUM_ION_TOKEN')).toBe('from-env');
  });

  it('falls back through the alias names in order', async () => {
    const { apiKey } = await import('../src/main/keys');
    process.env.CESIUM_ION_TOKEN = 'alias';
    expect(apiKey('EARTHY_ION_TOKEN', 'CESIUM_ION_TOKEN')).toBe('alias');
  });

  it('returns null when nothing is set and no keys file exists', async () => {
    const { apiKey } = await import('../src/main/keys');
    expect(apiKey('EARTHY_ION_TOKEN', 'CESIUM_ION_TOKEN')).toBeNull();
  });

  it('ignores blank values rather than treating them as configured', async () => {
    const { apiKey } = await import('../src/main/keys');
    process.env.EARTHY_ION_TOKEN = '   ';
    process.env.CESIUM_ION_TOKEN = 'real';
    expect(apiKey('EARTHY_ION_TOKEN', 'CESIUM_ION_TOKEN')).toBe('real');
  });
});
