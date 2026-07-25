import { useState } from 'react';
import { formatNumber } from '../lib/format.ts';
import type { QuickPanelProps } from '../lib/quick.ts';
import { QuickNoteField } from './QuickNoteField.tsx';

/**
 * The one-tap control, for counts and yes/no habits: the tracker's default
 * value is the whole point, so the screen is mostly button. A custom amount
 * is still one tap away, behind the drawer — but the common case costs
 * nothing, and the undo bar (owned by the page) covers the pocket tap.
 */
export function QuickTapPanel({ tracker, busy, onLog }: QuickPanelProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');

  const isBoolean = tracker.kind === 'boolean';

  function submitCustom(e: React.FormEvent) {
    e.preventDefault();
    const amount = value.trim() === '' ? tracker.default_value : Number(value);
    if (!Number.isFinite(amount)) return;
    onLog(amount, note.trim() || undefined);
    setValue('');
    setNote('');
    setDrawerOpen(false);
  }

  return (
    <div className="quick__control quick__control--tap">
      {isBoolean ? (
        <div className="quick-tap__pair">
          <button
            type="button"
            className="quick-tap__half"
            onClick={() => onLog(1)}
            disabled={busy}
          >
            Yes
          </button>
          <button
            type="button"
            className="quick-tap__half quick-tap__half--muted"
            onClick={() => onLog(0)}
            disabled={busy}
          >
            No
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="quick-tap__button"
          onClick={() => onLog(tracker.default_value)}
          disabled={busy}
          aria-label={`Log ${formatNumber(tracker.default_value, tracker.unit)}`}
        >
          <span className="quick-tap__amount">
            {tracker.default_value > 0 ? '+' : ''}
            {formatNumber(tracker.default_value)}
          </span>
          <span className="quick-tap__hint">tap to log</span>
        </button>
      )}

      <div className="quick__secondary">
        <button
          type="button"
          className="quick__chip"
          onClick={() => setDrawerOpen((open) => !open)}
          aria-expanded={drawerOpen}
        >
          {drawerOpen ? 'Cancel' : 'Custom value'}
        </button>
      </div>

      {drawerOpen && (
        <form className="quick__drawer" onSubmit={submitCustom}>
          <label className="quick__note">
            <span className="quick__note-label">Value</span>
            <input
              type="number"
              step="any"
              inputMode="decimal"
              placeholder={String(tracker.default_value)}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </label>
          <QuickNoteField value={note} onChange={setNote} />
          <button type="submit" className="quick__commit" disabled={busy}>
            Log entry
          </button>
        </form>
      )}
    </div>
  );
}
