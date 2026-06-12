import { useRef, useState } from 'react';
import {
  backupBundleUrl,
  backupSqliteUrl,
  downloadBackup,
  importBackup,
} from '../api/client.ts';
import { ArchivedTrackers } from '../components/ArchivedTrackers.tsx';

/**
 * Backup & restore. Backups are the documented egress point: download a
 * portable .countroster.zip (or the raw SQLite file), or restore the server's
 * data from a previously exported bundle.
 */
export function DataPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDownload(kind: string, url: string, fallbackName: string) {
    setDownloading(kind);
    setDownloadError(null);
    try {
      await downloadBackup(url, fallbackName);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
    }
  }

  async function onImport(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setError('Choose a .countroster.zip bundle first.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await importBackup(file, { confirmOverwrite });
      const total = Object.values(result.imported_rows).reduce((a, b) => a + b, 0);
      setMessage(`Imported ${total} rows (schema v${result.schema_version}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="form-page">
      <h1 className="page-title">Your data</h1>

      <section className="card data__section">
        <h2>Export</h2>
        <p className="muted">
          Download a portable backup. The bundle includes a JSON dump and
          per-table CSVs; both formats are fully documented and restorable.
        </p>
        <div className="data__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={downloading !== null}
            onClick={() =>
              onDownload('bundle', backupBundleUrl(), 'countroster.countroster.zip')
            }
          >
            {downloading === 'bundle' ? 'Preparing…' : 'Download bundle (.zip)'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={downloading !== null}
            onClick={() =>
              onDownload('sqlite', backupSqliteUrl(), 'countroster.sqlite')
            }
          >
            {downloading === 'sqlite' ? 'Preparing…' : 'Download raw SQLite'}
          </button>
        </div>
        {downloadError && <p className="error">{downloadError}</p>}
      </section>

      <section className="card data__section">
        <h2>Restore</h2>
        <p className="muted">
          Replace the server’s data with a previously exported bundle. This
          affects every device that uses this server.
        </p>
        <form className="data__import" onSubmit={onImport}>
          <input ref={fileInput} type="file" accept=".zip,application/zip" />
          <label className="data__confirm">
            <input
              type="checkbox"
              checked={confirmOverwrite}
              onChange={(e) => setConfirmOverwrite(e.target.checked)}
            />
            <span>Overwrite existing data</span>
          </label>
          <button type="submit" className="btn btn--danger" disabled={busy}>
            {busy ? 'Importing…' : 'Import bundle'}
          </button>
        </form>
        {message && <p className="data__ok">{message}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <ArchivedTrackers />
    </section>
  );
}
