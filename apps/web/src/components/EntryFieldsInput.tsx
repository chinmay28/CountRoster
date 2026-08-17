import type { CSSProperties } from 'react';
import type { TrackerField } from '@countroster/core';
import { fieldColumnBasis, sliceColor, type FieldAnswers } from '../lib/fields.ts';
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
  /**
   * Collapse each Yes/No field to a single chip that cycles through its three
   * states. The quick-log screen turns this on because it has one screen to
   * fit everything in and a label-over-two-pills block per field is what
   * pushed the log button off the bottom. Everywhere else has room to scroll,
   * so the two pills — where both answers are visible and each is one tap —
   * stay the default.
   */
  compact?: boolean;
}

/**
 * The controls for a tracker's custom fields, as used everywhere an entry is
 * written: the detail log form, the quick-log screen, and inline entry edits.
 *
 * Choices and flags are pill buttons rather than selects and checkboxes —
 * this sits under a thumb on a phone, and a one-tap answer is the whole point
 * of a quick log. Tapping the selected pill again clears it, which is the only
 * way back to "unanswered" for a field that isn't required.
 *
 * The fields themselves flow into up to two columns: each one declares the
 * width its own label and answers need (`--field-basis`, see
 * `fieldColumnBasis`) and the layout in styles.css breaks the row where that
 * width no longer fits. A screen of Yes/No fields pairs up instead of pushing
 * the log control off the bottom.
 *
 * In `compact` mode a Yes/No field collapses further still, to a single chip
 * that carries its own answer — see the prop. Those chips size to their text
 * rather than to a column, so they wrap as many to a row as fit.
 */
export function EntryFieldsInput({
  fields,
  answers,
  onChange,
  disabled = false,
  accent,
  compact = false,
}: EntryFieldsInputProps) {
  if (fields.length === 0) return null;

  function set(fieldId: string, value: FieldAnswers[string]) {
    onChange({ ...answers, [fieldId]: value });
  }

  return (
    <div className={`entry-fields${compact ? ' entry-fields--compact' : ''}`}>
      {fields.map((field) => {
        const answer = answers[field.id] ?? null;
        // No field is ever mandatory, so nothing is marked as such: an
        // unanswered field is a legitimate state, not an omission.
        const label = <span className="entry-fields__label">{field.name}</span>;
        const width = { '--field-basis': fieldColumnBasis(field) } as CSSProperties;

        if (field.kind === 'choice') {
          return (
            <div
              className="entry-fields__group"
              key={field.id}
              style={width}
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

          // One chip carrying its own name and its own answer, cycling
          // blank → Yes → No → blank. It costs a row per two fields instead
          // of a row per field, which is the whole point — but it only reads
          // as three states if all three look different, so an answered chip
          // is filled (Yes) or outlined-and-ticked (No) while a blank one
          // stays quiet. The state is in the accessible name too: the glyph
          // is decoration, and "Wet diaper" alone wouldn't say what it holds.
          if (compact) {
            return (
              <button
                type="button"
                key={field.id}
                className={`pill pill--state${on ? ' pill--on' : ''}${
                  off ? ' pill--state-off' : ''
                }`}
                aria-label={`${field.name}: ${on ? 'yes' : off ? 'no' : 'not answered'}`}
                disabled={disabled}
                style={
                  on
                    ? { background: tint, borderColor: tint, color: readableInk(accent ?? '#4ECDC4') }
                    : undefined
                }
                onClick={() => set(field.id, on ? 0 : off ? null : 1)}
              >
                {(on || off) && (
                  <span className="pill__mark" aria-hidden="true">
                    {on ? '✓' : '✕'}
                  </span>
                )}
                {field.name}
              </button>
            );
          }

          return (
            <div
              className="entry-fields__group"
              key={field.id}
              style={width}
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
            <label className="field entry-fields__field" key={field.id} style={width}>
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
          <label className="field entry-fields__field" key={field.id} style={width}>
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
