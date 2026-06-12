import { useState } from 'react';
import { useCore } from '../app/CoreContext.tsx';
import { useHiddenMode } from '../app/HiddenMode.tsx';
import { useAsync } from '../app/useAsync.ts';
import { KIND_LABELS } from '../lib/format.ts';

/**
 * Archived trackers: the place to find trackers you've archived and either
 * restore them (back onto Home) or delete them for good. Deleting is
 * permanent and takes the tracker's entries, notes, and reminders with it,
 * so it's gated behind a confirm.
 */
export function ArchivedTrackers() {
  const core = useCore();
  const { enabled: hiddenMode } = useHiddenMode();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, loading, reload } = useAsync(async () => {
    const all = await core.trackers.list({
      includeArchived: true,
      includeHidden: hiddenMode,
    });
    return all.filter((t) => t.archived_at != null);
  }, [hiddenMode]);

  async function run(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function restore(id: string) {
    return run(id, () => core.trackers.unarchive(id));
  }

  function remove(id: string, name: string) {
    if (
      !confirm(
        `Permanently delete "${name}"? This also deletes its entries, notes, ` +
          `and reminders. This cannot be undone.`,
      )
    ) {
      return;
    }
    return run(id, () => core.trackers.delete(id));
  }

  return (
    <section className="card data__section">
      <h2>Archived trackers</h2>
      <p className="muted">
        Archived trackers are hidden from Home but keep all their data. Restore
        one to bring it back, or delete it permanently.
      </p>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : !data || data.length === 0 ? (
        <p className="muted">No archived trackers.</p>
      ) : (
        <ul className="archived-list">
          {data.map((tracker) => (
            <li key={tracker.id} className="archived-list__item">
              <span
                className="archived-list__swatch"
                style={{ background: tracker.color }}
                aria-hidden="true"
              />
              <div className="archived-list__meta">
                <span className="archived-list__name">{tracker.name}</span>
                <span className="muted">{KIND_LABELS[tracker.kind]}</span>
              </div>
              <div className="archived-list__actions">
                <button
                  className="btn"
                  disabled={busyId === tracker.id}
                  onClick={() => restore(tracker.id)}
                >
                  Restore
                </button>
                <button
                  className="btn btn--danger"
                  disabled={busyId === tracker.id}
                  onClick={() => remove(tracker.id, tracker.name)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
