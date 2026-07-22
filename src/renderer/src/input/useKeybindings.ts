import { useEffect } from 'react';
import { useStore } from '@renderer/state/store';
import type { GlobeRenderer } from '@renderer/globe/GlobeRenderer';
import { commandForKey } from './commands';

/**
 * True when a keyboard shortcut should be IGNORED for this event — because the
 * user is typing, a modal is open, or a draw/edit tool owns the keyboard.
 */
export function shouldSkipShortcut(
  target: EventTarget | null,
  opts: { modalOpen: boolean; toolActive: boolean; hasModifier: boolean },
): boolean {
  if (opts.hasModifier) return true; // e.g. Cmd+N must not trigger plain "n"
  if (opts.modalOpen) return true; // import dialog / help — let Esc close them
  if (opts.toolActive) return true; // DrawTool/EditTool own Enter/Esc/Delete/etc.
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

/** Install the single window-level keyboard-shortcut dispatcher. */
export function useKeybindings(globeRef: React.MutableRefObject<GlobeRenderer | null>): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const s = useStore.getState();

      // Esc closes the help overlay regardless of other state.
      if (e.key === 'Escape' && s.helpOpen) {
        s.setHelpOpen(false);
        return;
      }

      const skip = shouldSkipShortcut(e.target, {
        modalOpen: s.pendingImport !== null || s.helpOpen,
        toolActive: s.interactionMode !== 'none',
        hasModifier: e.metaKey || e.ctrlKey || e.altKey,
      });
      // '?' toggles help even when help is open (so it can close it too).
      if (skip && !(e.key === '?' && s.helpOpen)) return;

      const cmd = commandForKey(e.key);
      const globe = globeRef.current;
      if (!cmd || !globe) return;
      e.preventDefault();
      cmd.run({ globe, store: useStore });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [globeRef]);
}
