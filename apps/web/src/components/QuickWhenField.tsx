import { useState } from 'react';
import { datetimeInputLabel, toDatetimeLocalValue } from '../lib/format.ts';

interface QuickWhenFieldProps {
  /** A datetime-local value, or `''` meaning "log at the current instant". */
  value: string;
  onChange: (next: string) => void;
}

/**
 * When the entry happened. Collapsed to a single chip reading "Now", because
 * that's the answer almost every time this screen is opened — tapping it
 * reveals a picker for the feed you're logging an hour late.
 *
 * A chosen time *sticks* until it's cleared or the screen is left: backdating
 * usually means entering a couple of things from the same moment, and
 * silently snapping back to now between them would file the second one wrong.
 * The chip stays lit with the chosen time so the state is never a surprise,
 * and the undo bar names the time it logged at.
 */
export function QuickWhenField({ value, onChange }: QuickWhenFieldProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="quick__when">
      <div className="quick__when-row">
        <button
          type="button"
          className={`quick__chip${value ? ' quick__chip--accent' : ''}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={value ? `Logging at ${datetimeInputLabel(value)}` : 'Logging now'}
        >
          {value ? datetimeInputLabel(value) : 'Now'} ▾
        </button>
        {value && (
          <button
            type="button"
            className="quick__chip"
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
          >
            Back to now
          </button>
        )}
      </div>
      {open && (
        <input
          className="quick__when-input"
          type="datetime-local"
          aria-label="When"
          // Empty means "now", so the picker opens on the current time
          // rather than an empty mm/dd/yyyy.
          value={value || toDatetimeLocalValue(new Date().toISOString())}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
