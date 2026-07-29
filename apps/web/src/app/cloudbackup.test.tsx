import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudBackupSettings } from '../components/CloudBackupSettings.tsx';
import type {
  CloudBackupSettings as Settings,
  CloudProviderInfo,
} from '../api/cloud.ts';

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

const PROVIDERS: CloudProviderInfo[] = [
  {
    id: 'dropbox',
    name: 'Dropbox',
    configured: 1,
    client_id: 'app-key',
    has_secret: 0,
    secret_required: 0,
    source: 'settings',
    setup_url: 'https://www.dropbox.com/developers/apps',
  },
  {
    id: 'google_drive',
    name: 'Google Drive',
    configured: 0,
    client_id: '',
    has_secret: 0,
    secret_required: 1,
    source: '',
    setup_url: 'https://console.cloud.google.com/apis/credentials',
  },
];

const REDIRECT_URI = 'https://roster.example/api/cloud/backup/callback';

/** The GET payload, with the fields every render reads. */
function state(settings: Settings, providers: CloudProviderInfo[] = PROVIDERS) {
  return { settings, providers, redirect_uri: REDIRECT_URI };
}

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
  // A provider with no OAuth client gets a working "Set up" button, not a
  // dead "Connect" with the reason buried in a tooltip no touch screen shows.
  it('offers Connect for a ready provider and Set up for one that needs it', async () => {
    stubFetch({ 'GET /api/cloud/backup': state(DISCONNECTED) });
    render(<CloudBackupSettings />);

    expect(await screen.findByText('Dropbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();

    expect(screen.getByText('Google Drive')).toBeInTheDocument();
    const setUp = screen.getByRole('button', { name: 'Set up' });
    expect(setUp).toBeEnabled();
    expect(screen.getByText('Needs a one-time setup')).toBeInTheDocument();
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
      'GET /api/cloud/backup': state(DISCONNECTED),
      'POST /api/cloud/backup/connect': {
        authorize_url: 'https://www.dropbox.com/oauth2/authorize?x=1',
      },
    });
    // jsdom can't navigate; the assertion is that we asked it to.
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, search: '' });

    render(<CloudBackupSettings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

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
      'GET /api/cloud/backup': state(CONNECTED),
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
      'GET /api/cloud/backup': state({
        ...CONNECTED,
        last_status: 'error',
        last_error: 'Dropbox: path/not_found',
        last_file_name: null,
      }),
    });
    render(<CloudBackupSettings />);
    expect(
      await screen.findByText(/Last backup failed.*path\/not_found/),
    ).toBeInTheDocument();
  });

  it('changes the schedule', async () => {
    const calls = stubFetch({
      'GET /api/cloud/backup': state(CONNECTED),
      'PATCH /api/cloud/backup': state({ ...CONNECTED, frequency: 'weekly' }),
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
      'GET /api/cloud/backup': state({
        ...CONNECTED,
        folder_id: null,
        folder_path: null,
        frequency: 'off',
      }),
    });
    render(<CloudBackupSettings />);

    expect(await screen.findByLabelText('Frequency')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
    expect(screen.getByText('No folder chosen yet')).toBeInTheDocument();
  });

  it('browses into a folder and saves it as the destination', async () => {
    const calls = stubFetch({
      'GET /api/cloud/backup': state({ ...CONNECTED, folder_id: null, folder_path: null }),
      'GET /api/cloud/backup/folders': {
        folders: [{ id: '/Apps', name: 'Apps', path: '/Apps' }],
      },
      'PATCH /api/cloud/backup': state({
        ...CONNECTED,
        folder_id: '/Apps',
        folder_path: '/Apps',
      }),
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
      'GET /api/cloud/backup': state(CONNECTED),
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
      'GET /api/cloud/backup': state(CONNECTED),
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
      'GET /api/cloud/backup': state(CONNECTED),
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
      'GET /api/cloud/backup': state(DISCONNECTED),
    });
    window.history.replaceState(
      null,
      '',
      '/data?cloud=error&cloud_error=' + encodeURIComponent('access_denied'),
    );

    render(<CloudBackupSettings />);
    expect(await screen.findByText('access_denied')).toBeInTheDocument();
  });
  // The point of the whole setup form: getting a provider working must be
  // possible from the phone in your hand, with no shell on the server.
  it('sets a provider up from the page, with no CLI involved', async () => {
    const READY: CloudProviderInfo = {
      ...PROVIDERS[1]!,
      configured: 1,
      client_id: 'pasted-id',
      has_secret: 1,
      source: 'settings',
    };
    const calls = stubFetch({
      'GET /api/cloud/backup': state(DISCONNECTED),
      'PUT /api/cloud/backup/providers/google_drive': state(DISCONNECTED, [
        PROVIDERS[0]!,
        READY,
      ]),
    });
    render(<CloudBackupSettings />);

    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }));

    // The redirect URI is the step people get wrong, so it's shown verbatim.
    expect(screen.getByText(REDIRECT_URI)).toBeInTheDocument();
    // And the console is one tap away rather than a paragraph of instructions.
    expect(
      screen.getByRole('link', { name: /developer console/ }),
    ).toHaveAttribute('href', PROVIDERS[1]!.setup_url);

    await userEvent.type(screen.getByLabelText('Client id'), 'pasted-id');
    await userEvent.type(
      screen.getByLabelText(/Client secret/),
      'pasted-secret',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save setup' }));

    await waitFor(() =>
      expect(calls.at(-1)).toMatchObject({
        method: 'PUT',
        body: { client_id: 'pasted-id', client_secret: 'pasted-secret' },
      }),
    );
    // Having saved, the provider is connectable — two Connect buttons now.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2),
    );
  });

  // Google rejects a PKCE-only client; the form says so up front rather than
  // letting the failure land at the token endpoint after a consent screen.
  it('marks the client secret required where the provider demands one', async () => {
    stubFetch({ 'GET /api/cloud/backup': state(DISCONNECTED) });
    render(<CloudBackupSettings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    expect(screen.getByLabelText(/Client secret \(required\)/)).toBeInTheDocument();
  });

  it('surfaces a rejected client id from the server', async () => {
    stubFetch({
      'GET /api/cloud/backup': state(DISCONNECTED),
      'PUT /api/cloud/backup/providers/google_drive': {
        status: 400,
        payload: {
          error: 'Validation failed',
          issues: [{ message: 'A client id is required.' }],
        },
      },
    });
    render(<CloudBackupSettings />);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save setup' }));
    expect(await screen.findByText('Validation failed')).toBeInTheDocument();
  });

  // A client id pinned by a startup flag still works, and is labelled as
  // coming from the server so nobody wonders where it was set.
  it('shows a server-supplied client id as such', async () => {
    stubFetch({
      'GET /api/cloud/backup': state(DISCONNECTED, [
        { ...PROVIDERS[0]!, source: 'server' },
        PROVIDERS[1]!,
      ]),
    });
    render(<CloudBackupSettings />);
    expect(await screen.findByText('Set up on the server')).toBeInTheDocument();
  });
});
