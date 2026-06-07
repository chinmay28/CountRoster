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
 * Pin the app shell to the *actual* visible height. iOS (especially installed
 * standalone PWAs) reports CSS viewport units (100vh/100dvh) too small on the
 * first paint and only corrects after an interaction, which strands the fixed
 * bottom tab bar above the real bottom until you navigate. window.innerHeight
 * is reliable, so we publish it as --app-height (read by the mobile shell in
 * styles.css) and keep it current as the viewport changes.
 */
function syncAppHeight() {
  document.documentElement.style.setProperty(
    '--app-height',
    `${window.innerHeight}px`,
  );
}
syncAppHeight();
window.addEventListener('resize', syncAppHeight);
window.addEventListener('orientationchange', syncAppHeight);
window.addEventListener('pageshow', syncAppHeight);
window.visualViewport?.addEventListener('resize', syncAppHeight);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <CoreProvider>
      <RouterProvider router={router} />
    </CoreProvider>
  </StrictMode>,
);
