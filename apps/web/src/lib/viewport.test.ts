import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installAppHeightSync,
  scheduleSettledAppHeightSync,
  syncAppHeight,
} from './viewport.ts';

/** Pretend the layout viewport is `px` tall, as `window.innerHeight` reports. */
function setInnerHeight(px: number): void {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: px,
  });
}

function appHeight(): string {
  return document.documentElement.style.getPropertyValue('--app-height');
}

describe('app height sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // requestAnimationFrame runs synchronously here so we can focus on the
    // debounced settle behavior the keyboard fix relies on.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    document.documentElement.style.removeProperty('--app-height');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes window.innerHeight as --app-height', () => {
    setInnerHeight(812);
    syncAppHeight();
    expect(appHeight()).toBe('812px');
  });

  it('settles to the final height after the resize stream goes quiet', () => {
    setInnerHeight(812);
    scheduleSettledAppHeightSync();
    expect(appHeight()).toBe('812px');

    // Soft keyboard slides up: a resize fires mid-animation at a smaller height.
    setInnerHeight(520);
    scheduleSettledAppHeightSync();
    expect(appHeight()).toBe('520px');

    // The keyboard is dismissed and the viewport grows back, but the final
    // value arrives without another resize event firing (e.g. swipe-to-dismiss
    // on iOS, where the window never refocuses). The debounced re-measure must
    // still catch it.
    setInnerHeight(812);
    vi.advanceTimersByTime(350);
    expect(appHeight()).toBe('812px');
  });

  it('re-measures after startup when first paint under-reported the height', () => {
    // iOS standalone first paint reports the viewport too small, and no resize
    // fires on a passive load to trigger a correction.
    setInnerHeight(600);
    installAppHeightSync();
    expect(appHeight()).toBe('600px');

    // The browser settles the real height a beat later, silently.
    setInnerHeight(812);
    vi.advanceTimersByTime(1000);
    expect(appHeight()).toBe('812px');
  });

  it('debounce coalesces a burst of resize events into one trailing sync', () => {
    setInnerHeight(700);
    installAppHeightSync();

    // A flurry of resize events during the keyboard animation; each resets the
    // settle timer, so the trailing re-measure only fires once it's quiet.
    for (const h of [650, 600, 560, 812]) {
      setInnerHeight(h);
      window.dispatchEvent(new Event('resize'));
    }

    // Final event already applied 812 immediately; advancing past the settle
    // delay must keep it there (and not regress to a stale measurement).
    setInnerHeight(812);
    vi.advanceTimersByTime(350);
    expect(appHeight()).toBe('812px');
  });
});
