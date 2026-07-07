package core

import (
	"strings"
	"testing"
)

// profitSetup builds a derived "Profit" tracker = Revenue (+1) − Expenses
// (−1) with a few entries, mirroring the TS suite's fixture.
func profitSetup(t *testing.T) (a *testApp, revenue, expenses, profit *Tracker) {
	t.Helper()
	a = newTestApp(t)
	revenue = mustCreate(t, a, obj("name", "Revenue", "kind", "number"))
	expenses = mustCreate(t, a, obj("name", "Expenses", "kind", "number"))

	mustLog(t, a, revenue.ID, obj("value", 100, "occurred_at", "2026-05-25T09:00:00.000-07:00"))
	mustLog(t, a, revenue.ID, obj("value", 50, "occurred_at", "2026-05-25T11:00:00.000-07:00"))
	mustLog(t, a, expenses.ID, obj("value", 30, "occurred_at", "2026-05-25T10:00:00.000-07:00"))

	profit = mustCreate(t, a, obj("name", "Profit", "kind", "number",
		"links", []any{
			obj("source_id", revenue.ID, "coefficient", 1),
			obj("source_id", expenses.ID, "coefficient", -1),
		}))
	return a, revenue, expenses, profit
}

func TestDerivedMarksTrackerAndStoresLinks(t *testing.T) {
	a, revenue, expenses, profit := profitSetup(t)
	if profit.IsDerived != 1 {
		t.Error("profit should be derived")
	}
	links, _ := a.Trackers.Links(profit.ID)
	if len(links) != 2 ||
		links[0].SourceID != revenue.ID || links[0].Coefficient != 1 ||
		links[1].SourceID != expenses.ID || links[1].Coefficient != -1 {
		t.Errorf("links wrong: %+v", links)
	}
}

func TestOrdinaryTrackerHasNoLinks(t *testing.T) {
	a, revenue, _, _ := profitSetup(t)
	if revenue.IsDerived != 0 {
		t.Error("revenue should not be derived")
	}
	links, _ := a.Trackers.Links(revenue.ID)
	if len(links) != 0 {
		t.Error("revenue should have no links")
	}
}

func TestDerivedEffectiveEntries(t *testing.T) {
	a, _, _, profit := profitSetup(t)
	entries, _ := a.Entries.ForTracker(profit.ID, TimeRange{})
	// +100, −30, +50 ordered by occurred_at.
	if !equalFloats(entryValues(entries), []float64{100, -30, 50}) {
		t.Errorf("effective entries wrong: %v", entryValues(entries))
	}
	if sumValues(entries) != 120 {
		t.Errorf("total wrong: %v", sumValues(entries))
	}
	for _, e := range entries {
		if e.TrackerID != profit.ID {
			t.Error("virtual entries should report the derived tracker as owner")
		}
	}
}

func TestDerivedRefusesDirectLogging(t *testing.T) {
	a, _, _, profit := profitSetup(t)
	if _, err := a.Entries.Log(profit.ID, obj("value", 5)); !isDerivedErr(err) {
		t.Errorf("expected DerivedTrackerError, got %v", err)
	}
}

func TestDerivedBuckets(t *testing.T) {
	a, _, _, profit := profitSetup(t)
	buckets, err := a.Stats.Bucket(profit.ID,
		"2026-05-24T00:00:00.000-07:00", "2026-05-27T00:00:00.000-07:00", PeriodDay)
	if err != nil {
		t.Fatal(err)
	}
	total, count := 0.0, 0
	for _, b := range buckets {
		total += b.Value
		count += b.Count
	}
	if total != 120 || count != 3 {
		t.Errorf("bucket totals wrong: total=%v count=%d", total, count)
	}
}

func TestDerivedTargetProgress(t *testing.T) {
	a, _, _, profit := profitSetup(t)
	if _, err := a.Trackers.Update(profit.ID, obj("target", 240)); err != nil {
		t.Fatal(err)
	}
	p, err := a.Stats.TargetProgressFor(profit.ID, "2026-05-25T12:00:00.000-07:00")
	if err != nil {
		t.Fatal(err)
	}
	if p.Current != 120 || p.Target == nil || *p.Target != 240 ||
		p.Ratio == nil || *p.Ratio != 0.5 {
		t.Errorf("progress wrong: %+v", p)
	}
}

func TestDerivedComposition(t *testing.T) {
	a, revenue, expenses, profit := profitSetup(t)
	slices, _ := a.Stats.Composition(profit.ID, TimeRange{})
	if len(slices) != 2 {
		t.Fatalf("expected 2 slices, got %d", len(slices))
	}
	if slices[0].SourceID != revenue.ID || slices[0].Name != "Revenue" ||
		slices[0].Coefficient != 1 || slices[0].Total != 150 || slices[0].Count != 2 {
		t.Errorf("revenue slice wrong: %+v", slices[0])
	}
	if slices[1].SourceID != expenses.ID || slices[1].Total != -30 || slices[1].Count != 1 {
		t.Errorf("expenses slice wrong: %+v", slices[1])
	}
}

func TestCompositionWeighsByCoefficient(t *testing.T) {
	a, revenue, expenses, profit := profitSetup(t)
	if _, err := a.Trackers.SetLinks(profit.ID, []TrackerLinkInput{
		{SourceID: revenue.ID, Coefficient: 2},
		{SourceID: expenses.ID, Coefficient: 1},
	}); err != nil {
		t.Fatal(err)
	}
	slices, _ := a.Stats.Composition(profit.ID, TimeRange{})
	if slices[0].Total != 300 || slices[1].Total != 30 {
		t.Errorf("weighted totals wrong: %v %v", slices[0].Total, slices[1].Total)
	}
}

func TestCompositionZeroSliceForIdleSource(t *testing.T) {
	a, revenue, _, profit := profitSetup(t)
	idle := mustCreate(t, a, obj("name", "Idle", "kind", "number"))
	if _, err := a.Trackers.SetLinks(profit.ID, []TrackerLinkInput{
		{SourceID: revenue.ID, Coefficient: 1},
		{SourceID: idle.ID, Coefficient: 1},
	}); err != nil {
		t.Fatal(err)
	}
	slices, _ := a.Stats.Composition(profit.ID, TimeRange{})
	found := false
	for _, s := range slices {
		if s.SourceID == idle.ID {
			found = true
			if s.Total != 0 || s.Count != 0 {
				t.Errorf("idle slice should be zero: %+v", s)
			}
		}
	}
	if !found {
		t.Error("idle source should still appear as a slice")
	}
}

func TestCompositionScopedToRange(t *testing.T) {
	a, revenue, _, profit := profitSetup(t)
	mustLog(t, a, revenue.ID, obj("value", 999, "occurred_at", "2025-06-15T12:00:00.000-07:00"))

	thisYear, _ := a.Stats.Composition(profit.ID, TimeRange{
		Start: "2026-01-01T00:00:00.000-07:00", End: "2027-01-01T00:00:00.000-07:00"})
	if thisYear[0].Total != 150 || thisYear[0].Count != 2 || thisYear[1].Total != -30 || thisYear[1].Count != 1 {
		t.Errorf("this year wrong: %+v", thisYear)
	}

	lastYear, _ := a.Stats.Composition(profit.ID, TimeRange{
		Start: "2025-01-01T00:00:00.000-07:00", End: "2026-01-01T00:00:00.000-07:00"})
	if lastYear[0].Total != 999 || lastYear[0].Count != 1 || lastYear[1].Total != 0 || lastYear[1].Count != 0 {
		t.Errorf("last year wrong: %+v", lastYear)
	}

	all, _ := a.Stats.Composition(profit.ID, TimeRange{})
	if all[0].Total != 1149 || all[1].Total != -30 {
		t.Errorf("all-time wrong: %+v", all)
	}
}

func TestCompositionEmptyForOrdinaryTracker(t *testing.T) {
	a, revenue, _, _ := profitSetup(t)
	slices, _ := a.Stats.Composition(revenue.ID, TimeRange{})
	if len(slices) != 0 {
		t.Errorf("expected empty composition, got %+v", slices)
	}
}

func TestDerivedStreak(t *testing.T) {
	a, _, _, profit := profitSetup(t)
	streak, _ := a.Stats.StreakFor(profit.ID)
	if streak.Longest != 1 {
		t.Errorf("longest wrong: %+v", streak)
	}
}

func TestSetLinksReplacesAndClears(t *testing.T) {
	a, revenue, _, profit := profitSetup(t)

	if _, err := a.Trackers.SetLinks(profit.ID, []TrackerLinkInput{{SourceID: revenue.ID, Coefficient: 2}}); err != nil {
		t.Fatal(err)
	}
	entries, _ := a.Entries.ForTracker(profit.ID, TimeRange{})
	if sumValues(entries) != 300 {
		t.Errorf("expected 300, got %v", sumValues(entries))
	}

	if _, err := a.Trackers.SetLinks(profit.ID, nil); err != nil {
		t.Fatal(err)
	}
	refreshed, _ := a.Trackers.Get(profit.ID)
	if refreshed.IsDerived != 0 {
		t.Error("tracker should be ordinary again")
	}
	entries, _ = a.Entries.ForTracker(profit.ID, TimeRange{})
	if len(entries) != 0 {
		t.Error("no more virtual entries expected")
	}
}

func TestUpdateReplacesLinks(t *testing.T) {
	a, _, expenses, profit := profitSetup(t)
	if _, err := a.Trackers.Update(profit.ID, obj("links", []any{
		obj("source_id", expenses.ID, "coefficient", -2),
	})); err != nil {
		t.Fatal(err)
	}
	links, _ := a.Trackers.Links(profit.ID)
	if len(links) != 1 || links[0].SourceID != expenses.ID || links[0].Coefficient != -2 {
		t.Errorf("links wrong: %+v", links)
	}
	entries, _ := a.Entries.ForTracker(profit.ID, TimeRange{})
	if sumValues(entries) != -60 {
		t.Errorf("expected -60, got %v", sumValues(entries))
	}
}

func TestRefusesDeleteAndArchiveOfSourceInUse(t *testing.T) {
	a, revenue, expenses, profit := profitSetup(t)
	if err := a.Trackers.Delete(expenses.ID); !isInUseErr(err) {
		t.Errorf("expected TrackerInUseError, got %v", err)
	}
	if got, _ := a.Trackers.Get(expenses.ID); got == nil {
		t.Error("source should be intact")
	}
	links, _ := a.Trackers.Links(profit.ID)
	if len(links) != 2 {
		t.Error("derivation should be intact")
	}

	if err := a.Trackers.Archive(revenue.ID); !isInUseErr(err) {
		t.Errorf("expected TrackerInUseError on archive, got %v", err)
	}
	refreshed, _ := a.Trackers.Get(revenue.ID)
	if refreshed.ArchivedAt != nil {
		t.Error("source should stay active")
	}
}

func TestDerivedTrackerItselfCanBeArchived(t *testing.T) {
	a, _, _, profit := profitSetup(t)
	if err := a.Trackers.Archive(profit.ID); err != nil {
		t.Fatal(err)
	}
	refreshed, _ := a.Trackers.Get(profit.ID)
	if refreshed.ArchivedAt == nil {
		t.Error("derived tracker should be archivable")
	}
}

func TestInUseErrorNamesDependents(t *testing.T) {
	a, revenue, _, _ := profitSetup(t)
	mustCreate(t, a, obj("name", "Double revenue", "kind", "number",
		"links", []any{obj("source_id", revenue.ID, "coefficient", 2)}))
	err := a.Trackers.Delete(revenue.ID)
	if err == nil || !strings.Contains(err.Error(), "Profit") ||
		!strings.Contains(err.Error(), "Double revenue") {
		t.Errorf("error should name dependents: %v", err)
	}
}

func TestDeleteSourceAfterDerivedGone(t *testing.T) {
	a, _, expenses, profit := profitSetup(t)
	if err := a.Trackers.Delete(profit.ID); err != nil {
		t.Fatal(err)
	}
	if err := a.Trackers.Delete(expenses.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.Trackers.Get(expenses.ID); got != nil {
		t.Error("source should be deletable once the derivation is gone")
	}
}

func TestRejectsInvalidDerivations(t *testing.T) {
	a := newTestApp(t)
	loop := mustCreate(t, a, obj("name", "Loop"))
	if _, err := a.Trackers.SetLinks(loop.ID, []TrackerLinkInput{{SourceID: loop.ID, Coefficient: 1}}); !isDerivedErr(err) {
		t.Errorf("self-reference: expected DerivedTrackerError, got %v", err)
	}

	x := mustCreate(t, a, obj("name", "X"))
	if _, err := a.Trackers.SetLinks(x.ID, []TrackerLinkInput{{SourceID: "does-not-exist", Coefficient: 1}}); !isDerivedErr(err) {
		t.Errorf("missing source: expected DerivedTrackerError, got %v", err)
	}

	src := mustCreate(t, a, obj("name", "Src"))
	derived := mustCreate(t, a, obj("name", "D",
		"links", []any{obj("source_id", src.ID, "coefficient", 1)}))
	meta := mustCreate(t, a, obj("name", "Meta"))
	if _, err := a.Trackers.SetLinks(meta.ID, []TrackerLinkInput{
		{SourceID: src.ID, Coefficient: 1},
		{SourceID: derived.ID, Coefficient: 1},
	}); !isDerivedErr(err) {
		t.Errorf("nesting: expected DerivedTrackerError, got %v", err)
	}

	dup := mustCreate(t, a, obj("name", "Dup"))
	if _, err := a.Trackers.SetLinks(dup.ID, []TrackerLinkInput{
		{SourceID: src.ID, Coefficient: 1},
		{SourceID: src.ID, Coefficient: 2},
	}); !isDerivedErr(err) {
		t.Errorf("duplicates: expected DerivedTrackerError, got %v", err)
	}
}
