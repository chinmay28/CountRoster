package core

import "testing"

// The running example is the one custom fields were added for: a milk-feeding
// tracker whose primary value is the volume, carrying "Feed type" (a choice)
// and "Wet diaper" (a flag) alongside every feed.

func mustSetFields(t *testing.T, a *testApp, trackerID string, spec []any) []*TrackerField {
	t.Helper()
	inputs, err := ParseTrackerFieldsInput(spec)
	if err != nil {
		t.Fatalf("parse fields: %v", err)
	}
	fields, err := a.Fields.Replace(trackerID, inputs)
	if err != nil {
		t.Fatalf("replace fields: %v", err)
	}
	return fields
}

// feedingTracker returns a tracker with the two example fields already set up.
func feedingTracker(t *testing.T, a *testApp) (tracker *Tracker, feedType, wetDiaper *TrackerField) {
	t.Helper()
	tracker = mustCreate(t, a, obj("name", "Milk", "kind", "number", "unit", "ml"))
	fields := mustSetFields(t, a, tracker.ID, []any{
		obj("name", "Feed type", "kind", "choice", "options", []any{
			obj("label", "Bottle", "color", "#4ECDC4"),
			obj("label", "Formula"),
			obj("label", "Breast"),
		}),
		obj("name", "Wet diaper", "kind", "flag"),
	})
	if len(fields) != 2 {
		t.Fatalf("expected 2 fields, got %d", len(fields))
	}
	return tracker, fields[0], fields[1]
}

func TestFieldsReplaceAndList(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, wetDiaper := feedingTracker(t, a)

	if feedType.Name != "Feed type" || feedType.Kind != "choice" {
		t.Fatalf("unexpected first field: %+v", feedType)
	}
	if len(feedType.Options) != 3 {
		t.Fatalf("expected 3 options, got %d", len(feedType.Options))
	}
	if feedType.Options[0].Label != "Bottle" || feedType.Options[2].Label != "Breast" {
		t.Errorf("options out of order: %+v", feedType.Options)
	}
	if feedType.Options[0].Color == nil || *feedType.Options[0].Color != "#4ECDC4" {
		t.Errorf("option color not stored: %+v", feedType.Options[0])
	}
	if feedType.Options[1].Color != nil {
		t.Errorf("expected null color, got %v", *feedType.Options[1].Color)
	}
	if wetDiaper.Kind != "flag" || len(wetDiaper.Options) != 0 {
		t.Errorf("unexpected flag field: %+v", wetDiaper)
	}
	if feedType.SortOrder != 0 || wetDiaper.SortOrder != 1 {
		t.Errorf("sort order not assigned from position: %d, %d", feedType.SortOrder, wetDiaper.SortOrder)
	}

	listed, err := a.Fields.List(tracker.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 || listed[0].ID != feedType.ID {
		t.Errorf("List disagrees with Replace: %+v", listed)
	}
}

func TestFieldsChoiceNeedsOptions(t *testing.T) {
	a := newTestApp(t)
	tracker := mustCreate(t, a, obj("name", "Milk"))

	if _, err := ParseTrackerFieldsInput([]any{
		obj("name", "Feed type", "kind", "choice"),
	}); err == nil {
		t.Error("expected a choice field with no options to be rejected")
	}
	// Options on a non-choice field are meaningless, not merely ignored.
	if _, err := ParseTrackerFieldsInput([]any{
		obj("name", "Wet diaper", "kind", "flag", "options", []any{obj("label", "Yes")}),
	}); err == nil {
		t.Error("expected options on a flag field to be rejected")
	}
	if _, err := ParseTrackerFieldsInput([]any{
		obj("name", "Feed type", "kind", "colour"),
	}); err == nil {
		t.Error("expected an unknown field kind to be rejected")
	}
	_ = tracker
}

func TestFieldsRejectedOnDerivedTracker(t *testing.T) {
	a := newTestApp(t)
	source := mustCreate(t, a, obj("name", "Milk"))
	derived := mustCreate(t, a, obj("name", "Total", "links", []any{
		obj("source_id", source.ID),
	}))

	inputs, err := ParseTrackerFieldsInput([]any{obj("name", "Note", "kind", "text")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Fields.Replace(derived.ID, inputs); !isDerivedErr(err) {
		t.Errorf("expected DerivedTrackerError, got %v", err)
	}
	if _, err := a.Fields.Replace("missing", inputs); !isNotFound(err) {
		t.Errorf("expected NotFoundError, got %v", err)
	}
}

func TestEntryCarriesFieldAnswers(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, wetDiaper := feedingTracker(t, a)

	entry := mustLog(t, a, tracker.ID, obj("value", 120, "fields", obj(
		feedType.ID, feedType.Options[0].ID,
		wetDiaper.ID, true,
	)))
	if len(entry.Fields) != 2 {
		t.Fatalf("expected 2 answers, got %d", len(entry.Fields))
	}
	// Ordered by the owning field's sort order, not insertion.
	if entry.Fields[0].FieldID != feedType.ID {
		t.Errorf("answers not in field order: %+v", entry.Fields)
	}
	if entry.Fields[0].OptionID == nil || *entry.Fields[0].OptionID != feedType.Options[0].ID {
		t.Errorf("choice answer not stored: %+v", entry.Fields[0])
	}
	if entry.Fields[0].NumberValue != nil || entry.Fields[0].TextValue != nil {
		t.Errorf("choice answer polluted other columns: %+v", entry.Fields[0])
	}
	if entry.Fields[1].NumberValue == nil || *entry.Fields[1].NumberValue != 1 {
		t.Errorf("flag answer not stored as 1: %+v", entry.Fields[1])
	}

	// Reading the entry back — singly and through the tracker's list.
	got, err := a.Entries.Get(entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Fields) != 2 {
		t.Errorf("Get lost the answers: %+v", got.Fields)
	}
	list, err := a.Entries.ForTracker(tracker.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || len(list[0].Fields) != 2 {
		t.Errorf("ForTracker lost the answers: %+v", list)
	}

	// An entry logged without any answers reports an empty list, never null.
	bare := mustLog(t, a, tracker.ID, obj("value", 60))
	if bare.Fields == nil || len(bare.Fields) != 0 {
		t.Errorf("expected no answers, got %+v", bare.Fields)
	}
}

func TestEntryFieldAnswerValidation(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, wetDiaper := feedingTracker(t, a)

	if _, err := a.Entries.Log(tracker.ID, obj("fields", obj("nope", "x"))); !isValidationErr(err) {
		t.Errorf("expected unknown field to be rejected, got %v", err)
	}
	if _, err := a.Entries.Log(tracker.ID, obj("fields", obj(feedType.ID, "not-an-option"))); !isValidationErr(err) {
		t.Errorf("expected unknown option to be rejected, got %v", err)
	}
	if _, err := a.Entries.Log(tracker.ID, obj("fields", obj(wetDiaper.ID, 2))); !isValidationErr(err) {
		t.Errorf("expected 2 to be rejected as a flag, got %v", err)
	}

	// A flag takes booleans and 0|1 alike; both land as a number.
	for _, raw := range []any{false, 0} {
		entry, err := a.Entries.Log(tracker.ID, obj("fields", obj(wetDiaper.ID, raw)))
		if err != nil {
			t.Fatalf("flag %v: %v", raw, err)
		}
		if len(entry.Fields) != 1 || *entry.Fields[0].NumberValue != 0 {
			t.Errorf("flag %v stored as %+v", raw, entry.Fields)
		}
	}

	// A rejected answer must not leave the entry behind.
	before, err := a.Entries.ForTracker(tracker.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Entries.Log(tracker.ID, obj("value", 99, "fields", obj(feedType.ID, "bogus"))); err == nil {
		t.Fatal("expected the log to fail")
	}
	after, err := a.Entries.ForTracker(tracker.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Errorf("a rejected answer still wrote an entry: %d → %d", len(before), len(after))
	}
}

// Leaving a field blank is always allowed. This is what keeps fields
// backward compatible: adding one can't invalidate the entries logged before
// it existed, and every write path that predates it keeps working.
func TestUnansweredIsAlwaysLegitimate(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, wetDiaper := feedingTracker(t, a)

	// A bare log — the shape every client sent before fields existed.
	bare := mustLog(t, a, tracker.ID, obj("value", 120))
	if len(bare.Fields) != 0 {
		t.Errorf("expected no answers, got %+v", bare.Fields)
	}
	// An empty answer map is equally fine.
	if _, err := a.Entries.Log(tracker.ID, obj("value", 60, "fields", obj())); err != nil {
		t.Errorf("empty fields map rejected: %v", err)
	}
	// So is answering some fields but not others.
	partial := mustLog(t, a, tracker.ID, obj("value", 90, "fields", obj(
		feedType.ID, feedType.Options[0].ID,
	)))
	if len(partial.Fields) != 1 {
		t.Errorf("expected exactly the one answer given: %+v", partial.Fields)
	}

	// Every answer on an entry can be cleared back to blank.
	full := mustLog(t, a, tracker.ID, obj("value", 30, "fields", obj(
		feedType.ID, feedType.Options[0].ID,
		wetDiaper.ID, true,
	)))
	cleared, err := a.Entries.Update(full.ID, obj("fields", obj(
		feedType.ID, nil,
		wetDiaper.ID, nil,
	)))
	if err != nil {
		t.Fatalf("clearing every answer: %v", err)
	}
	if len(cleared.Fields) != 0 {
		t.Errorf("expected every answer cleared: %+v", cleared.Fields)
	}

	// Adding a field to a tracker that already has entries leaves them valid
	// and editable — they simply read as unanswered.
	fields := mustSetFields(t, a, tracker.ID, []any{
		obj("id", feedType.ID, "name", "Feed type", "kind", "choice", "options", []any{
			obj("id", feedType.Options[0].ID, "label", "Bottle"),
		}),
		obj("id", wetDiaper.ID, "name", "Wet diaper", "kind", "flag"),
		obj("name", "Side", "kind", "choice", "options", []any{obj("label", "Left")}),
	})
	if len(fields) != 3 {
		t.Fatalf("expected 3 fields, got %d", len(fields))
	}
	if _, err := a.Entries.Update(bare.ID, obj("value", 125)); err != nil {
		t.Errorf("an entry predating a field should still be editable: %v", err)
	}
	// And the new field reports those entries in its "Not set" bucket rather
	// than assuming an answer for them.
	slices, err := a.Stats.FieldBreakdown(tracker.ID, fields[2].ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	unset := slices[len(slices)-1]
	if unset.Key != "" || unset.Label != "Not set" || unset.Count != 4 {
		t.Errorf("expected all 4 entries unanswered: %+v", unset)
	}
}

func TestEntryUpdateRewritesAnswers(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, wetDiaper := feedingTracker(t, a)
	entry := mustLog(t, a, tracker.ID, obj("value", 120, "fields", obj(
		feedType.ID, feedType.Options[0].ID,
		wetDiaper.ID, 1,
	)))

	updated, err := a.Entries.Update(entry.ID, obj("value", 150, "fields", obj(
		feedType.ID, feedType.Options[2].ID,
	)))
	if err != nil {
		t.Fatal(err)
	}
	if updated.Value != 150 {
		t.Errorf("value not updated: %v", updated.Value)
	}
	if len(updated.Fields) != 2 {
		t.Fatalf("expected both answers to survive, got %+v", updated.Fields)
	}
	if *updated.Fields[0].OptionID != feedType.Options[2].ID {
		t.Errorf("choice not repointed: %+v", updated.Fields[0])
	}

	// An explicit null clears just that answer.
	cleared, err := a.Entries.Update(entry.ID, obj("fields", obj(wetDiaper.ID, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if len(cleared.Fields) != 1 || cleared.Fields[0].FieldID != feedType.ID {
		t.Errorf("expected only the flag to be cleared: %+v", cleared.Fields)
	}
}

func TestEntryDeleteCascadesAnswers(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, _ := feedingTracker(t, a)
	entry := mustLog(t, a, tracker.ID, obj("fields", obj(feedType.ID, feedType.Options[0].ID)))

	if err := a.Entries.Delete(entry.ID); err != nil {
		t.Fatal(err)
	}
	rows, err := a.st.Query(`SELECT id FROM entry_field_values WHERE entry_id = ?`, entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Errorf("deleting the entry left %d orphaned answers", len(rows))
	}
}

func TestFieldsReplacePreservesAndPrunes(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, wetDiaper := feedingTracker(t, a)
	entry := mustLog(t, a, tracker.ID, obj("value", 120, "fields", obj(
		feedType.ID, feedType.Options[0].ID,
		wetDiaper.ID, true,
	)))

	// Renaming the kept field (by id) must not disturb the answers filed
	// against it; the flag field is left out, so it and its answer go.
	after := mustSetFields(t, a, tracker.ID, []any{
		obj("id", feedType.ID, "name", "How fed", "kind", "choice", "options", []any{
			obj("id", feedType.Options[0].ID, "label", "Bottle"),
			obj("id", feedType.Options[1].ID, "label", "Formula"),
		}),
	})
	if len(after) != 1 || after[0].ID != feedType.ID || after[0].Name != "How fed" {
		t.Fatalf("unexpected field set: %+v", after)
	}
	if len(after[0].Options) != 2 {
		t.Errorf("expected the dropped option to be pruned: %+v", after[0].Options)
	}

	got, err := a.Entries.Get(entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Fields) != 1 {
		t.Fatalf("expected the removed field's answer to go with it: %+v", got.Fields)
	}
	if *got.Fields[0].OptionID != feedType.Options[0].ID {
		t.Errorf("kept answer was disturbed: %+v", got.Fields[0])
	}
}

func TestFieldsChangingKindClearsAnswers(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, _ := feedingTracker(t, a)
	entry := mustLog(t, a, tracker.ID, obj("fields", obj(feedType.ID, feedType.Options[0].ID)))

	// An option id means nothing to a text field, so the old answers go.
	mustSetFields(t, a, tracker.ID, []any{
		obj("id", feedType.ID, "name", "Feed type", "kind", "text"),
	})
	got, err := a.Entries.Get(entry.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Fields) != 0 {
		t.Errorf("expected answers to be cleared on a kind change: %+v", got.Fields)
	}
}

func TestFieldBreakdown(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, wetDiaper := feedingTracker(t, a)
	bottle, formula, breast := feedType.Options[0], feedType.Options[1], feedType.Options[2]

	mustLog(t, a, tracker.ID, obj("value", 120, "fields", obj(feedType.ID, bottle.ID, wetDiaper.ID, true)))
	mustLog(t, a, tracker.ID, obj("value", 80, "fields", obj(feedType.ID, bottle.ID, wetDiaper.ID, false)))
	mustLog(t, a, tracker.ID, obj("value", 50, "fields", obj(feedType.ID, breast.ID)))
	mustLog(t, a, tracker.ID, obj("value", 30)) // no answers at all

	slices, err := a.Stats.FieldBreakdown(tracker.ID, feedType.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	// Every option, in declared order, then the unanswered bucket.
	if len(slices) != 4 {
		t.Fatalf("expected 3 options + Not set, got %+v", slices)
	}
	want := []struct {
		key   string
		label string
		total float64
		count int
	}{
		{bottle.ID, "Bottle", 200, 2},
		{formula.ID, "Formula", 0, 0},
		{breast.ID, "Breast", 50, 1},
		{"", "Not set", 30, 1},
	}
	for i, w := range want {
		got := slices[i]
		if got.Key != w.key || got.Label != w.label || got.Total != w.total || got.Count != w.count {
			t.Errorf("slice %d = %+v, want %v", i, got, w)
		}
		if got.FieldID != feedType.ID {
			t.Errorf("slice %d carries the wrong field id: %s", i, got.FieldID)
		}
	}
	if slices[0].Color == nil || *slices[0].Color != "#4ECDC4" {
		t.Errorf("expected the option's color on its slice: %+v", slices[0])
	}

	// A flag splits into Yes/No, with the two unanswered feeds kept apart from
	// an explicit "No" rather than folded into it.
	flags, err := a.Stats.FieldBreakdown(tracker.ID, wetDiaper.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(flags) != 3 {
		t.Fatalf("expected Yes/No/Not set, got %+v", flags)
	}
	if flags[0].Label != "Yes" || flags[0].Total != 120 || flags[0].Count != 1 {
		t.Errorf("unexpected Yes slice: %+v", flags[0])
	}
	if flags[1].Label != "No" || flags[1].Total != 80 || flags[1].Count != 1 {
		t.Errorf("unexpected No slice: %+v", flags[1])
	}
	if flags[2].Label != "Not set" || flags[2].Total != 80 || flags[2].Count != 2 {
		t.Errorf("unexpected Not set slice: %+v", flags[2])
	}
}

func TestFieldBreakdownRangeAndErrors(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, _ := feedingTracker(t, a)
	bottle := feedType.Options[0]

	mustLog(t, a, tracker.ID, obj("value", 100, "occurred_at", "2026-05-24T09:00:00.000-07:00",
		"fields", obj(feedType.ID, bottle.ID)))
	mustLog(t, a, tracker.ID, obj("value", 40, "occurred_at", "2026-05-25T09:00:00.000-07:00",
		"fields", obj(feedType.ID, bottle.ID)))

	slices, err := a.Stats.FieldBreakdown(tracker.ID, feedType.ID, TimeRange{
		Start: "2026-05-25T00:00:00.000-07:00",
		End:   "2026-05-26T00:00:00.000-07:00",
	})
	if err != nil {
		t.Fatal(err)
	}
	if slices[0].Total != 40 || slices[0].Count != 1 {
		t.Errorf("range not applied: %+v", slices[0])
	}

	if _, err := a.Stats.FieldBreakdown(tracker.ID, "nope", TimeRange{}); !isNotFound(err) {
		t.Errorf("expected NotFoundError for an unknown field, got %v", err)
	}
	// A field belonging to another tracker is not this tracker's to break down.
	other := mustCreate(t, a, obj("name", "Sleep"))
	otherFields := mustSetFields(t, a, other.ID, []any{obj("name", "Where", "kind", "text")})
	if _, err := a.Stats.FieldBreakdown(tracker.ID, otherFields[0].ID, TimeRange{}); !isNotFound(err) {
		t.Errorf("expected NotFoundError across trackers, got %v", err)
	}

	numeric := mustSetFields(t, a, other.ID, []any{obj("name", "Minutes", "kind", "number")})
	if _, err := a.Stats.FieldBreakdown(other.ID, numeric[0].ID, TimeRange{}); !isValidationErr(err) {
		t.Errorf("expected a number field to be rejected, got %v", err)
	}
}

func TestFieldBreakdownText(t *testing.T) {
	a := newTestApp(t)
	tracker := mustCreate(t, a, obj("name", "Sleep", "kind", "duration"))
	fields := mustSetFields(t, a, tracker.ID, []any{obj("name", "Where", "kind", "text")})
	where := fields[0]

	mustLog(t, a, tracker.ID, obj("value", 30, "fields", obj(where.ID, "crib")))
	mustLog(t, a, tracker.ID, obj("value", 90, "fields", obj(where.ID, "stroller")))
	mustLog(t, a, tracker.ID, obj("value", 20, "fields", obj(where.ID, "crib")))
	// Whitespace-only text is no answer at all.
	mustLog(t, a, tracker.ID, obj("value", 5, "fields", obj(where.ID, "   ")))

	slices, err := a.Stats.FieldBreakdown(tracker.ID, where.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(slices) != 3 {
		t.Fatalf("expected two answers + Not set, got %+v", slices)
	}
	// Free text has no declared order, so the biggest bucket leads.
	if slices[0].Label != "stroller" || slices[0].Total != 90 {
		t.Errorf("unexpected leading slice: %+v", slices[0])
	}
	if slices[1].Label != "crib" || slices[1].Total != 50 || slices[1].Count != 2 {
		t.Errorf("unexpected second slice: %+v", slices[1])
	}
	if slices[2].Label != "Not set" || slices[2].Count != 1 {
		t.Errorf("expected blank text to count as unanswered: %+v", slices[2])
	}
}

func TestLogManyCarriesFieldAnswers(t *testing.T) {
	a := newTestApp(t)
	tracker, feedType, wetDiaper := feedingTracker(t, a)

	entries, err := a.Entries.LogMany([]any{
		obj("tracker_id", tracker.ID, "value", 120, "fields", obj(feedType.ID, feedType.Options[0].ID)),
		obj("tracker_id", tracker.ID, "value", 60, "fields", obj(wetDiaper.ID, true)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if len(entries[0].Fields) != 1 || *entries[0].Fields[0].OptionID != feedType.Options[0].ID {
		t.Errorf("first batch answer missing: %+v", entries[0].Fields)
	}
	if len(entries[1].Fields) != 1 || *entries[1].Fields[0].NumberValue != 1 {
		t.Errorf("second batch answer missing: %+v", entries[1].Fields)
	}

	// One bad answer rolls the whole batch back.
	before, err := a.Entries.ForTracker(tracker.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Entries.LogMany([]any{
		obj("tracker_id", tracker.ID, "value", 10),
		obj("tracker_id", tracker.ID, "value", 20, "fields", obj(feedType.ID, "bogus")),
	}); err == nil {
		t.Fatal("expected the batch to fail")
	}
	after, err := a.Entries.ForTracker(tracker.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Errorf("failed batch left rows behind: %d → %d", len(before), len(after))
	}
}
