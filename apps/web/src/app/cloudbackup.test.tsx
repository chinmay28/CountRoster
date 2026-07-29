import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudBackupSettings } from '../components/CloudBackupSettings.tsx';
import type { CloudBackupSettings as Settings } from '../api/cloud.ts';

/**
 * The cloud backup settings surface. It has no domain half — the schedule,
 * the OAuth grant and the upload all live server-side — so unlike the rest of
 * the component suites these tests drive it against a stubbed `fetch` rather
 * than a real in-memory core.
 */

const DISCONNECTED: Settings = {
  provider: null,
  account_label: null,
  connected: 0,
  folder_id: null,
  folder_path: null,
  frequency: 'off',
  next_run_at: null,
  last_run_at: null,
  last_status: null,
  last_error: null,
  last_file_name: null,
};

const CONNECTED: Settings = {
  ...DISCONNECTED,
  provider: 'dropbox',
  account_label: 'hedy@example.com',
  connected: 1,
  folder_id: '/Apps/CountRoster',
  folder_path: '/Apps/CountRoster',
  frequency: 'daily',
  next_run_at: '2026-05-26T12:00:00.000-07:00',
  last_run_at: '2026-05-25T12:00:00.000-07:00',
  last_status: 'ok',
  last_file_name: 'countroster-2026-05-25-1200.countroster.zip',
};

const PROVIDERS = [
  { id: 'dropbox', name: 'Dropbox', configured: 1 as const },
  { id: 'google_drive', name: 'Google Drive', configured: 0 as const },
];

/** One recorded request, so a test can assert on what was actually sent. */
interface Call {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A tiny router over `fetch`. Handlers are keyed by "METHOD /path" and may be
 * a value (200 JSON) or a `{status, body}` pair; anything unmatched fails the
 * test loudly rather than resolving to undefined.
 */
function stubFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace(/\?.*$/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });

    const route = routes[`${method} ${path}`];
    if (route === undefined) {
      throw new Error(`unstubbed request: ${method} ${url}`);
    }
    const { status = 200, payload } =
      typeof route === 'object' && route !== null && 'status' in route
        ? (route as { status: number; payload: unknown })
        : { payload: route };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
    } as Response;
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/data');
});

beforeEach(() => {
  window.history.replaceState(null, '', '/data');
});

describe('CloudBackupSettings', () => {
  it('offers each provider, disabling the ones the server has no client id for', async () => {
    stubFetch({
      'GET /api/cloud/backup': { settings: DISCONNECTED, providers: PROVIDERS },
    });
    render(<CloudBackupSettings />);

    const dropbox = await screen.findByRole('button', { name: 'Connect Dropbox' });
    expect(dropbox).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Connect Google Drive' }),
    ).toBeDisabled();
    // And the operator is told how to close the gap.
    expect(screen.getByText(/--google-client-id/)).toBeInTheDocument();
  });

  // A server built without cloud support doesn't register the routes; the
  // section must vanish rather than show a broken card.
  it('renders nothing when the server has no cloud endpoints', async () => {
    stubFetch({ 'GET /api/cloud/backup': { status: 404, payload: undefined } });
    const { container } = render(<CloudBackupSettings />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('sends the browser to the provider consent screen', async () => {
    const calls = stubFetch({
      'GET /api/cloud/backup': { settings: DISCONNECTED, providers: PROVIDERS },
      'POST /api/cloud/backup/connect': {
        authorize_url: 'https://www.dropbox.com/oauth2/authorize?x=1',
      },
    });
    // jsdom can't navigate; the assertion is that we asked it to.
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, search: '' });

    render(<CloudBackupSettings />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect Dropbox' }),
    );

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://www.dropbox.com/oauth2/authorize?x=1',
      ),
    );
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { provider: 'dropbox' },
    });
  });

  it('shows the account, folder, schedule and last run once connected', async () => {
    stubFetch({
      'GET /api/cloud/backup': { settings: CONNECTED, providers: PROVIDERS },
    });
    render(<CloudBackupSettings />);

    expect(await screen.findByText('hedy@example.com')).toBeInTheDocument();
    expect(screen.getByText('/Apps/CountRoster')).toBeInTheDocument();
    expect(screen.getByLabelText('Frequency')).toHaveValue('daily');
    expect(
      screen.getByText(/countroster-2026-05-25-1200\.countroster\.zip/),
    ).toBeInTheDocument();
  });

  it('reports a failed run with the provider’s own message', async () => {
    stubFetch({
      'GET /api/cloud/backup': {
        settings: {
          ...CONNECTED,
          last_status: 'error',
          last_error: 'Dropbox: path/not_found',
          last_file_name: null,
        },
        providers: PROVIDERS,
      },
    });
    render(<CloudBackupSettings />);
    expect(
      await screen.findByText(/Last backup failed.*path\/not_found/),
    ).toBeInTheDocument();
  });

  it('changes the schedule', async () => {
    const calls = stubFetch({
      'GET /api/cloud/backup': { settings: CONNECTED, providers: PROVIDERS },
      'PATCH /api/cloud/backup': {
        settings: { ...CONNECTED, frequency: 'weekly' },
        providers: PROVIDERS,
      },
    });
    render(<CloudBackupSettings />);

    await userEvent.selectOptions(
      await screen.findByLabelText('Frequency'),
      'weekly',
    );
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { frequency: 'weekly' },
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Frequency')).toHaveValue('weekly'),
    );
  });

  // The schedule can't do anything without a destination, so the controls
  // that would start one stay inert until a folder is picked.
  it('keeps the schedule and manual run disabled until a folder is chosen', async () => {
    stubFetch({
      'GET /api/cloud/backup': {
        settings: { ...CONNECTED, folder_id: null, folder_path: null, frequency: 'off' },
        providers: PROVIDERS,
      },
    });
    render(<CloudBackupSettings />);

    expect(await screen.findByLabelText('Frequency')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
    expect(screen.getByText('No folder chosen yet')).toBeInTheDocument();
  });

  it('browses into a folder and saves it as the destination', async () => {
    const calls = stubFetch({
      'GET /api/cloud/backup': {
        settings: { ...CONNECTED, folder_id: null, folder_path: null },
        providers: PROVIDERS,
      },
      'GET /api/cloud/backup/folders': {
        folders: [{ id: '/Apps', name: 'Apps', path: '/Apps' }],
      },
      'PATCH /api/cloud/backup': {
        settings: { ...CONNECTED, folder_id: '/Apps', folder_path: '/Apps' },
        providers: PROVIDERS,
      },
    });
    render(<CloudBackupSettings />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Choose folder' }),
    );
    // Descend into Apps, then take it.
    await userEvent.click(await screen.findByRole('button', { name: 'Apps' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use /Apps' }));

    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'PATCH',
        body: { folder_id: '/Apps', folder_path: '/Apps' },
      }),
    );
    // The trail is what makes "up" work, so the crumb has to be there.
    expect(
      await screen.findByText(/Backups will be saved to \/Apps/),
    ).toBeInTheDocument();
  });

  it('uploads on demand', async () => {
    const calls = stubFetch({
      'GET /api/cloud/backup': { settings: CONNECTED, providers: PROVIDERS },
      'POST /api/cloud/backup/run': {
        file_name: 'countroster-2026-05-25-1400.countroster.zip',
        bytes: 2048,
        settings: CONNECTED,
      },
    });
    render(<CloudBackupSettings />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Back up now' }),
    );
    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({ method: 'POST' }),
    );
    expect(
      await screen.findByText(/Uploaded countroster-2026-05-25-1400/),
    ).toBeInTheDocument();
  });

  it('surfaces a 502 from the provider', async () => {
    stubFetch({
      'GET /api/cloud/backup': { settings: CONNECTED, providers: PROVIDERS },
      'POST /api/cloud/backup/run': {
        status: 502,
        payload: { error: 'Dropbox: insufficient_space' },
      },
    });
    render(<CloudBackupSettings />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Back up now' }),
    );
    expect(
      await screen.findByText('Dropbox: insufficient_space'),
    ).toBeInTheDocument();
  });

  // The OAuth callback is a whole browser navigation, so its outcome comes
  // back in the query string — and must not survive a refresh.
  it('reports the OAuth outcome from the callback and scrubs the URL', async () => {
    stubFetch({
      'GET /api/cloud/backup': { settings: CONNECTED, providers: PROVIDERS },
    });
    window.history.replaceState(null, '', '/data?cloud=connected');

    render(<CloudBackupSettings />);
    expect(
      await screen.findByText(/Cloud account connected/),
    ).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('reports a refused authorization', async () => {
    stubFetch({
      'GET /api/cloud/backup': { settings: DISCONNECTED, providers: PROVIDERS },
    });
    window.history.replaceState(
      null,
      '',
      '/data?cloud=error&cloud_error=' + encodeURIComponent('access_denied'),
    );

    render(<CloudBackupSettings />);
    expect(await screen.findByText('access_denied')).toBeInTheDocument();
  });
});
