import type {
  Tracker,
  Entry,
  Note,
  NoteEdit,
  TrackerGroup,
  TrackerLink,
  TrackerService,
  EntryService,
  NoteService,
  GroupService,
  StatsService,
  StatBucket,
  TargetProgress,
  TimeRange,
  BucketPeriod,
  TrackerInput,
  TrackerPatch,
  EntryLogInput,
  EntryLogManyInput,
  EntryPatch,
  NoteInput,
  NotePatch,
  GroupInput,
  GroupPatch,
} from '@countroster/core';

/**
 * The subset of the core's surface the client exposes to the UI. It is
 * structurally a `CountRosterCore` minus `migrations` and `backup` (the server
 * owns migrations; backup is streamed over dedicated endpoints, see below) —
 * so a real in-memory core also satisfies it, which is exactly what the
 * component tests provide.
 */
export interface ApiCore {
  trackers: TrackerService;
  entries: EntryService;
  notes: NoteService;
  groups: GroupService;
  stats: StatsService;
}

/** Error carrying the HTTP status and any structured body from the API. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export function createApiClient(baseUrl = '/api'): ApiCore {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(baseUrl + path, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const message =
        (data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : res.statusText) || `Request failed (${res.status})`;
      throw new ApiError(message, res.status, data);
    }
    return data as T;
  }

  /** GET that resolves to null on a 404 (for `.get(id)` lookups). */
  async function getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await request<T>('GET', path);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  function rangeQuery(range?: TimeRange): string {
    return qs({ start: range?.start, end: range?.end });
  }

  const trackers: TrackerService = {
    list: (opts) =>
      request(
        'GET',
        `/trackers${qs({
          includeArchived: opts?.includeArchived ? '1' : undefined,
          includeHidden: opts?.includeHidden ? '1' : undefined,
        })}`,
      ),
    get: (id) => getOrNull<Tracker>(`/trackers/${id}`),
    create: (input: TrackerInput) => request('POST', '/trackers', input),
    update: (id, patch: TrackerPatch) => request('PATCH', `/trackers/${id}`, patch),
    archive: (id) => request('POST', `/trackers/${id}/archive`),
    unarchive: (id) => request('POST', `/trackers/${id}/unarchive`),
    delete: (id) => request('DELETE', `/trackers/${id}`),
    reorder: (orderedIds) => request('POST', '/trackers/reorder', { orderedIds }),
    links: (id) => request<TrackerLink[]>('GET', `/trackers/${id}/links`),
    setLinks: (id, links) => request('PUT', `/trackers/${id}/links`, { links }),
  };

  const entries: EntryService = {
    forTracker: (trackerId, range) =>
      request('GET', `/trackers/${trackerId}/entries${rangeQuery(range)}`),
    log: (trackerId, input?: EntryLogInput) =>
      request('POST', `/trackers/${trackerId}/entries`, input ?? {}),
    logMany: (inputs: EntryLogManyInput) =>
      request('POST', '/entries/batch', inputs),
    get: (id) => getOrNull<Entry>(`/entries/${id}`),
    update: (id, patch: EntryPatch) => request('PATCH', `/entries/${id}`, patch),
    delete: (id) => request('DELETE', `/entries/${id}`),
  };

  const notes: NoteService = {
    forTracker: (trackerId, range) =>
      request('GET', `/trackers/${trackerId}/notes${rangeQuery(range)}`),
    create: (input: NoteInput) => request('POST', '/notes', input),
    edit: (id, newBody: string) => request('PATCH', `/notes/${id}`, { body: newBody }),
    update: (id, patch: NotePatch) => request('PATCH', `/notes/${id}`, patch),
    delete: (id) => request('DELETE', `/notes/${id}`),
    get: (id) => getOrNull<Note>(`/notes/${id}`),
    history: (noteId) => request<NoteEdit[]>('GET', `/notes/${noteId}/history`),
  };

  const groups: GroupService = {
    list: () => request<TrackerGroup[]>('GET', '/groups'),
    get: (id) => getOrNull<TrackerGroup>(`/groups/${id}`),
    create: (input: GroupInput) => request('POST', '/groups', input),
    update: (id, patch: GroupPatch) => request('PATCH', `/groups/${id}`, patch),
    delete: (id) => request('DELETE', `/groups/${id}`),
    reorder: (orderedGroupIds) =>
      request('POST', '/groups/reorder', { orderedGroupIds }),
    trackersIn: (groupId) => request('GET', `/groups/${groupId}/trackers`),
    addTracker: (groupId, trackerId) =>
      request('POST', `/groups/${groupId}/trackers`, { tracker_id: trackerId }),
    removeTracker: (groupId, trackerId) =>
      request('DELETE', `/groups/${groupId}/trackers/${trackerId}`),
    reorderMembers: (groupId, orderedTrackerIds) =>
      request('POST', `/groups/${groupId}/reorder`, { orderedTrackerIds }),
  };

  const stats: StatsService = {
    bucket: (trackerId, range, period: BucketPeriod) =>
      request<StatBucket[]>(
        'GET',
        `/trackers/${trackerId}/stats/buckets${qs({ start: range.start, end: range.end, period })}`,
      ),
    streak: (trackerId) => request('GET', `/trackers/${trackerId}/stats/streak`),
    targetProgress: (trackerId, at) =>
      request<TargetProgress>(
        'GET',
        `/trackers/${trackerId}/stats/target-progress${qs({ at })}`,
      ),
  };

  return { trackers, entries, notes, groups, stats };
}

/** Default API mount point (same origin; dev server proxies it to the API). */
export const API_BASE = '/api';

/** Direct-download URLs for the backup endpoints (used by the Data page). */
export const backupBundleUrl = (baseUrl = API_BASE) => `${baseUrl}/backup/bundle`;
export const backupSqliteUrl = (baseUrl = API_BASE) => `${baseUrl}/backup/sqlite`;

function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = header?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? fallback;
}

/** True when running as an installed app (no browser chrome to recover with). */
function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Fetch a backup file and hand it to the user without navigating. A plain
 * `<a href download>` navigates the webview to the file URL, which strands an
 * installed PWA (no back button). Instead we fetch the bytes ourselves: in
 * standalone mode the native share sheet is the reliable save path (iOS
 * home-screen apps can't download via anchors); everywhere else a transient
 * object-URL anchor saves the file with the page left untouched.
 */
export async function downloadBackup(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    let data: unknown;
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = undefined;
    }
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Download failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  const blob = await res.blob();
  const filename = filenameFromDisposition(
    res.headers.get('content-disposition'),
    fallbackName,
  );

  if (isStandaloneDisplay() && typeof navigator.canShare === 'function') {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        // User dismissed the share sheet — done, don't also force a download.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Share failed for another reason; fall through to the anchor path.
      }
    }
  }

  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a beat to start the save before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/** Upload a .countroster.zip to replace the server's data. */
export async function importBackup(
  file: Blob,
  opts: { confirmOverwrite?: boolean; baseUrl?: string } = {},
): Promise<{ imported_rows: Record<string, number>; schema_version: number }> {
  const baseUrl = opts.baseUrl ?? API_BASE;
  const res = await fetch(
    `${baseUrl}/backup/import${opts.confirmOverwrite ? '?confirmOverwrite=1' : ''}`,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file },
  );
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Import failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}
