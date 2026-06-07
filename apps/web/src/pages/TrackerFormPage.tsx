import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ResetPeriod, TrackerInput, TrackerKind } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { KIND_LABELS, TRACKER_KINDS, RESET_PERIOD_OPTIONS } from '../lib/format.ts';

interface FormValues {
  name: string;
  description: string;
  color: string;
  kind: TrackerKind;
  unit: string;
  target: string;
  default_value: string;
  reset_period: ResetPeriod;
}

const DEFAULTS: FormValues = {
  name: '',
  description: '',
  color: '#4ECDC4',
  kind: 'count',
  unit: '',
  target: '',
  default_value: '1',
  reset_period: 'never',
};

/** Create a new tracker, or edit an existing one when `:id` is present. */
export function TrackerFormPage() {
  const core = useCore();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const editing = Boolean(id);

  const [values, setValues] = useState<FormValues>(DEFAULTS);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    core.trackers.get(id).then((t) => {
      if (cancelled) return;
      if (!t) {
        setError('Tracker not found.');
        setLoading(false);
        return;
      }
      setValues({
        name: t.name,
        description: t.description ?? '',
        color: t.color,
        kind: t.kind,
        unit: t.unit ?? '',
        target: t.target == null ? '' : String(t.target),
        default_value: String(t.default_value),
        reset_period: t.reset_period,
      });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [core, id]);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Build a clean input; omit optional fields rather than sending ""/NaN.
      const input: TrackerInput = {
        name: values.name.trim(),
        color: values.color,
        kind: values.kind,
        default_value: Number(values.default_value) || 0,
        reset_period: values.reset_period,
        // Zod fills the rest of the required defaults.
      } as TrackerInput;
      const description = values.description.trim();
      if (description) input.description = description;
      const unit = values.unit.trim();
      if (unit) input.unit = unit;
      if (values.target.trim()) input.target = Number(values.target);

      if (editing && id) {
        await core.trackers.update(id, {
          ...input,
          // patch wants explicit nulls to clear; map empties to null.
          description: description || null,
          unit: unit || null,
          target: values.target.trim() ? Number(values.target) : null,
        });
        navigate(`/trackers/${id}`);
      } else {
        const created = await core.trackers.create(input);
        navigate(`/trackers/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <section className="form-page">
      <h1 className="page-title">{editing ? 'Edit tracker' : 'New tracker'}</h1>
      <form onSubmit={onSubmit} className="form">
        <label className="field">
          <span>Name</span>
          <input
            type="text"
            required
            maxLength={120}
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            autoFocus
          />
        </label>

        <label className="field">
          <span>Kind</span>
          <select
            value={values.kind}
            onChange={(e) => set('kind', e.target.value as TrackerKind)}
          >
            {TRACKER_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Color</span>
          <input
            type="color"
            value={values.color}
            onChange={(e) => set('color', e.target.value)}
          />
        </label>

        <label className="field">
          <span>Unit (optional)</span>
          <input
            type="text"
            maxLength={30}
            placeholder="cups, mg, $…"
            value={values.unit}
            onChange={(e) => set('unit', e.target.value)}
          />
        </label>

        <label className="field">
          <span>Default value (per tap)</span>
          <input
            type="number"
            step="any"
            value={values.default_value}
            onChange={(e) => set('default_value', e.target.value)}
          />
        </label>

        <label className="field">
          <span>Reset every</span>
          <select
            value={values.reset_period}
            onChange={(e) => set('reset_period', e.target.value as ResetPeriod)}
          >
            {RESET_PERIOD_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Target (optional)</span>
          <input
            type="number"
            step="any"
            placeholder="goal per period"
            value={values.target}
            onChange={(e) => set('target', e.target.value)}
          />
        </label>

        <label className="field">
          <span>Description (optional)</span>
          <textarea
            maxLength={2000}
            rows={3}
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="form__actions">
          <button
            type="button"
            className="btn"
            onClick={() => navigate(-1)}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create tracker'}
          </button>
        </div>
      </form>
    </section>
  );
}
