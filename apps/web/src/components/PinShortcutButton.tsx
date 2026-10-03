import { useState } from 'react';
import { nativeBridge } from '../lib/platform.ts';

/**
 * "Add to home screen" for a tracker's quick-log screen — the mobile app's
 * version of bookmarking /trackers/:id/quick. Renders nothing unless the host
 * app can pin launcher shortcuts (a browser installs the quick screen via its
 * own Add to Home Screen instead).
 */
export function PinShortcutButton({
  tracker,
}: {
  tracker: { id: string; name: string; color: string };
}) {
  const native = nativeBridge();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  if (!native?.has('pinShortcut')) return null;

  async function onPin() {
    setState('busy');
    try {
      setState((await native!.pinShortcut(tracker)) ? 'done' : 'idle');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="btn"
      onClick={onPin}
      disabled={state === 'busy'}
      title="Put a one-tap logging shortcut for this tracker on your home screen"
    >
      {state === 'done'
        ? 'Added to home screen'
        : state === 'error'
          ? 'Couldn’t add shortcut'
          : 'Add to home screen'}
    </button>
  );
}
