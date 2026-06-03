import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createApiClient, API_BASE, type ApiCore } from '../api/client.ts';

interface CoreContextValue {
  /** The API-backed services the UI talks to. */
  core: ApiCore;
  /** Whether the backend has answered a health check. */
  connected: boolean;
}

const CoreContext = createContext<CoreContextValue | null>(null);

/**
 * Provide the API client to the tree. Unlike the old local-first boot, there's
 * no async DB to open — the client is created synchronously. We do a one-shot
 * health check so the chrome can surface an "offline / server unreachable"
 * banner, but the app renders immediately either way.
 */
export function CoreProvider({ children }: { children: ReactNode }) {
  const core = useMemo(() => createApiClient(), []);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/health`)
      .then((res) => {
        if (!cancelled) setConnected(res.ok);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <CoreContext.Provider value={{ core, connected }}>
      {children}
    </CoreContext.Provider>
  );
}

/**
 * Provide an already-constructed core directly, bypassing the API client.
 * Used by tests (which wire a MemoryAdapter-backed core) and any host that
 * wants to own the lifecycle itself.
 */
export function CoreValueProvider({
  value,
  children,
}: {
  value: CoreContextValue;
  children: ReactNode;
}) {
  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>;
}

/** Access the context. Throws if used outside <CoreProvider>. */
export function useCoreContext(): CoreContextValue {
  const ctx = useContext(CoreContext);
  if (!ctx) {
    throw new Error('useCoreContext must be used within <CoreProvider>');
  }
  return ctx;
}

/** Convenience: just the core services. */
export function useCore(): ApiCore {
  return useCoreContext().core;
}
