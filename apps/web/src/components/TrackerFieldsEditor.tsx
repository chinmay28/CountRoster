import type { TrackerFieldKind } from '@countroster/core';

/**
 * One field being edited. `id` is present for a field that already exists —
 * sending it back preserves the row and every answer filed against it, so
 * renaming "Feed type" doesn't discard the feeds already logged.
 */
export interface FieldRow {
  id?: string;
  name: string;
  kind: TrackerFieldKind;
  unit: string;
  options: OptionRow[];
}

export interface OptionRow {
  id?: string;
  label: string;
  color: string;
}

const FIELD_KIND_LABELS: Record<TrackerFieldKind, string> = {
  choice: 'Choice (pick one)',
  flag: 'Flag (yes / no)',
  number: 'Number',
  text: 'Text',
};

const FIELD_KINDS: readonly TrackerFieldKind[] = ['choice', 'flag', 'number', 'text'];

/** A new choice option starts uncolored; "" means "let the app pick". */
export function emptyOption(): OptionRow {
  return { label: '', color: '' };
}

export function emptyField(): FieldRow {
  return { name: '', kind: 'choice', unit: '', options: [emptyOption()] };
}

interface TrackerFieldsEditorProps {
  fields: FieldRow[];
  onChange: (fields: FieldRow[]) => void;
}

/**
 * The "extra details" editor on the tracker form: the fields each entry of
 * this tracker records alongside its value. A milk tracker counts millilitres
 * and adds "Feed type" (bottle / formula / breast) and "Wet diaper" here.
 */
export function TrackerFieldsEditor({ fields, onChange }: TrackerFieldsEditorProps) {
  function setField(index: number, patch: Partial<FieldRow>) {
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function setOption(fieldIndex: number, optionIndex: number, patch: Partial<OptionRow>) {
    setField(fieldIndex, {
      options: fields[fieldIndex]!.options.map((o, i) =>
        i === optionIndex ? { ...o, ...patch } : o,
      ),
    });
  }

  return (
    <fieldset className="field tracker-fields">
      <legend>Extra details</legend>
      <p className="muted">
        Captured alongside each entry's value. A feed tracker might count
        millilitres and record how it was fed and whether the diaper was wet —
        then break the total down by either.
      </p>

      {fields.map((field, i) => (
        <div className="tracker-fields__row" key={i}>
          <div className="tracker-fields__head">
            <input
              type="text"
              maxLength={60}
              placeholder="Field name"
              aria-label="Field name"
              value={field.name}
              onChange={(e) => setField(i, { name: e.target.value })}
            />
            <select
              aria-label="Field type"
              value={field.kind}
              onChange={(e) => {
                const kind = e.target.value as TrackerFieldKind;
                // Options only belong to a choice; a kind change drops them
                // (the server clears the answers to match).
                setField(i, {
                  kind,
                  options: kind === 'choice' ? field.options : [],
                });
              }}
            >
              {FIELD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FIELD_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--small btn--danger"
              aria-label={`Remove field ${field.name || i + 1}`}
              onClick={() => onChange(fields.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>

          {/* Fields are never mandatory — an entry may always leave one
              blank, so nothing here can force an answer. */}
          {field.kind === 'number' && (
            <div className="tracker-fields__meta">
              <input
                type="text"
                maxLength={30}
                placeholder="Unit (optional)"
                aria-label="Field unit"
                value={field.unit}
                onChange={(e) => setField(i, { unit: e.target.value })}
              />
            </div>
          )}

          {field.kind === 'choice' && (
            <div className="tracker-fields__options">
              {field.options.map((option, j) => (
                <div className="tracker-fields__option" key={j}>
                  <input
                    type="text"
                    maxLength={60}
                    placeholder="Option label"
                    aria-label="Option label"
                    value={option.label}
                    onChange={(e) => setOption(i, j, { label: e.target.value })}
                  />
                  {/* A color input has no empty state, so an explicit opt-in
                      keeps "no color chosen" reachable — the breakdown then
                      picks a distinct one from the palette. */}
                  {option.color ? (
                    <input
                      type="color"
                      aria-label="Option color"
                      value={option.color}
                      onChange={(e) => setOption(i, j, { color: e.target.value })}
                    />
                  ) : (
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setOption(i, j, { color: '#4ECDC4' })}
                    >
                      Color
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--small btn--danger"
                    aria-label={`Remove option ${option.label || j + 1}`}
                    disabled={field.options.length === 1}
                    onClick={() =>
                      setField(i, { options: field.options.filter((_, k) => k !== j) })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setField(i, { options: [...field.options, emptyOption()] })}
              >
                Add option
              </button>
            </div>
          )}
        </div>
      ))}

      <button
        type="button"
        className="btn btn--small"
        onClick={() => onChange([...fields, emptyField()])}
      >
        Add field
      </button>
    </fieldset>
  );
}
