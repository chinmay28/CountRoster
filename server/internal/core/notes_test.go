package core

import "testing"

func TestCreateNote(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Mood"))

	n, err := a.Notes.Create(obj("tracker_id", tr.ID, "body", "Feeling alright today."))
	if err != nil {
		t.Fatal(err)
	}
	if n.Body != "Feeling alright today." || n.TrackerID != tr.ID || n.EntryID != nil {
		t.Errorf("bad note: %+v", n)
	}
}

func TestCreateNoteAttachedToEntry(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Mood"))
	e := mustLog(t, a, tr.ID, nil)

	n, err := a.Notes.Create(obj("tracker_id", tr.ID, "entry_id", e.ID, "body", "afternoon"))
	if err != nil {
		t.Fatal(err)
	}
	if n.EntryID == nil || *n.EntryID != e.ID {
		t.Errorf("entry_id not set: %+v", n)
	}
}

func TestEditRecordsHistory(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Mood"))
	created, _ := a.Notes.Create(obj("tracker_id", tr.ID, "body", "Felt off today."))

	a.setTime("2026-05-25T13:00:00.000-07:00")
	edited, err := a.Notes.Update(created.ID, obj("body", "Felt better after a walk."))
	if err != nil {
		t.Fatal(err)
	}
	if edited.Body != "Felt better after a walk." || edited.UpdatedAt == created.UpdatedAt {
		t.Errorf("edit failed: %+v", edited)
	}

	history, _ := a.Notes.History(created.ID)
	if len(history) != 1 || history[0].PrevBody != "Felt off today." {
		t.Errorf("history wrong: %+v", history)
	}
}

func TestEditAppendsHistoryAcrossEdits(t *testing.T) {
	a := newTestApp(t)
	a.setTime("2026-05-25T10:00:00.000-07:00")
	tr := mustCreate(t, a, obj("name", "X"))
	n, _ := a.Notes.Create(obj("tracker_id", tr.ID, "body", "v1"))

	a.setTime("2026-05-25T11:00:00.000-07:00")
	if _, err := a.Notes.Update(n.ID, obj("body", "v2")); err != nil {
		t.Fatal(err)
	}
	a.setTime("2026-05-25T12:00:00.000-07:00")
	if _, err := a.Notes.Update(n.ID, obj("body", "v3")); err != nil {
		t.Fatal(err)
	}

	history, _ := a.Notes.History(n.ID)
	if len(history) != 2 || history[0].PrevBody != "v1" || history[1].PrevBody != "v2" {
		t.Errorf("history wrong: %+v", history)
	}
	current, _ := a.Notes.Get(n.ID)
	if current.Body != "v3" {
		t.Errorf("body wrong: %s", current.Body)
	}
}

func TestEditNoopWhenUnchanged(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X"))
	n, _ := a.Notes.Create(obj("tracker_id", tr.ID, "body", "same"))

	if _, err := a.Notes.Update(n.ID, obj("body", "same")); err != nil {
		t.Fatal(err)
	}
	history, _ := a.Notes.History(n.ID)
	if len(history) != 0 {
		t.Error("no-op edit should write no history")
	}
}

func TestEditUnknownNote(t *testing.T) {
	a := newTestApp(t)
	if _, err := a.Notes.Update("nope", obj("body", "x")); !isNotFound(err) {
		t.Errorf("expected NotFoundError, got %v", err)
	}
}

func TestDeleteNoteCascadesEditsKeepsEntry(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X"))
	e := mustLog(t, a, tr.ID, nil)
	n, _ := a.Notes.Create(obj("tracker_id", tr.ID, "entry_id", e.ID, "body", "v1"))
	if _, err := a.Notes.Update(n.ID, obj("body", "v2")); err != nil {
		t.Fatal(err)
	}

	if err := a.Notes.Delete(n.ID); err != nil {
		t.Fatal(err)
	}
	rows, _ := a.st.Query(`SELECT COUNT(*) AS c FROM note_edits WHERE note_id = ?`, n.ID)
	if asInt(rows[0].Get("c")) != 0 {
		t.Error("note_edits should cascade")
	}
	if still, _ := a.Entries.Get(e.ID); still == nil {
		t.Error("entry should survive note deletion")
	}
}

func TestDeleteEntryNullsNoteEntryID(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "X"))
	e := mustLog(t, a, tr.ID, nil)
	n, _ := a.Notes.Create(obj("tracker_id", tr.ID, "entry_id", e.ID, "body", "v1"))

	if err := a.Entries.Delete(e.ID); err != nil {
		t.Fatal(err)
	}
	reread, _ := a.Notes.Get(n.ID)
	if reread == nil || reread.EntryID != nil || reread.Body != "v1" {
		t.Errorf("note should survive with entry_id nulled: %+v", reread)
	}
}

func TestUpdateNoteRedatesWithoutHistory(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Mood"))
	n, _ := a.Notes.Create(obj("tracker_id", tr.ID, "body", "Note"))

	moved, err := a.Notes.Update(n.ID, obj("occurred_at", "2026-05-01T09:00:00.000-07:00"))
	if err != nil {
		t.Fatal(err)
	}
	if moved.OccurredAt != "2026-05-01T09:00:00.000-07:00" || moved.Body != "Note" {
		t.Errorf("re-date failed: %+v", moved)
	}
	history, _ := a.Notes.History(n.ID)
	if len(history) != 0 {
		t.Error("re-dating should write no audit row")
	}
}

func TestUpdateNoteBodyAndDateTogether(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Mood"))
	n, _ := a.Notes.Create(obj("tracker_id", tr.ID, "body", "before"))

	a.setTime("2026-05-25T13:00:00.000-07:00")
	updated, err := a.Notes.Update(n.ID, obj("body", "after", "occurred_at", "2026-04-01T08:00:00.000-07:00"))
	if err != nil {
		t.Fatal(err)
	}
	if updated.Body != "after" || updated.OccurredAt != "2026-04-01T08:00:00.000-07:00" {
		t.Errorf("update failed: %+v", updated)
	}
	history, _ := a.Notes.History(n.ID)
	if len(history) != 1 || history[0].PrevBody != "before" {
		t.Errorf("history wrong: %+v", history)
	}
}
