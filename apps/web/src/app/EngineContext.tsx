import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { fetchEngineStatus, type EngineStatus } from '../api/engine.ts';

interface EngineContextValue {
  /** The on-device engine's status; null in a browser (no engine). */
  status: EngineStatus | null;
  /** Re-read the status (after a switch, or when the app comes back). */
  refresh: () => Promise<void>;
  /** Replace the status with one an engine call already returned. */
  setStatus: (status: EngineStatus) => void;
}

const NO_ENGINE: EngineContextValue = {
  status: null,
  refresh: async () => {},
  setStatus: () => {},
};

const EngineContext = createContext<EngineContextValue>(NO_ENGINE);

/**
 * Asks once whether an on-device engine is serving this page (the mobile
 * app) and shares the answer. Without a provider — or in a browser — the
 * value says "no engine", so everything keyed on it simply doesn't render.
 */
export function EngineProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const refresh = useCallback(async () => {
    setStatus(await fetchEngineStatus());
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <EngineContext.Provider value={{ status, refresh, setStatus }}>
      {children}
    </EngineContext.Provider>
  );
}

/** Provide a fixed value — component tests. */
export function EngineValueProvider({
  value,
  children,
}: {
  value: Partial<EngineContextValue>;
  children: ReactNode;
}) {
  return (
    <EngineContext.Provider value={{ ...NO_ENGINE, ...value }}>{children}</EngineContext.Provider>
  );
}

export function useEngine(): EngineContextValue {
  return useContext(EngineContext);
}
