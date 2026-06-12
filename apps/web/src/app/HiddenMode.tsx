import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Hidden-tracker mode: a session-only switch that reveals hidden trackers and
 * the "hidden tracker" option on the create form.
 *
 * Unlocking is deliberately undiscoverable: tap the CountRoster logo/word in
 * the header as many times as the current year's digits sum to (2026 → 2+2+6
 * = 10), all within a 10-second window. While unlocked, 3 taps within 3
 * seconds lock it again. The state lives only in React — killing or reloading
 * the app always relocks it.
 */

/** How many brand taps unlock hidden mode: the digit sum of `year`. */
export function unlockTapCount(year: number): number {
  return String(year)
    .split('')
    .reduce((sum, digit) => sum + Number(digit), 0);
}

const UNLOCK_WINDOW_MS = 10_000;
const LOCK_TAP_COUNT = 3;
const LOCK_WINDOW_MS = 3_000;

interface HiddenModeValue {
  /** Whether hidden trackers are currently revealed. */
  enabled: boolean;
  /** Register one tap on the header brand (logo or text). */
  registerTap: () => void;
}

/**
 * Defaulting to "locked, taps ignored" (rather than throwing) keeps
 * components usable in trees that don't mount the app chrome.
 */
const HiddenModeContext = createContext<HiddenModeValue>({
  enabled: false,
  registerTap: () => {},
});

export function HiddenModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  // Tap timestamps (ms). A ref, not state: taps shouldn't re-render anything
  // until the mode actually flips.
  const taps = useRef<number[]>([]);
  // Mirrors `enabled` so registerTap stays a stable callback.
  const enabledRef = useRef(false);

  const registerTap = useCallback(() => {
    const now = Date.now();
    const windowMs = enabledRef.current ? LOCK_WINDOW_MS : UNLOCK_WINDOW_MS;
    const needed = enabledRef.current
      ? LOCK_TAP_COUNT
      : unlockTapCount(new Date().getFullYear());
    taps.current = [...taps.current.filter((t) => now - t < windowMs), now];
    if (taps.current.length >= needed) {
      taps.current = [];
      enabledRef.current = !enabledRef.current;
      setEnabled(enabledRef.current);
    }
  }, []);

  return (
    <HiddenModeContext.Provider value={{ enabled, registerTap }}>
      {children}
    </HiddenModeContext.Provider>
  );
}

export function useHiddenMode(): HiddenModeValue {
  return useContext(HiddenModeContext);
}
