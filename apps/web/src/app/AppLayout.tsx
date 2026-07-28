import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useCoreContext } from './CoreContext.tsx';
import { HiddenModeProvider, useHiddenMode } from './HiddenMode.tsx';
import { useKeyboardOpen } from './useKeyboardOpen.ts';
import { APP_VERSION } from '../version.ts';

/** Primary destinations, shown in the desktop header and the mobile tab bar. */
const NAV_ITEMS: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/', label: 'Home', icon: <HomeIcon /> },
  { to: '/transactions', label: 'Transactions', icon: <CardIcon /> },
  { to: '/groups', label: 'Groups', icon: <GroupsIcon /> },
  { to: '/data', label: 'Data', icon: <DataIcon /> },
];

/** How long the developer badge stays on screen when the header mark is
 * tapped. Kept in sync with the `dev-flash*` animation durations in
 * styles.css — the CSS fades out on its own clock, this unmounts it. */
const DEV_FLASH_MS = 3000;

/** App chrome: header, connectivity banner, the routed page outlet, and a
 * mobile bottom tab bar with a floating "new tracker" action. */
export function AppLayout() {
  // The app-wide provider lives above the router (main.tsx) so hidden mode
  // survives the quick-log screen, which routes outside this shell. This one
  // is the fallback for trees that mount the shell on its own — component
  // tests — and is a passthrough whenever an outer provider exists.
  return (
    <HiddenModeProvider>
      <AppShell />
    </HiddenModeProvider>
  );
}

function AppShell() {
  const { connected } = useCoreContext();
  const { enabled: hiddenMode, registerTap } = useHiddenMode();
  const { pathname } = useLocation();
  // While the on-screen keyboard is up, drop the bottom chrome so it never
  // floats over the keyboard; it comes back the moment the keyboard closes.
  const keyboardOpen = useKeyboardOpen();
  // The FAB *is* the "new tracker" action, so don't show it on that form.
  const showFab = !pathname.startsWith('/trackers/new') && !pathname.endsWith('/edit');
  // Tapping the developer mark throws the badge up full screen for a beat.
  const [devFlash, setDevFlash] = useState(false);

  useEffect(() => {
    if (!devFlash) return;
    const timer = window.setTimeout(() => setDevFlash(false), DEV_FLASH_MS);
    // Nobody should be stuck waiting out an animation — Escape ends it early,
    // as does a tap anywhere on the overlay.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDevFlash(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [devFlash]);

  return (
    <div className={`app${keyboardOpen ? ' app--keyboard-open' : ''}`}>
      <header className="app__header">
        <Link to="/" className="app__brand" onClick={registerTap}>
          <img className="app__brand-logo" src="/icon.svg" alt="" aria-hidden="true" />
          {/* Name over version, as a lockup. The version has to live inside
              the brand link — the link is also the hidden-mode tap target, and
              splitting it would put a dead zone in the middle of that target. */}
          <span className="app__brand-text">
            CountRoster
            <span className="app__brand-version">{APP_VERSION}</span>
          </span>
          {hiddenMode && (
            <span
              className="app__brand-hidden"
              role="status"
              title="Hidden trackers visible — tap 3× to hide"
              aria-label="Hidden trackers visible"
            >
              <EyeIcon />
            </span>
          )}
        </Link>
        {/* Everything that hangs off the right edge. Grouping the nav with the
            developer mark keeps them together when the nav collapses on
            mobile — the mark then sits alone opposite the brand. */}
        <div className="app__header-end">
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
          {/* Developer credit. Deliberately quiet — a muted disk that only
              comes to full strength on hover, so it never competes with the
              primary action next to it. Tapping it shows the badge full
              screen, which is the only place its detail is readable. */}
          <button
            type="button"
            className="app__dev"
            title="Built by CM Hegday · 0x434d"
            aria-label="Show the developer badge"
            onClick={() => setDevFlash(true)}
          >
            {/* The button carries the label; the image would only repeat it. */}
            <img className="app__dev-logo" src="/dev-badge.png" alt="" aria-hidden="true" />
          </button>
        </div>
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

      {/* Developer badge, full screen for three seconds. It lives out here
          rather than in the header because the header's backdrop-filter makes
          it a containing block — a fixed overlay inside it would be trapped
          in the header's strip instead of covering the viewport. */}
      {devFlash && (
        <div
          className="dev-flash"
          role="presentation"
          onClick={() => setDevFlash(false)}
        >
          <img
            className="dev-flash__logo"
            src="/dev-badge-full.png"
            alt="Built by CM Hegday — 0x434d"
          />
        </div>
      )}
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

function CardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
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

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}
