import { API_BASE, ApiError } from './client.ts';

/**
 * Typed client for the automatic cloud backup endpoints.
 *
 * These live outside `createApiClient` on purpose: `ApiCore` mirrors the
 * domain service interfaces so an in-memory core can stand in for it during
 * component tests, and cloud backup has no domain half — the schedule, the
 * OAuth grant and the upload all belong to the server. It's the same reason
 * `downloadBackup` and `importBackup` sit apart from the core surface.
 */

/** A cloud destination this server build knows about. */
export interface CloudProviderInfo {
  id: string;
  name: string;
  /** 0 until an OAuth client has been registered for it. */
  configured: 0 | 1;
  /** The client id in effect — not a secret, it rides in the authorize URL. */
  client_id: string;
  has_secret: 0 | 1;
  /** 1 for providers that reject a PKCE-only (secret-less) client. */
  secret_required: 0 | 1;
  /** "settings" (entered here), "server" (a startup flag), or "". */
  source: 'settings' | 'server' | '';
  /** The provider's developer console, where the OAuth app is registered. */
  setup_url: string;
}

/** The server's cloud backup configuration, with every token redacted. */
export interface CloudBackupSettings {
  provider: string | null;
  account_label: string | null;
  connected: 0 | 1;
  folder_id: string | null;
  folder_path: string | null;
  frequency: CloudBackupFrequency;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  last_file_name: string | null;
}

export type CloudBackupFrequency =
  | 'off'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly';

/** How each frequency is labelled in the picker, in the order it's offered. */
export const CLOUD_FREQUENCIES: ReadonlyArray<{
  value: CloudBackupFrequency;
  label: string;
}> = [
  { value: 'off', label: 'Off' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
];

export interface CloudBackupState {
  settings: CloudBackupSettings;
  providers: CloudProviderInfo[];
  /**
   * The exact redirect URI to register with the provider. The server derives
   * it from the origin this request arrived on, so the setup form can show
   * something copy-pasteable instead of asking the user to assemble it.
   */
  redirect_uri: string;
}

/** One folder in the connected account. */
export interface CloudFolder {
  id: string;
  name: string;
  path: string;
}

export interface CloudRunResult {
  file_name: string;
  bytes: number;
  settings: CloudBackupSettings;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  baseUrl = API_BASE,
): Promise<T> {
  const res = await fetch(`${baseUrl}/cloud${path}`, {
    method,
    ...(body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data as T;
}

/**
 * Read the current configuration and the destinations on offer.
 *
 * A server built without cloud support doesn't register these routes at all,
 * so a 404 here means "this deployment doesn't do cloud backup" — the caller
 * gets `null` and hides the section rather than showing a broken one.
 */
export async function fetchCloudBackup(
  baseUrl = API_BASE,
): Promise<CloudBackupState | null> {
  try {
    return await request<CloudBackupState>('GET', '/backup', undefined, baseUrl);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Patch the schedule and/or the destination folder. */
export function updateCloudBackup(
  patch: {
    frequency?: CloudBackupFrequency;
    folder_id?: string;
    folder_path?: string;
  },
  baseUrl = API_BASE,
): Promise<CloudBackupState> {
  return request('PATCH', '/backup', patch, baseUrl);
}

/**
 * Begin connecting an account. The server returns the provider's consent URL
 * rather than redirecting: this is a cross-origin hop, and a `fetch` that
 * followed the redirect would pull the consent page into an XHR instead of
 * putting it in front of the user.
 */
export function startCloudConnect(
  provider: string,
  baseUrl = API_BASE,
): Promise<{ authorize_url: string }> {
  return request('POST', '/backup/connect', { provider }, baseUrl);
}

export function disconnectCloudBackup(
  baseUrl = API_BASE,
): Promise<CloudBackupState> {
  return request('POST', '/backup/disconnect', {}, baseUrl);
}

/** List the folders inside `folderId` — omit it for the account root. */
export async function listCloudFolders(
  folderId?: string,
  baseUrl = API_BASE,
): Promise<CloudFolder[]> {
  const query = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : '';
  const body = await request<{ folders: CloudFolder[] }>(
    'GET',
    `/backup/folders${query}`,
    undefined,
    baseUrl,
  );
  return body.folders;
}

/** Export and upload a bundle right now, outside the schedule. */
export function runCloudBackup(baseUrl = API_BASE): Promise<CloudRunResult> {
  return request('POST', '/backup/run', {}, baseUrl);
}

/**
 * Store the OAuth client for a provider — the client id (and secret, where
 * the provider needs one) from an app the user registered themselves.
 *
 * This is what makes the feature reachable from a phone. The client id has to
 * come from *somewhere*: OAuth has no anonymous mode, and a self-hosted server
 * at an address nobody can predict can't share one shipped registration.
 * Entering it here beats a startup flag, because a phone has no command line.
 */
export function setProviderCredentials(
  provider: string,
  credentials: { client_id: string; client_secret?: string },
  baseUrl = API_BASE,
): Promise<CloudBackupState> {
  return request('PUT', `/backup/providers/${encodeURIComponent(provider)}`, credentials, baseUrl);
}

/** Forget a stored OAuth client, falling back to the server's startup flag. */
export function clearProviderCredentials(
  provider: string,
  baseUrl = API_BASE,
): Promise<CloudBackupState> {
  return request('DELETE', `/backup/providers/${encodeURIComponent(provider)}`, undefined, baseUrl);
}
