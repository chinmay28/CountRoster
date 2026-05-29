import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { CountRosterCore } from '@countroster/core';
import { bootApp, type BootedApp } from '../db/bootstrap.ts';

interface CoreContextValue {
  core: CountRosterCore;
  /** Whether data persists across reloads (OPFS) or is in-memory only. */
  persistent: boolean;
}

const CoreContext = createContext<CoreContextValue | null>(null);

type BootState =
  | { status: 'loading' }
  | { status: 'ready'; booted: BootedApp }
  | { status: 'error'; error: Error };

/**
 * Boots the core (open adapter → createApp → migrations) and provides it to
 * the tree. Renders a loading state while the wasm/DB initializes and a
 * clear error if it fails.
 */
export function CoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    bootApp().then(
      (booted) => {
        if (!cancelled) setState({ status: 'ready', booted });
      },
      (err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="boot boot--loading" role="status">
        <p>Opening your local database…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="boot boot--error" role="alert">
        <h1>Couldn’t start CountRoster</h1>
        <p>{state.error.message}</p>
      </div>
    );
  }

  return (
    <CoreContext.Provider
      value={{
        core: state.booted.core,
        persistent: state.booted.persistent,
      }}
    >
      {children}
    </CoreContext.Provider>
  );
}

/**
 * Provide an already-constructed core directly, bypassing the async boot.
 * Used by tests (which wire a MemoryAdapter-backed core) and any future
 * host that wants to own the boot lifecycle itself.
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

/** Access the booted core. Throws if used outside <CoreProvider>. */
export function useCoreContext(): CoreContextValue {
  const ctx = useContext(CoreContext);
  if (!ctx) {
    throw new Error('useCoreContext must be used within <CoreProvider>');
  }
  return ctx;
}

/** Convenience: just the core services. */
export function useCore(): CountRosterCore {
  return useCoreContext().core;
}
