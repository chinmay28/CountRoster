import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { CoreProvider } from './app/CoreContext.tsx';
import { AppLayout } from './app/AppLayout.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { TrackerDetailPage } from './pages/TrackerDetailPage.tsx';
import { TrackerFormPage } from './pages/TrackerFormPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import './styles.css';

/**
 * Hash routing keeps the SPA working on any static host without server-side
 * rewrite rules — fitting for a local-first, server-free app.
 */
const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'trackers/new', element: <TrackerFormPage /> },
      { path: 'trackers/:id', element: <TrackerDetailPage /> },
      { path: 'trackers/:id/edit', element: <TrackerFormPage /> },
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
