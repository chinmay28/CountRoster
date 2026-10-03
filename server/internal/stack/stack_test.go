package stack

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/migrate"
)

func TestOpenMigratesAndServesTheAPI(t *testing.T) {
	st, err := Open(Options{DBPath: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if st.SchemaVersion != migrate.LatestVersion {
		t.Errorf("schema v%d, want v%d", st.SchemaVersion, migrate.LatestVersion)
	}
	rec := httptest.NewRecorder()
	st.API.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/trackers", nil))
	if rec.Code != 200 || rec.Body.String() != "[]\n" && rec.Body.String() != "[]" {
		t.Errorf("GET /api/trackers = %d %q", rec.Code, rec.Body.String())
	}
}

func TestOpenCreatesTheParentDirectoryAndReopens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "db.sqlite")
	st, err := Open(Options{DBPath: path})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.App.Trackers.Create(map[string]any{"name": "Water", "kind": "count"}); err != nil {
		t.Fatal(err)
	}
	st.Close()

	st, err = Open(Options{DBPath: path})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	list, err := st.App.Trackers.List(core.ListOptions{})
	if err != nil || len(list) != 1 {
		t.Fatalf("after reopen: %d trackers, err %v", len(list), err)
	}
}
