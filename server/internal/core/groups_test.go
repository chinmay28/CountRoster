package core

import "testing"

func TestGroupCreateGetList(t *testing.T) {
	a := newTestApp(t)
	g, err := a.Groups.Create(obj("name", "Health", "color", "#4ECDC4"))
	if err != nil {
		t.Fatal(err)
	}
	if g.Name != "Health" || g.Color == nil || *g.Color != "#4ECDC4" {
		t.Errorf("bad group: %+v", g)
	}

	got, _ := a.Groups.Get(g.ID)
	if got == nil || got.ID != g.ID {
		t.Error("get should round-trip")
	}
	all, _ := a.Groups.List()
	if len(all) != 1 || all[0].ID != g.ID {
		t.Error("list should contain the group")
	}
}

func TestGroupUpdate(t *testing.T) {
	a := newTestApp(t)
	g, _ := a.Groups.Create(obj("name", "Old"))
	updated, err := a.Groups.Update(g.ID, obj("name", "New"))
	if err != nil || updated.Name != "New" {
		t.Errorf("update failed: %+v, %v", updated, err)
	}

	if _, err := a.Groups.Update("nope", obj("name", "x")); !isNotFound(err) {
		t.Errorf("expected NotFoundError, got %v", err)
	}
}

func TestGroupMembership(t *testing.T) {
	a := newTestApp(t)
	g, _ := a.Groups.Create(obj("name", "Morning"))
	trA := mustCreate(t, a, obj("name", "A"))
	trB := mustCreate(t, a, obj("name", "B"))

	for _, id := range []string{trA.ID, trB.ID, trA.ID} { // 3rd add is idempotent
		if err := a.Groups.AddTracker(g.ID, id); err != nil {
			t.Fatal(err)
		}
	}
	members, _ := a.Groups.TrackersIn(g.ID)
	if !equalStrings(trackerIDs(members), []string{trA.ID, trB.ID}) {
		t.Errorf("members wrong: %v", trackerIDs(members))
	}

	if err := a.Groups.ReorderMembers(g.ID, []string{trB.ID, trA.ID}); err != nil {
		t.Fatal(err)
	}
	members, _ = a.Groups.TrackersIn(g.ID)
	if !equalStrings(trackerIDs(members), []string{trB.ID, trA.ID}) {
		t.Errorf("reorder wrong: %v", trackerIDs(members))
	}

	if err := a.Groups.RemoveTracker(g.ID, trB.ID); err != nil {
		t.Fatal(err)
	}
	members, _ = a.Groups.TrackersIn(g.ID)
	if !equalStrings(trackerIDs(members), []string{trA.ID}) {
		t.Errorf("remove wrong: %v", trackerIDs(members))
	}
}

func TestGroupReorder(t *testing.T) {
	a := newTestApp(t)
	gA, _ := a.Groups.Create(obj("name", "A"))
	gB, _ := a.Groups.Create(obj("name", "B"))
	gC, _ := a.Groups.Create(obj("name", "C"))

	list, _ := a.Groups.List()
	if !(list[0].ID == gA.ID && list[1].ID == gB.ID && list[2].ID == gC.ID) {
		t.Fatalf("default order should be creation order")
	}

	if err := a.Groups.Reorder([]string{gC.ID, gA.ID, gB.ID}); err != nil {
		t.Fatal(err)
	}
	list, _ = a.Groups.List()
	if !(list[0].ID == gC.ID && list[1].ID == gA.ID && list[2].ID == gB.ID) {
		t.Errorf("reorder failed")
	}
}

func TestGroupDeleteCascadesMemberships(t *testing.T) {
	a := newTestApp(t)
	g, _ := a.Groups.Create(obj("name", "Temp"))
	tr := mustCreate(t, a, obj("name", "T"))
	if err := a.Groups.AddTracker(g.ID, tr.ID); err != nil {
		t.Fatal(err)
	}

	if err := a.Groups.Delete(g.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.Groups.Get(g.ID); got != nil {
		t.Error("group should be gone")
	}
	rows, _ := a.st.Query(`SELECT * FROM tracker_group_memberships WHERE group_id = ?`, g.ID)
	if len(rows) != 0 {
		t.Error("memberships should cascade")
	}
}
