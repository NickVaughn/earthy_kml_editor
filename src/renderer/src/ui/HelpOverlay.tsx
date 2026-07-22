import { useStore } from '@renderer/state/store';
import { COMMANDS, type Command } from '@renderer/input/commands';

/** Keyboard-shortcut cheat sheet, generated from the command registry. */
export function HelpOverlay(): JSX.Element | null {
  const open = useStore((s) => s.helpOpen);
  const setOpen = useStore((s) => s.setHelpOpen);
  if (!open) return null;

  const groups = new Map<string, Command[]>();
  for (const c of COMMANDS) {
    (groups.get(c.group) ?? groups.set(c.group, []).get(c.group)!).push(c);
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Keyboard shortcuts</div>
        {[...groups.entries()].map(([group, cmds]) => (
          <div key={group} className="help-group">
            <div className="help-group-title">{group}</div>
            {cmds.map((c) => (
              <div key={c.id} className="help-row">
                <kbd>{c.keyLabel}</kbd>
                <span>{c.label}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="modal-actions">
          <button className="primary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
