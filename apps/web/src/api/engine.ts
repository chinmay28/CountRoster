import { ApiError } from './client.ts';

/**
 * The on-device engine's own API (`/_engine/*`, server/internal/engine).
 *
 * It exists only inside the mobile app, where the web client is served by an
 * engine running on the phone: `/api` there is either the phone's own
 * database or a proxy to a CountRoster server, and these routes switch
 * between the two. A browser talking to a server gets a 404 (or the SPA
 * shell) from `/_engine/status`, which `fetchEngineStatus` reports as null —
 * "no engine, nothing to show".
 */

export type EngineMode = 'local' | 'remote';

export interface SafetyBundle {
  name: string;
  created_at: string;
  size: number;
}

export interface EngineStatus {
  mode: EngineMode;
  remote_url: string | null;
  remote_version: string | null;
  remote_api_level: number | null;
  /** False only when the server is known to be older than this app. */
  remote_compatible: boolean;
  local_empty: boolean;
  version: string;
  api_level: number;
  safety_bundles: SafetyBundle[];
}

export interface ProbeResult {
  url: string;
  version: string;
  api_level: number;
  /** The server holds no trackers. */
  empty: boolean;
  compatible: boolean;
  local_empty: boolean;
}

/** How data moves when sync is turned on. */
export type EnableStrategy = 'use_server' | 'move_to_server' | 'replace_server';
/** How data moves when sync is turned off. */
export type DisableStrategy = 'copy_from_server' | 'use_local';

export const ENGINE_BASE = '/_engine';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(ENGINE_BASE + path, init);
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

/** The engine's status, or null when there is no engine (a browser). */
export async function fetchEngineStatus(): Promise<EngineStatus | null> {
  try {
    const status = await request<EngineStatus>('GET', '/status');
    // A server's SPA fallback answers unknown paths with index.html; only a
    // real engine answers with a mode.
    return status && typeof status === 'object' && 'mode' in status ? status : null;
  } catch {
    return null;
  }
}

export function probeServer(url: string): Promise<ProbeResult> {
  return request('POST', '/sync/probe', { url });
}

export function enableSync(url: string, strategy: EnableStrategy): Promise<EngineStatus> {
  return request('POST', '/sync/enable', { url, strategy });
}

export function disableSync(strategy: DisableStrategy): Promise<EngineStatus> {
  return request('POST', '/sync/disable', { strategy });
}

export const safetyBundleUrl = (name: string) =>
  `${ENGINE_BASE}/safety/${encodeURIComponent(name)}`;
