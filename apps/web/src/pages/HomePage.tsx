import { Link } from 'react-router-dom';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { TrackerCard } from '../components/TrackerCard.tsx';
import { todayRange, sumValues } from '../lib/range.ts';

/**
 * Home: the roster of active trackers, each showing today's total with a
 * one-tap log button.
 */
export function HomePage() {
  const core = useCore();

  const { data, loading, error, reload } = useAsync(async () => {
    const trackers = await core.trackers.list();
    const range = todayRange();
    const totals = await Promise.all(
      trackers.map(async (t) => {
        const entries = await core.entries.forTracker(t.id, range);
        return [t.id, sumValues(entries)] as const;
      }),
    );
    return { trackers, totals: new Map(totals) };
  }, []);

  if (loading) return <p className="muted">Loading trackers…</p>;
  if (error) return <p className="error">Failed to load: {error.message}</p>;
  if (!data) return null;

  if (data.trackers.length === 0) {
    return (
      <div className="empty">
        <h1>No trackers yet</h1>
        <p>Create your first tracker to start logging.</p>
        <Link to="/trackers/new" className="btn btn--primary">
          New tracker
        </Link>
      </div>
    );
  }

  return (
    <section>
      <h1 className="page-title">Your trackers</h1>
      <div className="tracker-grid">
        {data.trackers.map((tracker) => (
          <TrackerCard
            key={tracker.id}
            tracker={tracker}
            todayTotal={data.totals.get(tracker.id) ?? 0}
            onLogged={reload}
          />
        ))}
      </div>
    </section>
  );
}
