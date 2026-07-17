import { useMemo, useRef, useState } from 'react';
import type { CardTransaction, Tracker, TransactionListStatus } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatDate } from '../lib/format.ts';
import { parseTransactionsCsv } from '../lib/transactionsCsv.ts';

const STATUSES: { status: TransactionListStatus; label: string }[] = [
  { status: 'pending', label: 'To review' },
  { status: 'confirmed', label: 'Filed' },
  { status: 'ignored', label: 'Dismissed' },
];

/**
 * The credit-card transactions inbox: upload a CSV exported from your
 * aggregator (Empower), review the auto-categorization, fix names, and
 * confirm rows into their trackers. Confirming creates the entry plus a note
 * carrying the transaction name, and teaches the server the merchant →
 * tracker rule for future imports.
 */
export function TransactionsPage() {
  const core = useCore();
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<TransactionListStatus>('pending');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trackers = useAsync(() => core.trackers.list(), []);
  const list = useAsync(() => core.transactions.list(status), [status]);

  const activeTrackers = useMemo(
    () => (trackers.data ?? []).filter((t) => t.is_derived === 0),
    [trackers.data],
  );
  const trackersById = useMemo(() => {
    const map = new Map<string, Tracker>();
    for (const t of trackers.data ?? []) map.set(t.id, t);
    return map;
  }, [trackers.data]);

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      const message = await action();
      setNotice(message);
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onImportFile(file: File) {
    await run(async () => {
      const { transactions, skipped } = parseTransactionsCsv(await file.text());
      if (transactions.length === 0) {
        throw new Error('No readable transactions in that file.');
      }
      const result = await core.transactions.import({ transactions });
      const parts = [`Imported ${result.imported} new`];
      if (result.duplicates > 0) parts.push(`skipped ${result.duplicates} already imported`);
      if (skipped > 0) parts.push(`${skipped} unreadable`);
      return `${parts.join(', ')}.`;
    });
    if (fileInput.current) fileInput.current.value = '';
  }

  const pending = status === 'pending' ? (list.data ?? []) : [];
  const categorized = pending.filter((t) => t.tracker_id !== null);

  async function confirmAll() {
    await run(async () => {
      let n = 0;
      for (const t of categorized) {
        await core.transactions.confirm(t.id);
        n++;
      }
      return `Filed ${n} transaction${n === 1 ? '' : 's'}.`;
    });
  }

  async function clearAll(which: 'pending' | 'confirmed' | 'ignored') {
    const n = list.data?.length ?? 0;
    const plural = n === 1 ? '' : 's';
    const warning =
      which === 'pending'
        ? `Drop all ${n} imported transaction${plural}? ` +
          'Nothing has been filed; re-importing the CSV stages them again.'
        : which === 'confirmed'
          ? `Clear ${n} filed transaction${plural} from this list? ` +
            'Their tracker entries stay, but re-importing an old CSV may stage them again.'
          : `Delete ${n} dismissed transaction${plural} for good? ` +
            'Re-importing an old CSV may bring them back.';
    if (!window.confirm(warning)) return;
    await run(async () => {
      const { cleared } = await core.transactions.clear(which);
      return `Cleared ${cleared} transaction${cleared === 1 ? '' : 's'}.`;
    });
  }

  return (
    <section className="form-page">
      <div className="stats__head">
        <h1 className="page-title">Transactions</h1>
        <div className="stats__periods" role="group" aria-label="Status filter">
          {STATUSES.map((s) => (
            <button
              key={s.status}
              type="button"
              className={`btn btn--small${s.status === status ? ' btn--active' : ''}`}
              aria-pressed={s.status === status}
              onClick={() => setStatus(s.status)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <section className="card txn__import">
        <p className="muted">
          Upload a transactions CSV exported from Empower, Chase or US Bank (or
          any export with Date, Description and Amount columns). Already-imported
          rows are skipped automatically.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          aria-label="Import transactions CSV"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onImportFile(file);
          }}
        />
        {notice && <p className="data__ok" role="status">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      {(list.data?.length ?? 0) > 0 && (
        <div className="txn__bulk">
          {status === 'pending' && categorized.length > 1 && (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void confirmAll()}>
              File all {categorized.length} categorized
            </button>
          )}
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={() => void clearAll(status as 'pending' | 'confirmed' | 'ignored')}
          >
            Clear all {list.data!.length}{' '}
            {status === 'pending' ? 'imported' : status === 'confirmed' ? 'filed' : 'dismissed'}
          </button>
        </div>
      )}

      {list.loading && <p className="muted">Loading…</p>}
      {list.error && <p className="error">{list.error.message}</p>}
      {!list.loading && !list.error && (list.data?.length ?? 0) === 0 && (
        <div className="empty">
          <h2>
            {status === 'pending'
              ? 'Nothing to review'
              : status === 'confirmed'
                ? 'Nothing filed yet'
                : 'Nothing dismissed'}
          </h2>
          {status === 'pending' && (
            <p>Import a CSV above to fill this inbox.</p>
          )}
        </div>
      )}

      <ul className="txn__list">
        {(list.data ?? []).map((t) => (
          <TransactionRow
            key={t.id}
            txn={t}
            trackers={activeTrackers}
            trackersById={trackersById}
            busy={busy}
            onRename={(name) =>
              run(async () => {
                if (name.trim() === '' || name === t.name) return null;
                await core.transactions.update(t.id, { name: name.trim() });
                return null;
              })
            }
            onPickTracker={(trackerId) =>
              run(async () => {
                await core.transactions.update(t.id, {
                  tracker_id: trackerId === '' ? null : trackerId,
                });
                return null;
              })
            }
            onConfirm={() =>
              run(async () => {
                const out = await core.transactions.confirm(t.id);
                const tracker = trackersById.get(out.entry.tracker_id);
                return `Filed “${out.transaction.name}” into ${tracker?.name ?? 'tracker'}.`;
              })
            }
            onDelete={() =>
              run(async () => {
                await core.transactions.delete(t.id);
                return null;
              })
            }
            onUnfile={() =>
              run(async () => {
                const restored = await core.transactions.unfile(t.id);
                return `Unfiled “${restored.name}” — it's back under To review.`;
              })
            }
          />
        ))}
      </ul>
    </section>
  );
}

function TransactionRow({
  txn,
  trackers,
  trackersById,
  busy,
  onRename,
  onPickTracker,
  onConfirm,
  onDelete,
  onUnfile,
}: {
  txn: CardTransaction;
  trackers: Tracker[];
  trackersById: Map<string, Tracker>;
  busy: boolean;
  onRename: (name: string) => void;
  onPickTracker: (trackerId: string) => void;
  onConfirm: () => void;
  onDelete: () => void;
  onUnfile: () => void;
}) {
  const pending = txn.status === 'pending';
  const spend = -txn.amount; // bank exports carry debits as negatives
  const amountLabel = `${spend < 0 ? '−$' : '$'}${Math.abs(spend).toFixed(2)}`;
  const tracker = txn.tracker_id ? trackersById.get(txn.tracker_id) : undefined;

  return (
    <li className="txn card">
      <div className="txn__main">
        <span className="txn__date">{formatDate(txn.posted_at)}</span>
        {pending ? (
          <input
            className="txn__name"
            // size=1 zeroes the input's intrinsic ~20ch width so the grid
            // column, not the input, decides how wide the name can be.
            size={1}
            defaultValue={txn.name}
            aria-label={`Name for ${txn.raw_description}`}
            disabled={busy}
            onBlur={(e) => onRename(e.target.value)}
          />
        ) : (
          <span className="txn__name txn__name--fixed">{txn.name}</span>
        )}
        <span className={`txn__amount${spend < 0 ? ' txn__amount--credit' : ''}`}>
          {amountLabel}
        </span>
      </div>
      <div className="txn__meta muted">
        {[
          // The raw descriptor is only interesting when sanitizing changed it.
          ...(txn.raw_description.toLowerCase() !== txn.name.toLowerCase()
            ? [txn.raw_description]
            : []),
          ...(txn.account ? [txn.account] : []),
          ...(txn.category ? [txn.category] : []),
        ].join(' · ')}
      </div>
      <div className="txn__actions">
        {pending ? (
          <>
            <select
              aria-label={`Tracker for ${txn.raw_description}`}
              value={txn.tracker_id ?? ''}
              disabled={busy}
              onChange={(e) => onPickTracker(e.target.value)}
            >
              <option value="">Choose tracker…</option>
              {trackers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={busy || !txn.tracker_id}
              onClick={onConfirm}
            >
              File it
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={onDelete}
              title="Dismiss — won't come back on re-import"
            >
              Dismiss
            </button>
          </>
        ) : txn.status === 'ignored' ? (
          <>
            <span className="muted">Dismissed</span>
            <button
              type="button"
              className="btn btn--danger btn--small"
              disabled={busy}
              onClick={onDelete}
              title="Remove for good — a future import can bring it back"
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <span className="muted">Filed into {tracker?.name ?? 'a tracker'}</span>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={onUnfile}
              title="Remove the entry and return this to the review inbox"
            >
              Undo
            </button>
          </>
        )}
      </div>
    </li>
  );
}
