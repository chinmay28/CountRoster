import { useCallback, useEffect, useState } from 'react';
import {
  CLOUD_FREQUENCIES,
  clearProviderCredentials,
  completeCloudConnect,
  disconnectCloudBackup,
  fetchCloudBackup,
  listCloudFolders,
  runCloudBackup,
  setProviderCredentials,
  startCloudConnect,
  updateCloudBackup,
  type CloudBackupFrequency,
  type CloudBackupState,
  type CloudConnectStart,
  type CloudFolder,
  type CloudProviderInfo,
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
  const [setupFor, setSetupFor] = useState<string | null>(null);
  // A paste-mode authorization in progress: the user is off at the provider,
  // and we're waiting for the code they'll bring back. The provider id rides
  // along so the panel renders under the row it belongs to.
  const [pasting, setPasting] = useState<
    { provider: string; start: CloudConnectStart } | null
  >(null);

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
      const start = await startCloudConnect(provider, 'redirect');
      // A full navigation, not a popup: this has to survive an OAuth screen
      // that may bounce through a login and a device prompt, and popups are
      // blocked in an installed PWA more often than not.
      window.location.assign(start.authorize_url);
    });
  }

  /**
   * Start the paste flow. Nothing navigates: the user opens the provider in a
   * new tab from the link we render, authorizes, and comes back with a code.
   * Keeping this page alive is the point — there's no redirect to return to.
   */
  function connectByPaste(provider: string) {
    return run(`paste:${provider}`, async () => {
      setPasting({ provider, start: await startCloudConnect(provider, 'paste') });
    });
  }

  function submitPastedCode(code: string) {
    if (!pasting) return;
    return run('paste-code', async () => {
      setState(await completeCloudConnect(pasting.start.pending_id, code));
      setPasting(null);
      setMessage('Cloud account connected. Choose a folder to back up into.');
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
  const redirectSupported = state.redirect_supported === 1;

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
          {/* One row per provider: connect it, or set it up first. A provider
              that isn't set up gets a working button that opens the form —
              never a dead control with the reason hidden in a tooltip nobody
              on a touch screen will ever see. */}
          <ul className="cloud__providers">
            {providers.map((provider) => {
              // Connectable unless this origin can't host a redirect and the
              // provider has no paste flow to fall back on.
              const connectable =
                redirectSupported || provider.supports_code_paste === 1;
              return (
              <li key={provider.id} className="cloud__provider">
                <div className="cloud__provider-row">
                  <div className="cloud__provider-meta">
                    <span className="cloud__provider-name">{provider.name}</span>
                    <span className="muted">
                      {provider.configured === 1
                        ? provider.source === 'server'
                          ? 'Set up on the server'
                          : 'Ready to connect'
                        : 'Needs a one-time setup'}
                    </span>
                  </div>
                  {provider.configured === 1 ? (
                    // Which flow leads depends on whether a redirect could
                    // come back here at all. On a plain-http LAN address it
                    // can't — providers require https — so the paste flow is
                    // the only one that works, and it gets the primary button.
                    redirectSupported || provider.supports_code_paste === 0 ? (
                      <button
                        type="button"
                        className="btn btn--primary"
                        // A provider that needs a redirect, on an origin no
                        // redirect can reach, cannot be connected here — and
                        // the reason is knowable now rather than after a
                        // bounce off the provider's error page. The note
                        // below says so; a disabled button whose reason is
                        // right beside it is honest, unlike a hidden tooltip.
                        disabled={busy !== null || !connectable}
                        onClick={() => connect(provider.id)}
                      >
                        {busy === `connect:${provider.id}` ? 'Opening…' : 'Connect'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy !== null}
                        onClick={() => connectByPaste(provider.id)}
                      >
                        {busy === `paste:${provider.id}` ? 'Starting…' : 'Connect'}
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy !== null}
                      onClick={() =>
                        setSetupFor((id) => (id === provider.id ? null : provider.id))
                      }
                    >
                      {setupFor === provider.id ? 'Cancel' : 'Set up'}
                    </button>
                  )}
                </div>

                {/* When a redirect can't reach this origin, say so once —
                    otherwise someone registers a redirect URI that can never
                    fire, or bounces off the provider's error page. */}
                {provider.configured === 1 && !redirectSupported && (
                  <p
                    className={
                      provider.supports_code_paste === 1
                        ? 'muted cloud__provider-note'
                        : 'error cloud__provider-note'
                    }
                  >
                    {provider.supports_code_paste === 1 ? (
                      <>
                        This server isn&rsquo;t on https, so {provider.name}{' '}
                        can&rsquo;t redirect back to it. You&rsquo;ll paste a code
                        instead — nothing to register.
                      </>
                    ) : (
                      <>
                        {provider.name} needs an https redirect URI and has no
                        paste-a-code sign-in, so it can&rsquo;t be connected while
                        this server is reached over plain http. Put it behind
                        HTTPS (Tailscale Serve or a reverse proxy) — the PWA
                        install wants that anyway.
                      </>
                    )}
                  </p>
                )}

                {provider.configured === 1 && (
                  <div className="cloud__provider-links">
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      disabled={busy !== null}
                      onClick={() =>
                        setSetupFor((id) => (id === provider.id ? null : provider.id))
                      }
                    >
                      {setupFor === provider.id ? 'Hide setup' : 'Edit setup'}
                    </button>
                    {/* The other flow stays reachable either way: a registered
                        redirect URI can still be wrong, and pasting a code
                        always works. */}
                    {provider.supports_code_paste === 1 && redirectSupported && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        disabled={busy !== null}
                        onClick={() => connectByPaste(provider.id)}
                      >
                        {busy === `paste:${provider.id}`
                          ? 'Starting…'
                          : 'Paste a code instead'}
                      </button>
                    )}
                  </div>
                )}

                {pasting?.provider === provider.id && (
                  <PasteCodePanel
                    providerName={provider.name}
                    authorizeUrl={pasting.start.authorize_url}
                    busy={busy !== null}
                    onSubmit={submitPastedCode}
                    onCancel={() => setPasting(null)}
                  />
                )}

                {setupFor === provider.id && (
                  <ProviderSetup
                    provider={provider}
                    redirectUri={state.redirect_uri}
                    busy={busy !== null}
                    onSave={(clientId, clientSecret) =>
                      run(`credentials:${provider.id}`, async () => {
                        setState(
                          await setProviderCredentials(provider.id, {
                            client_id: clientId,
                            ...(clientSecret ? { client_secret: clientSecret } : {}),
                          }),
                        );
                        setSetupFor(null);
                        setMessage(`${provider.name} is set up. You can connect it now.`);
                      })
                    }
                    onClear={() =>
                      run(`credentials:${provider.id}`, async () => {
                        setState(await clearProviderCredentials(provider.id));
                        setSetupFor(null);
                        setMessage(`${provider.name} setup cleared.`);
                      })
                    }
                  />
                )}
              </li>
              );
            })}
          </ul>
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

/**
 * The paste-a-code half of connecting an account.
 *
 * No redirect is involved, which is the entire point: the provider is opened
 * in a new tab, shows a code, and the user brings it back here. This page has
 * to stay alive to hold the pending authorization, so the link opens in a new
 * tab rather than navigating — losing this tab would lose the handle.
 */
function PasteCodePanel({
  providerName,
  authorizeUrl,
  busy,
  onSubmit,
  onCancel,
}: {
  providerName: string;
  authorizeUrl: string;
  busy: boolean;
  onSubmit: (code: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  return (
    <form
      className="cloud__paste"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <ol className="cloud__setup-steps">
        <li>
          <a
            href={authorizeUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn--primary cloud__paste-open"
          >
            Open {providerName} and allow access
          </a>
        </li>
        <li>Copy the code {providerName} shows you, and paste it here.</li>
      </ol>

      <label className="field">
        <span>Authorization code</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="paste the code"
        />
      </label>

      <div className="data__actions">
        {/* Distinct from the row's "Connect": two buttons with the same
            name in one view is a maze for anyone navigating by label. */}
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || code.trim() === ''}
        >
          {busy ? 'Connecting…' : 'Connect with this code'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One-time OAuth app setup for a provider.
 *
 * The client id has to come from somewhere: OAuth has no anonymous mode, and
 * a self-hosted server — reachable at an address nobody can predict — can't
 * share one shipped registration the way a store app can, because providers
 * require every redirect URI to be registered in advance. So the user
 * registers their own app once. What this form removes is the part that was
 * genuinely hostile: needing a command line to hand the result to the server.
 *
 * The redirect URI is shown first and copyable, because it's the step people
 * get wrong — it has to match character for character.
 */
function ProviderSetup({
  provider,
  redirectUri,
  busy,
  onSave,
  onClear,
}: {
  provider: CloudProviderInfo;
  redirectUri: string;
  busy: boolean;
  onSave: (clientId: string, clientSecret: string) => void;
  onClear: () => void;
}) {
  const [clientId, setClientId] = useState(provider.client_id);
  const [clientSecret, setClientSecret] = useState('');
  const [copied, setCopied] = useState(false);

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied or absent (older iOS, insecure
      // origin). The URI is selectable text right there, so this is a
      // convenience failing, not the flow failing.
    }
  }

  return (
    <form
      className="cloud__setup"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(clientId, clientSecret);
      }}
    >
      <ol className="cloud__setup-steps">
        <li>
          Open{' '}
          <a href={provider.setup_url} target="_blank" rel="noreferrer noopener">
            {provider.name}&rsquo;s developer console
          </a>{' '}
          and create an app.
        </li>
        <li>
          Register this exact redirect URI:
          <span className="cloud__redirect">
            <code>{redirectUri}</code>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={copyRedirect}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </span>
        </li>
        <li>Paste the app&rsquo;s credentials below.</li>
      </ol>

      <label className="field">
        <span>Client id</span>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="from the provider's console"
        />
      </label>

      <label className="field">
        <span>
          Client secret{' '}
          {provider.secret_required === 1 ? '(required)' : '(optional)'}
        </span>
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            provider.has_secret === 1
              ? 'stored — leave blank to keep it'
              : provider.secret_required === 1
                ? "from the provider's console"
                : 'not needed for a PKCE-only app'
          }
        />
      </label>

      <div className="data__actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          Save setup
        </button>
        {provider.source === 'settings' && (
          <button type="button" className="btn" disabled={busy} onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    </form>
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
