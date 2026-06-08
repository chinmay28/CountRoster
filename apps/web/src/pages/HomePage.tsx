import { Link } from 'react-router-dom';
import type { Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { TrackerCard } from '../components/TrackerCard.tsx';
import { resetPeriodRange, sumValues } from '../lib/range.ts';

/**
 * Home: the roster of active trackers, each showing today's total with a
 * one-tap log button. Trackers assigned to a group are shown under that
 * group's heading; the rest fall under "Ungrouped".
 */
export function HomePage() {
  const core = useCore();

  const { data, loading, error, reload } = useAsync(async () => {
    const [trackers, groups] = await Promise.all([
      core.trackers.list(),
      core.groups.list(),
    ]);
    // Each tracker's headline total covers its own reset window (today / this
    // week / month / year), or all-time when it never resets.
    const totals = new Map(
      await Promise.all(
        trackers.map(async (t) => {
          const range = resetPeriodRange(t.reset_period, t.week_start);
          const entries = await core.entries.forTracker(t.id, range ?? undefined);
          return [t.id, sumValues(entries)] as const;
        }),
      ),
    );

    // Build grouped sections in group order, then an "Ungrouped" remainder.
    const byId = new Map(trackers.map((t) => [t.id, t]));
    const grouped = new Set<string>();
    const sections: { key: string; title: string | null; trackers: Tracker[] }[] = [];
    for (const g of groups) {
      const members = await core.groups.trackersIn(g.id);
      const active = members.filter((m) => byId.has(m.id));
      if (active.length === 0) continue;
      for (const m of active) grouped.add(m.id);
      sections.push({ key: g.id, title: g.name, trackers: active });
    }
    const ungrouped = trackers.filter((t) => !grouped.has(t.id));
    if (ungrouped.length > 0) {
      sections.push({
        key: '__ungrouped',
        title: sections.length > 0 ? 'Ungrouped' : null,
        trackers: ungrouped,
      });
    }

    return { trackers, totals, sections };
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
      <h1 className="page-title">
        <img className="page-title__logo" src="/icon.svg" alt="" aria-hidden="true" />
        Your trackers
      </h1>
      {data.sections.map((section) => (
        <div className="home-section" key={section.key}>
          {section.title && <h2 className="home-section__title">{section.title}</h2>}
          <div className="tracker-grid">
            {section.trackers.map((tracker) => (
              <TrackerCard
                key={tracker.id}
                tracker={tracker}
                todayTotal={data.totals.get(tracker.id) ?? 0}
                onLogged={reload}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
