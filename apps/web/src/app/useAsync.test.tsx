import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useAsync, REFOCUS_RELOAD_MS } from './useAsync.ts';

/** Shows what a page would: a placeholder while loading, else the data. */
function Probe({ loader }: { loader: () => Promise<string> }) {
  const { data, loading, error } = useAsync(loader, []);
  if (loading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;
  return (
    <div>
      <p>{data}</p>
      {/* Stands in for a half-filled form the refresh must not wipe. */}
      <input aria-label="draft" defaultValue="" />
    </div>
  );
}

function becomeVisible() {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useAsync refresh on focus', () => {
  it('reloads quietly when the page comes back, keeping what is on screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    let release: () => void = () => {};
    const loader = vi.fn(() => {
      n += 1;
      const value = `count ${n}`;
      if (n === 1) return Promise.resolve(value);
      return new Promise<string>((resolve) => {
        release = () => resolve(value);
      });
    });
    render(<Probe loader={loader} />);
    expect(await screen.findByText('count 1')).toBeInTheDocument();
    const draft = screen.getByLabelText('draft') as HTMLInputElement;
    draft.value = 'half typed';

    // Too soon after the last load: no refresh.
    becomeVisible();
    expect(loader).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(REFOCUS_RELOAD_MS + 1);
    becomeVisible();
    expect(loader).toHaveBeenCalledTimes(2);
    // While it's in flight the page stays as it was — no "Loading…".
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.getByText('count 1')).toBeInTheDocument();

    await act(async () => release());
    expect(await screen.findByText('count 2')).toBeInTheDocument();
    expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('half typed');
  });

  it('keeps the old data when a quiet refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const loader = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('count 1')
      .mockRejectedValueOnce(new Error('server unreachable'));
    render(<Probe loader={loader} />);
    expect(await screen.findByText('count 1')).toBeInTheDocument();

    vi.advanceTimersByTime(REFOCUS_RELOAD_MS + 1);
    becomeVisible();
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByText('count 1')).toBeInTheDocument();
    expect(screen.queryByText(/Error/)).not.toBeInTheDocument();
  });
});
