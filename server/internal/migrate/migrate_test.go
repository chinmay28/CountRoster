package migrate

import (
	"testing"

	"github.com/chinmay28/countroster/server/internal/storage"
)

func openDB(t *testing.T) *storage.DB {
	t.Helper()
	st, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestFreshDBVersionZero(t *testing.T) {
	st := openDB(t)
	v, err := CurrentVersion(st)
	if err != nil || v != 0 {
		t.Errorf("fresh DB should be version 0, got %d (%v)", v, err)
	}
}

func TestRunAppliesAllMigrations(t *testing.T) {
	st := openDB(t)
	v, err := Run(st)
	if err != nil {
		t.Fatal(err)
	}
	if v != LatestVersion {
		t.Errorf("expected version %d, got %d", LatestVersion, v)
	}
	current, _ := CurrentVersion(st)
	if current != LatestVersion {
		t.Errorf("currentVersion should be %d, got %d", LatestVersion, current)
	}
}

func TestRunIsIdempotent(t *testing.T) {
	st := openDB(t)
	if _, err := Run(st); err != nil {
		t.Fatal(err)
	}
	second, err := Run(st)
	if err != nil || second != LatestVersion {
		t.Errorf("second run should be a no-op at %d, got %d (%v)", LatestVersion, second, err)
	}
}

func TestCreatesEveryExpectedTable(t *testing.T) {
	st := openDB(t)
	if _, err := Run(st); err != nil {
		t.Fatal(err)
	}
	rows, err := st.Query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, r := range rows {
		if s, ok := r.Get("name").(string); ok {
			names[s] = true
		}
	}
	for _, expected := range []string{
		"app_meta", "entries", "note_edits", "notes", "reminders",
		"tracker_group_memberships", "tracker_groups", "tracker_links",
		"tracker_options", "trackers",
	} {
		if !names[expected] {
			t.Errorf("missing table %s", expected)
		}
	}
}
