import { Link, Outlet } from 'react-router-dom';
import { useCoreContext } from './CoreContext.tsx';

/** App chrome: header, connectivity banner, and the routed page outlet. */
export function AppLayout() {
  const { connected } = useCoreContext();

  return (
    <div className="app">
      <header className="app__header">
        <Link to="/" className="app__brand">
          CountRoster
        </Link>
        <nav className="app__nav">
          <Link to="/data" className="btn btn--ghost">
            Data
          </Link>
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
    </div>
  );
}
