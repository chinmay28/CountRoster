import { useState } from 'react';
import { downloadBackup } from '../api/client.ts';
import {
  disableSync,
  enableSync,
  probeServer,
  safetyBundleUrl,
  type DisableStrategy,
  type EnableStrategy,
  type EngineStatus,
  type ProbeResult,
} from '../api/engine.ts';
import { useEngine } from '../app/EngineContext.tsx';

/** Every view is stale after a switch; a reload is the honest refresh. */
const reloadPage = () => window.location.reload();

/**
 * Sync settings — only in the mobile app, where an on-device engine serves
 * this page. Local mode keeps the data on the phone; sync points the app at a
 * CountRoster server, so it shares one dataset with every other synced phone
 * and every browser using that server. Switching moves data as the person
 * chooses, and anything that would overwrite data is backed up first (the
 * engine keeps those bundles; they're listed at the bottom).
 */
export function SyncSettings({ onSwitched = reloadPage }: { onSwitched?: () => void }) {
  const { status, setStatus } = useEngine();
  if (!status) return null;

  const switched = (next: EngineStatus) => {
    setStatus(next);
    onSwitched();
  };

  return (
    <section className="card data__section" aria-labelledby="sync-heading">
      <h2 id="sync-heading">Sync</h2>
      {status.mode === 'local' ? (
        <EnableSync onEnabled={switched} />
      ) : (
        <SyncedWith status={status} onDisabled={switched} />
      )}
      <SafetyBundles status={status} />
    </section>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function EnableSync({ onEnabled }: { onEnabled: (s: EngineStatus) => void }) {
  const [address, setAddress] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [strategy, setStrategy] = useState<EnableStrategy>('use_server');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'probe' | 'enable' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCheck(e: React.FormEvent) {
    e.preventDefault();
    setBusy('probe');
    setError(null);
    setProbe(null);
    setConfirmed(false);
    try {
      const result = await probeServer(address);
      setProbe(result);
      setStrategy(defaultStrategy(result));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function onEnable() {
    if (!probe) return;
    setBusy('enable');
    setError(null);
    try {
      onEnabled(await enableSync(probe.url, strategy));
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  }

  const choices = probe ? enableChoices(probe) : [];
  const needsConfirm = strategy === 'replace_server';

  return (
    <div className="sync">
      <p className="muted">
        Your data is stored on this device. Sync with a CountRoster server to
        use the same data on your other phones and in the browser.
      </p>
      <form className="sync__address" onSubmit={onCheck}>
        <label className="field">
          <span>Server address</span>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="192.168.1.20:8787 or https://roster.example.ts.net"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setProbe(null);
            }}
          />
        </label>
        <button type="submit" className="btn" disabled={busy !== null || !address.trim()}>
          {busy === 'probe' ? 'Checking…' : 'Check server'}
        </button>
      </form>

      {probe && !probe.compatible && (
        <p className="error">
          {probe.url} runs CountRoster {probe.version || '(an older version)'}, which
          is older than this app. Update the server first, then check again.
        </p>
      )}

      {probe && probe.compatible && (
        <div className="sync__plan">
          <p>
            Found CountRoster {probe.version} at <strong>{probe.url}</strong>
            {probe.empty ? ' — it has no data yet.' : '.'}
          </p>
          {choices.length > 1 && (
            <fieldset className="sync__choices">
              <legend>What should happen to the data?</legend>
              {choices.map((c) => (
                <label key={c.value} className="sync__choice">
                  <input
                    type="radio"
                    name="sync-enable"
                    value={c.value}
                    checked={strategy === c.value}
                    onChange={() => {
                      setStrategy(c.value);
                      setConfirmed(false);
                    }}
                  />
                  <span>
                    <strong>{c.label}</strong>
                    <span className="muted">{c.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {needsConfirm && (
            <label className="data__confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>Yes, replace the server’s data for every device that uses it</span>
            </label>
          )}
          <button
            type="button"
            className={`btn ${needsConfirm ? 'btn--danger' : 'btn--primary'}`}
            disabled={busy !== null || (needsConfirm && !confirmed)}
            onClick={onEnable}
          >
            {busy === 'enable' ? 'Turning on sync…' : 'Turn on sync'}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface Choice<T> {
  value: T;
  label: string;
  detail: string;
}

/** The sensible default: never overwrite anything without being asked. */
function defaultStrategy(p: ProbeResult): EnableStrategy {
  return !p.local_empty && p.empty ? 'move_to_server' : 'use_server';
}

/** What the person can choose, given who has data. One choice → no question. */
function enableChoices(p: ProbeResult): Choice<EnableStrategy>[] {
  if (p.local_empty) {
    return [{ value: 'use_server', label: 'Use the server’s data', detail: '' }];
  }
  if (p.empty) {
    return [
      {
        value: 'move_to_server',
        label: 'Move this device’s data to the server',
        detail: 'Your trackers and history go up to the server and appear on every synced device.',
      },
      {
        value: 'use_server',
        label: 'Start fresh with the server',
        detail: 'This device’s data is set aside (and backed up) — you can switch back to it.',
      },
    ];
  }
  return [
    {
      value: 'use_server',
      label: 'Use the server’s data',
      detail: 'This device’s data is set aside (and backed up) — you can switch back to it.',
    },
    {
      value: 'replace_server',
      label: 'Replace the server’s data with this device’s',
      detail:
        'Every device using the server will see this device’s data. The server’s current data is backed up on this device first.',
    },
  ];
}

const DISABLE_CHOICES: Choice<DisableStrategy>[] = [
  {
    value: 'copy_from_server',
    label: 'Keep a copy of the server’s data on this device',
    detail: 'Carry on where you are, offline. Later changes stay on this device.',
  },
  {
    value: 'use_local',
    label: 'Go back to this device’s earlier data',
    detail: 'The data this device had before sync was turned on.',
  },
];

function SyncedWith({
  status,
  onDisabled,
}: {
  status: EngineStatus;
  onDisabled: (s: EngineStatus) => void;
}) {
  const [strategy, setStrategy] = useState<DisableStrategy>('copy_from_server');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDisable() {
    setBusy(true);
    setError(null);
    try {
      onDisabled(await disableSync(strategy));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="sync">
      <p>
        Synced with <strong>{status.remote_url}</strong>
        {status.remote_version ? ` (CountRoster ${status.remote_version})` : ''}. Every
        synced device and browser using this server sees the same data.
      </p>
      {!status.remote_compatible && (
        <p className="error">
          The server is older than this app, so changes are paused to keep it from
          dropping data it doesn’t understand. Update the server to continue.
        </p>
      )}
      <fieldset className="sync__choices">
        <legend>Turn off sync</legend>
        {DISABLE_CHOICES.map((c) => (
          <label key={c.value} className="sync__choice">
            <input
              type="radio"
              name="sync-disable"
              value={c.value}
              checked={strategy === c.value}
              onChange={() => setStrategy(c.value)}
            />
            <span>
              <strong>{c.label}</strong>
              <span className="muted">{c.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <button type="button" className="btn" disabled={busy} onClick={onDisable}>
        {busy ? 'Turning off sync…' : 'Turn off sync'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function SafetyBundles({ status }: { status: EngineStatus }) {
  const [error, setError] = useState<string | null>(null);
  if (status.safety_bundles.length === 0) return null;
  return (
    <div className="sync__safety">
      <h3>Backups taken before switching</h3>
      <ul className="sync__bundles">
        {status.safety_bundles.map((b) => (
          <li key={b.name}>
            <span className="sync__bundle-meta">
              <span>{describeBundle(b.name)}</span>
              <span className="muted">
                {new Date(b.created_at).toLocaleString()} · {formatSize(b.size)}
              </span>
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setError(null);
                downloadBackup(safetyBundleUrl(b.name), b.name).catch((err: unknown) =>
                  setError(errorText(err)),
                );
              }}
            >
              Download
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const BUNDLE_REASONS: Record<string, string> = {
  'before-sync': 'This device’s data, before sync',
  'server-before-replace': 'The server’s data, before it was replaced',
  'before-copy-from-server': 'This device’s data, before copying from the server',
};

function describeBundle(name: string): string {
  const reason = name.replace(/^[^-]+-/, '').replace(/\.countroster\.zip$/, '');
  return BUNDLE_REASONS[reason] ?? name;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
