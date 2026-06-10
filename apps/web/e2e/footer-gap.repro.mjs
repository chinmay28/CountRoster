// Standalone Playwright repro for the mobile footer/tab-bar gap.
//
// We can't summon a real iOS soft keyboard in headless Chromium, but the bug's
// mechanism is simple: the app sized its shell from `window.innerHeight`, and on
// iOS that value under-reports the visible height (on first paint, and it stays
// stuck at the keyboard-reduced height after dismiss). We reproduce exactly that
// condition by making `innerHeight` report less than the real visible height
// while `visualViewport.height` stays correct — then check whether the tab bar
// sits flush at the bottom or leaves a gap.
import { chromium } from 'playwright';

const URL = process.env.APP_URL ?? 'http://127.0.0.1:8787/';
const EXECUTABLE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const VIEWPORT = { width: 390, height: 844 }; // iPhone 12/13/14-ish
const FAKE_INNER_HEIGHT = 700; // iOS under-reporting: 144px short of the real 844

// Before any app code runs, make innerHeight lie (smaller) while the visual
// viewport keeps reporting the true visible height — the real iOS situation.
const initScript = (fakeInner) => {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    get: () => fakeInner,
  });
};

async function measure(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.tab-bar');
    const rect = bar?.getBoundingClientRect();
    return {
      appHeight: getComputedStyle(document.documentElement)
        .getPropertyValue('--app-height')
        .trim(),
      tabBarBottom: rect ? Math.round(rect.bottom) : null,
      visibleHeight: window.visualViewport?.height ?? window.innerHeight,
    };
  });
}

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: VIEWPORT });
await page.addInitScript(initScript, FAKE_INNER_HEIGHT);
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.tab-bar');
await page.waitForTimeout(1200); // let startup re-syncs settle

const m = await measure(page);
const gap = m.visibleHeight - m.tabBarBottom;
console.log(JSON.stringify({ ...m, gapBelowTabBar: Math.round(gap) }, null, 2));

await page.screenshot({ path: 'apps/web/e2e/footer-gap.png' });

await browser.close();

if (gap > 2) {
  console.error(`\nFAIL: ${Math.round(gap)}px gap below the tab bar (bug reproduced).`);
  process.exit(1);
}
console.log('\nPASS: tab bar is flush with the bottom of the visible viewport.');
