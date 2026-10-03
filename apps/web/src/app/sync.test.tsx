import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SyncSettings } from '../components/SyncSettings.tsx';
import { EngineValueProvider } from './EngineContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { CoreValueProvider } from './CoreContext.tsx';
import type { EngineStatus, ProbeResult } from '../api/engine.ts';
import { makeTestCore } from '../test/makeTestCore.ts';

/**
 * The mobile app's Sync settings. Like cloud backup, it has no domain half
 * in the browser — the switching happens in the on-device engine — so these
 * drive it against a stubbed `fetch` and check what was actually asked for.
 */

const LOCAL: EngineStatus = {
  mode: 'local',
  remote_url: null,
  remote_version: null,
  remote_api_level: null,
  remote_compatible: true,
  local_empty: false,
  version: 'v2026.10.1',
  api_level: 1,
  safety_bundles: [],
};

const REMOTE: EngineStatus = {
  ...LOCAL,
  mode: 'remote',
  remote_url: 'http://pi.local:8787',
  remote_version: 'v2026.10.1',
  remote_api_level: 1,
};

function probe(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    url: 'http://pi.local:8787',
    version: 'v2026.10.1',
    api_level: 1,
    empty: true,
    compatible: true,
    local_empty: false,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stubFetch(routes: Record<string, { status?: number; payload: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const route = routes[`${method} ${url}`];
      if (!route) throw new Error(`unstubbed request: ${method} ${url}`);
      const status = route.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(route.payload),
      } as Response;
    }),
  );
  return calls;
}

function renderSync(status: EngineStatus | null) {
  const onSwitched = vi.fn();
  const setStatus = vi.fn();
  render(
    <EngineValueProvider value={{ status, setStatus }}>
      <SyncSettings onSwitched={onSwitched} />
    </EngineValueProvider>,
  );
  return { onSwitched, setStatus };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SyncSettings', () => {
  it('renders nothing in a browser (no engine)', () => {
    const { container } = render(<SyncSettings />);
    expect(container).toBeEmptyDOMElement();
  });

  it('moves this device’s data to an empty server by default', async () => {
    const calls = stubFetch({
      'POST /_engine/sync/probe': { payload: probe({ empty: true }) },
      'POST /_engine/sync/enable': { payload: REMOTE },
    });
    const { onSwitched, setStatus } = renderSync(LOCAL);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Server address'), 'pi.local:8787');
    await user.click(screen.getByRole('button', { name: 'Check server' }));
    expect(await screen.findByText(/it has no data yet/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Move this device’s data to the server/)).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Turn on sync' }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(setStatus).toHaveBeenCalledWith(REMOTE);
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ['/_engine/sync/probe', { url: 'pi.local:8787' }],
      // The probe's normalized URL is what gets enabled.
      ['/_engine/sync/enable', { url: 'http://pi.local:8787', strategy: 'move_to_server' }],
    ]);
  });

  it('asks before replacing a server that has data, and defaults to keeping it', async () => {
    const calls = stubFetch({
      'POST /_engine/sync/probe': { payload: probe({ empty: false }) },
      'POST /_engine/sync/enable': { payload: REMOTE },
    });
    renderSync(LOCAL);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Server address'), 'pi.local:8787');
    await user.click(screen.getByRole('button', { name: 'Check server' }));

    expect(await screen.findByLabelText(/Use the server’s data/)).toBeChecked();
    await user.click(screen.getByLabelText(/Replace the server’s data with this device’s/));
    const turnOn = screen.getByRole('button', { name: 'Turn on sync' });
    expect(turnOn).toBeDisabled(); // not until the overwrite is confirmed
    await user.click(screen.getByLabelText(/Yes, replace the server’s data/));
    await user.click(turnOn);
    await waitFor(() =>
      expect(calls.at(-1)?.body).toEqual({ url: 'http://pi.local:8787', strategy: 'replace_server' }),
    );
  });

  it('just connects when this device has nothing to lose', async () => {
    const calls = stubFetch({
      'POST /_engine/sync/probe': { payload: probe({ empty: false, local_empty: true }) },
      'POST /_engine/sync/enable': { payload: REMOTE },
    });
    renderSync({ ...LOCAL, local_empty: true });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Server address'), 'pi.local:8787');
    await user.click(screen.getByRole('button', { name: 'Check server' }));
    await user.click(await screen.findByRole('button', { name: 'Turn on sync' }));
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ url: 'http://pi.local:8787', strategy: 'use_server' }));
  });

  it('refuses a server older than the app', async () => {
    stubFetch({
      'POST /_engine/sync/probe': { payload: probe({ compatible: false, api_level: 0, version: 'v2026.8.300' }) },
    });
    renderSync(LOCAL);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Server address'), 'pi.local:8787');
    await user.click(screen.getByRole('button', { name: 'Check server' }));
    expect(await screen.findByText(/older than this app/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on sync' })).not.toBeInTheDocument();
  });

  it('shows why a server couldn’t be reached', async () => {
    stubFetch({
      'POST /_engine/sync/probe': { status: 502, payload: { error: 'can’t reach the server: connection refused' } },
    });
    renderSync(LOCAL);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Server address'), 'pi.local:8787');
    await user.click(screen.getByRole('button', { name: 'Check server' }));
    expect(await screen.findByText(/connection refused/)).toBeInTheDocument();
  });

  it('turns sync off keeping a copy of the server’s data by default', async () => {
    const calls = stubFetch({ 'POST /_engine/sync/disable': { payload: LOCAL } });
    const { onSwitched } = renderSync(REMOTE);
    expect(screen.getByText('http://pi.local:8787')).toBeInTheDocument();
    expect(screen.getByLabelText(/Keep a copy of the server’s data/)).toBeChecked();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn off sync' }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(calls[0]?.body).toEqual({ strategy: 'copy_from_server' });
  });

  it('warns when the synced server turned out older than the app', () => {
    renderSync({ ...REMOTE, remote_compatible: false, remote_api_level: 0 });
    expect(screen.getByText(/changes are paused/)).toBeInTheDocument();
  });

  it('lists the safety backups with what each one holds', () => {
    renderSync({
      ...REMOTE,
      safety_bundles: [
        { name: '20261003T120000.000Z-server-before-replace.countroster.zip', created_at: '2026-10-03T12:00:00.000Z', size: 2048 },
        { name: '20261003T110000.000Z-before-sync.countroster.zip', created_at: '2026-10-03T11:00:00.000Z', size: 10 },
      ],
    });
    expect(screen.getByText('The server’s data, before it was replaced')).toBeInTheDocument();
    expect(screen.getByText('This device’s data, before sync')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
  });
});

describe('the footer says where the data lives', () => {
  async function footerFor(status: EngineStatus | null) {
    const { core } = await makeTestCore();
    render(
      <CoreValueProvider value={{ core, connected: true }}>
        <EngineValueProvider value={{ status }}>
          <MemoryRouter>
            <AppLayout />
          </MemoryRouter>
        </EngineValueProvider>
      </CoreValueProvider>,
    );
    return document.querySelector('.app__footer')?.textContent;
  }

  it('on this device in local mode', async () => {
    expect(await footerFor(LOCAL)).toMatch(/Stored on this device/);
  });
  it('names the server when synced', async () => {
    expect(await footerFor(REMOTE)).toMatch(/Synced to pi\.local:8787/);
  });
  it('is unchanged in a browser', async () => {
    expect(await footerFor(null)).toMatch(/Synced to your CountRoster server/);
  });
});
