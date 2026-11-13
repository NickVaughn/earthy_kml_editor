/** True when a key event's target is a form field or editable text, so its keys are typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

/** Fired on `window` for Edit ▸ Cut/Copy/Paste when no text field has the focus. */
export const CLIPBOARD_EVENT = 'earthy:clipboard';
