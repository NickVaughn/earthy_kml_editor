import { describe, it, expect } from 'vitest';
import {
  nadirOrientation,
  northUpOrientation,
  NADIR_PITCH,
} from '@renderer/globe/cameraCommands';
import { commandForKey, COMMANDS } from '@renderer/input/commands';
import { shouldSkipShortcut } from '@renderer/input/useKeybindings';

describe('camera orientation math', () => {
  const cur = { heading: 1.2, pitch: -0.4, range: 5000 };

  it('nadir levels pitch straight down, keeping heading and range', () => {
    const o = nadirOrientation(cur);
    expect(o.pitch).toBe(NADIR_PITCH);
    expect(o.heading).toBe(cur.heading);
    expect(o.range).toBe(cur.range);
  });

  it('north-up zeroes heading, keeping pitch and range', () => {
    const o = northUpOrientation(cur);
    expect(o.heading).toBe(0);
    expect(o.pitch).toBe(cur.pitch);
    expect(o.range).toBe(cur.range);
  });
});

describe('command registry', () => {
  it('maps the requested keys', () => {
    expect(commandForKey('u')?.id).toBe('view.nadir');
    expect(commandForKey('n')?.id).toBe('view.northUp');
    expect(commandForKey('U')?.id).toBe('view.nadir'); // case-insensitive
    expect(commandForKey('?')?.id).toBe('help.toggle');
    expect(commandForKey('z')).toBeNull();
  });

  it('has unique keys and ids', () => {
    expect(new Set(COMMANDS.map((c) => c.keys)).size).toBe(COMMANDS.length);
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
  });
});

describe('shortcut guards', () => {
  const base = { modalOpen: false, toolActive: false, hasModifier: false };
  const el = (tag: string): EventTarget => ({ tagName: tag }) as unknown as EventTarget;

  it('fires on the globe canvas / body', () => {
    expect(shouldSkipShortcut(el('CANVAS'), base)).toBe(false);
    expect(shouldSkipShortcut(el('DIV'), base)).toBe(false);
  });

  it('skips while typing in form fields', () => {
    expect(shouldSkipShortcut(el('INPUT'), base)).toBe(true);
    expect(shouldSkipShortcut(el('TEXTAREA'), base)).toBe(true);
    expect(shouldSkipShortcut(el('SELECT'), base)).toBe(true);
  });

  it('skips contenteditable targets', () => {
    const ce = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
    expect(shouldSkipShortcut(ce, base)).toBe(true);
  });

  it('skips when a modal is open, a tool is active, or a modifier is held', () => {
    expect(shouldSkipShortcut(el('CANVAS'), { ...base, modalOpen: true })).toBe(true);
    expect(shouldSkipShortcut(el('CANVAS'), { ...base, toolActive: true })).toBe(true);
    expect(shouldSkipShortcut(el('CANVAS'), { ...base, hasModifier: true })).toBe(true);
  });
});
