import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PinShortcutButton } from '../components/PinShortcutButton.tsx';

const TRACKER = { id: 't1', name: 'Water', color: '#2266ff' };

afterEach(() => {
  delete window.CountRosterNative;
  delete window.__countrosterNativeReply;
});

describe('PinShortcutButton', () => {
  it('is absent in a browser', () => {
    const { container } = render(<PinShortcutButton tracker={TRACKER} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('asks the app to pin the tracker’s quick-log shortcut', async () => {
    const sent: unknown[] = [];
    window.CountRosterNative = {
      capabilities: () => '["pinShortcut"]',
      postMessage: (json) => {
        const msg = JSON.parse(json) as { id: number; args: unknown };
        sent.push(msg.args);
        setTimeout(() => window.__countrosterNativeReply?.(msg.id, true, true), 0);
      },
    };
    render(<PinShortcutButton tracker={TRACKER} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add to home screen' }));
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('Added to home screen'));
    expect(sent).toEqual([TRACKER]);
  });
});
