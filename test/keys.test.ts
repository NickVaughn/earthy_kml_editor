import { describe, it, expect } from 'vitest';
import { parseKeyFile, resolveKey, KEYS_TEMPLATE } from '@shared/keys';

describe('keys file parsing', () => {
  it('reads plain KEY=value lines', () => {
    expect(parseKeyFile('EARTHY_ION_TOKEN=abc123')).toEqual({ EARTHY_ION_TOKEN: 'abc123' });
  });

  it('accepts a line pasted straight out of an .envrc', () => {
    // `export` prefix and quotes are how the same value looks in a shell file.
    expect(parseKeyFile('export EARTHY_ION_TOKEN="abc123"')).toEqual({
      EARTHY_ION_TOKEN: 'abc123',
    });
    expect(parseKeyFile("EARTHY_ION_TOKEN='abc123'")).toEqual({ EARTHY_ION_TOKEN: 'abc123' });
  });

  it('skips comments, blanks, and valueless keys', () => {
    const parsed = parseKeyFile(
      ['# a comment', '', '   ', 'EARTHY_ION_TOKEN=', 'GOOD=yes'].join('\n'),
    );
    expect(parsed).toEqual({ GOOD: 'yes' });
  });

  it('keeps "=" inside a value', () => {
    // JWTs and base64 both end up with padding.
    expect(parseKeyFile('K=eyJhbGci.payload==')).toEqual({ K: 'eyJhbGci.payload==' });
  });

  it('ships a template that configures nothing until uncommented', () => {
    expect(parseKeyFile(KEYS_TEMPLATE)).toEqual({});
  });
});

describe('key resolution order', () => {
  const NAMES = ['EARTHY_ION_TOKEN', 'CESIUM_ION_TOKEN'];

  it('prefers the environment over the file', () => {
    // A dev shell must win over whatever an installed app has stored.
    expect(resolveKey(NAMES, { EARTHY_ION_TOKEN: 'env' }, { EARTHY_ION_TOKEN: 'file' })).toBe(
      'env',
    );
  });

  it('falls back to the file when the environment is empty', () => {
    expect(resolveKey(NAMES, {}, { EARTHY_ION_TOKEN: 'file' })).toBe('file');
  });

  it('tries alias names in order, in both sources', () => {
    expect(resolveKey(NAMES, { CESIUM_ION_TOKEN: 'env-alias' }, {})).toBe('env-alias');
    expect(resolveKey(NAMES, {}, { CESIUM_ION_TOKEN: 'file-alias' })).toBe('file-alias');
  });

  it('treats blank as unset rather than configured', () => {
    expect(resolveKey(NAMES, { EARTHY_ION_TOKEN: '   ' }, { CESIUM_ION_TOKEN: 'real' })).toBe(
      'real',
    );
  });

  it('returns null when nothing is set anywhere', () => {
    expect(resolveKey(NAMES, {}, {})).toBeNull();
  });
});
