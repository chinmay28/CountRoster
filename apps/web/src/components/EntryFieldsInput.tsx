import type { TrackerField } from '@countroster/core';
import { sliceColor, type FieldAnswers } from '../lib/fields.ts';
import { readableInk } from '../lib/color.ts';

interface EntryFieldsInputProps {
  fields: readonly TrackerField[];
  answers: FieldAnswers;
  onChange: (next: FieldAnswers) => void;
  disabled?: boolean;
  /**
   * Tint for the selected state. The quick-log screen passes the tracker's
   * color so the controls belong to the same surface as the log button.
   */
  accent?: string;
}

/**
 * The controls for a tracker's custom fields, as used everywhere an entry is
 * written: the detail log form, the quick-log screen, and inline entry edits.
 *
 * Choices and flags are pill buttons rather than selects and checkboxes —
 * this sits under a thumb on a phone, and a one-tap answer is the whole point
 * of a quick log. Tapping the selected pill again clears it, which is the only
 * way back to "unanswered" for a field that isn't required.
 */
export function EntryFieldsInput({
  fields,
  answers,
  onChange,
  disabled = false,
  accent,
}: EntryFieldsInputProps) {
  if (fields.length === 0) return null;

  function set(fieldId: string, value: FieldAnswers[string]) {
    onChange({ ...answers, [fieldId]: value });
  }

  return (
    <div className="entry-fields">
      {fields.map((field) => {
        const answer = answers[field.id] ?? null;
        // No field is ever mandatory, so nothing is marked as such: an
        // unanswered field is a legitimate state, not an omission.
        const label = <span className="entry-fields__label">{field.name}</span>;

        if (field.kind === 'choice') {
          return (
            <div
              className="entry-fields__group"
              key={field.id}
              role="group"
              aria-label={field.name}
            >
              {label}
              <div className="entry-fields__pills">
                {field.options.map((option, i) => {
                  const selected = answer === option.id;
                  const color = sliceColor(option.color, i);
                  return (
                    <button
                      type="button"
                      key={option.id}
                      className={`pill${selected ? ' pill--on' : ''}`}
                      aria-pressed={selected}
                      disabled={disabled}
                      style={
                        selected
                          ? { background: color, borderColor: color, color: readableInk(color) }
                          : { borderColor: color }
                      }
                      // Tapping the selected pill clears the answer.
                      onClick={() => set(field.id, selected ? null : option.id)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }

        if (field.kind === 'flag') {
          const on = answer === 1 || answer === true;
          const off = answer === 0 || answer === false;
          const tint = accent ?? 'var(--accent)';
          return (
            <div
              className="entry-fields__group"
              key={field.id}
              role="group"
              aria-label={field.name}
            >
              {label}
              <div className="entry-fields__pills">
                <button
                  type="button"
                  className={`pill${on ? ' pill--on' : ''}`}
                  aria-pressed={on}
                  disabled={disabled}
                  style={on ? { background: tint, borderColor: tint, color: readableInk(accent ?? '#4ECDC4') } : undefined}
                  onClick={() => set(field.id, on ? null : 1)}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className={`pill${off ? ' pill--on' : ''}`}
                  aria-pressed={off}
                  disabled={disabled}
                  onClick={() => set(field.id, off ? null : 0)}
                >
                  No
                </button>
              </div>
            </div>
          );
        }

        if (field.kind === 'number') {
          return (
            <label className="field entry-fields__field" key={field.id}>
              {label}
              <input
                type="number"
                step="any"
                inputMode="decimal"
                placeholder={field.unit ?? ''}
                disabled={disabled}
                value={answer == null ? '' : String(answer)}
                onChange={(e) =>
                  set(field.id, e.target.value === '' ? null : Number(e.target.value))
                }
              />
            </label>
          );
        }

        return (
          <label className="field entry-fields__field" key={field.id}>
            {label}
            <input
              type="text"
              maxLength={500}
              disabled={disabled}
              value={answer == null ? '' : String(answer)}
              onChange={(e) => set(field.id, e.target.value === '' ? null : e.target.value)}
            />
          </label>
        );
      })}
    </div>
  );
}
