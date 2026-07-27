import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { CoreProvider } from './app/CoreContext.tsx';
import { AppLayout } from './app/AppLayout.tsx';
import { HiddenModeProvider } from './app/HiddenMode.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { TrackerDetailPage } from './pages/TrackerDetailPage.tsx';
import { TrackerFormPage } from './pages/TrackerFormPage.tsx';
import { GroupsPage } from './pages/GroupsPage.tsx';
import { TransactionsPage } from './pages/TransactionsPage.tsx';
import { DataPage } from './pages/DataPage.tsx';
import { QuickLogPage } from './pages/QuickLogPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import './styles.css';

/**
 * Browser (history) routing gives clean URLs. The server serves index.html for
 * any non-API GET (SPA fallback), so deep links and refreshes resolve.
 */
const router = createBrowserRouter([
  // The quick-log screen sits *outside* the app shell: it's the bookmark /
  // Home Screen target for a single tracker, so it renders full-bleed with no
  // header, tab bar, or footer competing for the tap.
  { path: '/trackers/:id/quick', element: <QuickLogPage /> },
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'trackers/new', element: <TrackerFormPage /> },
      { path: 'trackers/:id', element: <TrackerDetailPage /> },
      { path: 'trackers/:id/edit', element: <TrackerFormPage /> },
      { path: 'groups', element: <GroupsPage /> },
      { path: 'transactions', element: <TransactionsPage /> },
      { path: 'data', element: <DataPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <CoreProvider>
      {/* Above the router, so hidden mode spans every route — including the
          quick-log screen, which renders outside the app shell. Unlocking it
          and stepping onto that screen must not relock on the way back. */}
      <HiddenModeProvider>
        <RouterProvider router={router} />
      </HiddenModeProvider>
    </CoreProvider>
  </StrictMode>,
);
