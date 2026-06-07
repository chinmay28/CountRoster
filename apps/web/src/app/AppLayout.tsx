import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useCoreContext } from './CoreContext.tsx';

/** Primary destinations, shown in the desktop header and the mobile tab bar. */
const NAV_ITEMS: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/', label: 'Home', icon: <HomeIcon /> },
  { to: '/compare', label: 'Compare', icon: <CompareIcon /> },
  { to: '/groups', label: 'Groups', icon: <GroupsIcon /> },
  { to: '/data', label: 'Data', icon: <DataIcon /> },
];

/** App chrome: header, connectivity banner, the routed page outlet, and a
 * mobile bottom tab bar with a floating "new tracker" action. */
export function AppLayout() {
  const { connected } = useCoreContext();
  const { pathname } = useLocation();
  // The FAB *is* the "new tracker" action, so don't show it on that form.
  const showFab = !pathname.startsWith('/trackers/new') && !pathname.endsWith('/edit');

  return (
    <div className="app">
      <header className="app__header">
        <Link to="/" className="app__brand">
          <span className="app__brand-mark" aria-hidden="true">
            ✦
          </span>
          CountRoster
        </Link>
        {/* Desktop / wide-screen navigation. The mobile tab bar mirrors it. */}
        <nav className="app__nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `btn btn--ghost${isActive ? ' btn--active' : ''}`
              }
            >
              {item.label}
            </NavLink>
          ))}
          <Link to="/trackers/new" className="btn btn--primary">
            New tracker
          </Link>
        </nav>
      </header>

      {!connected && (
        <div className="banner banner--warn" role="status">
          Can’t reach the CountRoster server. Changes won’t be saved until the
          connection is restored.
        </div>
      )}

      <main className="app__main">
        <Outlet />
      </main>

      <footer className="app__footer">
        <span>Synced to your CountRoster server · the same data on every device.</span>
      </footer>

      {/* Floating action button — the primary create action on phones. */}
      {showFab && (
        <Link
          to="/trackers/new"
          className="fab"
          aria-label="New tracker"
          title="New tracker"
        >
          <PlusIcon />
        </Link>
      )}

      {/* Mobile bottom tab bar (hidden on wide screens via CSS). */}
      <nav className="tab-bar" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `tab-bar__item${isActive ? ' tab-bar__item--active' : ''}`
            }
          >
            <span className="tab-bar__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="tab-bar__label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/* Inline, dependency-free icons. They inherit `currentColor` and a 24px box. */

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}

function CompareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </svg>
  );
}

function GroupsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function DataIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
