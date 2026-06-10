/**
 * Mobile shell sizing. iOS (especially installed standalone PWAs) reports CSS
 * viewport units (100vh/100dvh) too small on first paint and only corrects
 * after an interaction, which strands the in-flow bottom tab bar above the real
 * bottom until you navigate. `window.innerHeight` is reliable, so we publish it
 * as `--app-height` (read by the mobile shell in styles.css).
 *
 * The catch: `window.innerHeight` can also be measured *wrong* transiently —
 * most notably while a native `window.confirm()`/`alert()` dialog is open. If we
 * publish that stale value and no further resize event fires, `.app` (which is
 * `overflow: hidden`) clips the tab bar off-screen and it stays hidden until the
 * app is backgrounded/reopened (`pageshow`). To avoid that, every sync also
 * re-measures on the next animation frame: a frame scheduled while a modal
 * dialog blocks the main thread only runs once the dialog closes and layout has
 * settled, so a bad measurement self-corrects.
 */
export function syncAppHeight(): void {
  document.documentElement.style.setProperty(
    '--app-height',
    `${window.innerHeight}px`,
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
 * stops changing. The soft keyboard animates `window.innerHeight` over several
 * hundred ms, firing resize events throughout; the immediate + next-frame
 * measurements above can both land mid-animation on a too-small height. When
 * the keyboard is dismissed by swipe/"done" the window never refocuses, so —
 * unlike a native dialog — no later event corrects that stale value, and the
 * shell stays sized too short, stranding the in-flow tab bar upward and leaving
 * a gap at the bottom. Debouncing a final measurement that fires only after the
 * resize stream goes quiet guarantees the shell settles to the true height,
 * however long the animation runs.
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
