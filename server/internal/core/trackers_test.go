package core

import "testing"

func TestCreateTrackerDefaults(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Water"))

	if tr.Name != "Water" || tr.Kind != "count" || tr.ResetPeriod != "never" ||
		tr.DefaultValue != 1 || tr.Color != "#888888" {
		t.Errorf("unexpected defaults: %+v", tr)
	}
	if tr.ArchivedAt != nil {
		t.Error("archived_at should be null")
	}
	if tr.ID == "" {
		t.Error("id should be set")
	}
	if tr.CreatedAt != tr.UpdatedAt {
		t.Error("created_at should equal updated_at on create")
	}
}

func TestCreateTrackerRejectsEmptyName(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Trackers.Create(obj("name", "   ")); !isValidationErr(err) {
		t.Errorf("expected validation error, got %v", err)
	}
}

func TestCreateTrackerRejectsInvalidColor(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Trackers.Create(obj("name", "X", "color", "red")); !isValidationErr(err) {
		t.Errorf("expected validation error, got %v", err)
	}
}

func TestUpdateTracker(t *testing.T) {
	a := newTestApp(t)
	created := mustCreate(t, a, obj("name", "Coffee"))

	a.setTime("2026-05-25T15:00:00.000-07:00")
	updated, err := a.Trackers.Update(created.ID, obj("name", "Espresso", "target", 3))
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Espresso" || updated.Target == nil || *updated.Target != 3 {
		t.Errorf("update failed: %+v", updated)
	}
	if updated.UpdatedAt == created.UpdatedAt {
		t.Error("updated_at should change")
	}
	if updated.CreatedAt != created.CreatedAt {
		t.Error("created_at should not change")
	}
}

func TestArchiveUnarchive(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Pushups"))

	if err := a.Trackers.Archive(tr.ID); err != nil {
		t.Fatal(err)
	}
	archived, _ := a.Trackers.Get(tr.ID)
	if archived.ArchivedAt == nil {
		t.Error("archived_at should be set")
	}

	if err := a.Trackers.Unarchive(tr.ID); err != nil {
		t.Fatal(err)
	}
	unarchived, _ := a.Trackers.Get(tr.ID)
	if unarchived.ArchivedAt != nil {
		t.Error("archived_at should be null after unarchive")
	}
}

func TestListExcludesArchived(t *testing.T) {
	a := newTestApp(t)
	trA := mustCreate(t, a, obj("name", "A"))
	trB := mustCreate(t, a, obj("name", "B"))
	if err := a.Trackers.Archive(trB.ID); err != nil {
		t.Fatal(err)
	}

	active, _ := a.Trackers.List(ListOptions{})
	if !equalStrings(trackerIDs(active), []string{trA.ID}) {
		t.Errorf("active list wrong: %v", trackerIDs(active))
	}
	all, _ := a.Trackers.List(ListOptions{IncludeArchived: true})
	if len(all) != 2 {
		t.Errorf("expected 2 with includeArchived, got %d", len(all))
	}
}

func TestDeleteCascades(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Temp"))
	entry := mustLog(t, a, tr.ID, nil)
	if _, err := a.Notes.Create(obj("tracker_id", tr.ID, "entry_id", entry.ID, "body", "hi")); err != nil {
		t.Fatal(err)
	}

	if err := a.Trackers.Delete(tr.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.Trackers.Get(tr.ID); got != nil {
		t.Error("tracker should be gone")
	}
	if got, _ := a.Entries.Get(entry.ID); got != nil {
		t.Error("entries should cascade")
	}
	notes, _ := a.Notes.ForTracker(tr.ID, TimeRange{})
	if len(notes) != 0 {
		t.Error("notes should cascade")
	}
}

func TestDeleteUnknownIsNoop(t *testing.T) {
	a := newTestApp(t)
	if err := a.Trackers.Delete("nope"); err != nil {
		t.Errorf("delete of unknown id should be a no-op, got %v", err)
	}
}

func TestReorder(t *testing.T) {
	a := newTestApp(t)
	trA := mustCreate(t, a, obj("name", "A", "sort_order", 0))
	trB := mustCreate(t, a, obj("name", "B", "sort_order", 1))
	trC := mustCreate(t, a, obj("name", "C", "sort_order", 2))

	if err := a.Trackers.Reorder([]string{trC.ID, trA.ID, trB.ID}); err != nil {
		t.Fatal(err)
	}
	list, _ := a.Trackers.List(ListOptions{})
	if !equalStrings(trackerIDs(list), []string{trC.ID, trA.ID, trB.ID}) {
		t.Errorf("reorder failed: %v", trackerIDs(list))
	}
}

func TestUpdateUnknownTracker(t *testing.T) {
	a := newTestApp(t)
	_, err := a.Trackers.Update("00000000-0000-0000-0000-000000000000", obj("name", "X"))
	if !isNotFound(err) {
		t.Errorf("expected NotFoundError, got %v", err)
	}
}

func TestPatchNullClearsNullableField(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X", "description", "temp", "target", 5))
	updated, err := a.Trackers.Update(tr.ID, map[string]any{"description": nil, "target": nil})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Description != nil || updated.Target != nil {
		t.Errorf("explicit null should clear nullable fields: %+v", updated)
	}
}
