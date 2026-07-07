package core

import "testing"

func TestLogUsesDefaultValue(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Reps", "default_value", 10))

	e := mustLog(t, a, tr.ID, nil)
	if e.Value != 10 || e.TrackerID != tr.ID {
		t.Errorf("bad entry: %+v", e)
	}
}

func TestLogCustomValueAndOccurredAt(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Weight", "kind", "number"))

	e := mustLog(t, a, tr.ID, obj("value", 175.4, "occurred_at", "2026-04-01T08:00:00.000-07:00"))
	if e.Value != 175.4 || e.OccurredAt != "2026-04-01T08:00:00.000-07:00" {
		t.Errorf("bad entry: %+v", e)
	}
}

func TestLogUnknownTracker(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Entries.Log("does-not-exist", nil); !isNotFound(err) {
		t.Errorf("expected NotFoundError, got %v", err)
	}
}

func TestLogManyBatchAcrossTrackers(t *testing.T) {
	a := newTestApp(t)
	coffee := mustCreate(t, a, obj("name", "Coffee", "default_value", 1))
	water := mustCreate(t, a, obj("name", "Water", "default_value", 2))

	entries, err := a.Entries.LogMany([]any{
		obj("tracker_id", water.ID, "value", 3),
		obj("tracker_id", coffee.ID),
		obj("tracker_id", water.ID, "occurred_at", "2026-05-24T12:00:00.000-07:00"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !equalFloats(entryValues(entries), []float64{3, 1, 2}) {
		t.Errorf("values wrong: %v", entryValues(entries))
	}
	wantIDs := []string{water.ID, coffee.ID, water.ID}
	for i, e := range entries {
		if e.TrackerID != wantIDs[i] {
			t.Errorf("entry %d tracker mismatch", i)
		}
	}
	if entries[2].OccurredAt != "2026-05-24T12:00:00.000-07:00" {
		t.Errorf("occurred_at wrong: %s", entries[2].OccurredAt)
	}
	waterEntries, _ := a.Entries.ForTracker(water.ID, TimeRange{})
	if len(waterEntries) != 2 {
		t.Errorf("expected 2 water entries, got %d", len(waterEntries))
	}
}

func TestLogManyRollsBackOnUnknownTracker(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Coffee"))

	_, err := a.Entries.LogMany([]any{
		obj("tracker_id", tr.ID, "value", 1),
		obj("tracker_id", "does-not-exist", "value", 2),
	})
	if !isNotFound(err) {
		t.Fatalf("expected NotFoundError, got %v", err)
	}
	entries, _ := a.Entries.ForTracker(tr.ID, TimeRange{})
	if len(entries) != 0 {
		t.Error("valid item should have rolled back with the bad one")
	}
}

func TestLogManyRejectsDerivedAndEmpty(t *testing.T) {
	a := newTestApp(t)
	source := mustCreate(t, a, obj("name", "Source"))
	derived := mustCreate(t, a, obj("name", "Derived",
		"links", []any{obj("source_id", source.ID, "coefficient", 1)}))

	if _, err := a.Entries.LogMany([]any{obj("tracker_id", derived.ID, "value", 1)}); !isDerivedErr(err) {
		t.Errorf("expected DerivedTrackerError, got %v", err)
	}
	if _, err := a.Entries.LogMany([]any{}); !isValidationErr(err) {
		t.Errorf("expected validation error for empty batch, got %v", err)
	}
}

func TestUpdateEntry(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Coffee"))
	e := mustLog(t, a, tr.ID, nil)

	a.setTime("2026-05-25T13:00:00.000-07:00")
	patched, err := a.Entries.Update(e.ID, obj("value", 2))
	if err != nil {
		t.Fatal(err)
	}
	if patched.Value != 2 || patched.UpdatedAt == e.UpdatedAt {
		t.Errorf("update failed: %+v", patched)
	}
}

func TestUpdateUnknownEntry(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Entries.Update("nope", obj("value", 1)); !isNotFound(err) {
		t.Errorf("expected NotFoundError, got %v", err)
	}
}

func TestDeleteEntry(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X"))
	e := mustLog(t, a, tr.ID, nil)

	if err := a.Entries.Delete(e.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.Entries.Get(e.ID); got != nil {
		t.Error("entry should be gone")
	}
}

func TestForTrackerOrdersByOccurredAt(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X"))

	e1 := mustLog(t, a, tr.ID, obj("occurred_at", "2026-05-20T10:00:00.000-07:00"))
	e2 := mustLog(t, a, tr.ID, obj("occurred_at", "2026-05-22T10:00:00.000-07:00"))
	e3 := mustLog(t, a, tr.ID, obj("occurred_at", "2026-05-21T10:00:00.000-07:00"))

	all, _ := a.Entries.ForTracker(tr.ID, TimeRange{})
	if !equalStrings(entryIDs(all), []string{e1.ID, e3.ID, e2.ID}) {
		t.Errorf("order wrong: %v", entryIDs(all))
	}
}

func TestForTrackerRangeFilter(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X"))

	mustLog(t, a, tr.ID, obj("occurred_at", "2026-05-20T10:00:00.000-07:00"))
	inside := mustLog(t, a, tr.ID, obj("occurred_at", "2026-05-22T10:00:00.000-07:00"))
	mustLog(t, a, tr.ID, obj("occurred_at", "2026-05-24T10:00:00.000-07:00"))

	filtered, _ := a.Entries.ForTracker(tr.ID, TimeRange{
		Start: "2026-05-21T00:00:00.000-07:00",
		End:   "2026-05-23T00:00:00.000-07:00",
	})
	if !equalStrings(entryIDs(filtered), []string{inside.ID}) {
		t.Errorf("range filter wrong: %v", entryIDs(filtered))
	}
}

func TestForTrackerComparesByInstantAcrossOffsets(t *testing.T) {
	// An entry stored at 03:00 UTC is, in a client's -08:00 timezone, still
	// the *previous* calendar day — a lexical string comparison would wrongly
	// include it in "today".
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X"))

	prevDay := mustLog(t, a, tr.ID, obj("occurred_at", "2026-05-22T03:00:00.000+00:00"))
	sameDay := mustLog(t, a, tr.ID, obj("occurred_at", "2026-05-22T20:00:00.000+00:00"))

	today, _ := a.Entries.ForTracker(tr.ID, TimeRange{
		Start: "2026-05-22T00:00:00.000-08:00",
		End:   "2026-05-23T00:00:00.000-08:00",
	})
	if !equalStrings(entryIDs(today), []string{sameDay.ID}) {
		t.Errorf("instant comparison wrong: got %v, prevDay=%s", entryIDs(today), prevDay.ID)
	}
}

func TestTrackerDeleteCascadesEntries(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X"))
	mustLog(t, a, tr.ID, nil)
	mustLog(t, a, tr.ID, nil)

	if err := a.st.Exec(`DELETE FROM trackers WHERE id = ?`, tr.ID); err != nil {
		t.Fatal(err)
	}
	rows, _ := a.st.Query(`SELECT COUNT(*) AS c FROM entries WHERE tracker_id = ?`, tr.ID)
	if asInt(rows[0].Get("c")) != 0 {
		t.Error("entries should cascade with the tracker")
	}
}
