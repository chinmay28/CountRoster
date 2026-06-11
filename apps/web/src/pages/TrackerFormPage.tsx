import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Tracker, TrackerInput, TrackerKind, ResetPeriod } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { KIND_LABELS, TRACKER_KINDS, RESET_PERIOD_OPTIONS } from '../lib/format.ts';

/** One row of the derived-sources editor. */
interface LinkRow {
  source_id: string;
  coefficient: string;
}

interface FormValues {
  name: string;
  description: string;
  color: string;
  kind: TrackerKind;
  unit: string;
  target: string;
  default_value: string;
  reset_period: ResetPeriod;
  /** When true, the tracker is computed from `links` rather than logged. */
  isDerived: boolean;
  links: LinkRow[];
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
  isDerived: false,
  links: [],
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
  // Candidate source trackers for a derivation (ordinary trackers, not self).
  const [available, setAvailable] = useState<Tracker[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Sources can only be ordinary (non-derived) trackers, and never the
    // tracker being edited (no self-reference).
    core.trackers.list().then((all) => {
      if (cancelled) return;
      setAvailable(all.filter((t) => t.is_derived !== 1 && t.id !== id));
    });
    return () => {
      cancelled = true;
    };
  }, [core, id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const t = await core.trackers.get(id);
      if (cancelled) return;
      if (!t) {
        setError('Tracker not found.');
        setLoading(false);
        return;
      }
      const isDerived = t.is_derived === 1;
      const linkRows = isDerived ? await core.trackers.links(id) : [];
      if (cancelled) return;
      setValues({
        name: t.name,
        description: t.description ?? '',
        color: t.color,
        kind: t.kind,
        unit: t.unit ?? '',
        target: t.target == null ? '' : String(t.target),
        default_value: String(t.default_value),
        reset_period: t.reset_period,
        isDerived,
        links: linkRows.map((l) => ({
          source_id: l.source_id,
          coefficient: String(l.coefficient),
        })),
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [core, id]);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function setLink(index: number, patch: Partial<LinkRow>) {
    setValues((v) => ({
      ...v,
      links: v.links.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  }

  function addLink() {
    setValues((v) => ({ ...v, links: [...v.links, { source_id: '', coefficient: '1' }] }));
  }

  function removeLink(index: number) {
    setValues((v) => ({ ...v, links: v.links.filter((_, i) => i !== index) }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    // Collapse the source rows into validated link operands.
    const links = values.links
      .filter((l) => l.source_id)
      .map((l) => ({ source_id: l.source_id, coefficient: Number(l.coefficient) || 0 }));

    if (values.isDerived && links.length === 0) {
      setError('A derived tracker needs at least one source.');
      setSaving(false);
      return;
    }

    try {
      // A derived tracker holds a computed number; it is never tapped to log.
      const input: TrackerInput = {
        name: values.name.trim(),
        color: values.color,
        kind: values.isDerived ? 'number' : values.kind,
        default_value: values.isDerived ? 0 : Number(values.default_value) || 0,
        reset_period: values.reset_period,
        // Zod fills the rest of the required defaults.
      } as TrackerInput;
      const description = values.description.trim();
      if (description) input.description = description;
      const unit = values.unit.trim();
      if (unit) input.unit = unit;
      if (values.target.trim()) input.target = Number(values.target);
      if (values.isDerived) input.links = links;

      if (editing && id) {
        await core.trackers.update(id, {
          ...input,
          // patch wants explicit nulls to clear; map empties to null.
          description: description || null,
          unit: unit || null,
          target: values.target.trim() ? Number(values.target) : null,
          // Always send links so toggling derived off clears any prior ones.
          links: values.isDerived ? links : [],
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

        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={values.isDerived}
            onChange={(e) => set('isDerived', e.target.checked)}
          />
          <span>Derived tracker (computed from other trackers)</span>
        </label>

        {values.isDerived ? (
          <DerivedSourcesEditor
            links={values.links}
            available={available}
            onAdd={addLink}
            onRemove={removeLink}
            onChange={setLink}
          />
        ) : (
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
        )}

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

        {!values.isDerived && (
          <label className="field">
            <span>Default value (per tap)</span>
            <input
              type="number"
              step="any"
              value={values.default_value}
              onChange={(e) => set('default_value', e.target.value)}
            />
          </label>
        )}

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

/** The editable list of (source tracker, coefficient) operands for a derivation. */
function DerivedSourcesEditor({
  links,
  available,
  onAdd,
  onRemove,
  onChange,
}: {
  links: LinkRow[];
  available: Tracker[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, patch: Partial<LinkRow>) => void;
}) {
  return (
    <fieldset className="field derived-sources">
      <legend>Sources</legend>
      <p className="muted">
        The value is the sum of each source multiplied by its coefficient. Use −1
        to subtract (e.g. Profit = Revenue × 1 + Expenses × −1).
      </p>
      {available.length === 0 && (
        <p className="muted">Create some ordinary trackers first to link them here.</p>
      )}
      {links.map((link, i) => (
        <div className="derived-sources__row" key={i}>
          <select
            value={link.source_id}
            onChange={(e) => onChange(i, { source_id: e.target.value })}
          >
            <option value="">Choose a tracker…</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            step="any"
            aria-label="Coefficient"
            value={link.coefficient}
            onChange={(e) => onChange(i, { coefficient: e.target.value })}
          />
          <button
            type="button"
            className="btn btn--small btn--danger"
            onClick={() => onRemove(i)}
            aria-label="Remove source"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn--small"
        onClick={onAdd}
        disabled={available.length === 0}
      >
        Add source
      </button>
    </fieldset>
  );
}
