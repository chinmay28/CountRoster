import { useCallback, useEffect, useState } from 'react';
import {
  CLOUD_FREQUENCIES,
  disconnectCloudBackup,
  fetchCloudBackup,
  listCloudFolders,
  runCloudBackup,
  startCloudConnect,
  updateCloudBackup,
  type CloudBackupFrequency,
  type CloudBackupState,
  type CloudFolder,
} from '../api/cloud.ts';
import { formatDateTime } from '../lib/format.ts';

/** One step of the folder picker's trail, so "up" is just a pop. */
interface Crumb {
  id: string;
  name: string;
  path: string;
}

/**
 * Automatic backup to a cloud folder.
 *
 * Three things have to be true before anything is uploaded: an account is
 * connected, a folder is chosen inside it, and the frequency isn't "off".
 * The section is laid out in that order, and each step only appears once the
 * one before it is done — the alternative is a screen of dead controls.
 *
 * The server does the actual work; this is a settings surface over
 * `/api/cloud/backup`. On a server built without cloud support those routes
 * don't exist, and the section renders nothing at all.
 */
export function CloudBackupSettings() {
  const [state, setState] = useState<CloudBackupState | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchCloudBackup();
      if (next === null) {
        setSupported(false);
        return;
      }
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The OAuth callback lands the browser back here with the outcome in the
  // query string (the provider redirects a whole navigation, so there's no
  // promise to await). Report it, then scrub the parameters so a refresh
  // doesn't replay a stale "connected".
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('cloud');
    if (!outcome) return;
    if (outcome === 'connected') {
      setMessage('Cloud account connected. Choose a folder to back up into.');
    } else {
      setError(params.get('cloud_error') ?? 'Connecting the cloud account failed.');
    }
    params.delete('cloud');
    params.delete('cloud_error');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query ? `?${query}` : ''),
    );
  }, []);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A failed run still writes its outcome to the settings row, so pull
      // the fresh state in rather than leaving stale status on screen.
      void load();
    } finally {
      setBusy(null);
    }
  }

  function connect(provider: string) {
    return run(`connect:${provider}`, async () => {
      const { authorize_url } = await startCloudConnect(provider);
      // A full navigation, not a popup: this has to survive an OAuth screen
      // that may bounce through a login and a device prompt, and popups are
      // blocked in an installed PWA more often than not.
      window.location.assign(authorize_url);
    });
  }

  function disconnect() {
    if (
      !confirm(
        'Disconnect this cloud account? Scheduled backups stop and the stored ' +
          'access is deleted. Backups already uploaded are left alone.',
      )
    ) {
      return;
    }
    return run('disconnect', async () => {
      setState(await disconnectCloudBackup());
      setPicking(false);
      setMessage('Cloud account disconnected.');
    });
  }

  function setFrequency(frequency: CloudBackupFrequency) {
    return run('frequency', async () => {
      setState(await updateCloudBackup({ frequency }));
    });
  }

  function chooseFolder(folder: Crumb) {
    return run('folder', async () => {
      setState(
        await updateCloudBackup({ folder_id: folder.id, folder_path: folder.path }),
      );
      setPicking(false);
      setMessage(`Backups will be saved to ${folder.path}.`);
    });
  }

  function backUpNow() {
    return run('run', async () => {
      const result = await runCloudBackup();
      setState((prev) => (prev ? { ...prev, settings: result.settings } : prev));
      setMessage(`Uploaded ${result.file_name}.`);
    });
  }

  // A server with no cloud support, or one still loading, shows nothing —
  // a placeholder card would just be noise on a page that already works.
  if (!supported) return null;
  if (loading || !state) {
    return (
      <section className="card data__section">
        <h2>Automatic cloud backup</h2>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const { settings, providers } = state;
  const connected = settings.connected === 1;
  const unconfigured = providers.filter((p) => p.configured === 0);

  return (
    <section className="card data__section">
      <h2>Automatic cloud backup</h2>
      <p className="muted">
        Have the server export a bundle on a schedule and save it to a folder
        in your Dropbox or Google Drive — the same <code>.countroster.zip</code>{' '}
        the download button produces, so anything it uploads can be restored
        above.
      </p>

      {!connected ? (
        <div className="cloud__connect">
          {/* Say why a button is dead. A `title` alone is invisible on a
              touch screen, which is most of this app's traffic — and this is
              exactly the case where the user can't guess the reason. */}
          {unconfigured.length > 0 && (
            <p className="muted">
              {unconfigured.map((p) => p.name).join(' and ')}{' '}
              {unconfigured.length === 1 ? 'is' : 'are'} not set up on this
              server. Register an OAuth app with the provider and start the
              server with its client id (
              {unconfigured.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ' / '}
                  <code>--{p.id === 'dropbox' ? 'dropbox' : 'google'}-client-id</code>
                </span>
              ))}
              ) — see DEPLOYMENT.md.
            </p>
          )}
          <div className="data__actions">
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className="btn"
                disabled={provider.configured === 0 || busy !== null}
                title={
                  provider.configured === 0
                    ? `${provider.name} is not set up on this server`
                    : undefined
                }
                onClick={() => connect(provider.id)}
              >
                {busy === `connect:${provider.id}`
                  ? 'Opening…'
                  : `Connect ${provider.name}`}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="cloud">
          <div className="cloud__account">
            <div>
              <span className="cloud__account-name">
                {settings.account_label ?? 'Connected account'}
              </span>
              <span className="muted">
                {providerName(providers, settings.provider)}
              </span>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={disconnect}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>

          <div className="cloud__row">
            <span className="cloud__label">Folder</span>
            <span className="cloud__value">
              {settings.folder_path ?? (
                <span className="muted">No folder chosen yet</span>
              )}
            </span>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => setPicking((open) => !open)}
            >
              {picking ? 'Cancel' : settings.folder_id ? 'Change' : 'Choose folder'}
            </button>
          </div>

          {picking && (
            <FolderPicker
              disabled={busy !== null}
              onChoose={chooseFolder}
              onError={setError}
            />
          )}

          <div className="cloud__row">
            <label className="cloud__label" htmlFor="cloud-frequency">
              Frequency
            </label>
            <select
              id="cloud-frequency"
              className="cloud__value"
              value={settings.frequency}
              disabled={busy !== null || settings.folder_id === null}
              onChange={(e) => setFrequency(e.target.value as CloudBackupFrequency)}
            >
              {CLOUD_FREQUENCIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy !== null || settings.folder_id === null}
              onClick={backUpNow}
            >
              {busy === 'run' ? 'Uploading…' : 'Back up now'}
            </button>
          </div>

          <CloudStatus settings={settings} />
        </div>
      )}

      {message && <p className="data__ok">{message}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The provider's display name, falling back to its raw id. */
function providerName(
  providers: CloudBackupState['providers'],
  id: string | null,
): string {
  if (!id) return '';
  return providers.find((p) => p.id === id)?.name ?? id;
}

/** When the last run happened, how it went, and when the next one is due. */
function CloudStatus({ settings }: { settings: CloudBackupState['settings'] }) {
  const failed = settings.last_status === 'error';
  return (
    <div className="cloud__status" role="status">
      {settings.last_run_at ? (
        <p className={failed ? 'error' : 'muted'}>
          {failed
            ? `Last backup failed ${formatDateTime(settings.last_run_at)}: ${
                settings.last_error ?? 'unknown error'
              }`
            : `Last backup ${formatDateTime(settings.last_run_at)}${
                settings.last_file_name ? ` — ${settings.last_file_name}` : ''
              }`}
        </p>
      ) : (
        <p className="muted">No backup has run yet.</p>
      )}
      {settings.frequency !== 'off' && settings.next_run_at && (
        <p className="muted">Next backup {formatDateTime(settings.next_run_at)}.</p>
      )}
    </div>
  );
}

/**
 * Browse the connected account and pick a destination.
 *
 * The trail is kept here rather than asked of the server: the picker only
 * ever descends, so the way back up is the list of folders it came through.
 * That's one API call per level instead of two.
 */
function FolderPicker({
  disabled,
  onChoose,
  onError,
}: {
  disabled: boolean;
  onChoose: (folder: Crumb) => void;
  onError: (message: string) => void;
}) {
  const ROOT: Crumb = { id: '', name: 'Account root', path: '/' };
  const [trail, setTrail] = useState<Crumb[]>([ROOT]);
  const [folders, setFolders] = useState<CloudFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const here = trail[trail.length - 1] ?? ROOT;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listCloudFolders(here.id || undefined).then(
      (next) => {
        if (cancelled) return;
        setFolders(next);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        onError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // `here.id` is the whole input: a different folder, a different listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here.id]);

  function open(folder: CloudFolder) {
    // Providers that identify folders by an opaque id (Drive) return a bare
    // name as the path, so the readable path is built from the trail.
    const path = folder.path.startsWith('/')
      ? folder.path
      : `${here.path.replace(/\/$/, '')}/${folder.name}`;
    setTrail((prev) => [...prev, { id: folder.id, name: folder.name, path }]);
  }

  return (
    <div className="cloud__picker">
      <nav className="cloud__crumbs" aria-label="Folder path">
        {trail.map((crumb, index) => (
          <span key={`${crumb.id}:${index}`}>
            {index > 0 && <span aria-hidden="true"> / </span>}
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={index === trail.length - 1}
              onClick={() => setTrail((prev) => prev.slice(0, index + 1))}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {loading ? (
        <p className="muted">Loading folders…</p>
      ) : folders.length === 0 ? (
        <p className="muted">No sub-folders here.</p>
      ) : (
        <ul className="cloud__folders">
          {folders.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                className="btn btn--ghost cloud__folder"
                onClick={() => open(folder)}
              >
                <FolderIcon />
                {folder.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="btn btn--primary"
        disabled={disabled}
        onClick={() => onChoose(here)}
      >
        Use {here.path}
      </button>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="cloud__folder-icon"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}
