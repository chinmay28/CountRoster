import { useState } from 'react';
import { toDatetimeLocalValue } from '../lib/format.ts';

interface QuickWhenFieldProps {
  /** A datetime-local value, or `''` meaning "log at the current instant". */
  value: string;
  onChange: (next: string) => void;
}

/**
 * When the entry happened. Collapsed to a single chip reading "Now", because
 * that's the answer almost every time this screen is opened — tapping it
 * swaps the chip *in place* for a picker.
 *
 * In place, and not a picker revealed underneath it: this row sits above the
 * keypad, so a second row appearing here pushes the log button down the
 * screen — on a phone, out from under the thumb that was already reaching for
 * it. The row is one line tall in every state, so opening the picker moves
 * nothing.
 *
 * A chosen time *sticks* until it's cleared or the screen is left: backdating
 * usually means entering a couple of things from the same moment, and
 * silently snapping back to now between them would file the second one wrong.
 * The picker stays up, lit, showing the time it will log at, so the state is
 * never a surprise; ✕ hands the field back to now. The undo bar names the
 * time it logged at too.
 */
export function QuickWhenField({ value, onChange }: QuickWhenFieldProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="quick__when">
      <div className="quick__when-row">
        {open ? (
          <>
            <input
              className={`quick__when-input${value ? ' quick__when-input--accent' : ''}`}
              type="datetime-local"
              aria-label="When"
              // Empty means "now", so the picker opens on the current time
              // rather than an empty mm/dd/yyyy.
              value={value || toDatetimeLocalValue(new Date().toISOString())}
              onChange={(e) => onChange(e.target.value)}
            />
            <button
              type="button"
              className="quick__chip quick__chip--icon"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              aria-label="Back to now"
              title="Back to now"
            >
              ✕
            </button>
          </>
        ) : (
          <button
            type="button"
            className="quick__chip"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            aria-label="Logging now"
          >
            Now ▾
          </button>
        )}
      </div>
    </div>
  );
}
