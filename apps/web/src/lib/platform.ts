/**
 * The native app bridge — the only way the web client reaches past the
 * browser, and only when it runs inside the CountRoster mobile app.
 *
 * The contract a host implements (Android: an `addJavascriptInterface`
 * object; iOS: a document-start user script over a message handler) is one
 * global, `window.CountRosterNative`, with two methods:
 *
 *   - `capabilities(): string` — a JSON array of the methods it supports
 *     (synchronous, so the UI can decide what to render on first paint);
 *   - `postMessage(json: string): void` — a request
 *     `{"id": n, "method": "...", "args": {...}}`.
 *
 * The host answers every request, asynchronously, by calling
 * `window.__countrosterNativeReply(id, ok, value)`. Requests are therefore
 * Promise-based even where the host could answer synchronously — that is
 * what lets one client serve both platforms unchanged.
 *
 * Absent the global, this is a plain browser and `nativeBridge()` is null.
 */

/** Methods a host may offer. */
export type NativeCapability = 'saveUrl' | 'pinShortcut';

export interface NativeBridge {
  has(capability: NativeCapability): boolean;
  /**
   * Save something this origin serves (a same-origin path such as
   * `/api/backup/bundle`) to a file the user picks. Resolves false when the
   * user cancels.
   */
  saveUrl(path: string, suggestedName: string): Promise<boolean>;
  /** Put a launcher shortcut to a tracker's quick-log screen on the home screen. */
  pinShortcut(tracker: { id: string; name: string; color: string }): Promise<boolean>;
}

interface HostObject {
  capabilities(): string;
  postMessage(json: string): void;
}

type Reply = (id: number, ok: boolean, value: unknown) => void;

declare global {
  interface Window {
    CountRosterNative?: HostObject;
    __countrosterNativeReply?: Reply;
  }
}

let cached: { host: HostObject; bridge: NativeBridge } | null = null;

/** The bridge, or null in a plain browser. */
export function nativeBridge(): NativeBridge | null {
  const host = typeof window === 'undefined' ? undefined : window.CountRosterNative;
  if (!host) return null;
  if (cached?.host === host) return cached.bridge;
  cached = { host, bridge: createBridge(host) };
  return cached.bridge;
}

function createBridge(host: HostObject): NativeBridge {
  let capabilities: Set<string>;
  try {
    const parsed: unknown = JSON.parse(host.capabilities());
    capabilities = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    capabilities = new Set();
  }

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  window.__countrosterNativeReply = (id, ok, value) => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (ok) waiter.resolve(value);
    else waiter.reject(new Error(typeof value === 'string' ? value : 'The app could not do that.'));
  };

  function call(method: NativeCapability, args: Record<string, unknown>): Promise<unknown> {
    if (!capabilities.has(method)) {
      return Promise.reject(new Error(`This app version can't ${method}.`));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        host.postMessage(JSON.stringify({ id, method, args }));
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    has: (capability) => capabilities.has(capability),
    saveUrl: async (path, suggestedName) =>
      (await call('saveUrl', { path, suggestedName })) === true,
    pinShortcut: async ({ id, name, color }) =>
      (await call('pinShortcut', { id, name, color })) === true,
  };
}
