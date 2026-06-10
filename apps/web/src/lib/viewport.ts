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

/** Wire up the viewport listeners that keep `--app-height` current. */
export function installAppHeightSync(): void {
  scheduleAppHeightSync();
  window.addEventListener('resize', scheduleAppHeightSync);
  window.addEventListener('orientationchange', scheduleAppHeightSync);
  window.addEventListener('pageshow', scheduleAppHeightSync);
  // Refocusing the window after a native dialog closes is the safety net that
  // restores the tab bar even if no resize fired around the dialog.
  window.addEventListener('focus', scheduleAppHeightSync);
  window.visualViewport?.addEventListener('resize', scheduleAppHeightSync);
}
