import { StrictMode } from 'react';
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
      <RouterProvider router={router} />
    </CoreProvider>
  </StrictMode>,
);
