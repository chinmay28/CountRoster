import { useEffect, useState } from 'react';

/** Does focusing this element pop up the software keyboard? Text inputs,
 * textareas, and contenteditable do; buttons, checkboxes, etc. don't. */
function opensKeyboard(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el instanceof HTMLInputElement) {
    // Types that show a typing keyboard (everything except buttons/toggles/
    // pickers that don't need one).
    const noKeyboard = new Set([
      'button',
      'submit',
      'reset',
      'checkbox',
      'radio',
      'file',
      'range',
      'color',
      'image',
      'hidden',
    ]);
    return !noKeyboard.has(el.type);
  }
  return false;
}

/**
 * Track whether the on-screen (software) keyboard is up by watching which
 * element has focus: the keyboard appears when a text-entry field is focused
 * and disappears when focus leaves it. This is more reliable across platforms
 * (notably iOS) than measuring viewport height deltas.
 *
 * Used to dismiss the bottom chrome (tab bar / FAB) while typing so it never
 * floats over the keyboard, and to bring it back once the keyboard is gone.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Defer to a microtask so `document.activeElement` has settled: when focus
    // moves directly between two inputs, focusout fires while activeElement is
    // momentarily <body>, which would otherwise flash the chrome back in.
    let queued = false;
    const sync = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        setOpen(opensKeyboard(document.activeElement));
      });
    };

    // focusin/focusout bubble (unlike focus/blur), so a single document-level
    // pair catches focus changes anywhere in the app.
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);
    sync();
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
    };
  }, []);

  return open;
}
