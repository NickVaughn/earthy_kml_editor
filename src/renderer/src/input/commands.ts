import type { GlobeRenderer } from '@renderer/globe/GlobeRenderer';
import { useStore } from '@renderer/state/store';

export interface CommandContext {
  globe: GlobeRenderer;
  store: typeof useStore;
}

export interface Command {
  id: string;
  /** Single key that triggers it (matched case-insensitively, no modifiers). */
  keys: string;
  /** Human-friendly key label for the help overlay. */
  keyLabel: string;
  label: string;
  group: 'View' | 'Edit' | 'Help';
  run(ctx: CommandContext): void;
}

/**
 * The keyboard-shortcut registry. Adding a shortcut is a one-line addition here;
 * the dispatcher and the help overlay are both driven off this list, so they
 * can never drift out of sync. Bare single keys only (see useKeybindings for
 * the guards that keep them from firing while typing).
 */
export const COMMANDS: Command[] = [
  {
    id: 'view.nadir',
    keys: 'u',
    keyLabel: 'U',
    label: 'Look straight down (nadir)',
    group: 'View',
    run: ({ globe }) => globe.lookNadir(),
  },
  {
    id: 'view.northUp',
    keys: 'n',
    keyLabel: 'N',
    label: 'Rotate so north is up',
    group: 'View',
    run: ({ globe }) => globe.lookNorthUp(),
  },
  {
    id: 'view.reset',
    keys: 'r',
    keyLabel: 'R',
    label: 'Reset view (north-up + nadir)',
    group: 'View',
    run: ({ globe }) => {
      globe.lookNorthUp();
      globe.lookNadir();
    },
  },
  {
    id: 'view.flyToSelection',
    keys: 'f',
    keyLabel: 'F',
    label: 'Zoom to selection',
    group: 'View',
    run: ({ globe, store }) => {
      const sel = store.getState().selection[0];
      if (sel) globe.flyTo(sel);
    },
  },
  {
    id: 'edit.editSelection',
    keys: 'e',
    keyLabel: 'E',
    label: 'Edit the selected feature’s shape',
    group: 'Edit',
    run: ({ store }) => {
      const s = store.getState();
      if (s.selection.length !== 1) return;
      const node = s.docOf(s.selection[0])?.nodeById(s.selection[0]);
      if (node?.type === 'Placemark' && node.geometry) s.setMode('edit');
    },
  },
  {
    id: 'help.toggle',
    keys: '?',
    keyLabel: '?',
    label: 'Show keyboard shortcuts',
    group: 'Help',
    run: ({ store }) => store.getState().setHelpOpen(!store.getState().helpOpen),
  },
];

const byKey = new Map(COMMANDS.map((c) => [c.keys.toLowerCase(), c]));

/** Look up a command for a raw KeyboardEvent.key value (or null). */
export function commandForKey(key: string): Command | null {
  return byKey.get(key.toLowerCase()) ?? null;
}
