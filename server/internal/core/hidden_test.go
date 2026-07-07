package core

import "testing"

func TestHiddenDefaults(t *testing.T) {
	a := newTestApp(t)
	if tr := mustCreate(t, a, obj("name", "Water")); tr.IsHidden != 0 {
		t.Error("trackers should be visible by default")
	}
	if tr := mustCreate(t, a, obj("name", "Secret", "is_hidden", 1)); tr.IsHidden != 1 {
		t.Error("is_hidden should persist")
	}
}

func TestListExcludesHidden(t *testing.T) {
	a := newTestApp(t)
	visible := mustCreate(t, a, obj("name", "Visible"))
	hidden := mustCreate(t, a, obj("name", "Hidden", "is_hidden", 1))

	def, _ := a.Trackers.List(ListOptions{})
	if !equalStrings(trackerIDs(def), []string{visible.ID}) {
		t.Errorf("default list wrong: %v", trackerIDs(def))
	}
	all, _ := a.Trackers.List(ListOptions{IncludeHidden: true})
	if len(all) != 2 {
		t.Errorf("includeHidden should show both, got %d", len(all))
	}
	_ = hidden
}

func TestIncludeHiddenComposesWithIncludeArchived(t *testing.T) {
	a := newTestApp(t)
	hidden := mustCreate(t, a, obj("name", "Hidden", "is_hidden", 1))
	if err := a.Trackers.Archive(hidden.ID); err != nil {
		t.Fatal(err)
	}

	if list, _ := a.Trackers.List(ListOptions{IncludeArchived: true}); len(list) != 0 {
		t.Error("archived+hidden should stay hidden without includeHidden")
	}
	if list, _ := a.Trackers.List(ListOptions{IncludeHidden: true}); len(list) != 0 {
		t.Error("hidden+archived should stay out without includeArchived")
	}
	both, _ := a.Trackers.List(ListOptions{IncludeArchived: true, IncludeHidden: true})
	if !equalStrings(trackerIDs(both), []string{hidden.ID}) {
		t.Errorf("both flags should reveal it: %v", trackerIDs(both))
	}
}

func TestHideUnhideViaUpdate(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Coffee"))

	hidden, err := a.Trackers.Update(tr.ID, obj("is_hidden", 1))
	if err != nil || hidden.IsHidden != 1 {
		t.Fatalf("hide failed: %+v %v", hidden, err)
	}
	list, _ := a.Trackers.List(ListOptions{})
	for _, x := range list {
		if x.ID == tr.ID {
			t.Error("hidden tracker should not be listed")
		}
	}

	visible, err := a.Trackers.Update(tr.ID, obj("is_hidden", 0))
	if err != nil || visible.IsHidden != 0 {
		t.Fatalf("unhide failed: %+v %v", visible, err)
	}
}

func TestDerivationsCannotMixVisibility(t *testing.T) {
	a := newTestApp(t)

	visSource := mustCreate(t, a, obj("name", "Revenue", "kind", "number"))
	if _, err := a.Trackers.Create(obj("name", "Secret profit", "kind", "number", "is_hidden", 1,
		"links", []any{obj("source_id", visSource.ID, "coefficient", 1)})); !isDerivedErr(err) {
		t.Errorf("hidden-over-visible: expected DerivedTrackerError, got %v", err)
	}

	hidSource := mustCreate(t, a, obj("name", "Secret revenue", "kind", "number", "is_hidden", 1))
	if _, err := a.Trackers.Create(obj("name", "Profit", "kind", "number",
		"links", []any{obj("source_id", hidSource.ID, "coefficient", 1)})); !isDerivedErr(err) {
		t.Errorf("visible-over-hidden: expected DerivedTrackerError, got %v", err)
	}
}

func TestHiddenDerivationOverHiddenSources(t *testing.T) {
	a := newTestApp(t)
	trA := mustCreate(t, a, obj("name", "A", "kind", "number", "is_hidden", 1))
	trB := mustCreate(t, a, obj("name", "B", "kind", "number", "is_hidden", 1))
	derived := mustCreate(t, a, obj("name", "A minus B", "kind", "number", "is_hidden", 1,
		"links", []any{
			obj("source_id", trA.ID, "coefficient", 1),
			obj("source_id", trB.ID, "coefficient", -1),
		}))
	if derived.IsDerived != 1 || derived.IsHidden != 1 {
		t.Errorf("bad derived tracker: %+v", derived)
	}

	mustLog(t, a, trA.ID, obj("value", 5))
	mustLog(t, a, trB.ID, obj("value", 2))
	entries, _ := a.Entries.ForTracker(derived.ID, TimeRange{})
	if sumValues(entries) != 3 {
		t.Errorf("combined value wrong: %v", entryValues(entries))
	}
}

func TestSetLinksRejectsOtherVisibility(t *testing.T) {
	a := newTestApp(t)
	hiddenSource := mustCreate(t, a, obj("name", "H", "is_hidden", 1))
	derived := mustCreate(t, a, obj("name", "D", "kind", "number"))
	if _, err := a.Trackers.SetLinks(derived.ID,
		[]TrackerLinkInput{{SourceID: hiddenSource.ID, Coefficient: 1}}); !isDerivedErr(err) {
		t.Errorf("expected DerivedTrackerError, got %v", err)
	}
}

func TestRejectsVisibilityFlipsSplittingDerivation(t *testing.T) {
	a := newTestApp(t)
	source := mustCreate(t, a, obj("name", "Revenue", "kind", "number"))
	mustCreate(t, a, obj("name", "Profit", "kind", "number",
		"links", []any{obj("source_id", source.ID, "coefficient", 1)}))
	if _, err := a.Trackers.Update(source.ID, obj("is_hidden", 1)); !isDerivedErr(err) {
		t.Errorf("hiding a source of a visible derivation should fail, got %v", err)
	}

	hSource := mustCreate(t, a, obj("name", "H", "kind", "number", "is_hidden", 1))
	hDerived := mustCreate(t, a, obj("name", "D", "kind", "number", "is_hidden", 1,
		"links", []any{obj("source_id", hSource.ID, "coefficient", 1)}))
	if _, err := a.Trackers.Update(hDerived.ID, obj("is_hidden", 0)); !isDerivedErr(err) {
		t.Errorf("unhiding only the derived tracker should fail, got %v", err)
	}
}

func TestUnhideWithReplacementLinks(t *testing.T) {
	a := newTestApp(t)
	hiddenSource := mustCreate(t, a, obj("name", "H", "kind", "number", "is_hidden", 1))
	visibleSource := mustCreate(t, a, obj("name", "V", "kind", "number"))
	derived := mustCreate(t, a, obj("name", "D", "kind", "number", "is_hidden", 1,
		"links", []any{obj("source_id", hiddenSource.ID, "coefficient", 1)}))

	updated, err := a.Trackers.Update(derived.ID, obj("is_hidden", 0,
		"links", []any{obj("source_id", visibleSource.ID, "coefficient", 1)}))
	if err != nil {
		t.Fatal(err)
	}
	if updated.IsHidden != 0 {
		t.Error("should be visible now")
	}
	links, _ := a.Trackers.Links(derived.ID)
	if len(links) != 1 || links[0].SourceID != visibleSource.ID {
		t.Errorf("links wrong: %+v", links)
	}
}
