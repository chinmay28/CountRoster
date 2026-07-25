interface QuickNoteFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Open the keyboard straight away (when the note is the only field). */
  autoFocus?: boolean;
}

/**
 * The optional note attached to a quick-logged entry. Deliberately plain: on
 * this screen the note is the one place the OS keyboard is welcome.
 */
export function QuickNoteField({ value, onChange, autoFocus = false }: QuickNoteFieldProps) {
  return (
    <label className="quick__note">
      <span className="quick__note-label">Note</span>
      <textarea
        rows={2}
        placeholder="What was this?"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
    </label>
  );
}
