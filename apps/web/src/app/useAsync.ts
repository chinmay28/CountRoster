import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  /** Re-run the loader (e.g. after a write). */
  reload: () => void;
}

/**
 * Don't reload on every flick back to the tab — a burst of switches costs
 * one refresh, not one each.
 */
export const REFOCUS_RELOAD_MS = 5_000;

/**
 * Run an async loader and track its lifecycle. `deps` controls when it
 * re-runs (same contract as useEffect deps). `reload()` forces a refresh —
 * handy after mutations, since there are no change subscriptions.
 *
 * It also reloads when the page becomes visible again. Every device synced
 * to a server writes to the same data, so a tab or an app left in the
 * background is showing stale numbers the moment another device logs
 * something; coming back to it is when the person looks. That refresh is
 * silent: `loading` stays false and the current data stays on screen until
 * the new data arrives (a failed refresh keeps it), because callers render a
 * placeholder while loading — and swapping a page for "Loading…" would throw
 * away whatever was being typed into it.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const silent = useRef(false);
  const settled = useRef(false);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let lastLoad = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoad < REFOCUS_RELOAD_MS) return;
      lastLoad = Date.now();
      silent.current = true;
      setNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Quiet only once something is on screen to keep showing.
    const quiet = silent.current && settled.current;
    silent.current = false;
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    loader().then(
      (result) => {
        if (cancelled) return;
        settled.current = true;
        setData(result);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled || quiet) return;
        settled.current = true;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
