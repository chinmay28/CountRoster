import { useEffect, useState } from 'react';

/** Below this many pixels of viewport shrink we assume it's browser chrome
 * (URL bar) collapsing, not the on-screen keyboard. */
const KEYBOARD_THRESHOLD_PX = 150;

/**
 * Track whether the on-screen (software) keyboard is up, using the
 * VisualViewport API. When the keyboard opens it shrinks the *visual*
 * viewport without changing the *layout* viewport, so a large gap between
 * `window.innerHeight` and `visualViewport.height` means the keyboard is up.
 *
 * Used to dismiss the bottom chrome (tab bar / FAB) while typing so it never
 * floats over the keyboard, and to bring it back once the keyboard is gone.
 * Returns `false` when the API is unavailable (e.g. desktop), where there is
 * no software keyboard to worry about.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      const occluded = window.innerHeight - viewport.height;
      setOpen(occluded > KEYBOARD_THRESHOLD_PX);
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return open;
}
