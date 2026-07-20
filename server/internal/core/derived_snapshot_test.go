package core

import "testing"

// netWorthSetup mirrors the TS fixture: "Net worth" = Checking + Brokerage,
// derived snapshot over snapshot sources; Brokerage has no May reading so its
// April one carries over.
func netWorthSetup(t *testing.T) (a *testApp, checking, brokerage, netWorth *Tracker) {
	t.Helper()
	a = newTestApp(t)
	checking = mustCreate(t, a, obj("name", "Checking", "kind", "number", "is_snapshot", 1))
	brokerage = mustCreate(t, a, obj("name", "Brokerage", "kind", "number", "is_snapshot", 1))

	mustLog(t, a, checking.ID, obj("value", 1000, "occurred_at", "2026-03-05T10:00:00.000-07:00"))
	mustLog(t, a, brokerage.ID, obj("value", 500, "occurred_at", "2026-04-10T10:00:00.000-07:00"))
	mustLog(t, a, checking.ID, obj("value", 1200, "occurred_at", "2026-04-20T10:00:00.000-07:00"))
	mustLog(t, a, checking.ID, obj("value", 1100, "occurred_at", "2026-05-10T10:00:00.000-07:00"))

	netWorth = mustCreate(t, a, obj("name", "Net worth", "kind", "number", "is_snapshot", 1,
		"links", []any{
			obj("source_id", checking.ID, "coefficient", 1),
			obj("source_id", brokerage.ID, "coefficient", 1),
		}))
	return a, checking, brokerage, netWorth
}

func TestDerivedSnapshotFlags(t *testing.T) {
	_, _, _, netWorth := netWorthSetup(t)
	if netWorth.IsDerived != 1 || netWorth.IsSnapshot != 1 || netWorth.ResetPeriod != "never" {
		t.Errorf("bad derived snapshot: %+v", netWorth)
	}
}

func TestDerivedSnapshotEffectiveEntries(t *testing.T) {
	a, _, _, netWorth := netWorthSetup(t)
	entries, _ := a.Entries.ForTracker(netWorth.ID, TimeRange{})
	// 1000 → 1500 (+Brokerage) → 1700 (Checking 1200) → 1600 (Checking 1100).
	if !equalFloats(entryValues(entries), []float64{1000, 1500, 1700, 1600}) {
		t.Errorf("combined levels wrong: %v", entryValues(entries))
	}
	for _, e := range entries {
		if e.TrackerID != netWorth.ID {
			t.Error("virtual entries should belong to the derived tracker")
		}
	}
}

func TestDerivedSnapshotCollapsesSameDayReadings(t *testing.T) {
	a := newTestApp(t)
	// Three accounts updated one at a time within the same day — a minute
	// apart, exactly as a person records "as of today" balances. The per-source
	// join would otherwise emit a row per touch (66000 → 300000 → 1981284),
	// each a partial level while the others are momentarily stale. Only the
	// day's settled combined level is a real point.
	checking := mustCreate(t, a, obj("name", "Checking", "kind", "number", "is_snapshot", 1))
	savings := mustCreate(t, a, obj("name", "Savings", "kind", "number", "is_snapshot", 1))
	broker := mustCreate(t, a, obj("name", "Broker", "kind", "number", "is_snapshot", 1))
	mustLog(t, a, checking.ID, obj("value", 66000, "occurred_at", "2026-06-04T10:23:00.000-07:00"))
	mustLog(t, a, savings.ID, obj("value", 234000, "occurred_at", "2026-06-04T10:24:00.000-07:00"))
	mustLog(t, a, broker.ID, obj("value", 1681284, "occurred_at", "2026-06-04T10:25:00.000-07:00"))
	net := mustCreate(t, a, obj("name", "Net worth", "kind", "number", "is_snapshot", 1,
		"links", []any{
			obj("source_id", checking.ID, "coefficient", 1),
			obj("source_id", savings.ID, "coefficient", 1),
			obj("source_id", broker.ID, "coefficient", 1),
		}))

	entries, _ := a.Entries.ForTracker(net.ID, TimeRange{})
	// One point for the day: the fully-combined level, not the partial sums.
	if !equalFloats(entryValues(entries), []float64{1981284}) {
		t.Errorf("expected a single settled level, got %v", entryValues(entries))
	}
}

func TestDerivedSnapshotKeepsDistinctDays(t *testing.T) {
	// Readings on genuinely different days are each their own point — collapsing
	// only applies within a day, so the net-worth fixture (Mar 5, Apr 10, Apr 20,
	// May 10, all distinct days) is unchanged.
	a, _, _, netWorth := netWorthSetup(t)
	entries, _ := a.Entries.ForTracker(netWorth.ID, TimeRange{})
	if !equalFloats(entryValues(entries), []float64{1000, 1500, 1700, 1600}) {
		t.Errorf("distinct days should each survive: %v", entryValues(entries))
	}
}

func TestDerivedSnapshotTargetProgress(t *testing.T) {
	a, _, _, netWorth := netWorthSetup(t)
	if _, err := a.Trackers.Update(netWorth.ID, obj("target", 3200)); err != nil {
		t.Fatal(err)
	}
	p, err := a.Stats.TargetProgressFor(netWorth.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Current != 1600 || p.Ratio == nil || *p.Ratio != 0.5 {
		t.Errorf("progress wrong: %+v", p)
	}
}

func TestDerivedSnapshotNegativeCoefficients(t *testing.T) {
	a, checking, _, _ := netWorthSetup(t)
	loan := mustCreate(t, a, obj("name", "Loan", "kind", "number", "is_snapshot", 1))
	mustLog(t, a, loan.ID, obj("value", 400, "occurred_at", "2026-05-01T10:00:00.000-07:00"))
	equity := mustCreate(t, a, obj("name", "Equity", "kind", "number", "is_snapshot", 1,
		"links", []any{
			obj("source_id", checking.ID, "coefficient", 1),
			obj("source_id", loan.ID, "coefficient", -1),
		}))

	p, _ := a.Stats.TargetProgressFor(equity.ID, "")
	if p.Current != 700 {
		t.Errorf("equity should be 1100-400=700, got %v", p.Current)
	}
	slices, _ := a.Stats.Composition(equity.ID, TimeRange{})
	if slices[0].Total != 1100 || slices[1].Total != -400 {
		t.Errorf("slices wrong: %+v", slices)
	}
}

func TestDerivedSnapshotBucketsCarryLevel(t *testing.T) {
	a, _, _, netWorth := netWorthSetup(t)
	buckets, err := a.Stats.Bucket(netWorth.ID,
		"2026-03-01T00:00:00.000-07:00", "2026-07-01T00:00:00.000-07:00", PeriodMonth)
	if err != nil {
		t.Fatal(err)
	}
	var populated []StatBucket
	lastPopulated := -1
	for i, b := range buckets {
		if b.Count > 0 {
			populated = append(populated, b)
			lastPopulated = i
		}
	}
	if len(populated) != 3 ||
		populated[0].Value != 1000 || populated[0].Count != 1 ||
		populated[1].Value != 1700 || populated[1].Count != 2 ||
		populated[2].Value != 1600 || populated[2].Count != 1 {
		t.Errorf("populated buckets wrong: %+v", populated)
	}
	trailing := buckets[lastPopulated+1:]
	if len(trailing) == 0 {
		t.Fatal("expected trailing empty buckets")
	}
	for _, b := range trailing {
		if b.Value != 1600 || b.Count != 0 {
			t.Errorf("trailing bucket should carry 1600: %+v", b)
		}
	}
}

func TestDerivedSnapshotSeedsCarryFromBeforeRange(t *testing.T) {
	a, _, _, netWorth := netWorthSetup(t)
	buckets, err := a.Stats.Bucket(netWorth.ID,
		"2026-06-05T00:00:00.000-07:00", "2026-06-25T00:00:00.000-07:00", PeriodMonth)
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) == 0 {
		t.Fatal("expected buckets")
	}
	for _, b := range buckets {
		if b.Value != 1600 || b.Count != 0 {
			t.Errorf("carried bucket wrong: %+v", b)
		}
	}
}

func TestOrdinarySnapshotCarriesLevelAcrossBuckets(t *testing.T) {
	a, checking, _, _ := netWorthSetup(t)
	buckets, err := a.Stats.Bucket(checking.ID,
		"2026-02-01T00:00:00.000-07:00", "2026-07-01T00:00:00.000-07:00", PeriodMonth)
	if err != nil {
		t.Fatal(err)
	}
	first, last := -1, -1
	var populated []float64
	for i, b := range buckets {
		if b.Count > 0 {
			if first < 0 {
				first = i
			}
			last = i
			populated = append(populated, b.Value)
		}
	}
	if !equalFloats(populated, []float64{1000, 1200, 1100}) {
		t.Errorf("populated wrong: %v", populated)
	}
	for _, b := range buckets[:first] {
		if b.Value != 0 {
			t.Error("before the first reading there is nothing to carry")
		}
	}
	for _, b := range buckets[last+1:] {
		if b.Value != 1100 || b.Count != 0 {
			t.Errorf("trailing carry wrong: %+v", b)
		}
	}
}

func TestDerivedSnapshotComposition(t *testing.T) {
	a, checking, brokerage, netWorth := netWorthSetup(t)
	slices, _ := a.Stats.Composition(netWorth.ID, TimeRange{})
	if len(slices) != 2 ||
		slices[0].SourceID != checking.ID || slices[0].Total != 1100 || slices[0].Count != 3 ||
		slices[1].SourceID != brokerage.ID || slices[1].Total != 500 || slices[1].Count != 1 {
		t.Errorf("slices wrong: %+v", slices)
	}
}

func TestDerivedSnapshotCompositionScoped(t *testing.T) {
	a, _, _, netWorth := netWorthSetup(t)

	april, _ := a.Stats.Composition(netWorth.ID, TimeRange{
		Start: "2026-04-01T00:00:00.000-07:00", End: "2026-05-01T00:00:00.000-07:00"})
	if april[0].Total != 1200 || april[0].Count != 1 || april[1].Total != 500 || april[1].Count != 1 {
		t.Errorf("april wrong: %+v", april)
	}

	may, _ := a.Stats.Composition(netWorth.ID, TimeRange{
		Start: "2026-05-01T00:00:00.000-07:00", End: "2026-06-01T00:00:00.000-07:00"})
	if may[0].Total != 1100 || may[0].Count != 1 || may[1].Total != 500 || may[1].Count != 0 {
		t.Errorf("may wrong: %+v", may)
	}

	march, _ := a.Stats.Composition(netWorth.ID, TimeRange{
		Start: "2026-03-01T00:00:00.000-07:00", End: "2026-04-01T00:00:00.000-07:00"})
	if march[0].Total != 1000 || march[0].Count != 1 || march[1].Total != 0 || march[1].Count != 0 {
		t.Errorf("march wrong: %+v", march)
	}
}
