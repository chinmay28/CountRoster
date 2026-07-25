interface NumberKeypadProps {
  /** The digits typed so far, e.g. `"12.5"`. Empty means nothing entered. */
  value: string;
  onChange: (next: string) => void;
  /** Hide the decimal key for whole-number-only trackers. */
  allowDecimal?: boolean;
  /** Digits allowed before the decimal point; guards runaway input. */
  maxDigits?: number;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * An on-screen numeric keypad. The quick-log screen uses this instead of a
 * focused `<input>` so the OS keyboard never opens: nothing slides, resizes,
 * or covers the Log button mid-entry, and the keys sit where a thumb already
 * is. Ordinary buttons, so they're reachable by keyboard and screen reader.
 */
export function NumberKeypad({
  value,
  onChange,
  allowDecimal = true,
  maxDigits = 9,
}: NumberKeypadProps) {
  function press(key: string) {
    if (key === '.') {
      if (!allowDecimal || value.includes('.')) return;
      onChange((value === '' ? '0' : value) + '.');
      return;
    }
    if (value.replace(/[.-]/g, '').length >= maxDigits) return;
    // A lone leading zero is a placeholder, not a digit: "0" + "5" is 5.
    onChange(value === '0' ? key : value + key);
  }

  return (
    <div className="keypad" role="group" aria-label="Number keypad">
      {DIGITS.map((digit) => (
        <button key={digit} type="button" className="keypad__key" onClick={() => press(digit)}>
          {digit}
        </button>
      ))}
      {allowDecimal ? (
        <button type="button" className="keypad__key" onClick={() => press('.')} aria-label="Decimal point">
          .
        </button>
      ) : (
        <span className="keypad__key keypad__key--blank" aria-hidden="true" />
      )}
      <button type="button" className="keypad__key" onClick={() => press('0')}>
        0
      </button>
      <button
        type="button"
        className="keypad__key"
        onClick={() => onChange(value.slice(0, -1))}
        aria-label="Delete last digit"
      >
        ⌫
      </button>
    </div>
  );
}
