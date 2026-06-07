import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { CoreProvider } from './app/CoreContext.tsx';
import { AppLayout } from './app/AppLayout.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { TrackerDetailPage } from './pages/TrackerDetailPage.tsx';
import { TrackerFormPage } from './pages/TrackerFormPage.tsx';
import { GroupsPage } from './pages/GroupsPage.tsx';
import { DataPage } from './pages/DataPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import './styles.css';

// The comparison page is chart-heavy (Observable Plot); load it on demand.
const ComparePage = lazy(() =>
  import('./pages/ComparePage.tsx').then((m) => ({ default: m.ComparePage })),
);

/**
 * Browser (history) routing gives clean URLs. The server serves index.html for
 * any non-API GET (SPA fallback), so deep links and refreshes resolve.
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'trackers/new', element: <TrackerFormPage /> },
      { path: 'trackers/:id', element: <TrackerDetailPage /> },
      { path: 'trackers/:id/edit', element: <TrackerFormPage /> },
      { path: 'groups', element: <GroupsPage /> },
      {
        path: 'compare',
        element: (
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <ComparePage />
          </Suspense>
        ),
      },
      { path: 'data', element: <DataPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

/**
 * Pin the app shell to the *actual* visible height. iOS home-screen PWAs
 * (display: standalone) report window.innerHeight too SHORT on the first paint
 * and frequently never fire a resize to correct it, which strands the bottom
 * tab bar above the real bottom until a navigation forces a relayout. So we
 * publish the measured height as --app-height (read by the mobile shell in
 * styles.css) and, crucially, re-measure aggressively after the webview
 * settles — on events AND via rAF / load / delayed timers — rather than once.
 */
function syncAppHeight() {
  document.documentElement.style.setProperty(
    '--app-height',
    `${window.innerHeight}px`,
  );
}
syncAppHeight();
for (const ev of ['resize', 'orientationchange', 'pageshow', 'load', 'focus']) {
  window.addEventListener(ev, syncAppHeight);
}
window.visualViewport?.addEventListener('resize', syncAppHeight);
window.visualViewport?.addEventListener('scroll', syncAppHeight);
document.addEventListener('visibilitychange', syncAppHeight);
// The standalone webview's true height only becomes available after the first
// frame(s); re-read across several beats to catch it without a navigation.
requestAnimationFrame(() => {
  syncAppHeight();
  requestAnimationFrame(syncAppHeight);
});
for (const t of [50, 150, 300, 600, 1000, 1500]) setTimeout(syncAppHeight, t);

// ---- TEMPORARY diagnostics overlay (remove once the standalone bug is fixed).
// Shows what iOS actually reports so we can compare first load vs. navigation.
function mountViewportDebug() {
  const box = document.createElement('div');
  box.id = 'vh-debug';
  box.style.cssText =
    'position:fixed;top:0;left:0;z-index:99999;font:11px/1.35 ui-monospace,monospace;' +
    'background:rgba(0,0,0,.82);color:#3cf;padding:6px 8px;white-space:pre;' +
    'pointer-events:none;border-bottom-right-radius:8px;';
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;bottom:0;left:0;width:0;height:env(safe-area-inset-bottom);';
  let ticks = 0;
  let lastEvent = 'init';
  const appH = () =>
    getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim();
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  const render = () => {
    const vv = window.visualViewport;
    box.textContent =
      `tick ${ticks}  ev:${lastEvent}\n` +
      `innerH        ${window.innerHeight}\n` +
      `vv.height     ${vv ? Math.round(vv.height) : '-'}\n` +
      `docEl.clientH ${document.documentElement.clientHeight}\n` +
      `--app-height  ${appH()}\n` +
      `safe-bottom   ${Math.round(probe.getBoundingClientRect().height)}\n` +
      `standalone    ${standalone}`;
  };
  const tick = (ev: string) => {
    ticks++;
    lastEvent = ev;
    render();
  };
  const start = () => {
    document.body.append(probe, box);
    render();
    for (const ev of ['resize', 'orientationchange', 'pageshow', 'load']) {
      window.addEventListener(ev, () => tick(ev));
    }
    window.visualViewport?.addEventListener('resize', () => tick('vv-resize'));
    window.setInterval(() => tick('interval'), 500);
  };
  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start);
}
mountViewportDebug();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <CoreProvider>
      <RouterProvider router={router} />
    </CoreProvider>
  </StrictMode>,
);
