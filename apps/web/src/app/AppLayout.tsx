import { Link, Outlet } from 'react-router-dom';
import { useCoreContext } from './CoreContext.tsx';

/** App chrome: header, persistence warning, and the routed page outlet. */
export function AppLayout() {
  const { persistent } = useCoreContext();

  return (
    <div className="app">
      <header className="app__header">
        <Link to="/" className="app__brand">
          CountRoster
        </Link>
        <nav className="app__nav">
          <Link to="/trackers/new" className="btn btn--primary">
            New tracker
          </Link>
        </nav>
      </header>

      {!persistent && (
        <div className="banner banner--warn" role="alert">
          This browser can’t store data persistently (OPFS is unavailable, e.g.
          a private window or an older OS). Anything you log will be lost on
          reload.
        </div>
      )}

      <main className="app__main">
        <Outlet />
      </main>

      <footer className="app__footer">
        <span>Local-first · your data never leaves this device.</span>
      </footer>
    </div>
  );
}
