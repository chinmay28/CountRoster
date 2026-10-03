import { useRef, useState } from 'react';
import {
  backupBundleUrl,
  backupSqliteUrl,
  downloadBackup,
  importBackup,
} from '../api/client.ts';
import { ArchivedTrackers } from '../components/ArchivedTrackers.tsx';
import { CloudBackupSettings } from '../components/CloudBackupSettings.tsx';
import { SyncSettings } from '../components/SyncSettings.tsx';
import { useEngine } from '../app/EngineContext.tsx';

/**
 * Backup & restore (and, in the mobile app, sync). Backups are the documented egress point: download a
 * portable .countroster.zip (or the raw SQLite file), have the server upload
 * one to a cloud folder on a schedule, or restore the server's data from a
 * previously exported bundle.
 */
export function DataPage() {
  const { status: engine } = useEngine();
  // In the mobile app's local mode the data is the device's own, not a
  // server's shared with other devices — the copy shouldn't say otherwise.
  const onDevice = engine?.mode === 'local';
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

      {/* Only in the mobile app; renders nothing in a browser. */}
      <SyncSettings />

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

      {/* Directly under Export: it's the same bundle, just written for you
          on a schedule instead of on a tap. */}
      <CloudBackupSettings />

      <section className="card data__section">
        <h2>Restore</h2>
        <p className="muted">
          {onDevice
            ? 'Replace this device’s data with a previously exported bundle.'
            : 'Replace the server’s data with a previously exported bundle. This affects every device that uses this server.'}
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
