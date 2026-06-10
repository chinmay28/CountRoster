/**
 * Mobile shell sizing. The mobile shell (`.app`) is locked to `--app-height`
 * with the tab bar as an in-flow child at its bottom, so `--app-height` must
 * equal the *actually visible* height or the bar drifts off the real bottom.
 *
 * The source of truth is `window.visualViewport.height`, not
 * `window.innerHeight`. On iOS — especially installed standalone PWAs — the
 * layout viewport (`innerHeight`) is reported too small on first paint and is
 * left at the keyboard-reduced height after the keyboard is dismissed, so
 * publishing it sizes the shell short and leaves a gap below the tab bar (both
 * on first load and after every keyboard dismiss). The *visual* viewport tracks
 * the real visible area: it's correct at rest, shrinks to the area above the
 * keyboard while typing (so the tab bar rides just above it), and restores
 * exactly on dismiss. We fall back to `innerHeight` only where `visualViewport`
 * is unavailable.
 */
function visibleHeight(): number {
  const vv = window.visualViewport;
  if (vv && vv.height > 0) return vv.height;
  return window.innerHeight;
}

export function syncAppHeight(): void {
  document.documentElement.style.setProperty(
    '--app-height',
    `${visibleHeight()}px`,
  );
}

/**
 * Sync now, then again on the next frame so a measurement taken at a bad moment
 * (e.g. while a native dialog is open) is corrected once layout settles.
 */
export function scheduleAppHeightSync(): void {
  syncAppHeight();
  requestAnimationFrame(syncAppHeight);
}

/**
 * How long the viewport must be quiet before we trust a measurement as the
 * settled value. Comfortably longer than a soft-keyboard slide animation
 * (~250ms on iOS) so the debounced re-measure fires only after it finishes.
 */
const SETTLE_DELAY_MS = 350;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Like {@link scheduleAppHeightSync}, but also re-measures once the viewport
 * stops changing. The soft keyboard animates the visible height over several
 * hundred ms, firing resize events throughout; the immediate + next-frame
 * measurements above can both land mid-animation on a transient height.
 * Debouncing a final measurement that fires only after the resize stream goes
 * quiet guarantees the shell settles to the true height, however long the
 * animation runs.
 */
export function scheduleSettledAppHeightSync(): void {
  scheduleAppHeightSync();
  if (settleTimer !== undefined) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = undefined;
    syncAppHeight();
  }, SETTLE_DELAY_MS);
}

/**
 * Staged re-measurements after startup. iOS standalone PWAs report the viewport
 * height too small on first paint and only correct it a beat later — and on a
 * passive first load no resize/interaction fires to trigger a re-sync, so the
 * shell stays sized short and leaves a gap below the tab bar. Re-measuring at a
 * spread of delays catches the corrected height however long the browser takes
 * to settle it, without depending on an event we might never hear.
 */
const STARTUP_RESYNC_DELAYS_MS = [100, 300, 600, 1000];

/** Wire up the viewport listeners that keep `--app-height` current. */
export function installAppHeightSync(): void {
  scheduleSettledAppHeightSync();
  // First paint may report a too-small height; re-measure as the browser
  // settles, and again once all resources have loaded.
  for (const delay of STARTUP_RESYNC_DELAYS_MS) {
    setTimeout(syncAppHeight, delay);
  }
  window.addEventListener('load', syncAppHeight);
  window.addEventListener('resize', scheduleSettledAppHeightSync);
  window.addEventListener('orientationchange', scheduleSettledAppHeightSync);
  window.addEventListener('pageshow', scheduleSettledAppHeightSync);
  // Refocusing the window after a native dialog closes is the safety net that
  // restores the tab bar even if no resize fired around the dialog.
  window.addEventListener('focus', scheduleSettledAppHeightSync);
  window.visualViewport?.addEventListener('resize', scheduleSettledAppHeightSync);
}
