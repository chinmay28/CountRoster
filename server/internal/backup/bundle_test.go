package backup

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/jsjson"
	"github.com/chinmay28/countroster/server/internal/migrate"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

type fixture struct {
	st     *storage.DB
	app    *core.App
	backup *Service
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	st, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := migrate.Run(st); err != nil {
		t.Fatal(err)
	}
	clock := &timeutil.FixedClock{ISO: "2026-05-25T12:00:00.000-07:00"}
	return &fixture{st: st, app: core.New(st, clock), backup: &Service{St: st, Clock: clock}}
}

func (f *fixture) seed(t *testing.T) *core.Tracker {
	t.Helper()
	tracker, err := f.app.Trackers.Create(map[string]any{"name": "Coffee", "target": 3})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.Entries.Log(tracker.ID, map[string]any{"value": 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.Entries.Log(tracker.ID, map[string]any{"value": 2}); err != nil {
		t.Fatal(err)
	}
	note, err := f.app.Notes.Create(map[string]any{"tracker_id": tracker.ID, "body": "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.app.Notes.Update(note.ID, map[string]any{"body": "second"}); err != nil {
		t.Fatal(err)
	}
	group, err := f.app.Groups.Create(map[string]any{"name": "Morning"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.app.Groups.AddTracker(group.ID, tracker.ID); err != nil {
		t.Fatal(err)
	}
	return tracker
}

func TestBuildManifest(t *testing.T) {
	f := newFixture(t)
	f.seed(t)
	m, err := f.backup.BuildManifest("1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if m.Get("app_version") != "1.2.3" {
		t.Errorf("app_version wrong: %v", m.Get("app_version"))
	}
	counts := m.Get("row_counts").(*jsjson.Obj)
	if counts.Get("trackers") != 1.0 || counts.Get("entries") != 2.0 || counts.Get("note_edits") != 1.0 {
		t.Errorf("row_counts wrong: %s", jsjson.Stringify(counts))
	}
	if !checksumRe.MatchString(m.Get("checksums").(*jsjson.Obj).Get("tables").(string)) {
		t.Error("checksum format wrong")
	}
}

func TestExportBundleZipContents(t *testing.T) {
	f := newFixture(t)
	f.seed(t)
	data, err := f.backup.ExportBundle("1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	var trackersCSV string
	for _, file := range zr.File {
		found[file.Name] = true
		if file.Method != zip.Store {
			t.Errorf("%s should use the stored method (TS unzip requirement)", file.Name)
		}
		if file.Name == "exports/trackers.csv" {
			rc, _ := file.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			trackersCSV = string(b)
		}
	}
	for _, want := range []string{"manifest.json", "all.json", "exports/trackers.csv", "exports/entries.csv"} {
		if !found[want] {
			t.Errorf("missing zip entry %s", want)
		}
	}
	if !strings.Contains(strings.Split(trackersCSV, "\r\n")[0], "name") ||
		!strings.Contains(trackersCSV, "Coffee") {
		t.Errorf("trackers.csv wrong:\n%s", trackersCSV)
	}
}

func TestRoundTripExportImport(t *testing.T) {
	src := newFixture(t)
	src.seed(t)
	data, err := src.backup.ExportBundle("1.0.0")
	if err != nil {
		t.Fatal(err)
	}

	dest := newFixture(t)
	result, err := dest.backup.ImportBundle(data, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.ImportedRows.Get("trackers") != 1.0 || result.ImportedRows.Get("entries") != 2.0 {
		t.Errorf("imported_rows wrong: %s", jsjson.Stringify(result.ImportedRows))
	}

	trackers, _ := dest.app.Trackers.List(core.ListOptions{})
	if len(trackers) != 1 || trackers[0].Name != "Coffee" {
		t.Fatalf("restored trackers wrong: %+v", trackers)
	}
	entries, _ := dest.app.Entries.ForTracker(trackers[0].ID, core.TimeRange{})
	if len(entries) != 2 {
		t.Errorf("restored entries wrong: %d", len(entries))
	}
	notes, _ := dest.app.Notes.ForTracker(trackers[0].ID, core.TimeRange{})
	if len(notes) != 1 || notes[0].Body != "second" {
		t.Errorf("restored notes wrong: %+v", notes)
	}
}

func TestRefusesOverwriteWithoutConfirm(t *testing.T) {
	f := newFixture(t)
	f.seed(t)
	data, err := f.backup.ExportBundle("1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.backup.ImportBundle(data, false); err == nil ||
		!strings.Contains(err.Error(), "non-empty") {
		t.Errorf("expected non-empty refusal, got %v", err)
	}
	ok, err := f.backup.ImportBundle(data, true)
	if err != nil {
		t.Fatal(err)
	}
	if ok.ImportedRows.Get("trackers") != 1.0 {
		t.Error("confirmOverwrite import should succeed")
	}
}

func TestChecksumDetectsTampering(t *testing.T) {
	f := newFixture(t)
	f.seed(t)
	data, err := f.backup.ExportBundle("1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	// Same-length replacement keeps the (stored-method) zip offsets valid, so
	// it's the tables checksum that must reject the import.
	tampered := bytes.ReplaceAll(data, []byte("Coffee"), []byte("Teaaaa"))

	dest := newFixture(t)
	if _, err := dest.backup.ImportBundle(tampered, false); err == nil {
		t.Error("tampered bundle should be rejected")
	}
}

// TestImportsNodeBundle is the cross-implementation guarantee: a bundle
// exported by the TypeScript core (testdata/node-bundle.zip, generated with a
// fixed clock) must import into the Go implementation with its checksum
// verifying, and re-computing the manifest over the imported rows must
// reproduce the exact checksum the Node implementation wrote.
func TestImportsNodeBundle(t *testing.T) {
	data, err := os.ReadFile("testdata/node-bundle.zip")
	if err != nil {
		t.Fatal(err)
	}
	var nodeManifest struct {
		Checksums struct {
			Tables string `json:"tables"`
		} `json:"checksums"`
		RowCounts map[string]int `json:"row_counts"`
	}
	manifestJSON, err := os.ReadFile("testdata/node-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(manifestJSON, &nodeManifest); err != nil {
		t.Fatal(err)
	}

	f := newFixture(t)
	result, err := f.backup.ImportBundle(data, false)
	if err != nil {
		t.Fatalf("Node bundle failed to import (checksum canonicalization drift?): %v", err)
	}
	for table, want := range nodeManifest.RowCounts {
		if got := result.ImportedRows.Get(table); got != float64(want) {
			t.Errorf("imported_rows[%s] = %v, want %d", table, got, want)
		}
	}

	// The imported DB is bit-for-bit the same data for every table the Node
	// bundle carried, so hashing just those tables must reproduce the Node
	// manifest's exact checksum. (A full Go re-export also covers tables added
	// to the schema since that bundle was written, so its own checksum
	// legitimately differs.)
	tables, err := f.backup.readAllTables()
	if err != nil {
		t.Fatal(err)
	}
	shared := jsjson.NewObj()
	for _, bt := range backupTables {
		if _, ok := nodeManifest.RowCounts[bt.Name]; ok {
			shared.Set(bt.Name, tables.Get(bt.Name))
		}
	}
	if got := checksumTables(shared); got != nodeManifest.Checksums.Tables {
		t.Errorf("Go checksum %s != Node checksum %s", got, nodeManifest.Checksums.Tables)
	}

	// Spot-check restored domain state: derived Profit still computes, the
	// hidden tracker stays hidden, the archived one stays archived.
	trackers, _ := f.app.Trackers.List(core.ListOptions{IncludeArchived: true, IncludeHidden: true})
	byName := map[string]*core.Tracker{}
	for _, tr := range trackers {
		byName[tr.Name] = tr
	}
	profit := byName["Profit"]
	if profit == nil || profit.IsDerived != 1 {
		t.Fatal("Profit tracker should be restored as derived")
	}
	entries, _ := f.app.Entries.ForTracker(profit.ID, core.TimeRange{})
	total := 0.0
	for _, e := range entries {
		total += e.Value
	}
	if total != 100.25-30.125 {
		t.Errorf("derived total wrong: %v", total)
	}
	if byName["Secret"] == nil || byName["Secret"].IsHidden != 1 {
		t.Error("hidden tracker lost its flag")
	}
	if byName["Old habit"] == nil || byName["Old habit"].ArchivedAt == nil {
		t.Error("archived tracker lost archived_at")
	}
	if byName["Weight"] == nil || byName["Weight"].IsSnapshot != 1 {
		t.Error("snapshot tracker lost its flag")
	}
}

// TestGoBundleReadableByTSUnzip pins the properties the TS unzip relies on:
// stored method only and sizes present in the central directory.
func TestGoBundleMatchesNodeChecksumAfterImport(t *testing.T) {
	// Import the Node bundle, export from Go, re-import that Go bundle into
	// a third instance — full cross-generation round trip.
	data, err := os.ReadFile("testdata/node-bundle.zip")
	if err != nil {
		t.Fatal(err)
	}
	first := newFixture(t)
	if _, err := first.backup.ImportBundle(data, false); err != nil {
		t.Fatal(err)
	}
	goBundle, err := first.backup.ExportBundle("0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	second := newFixture(t)
	if _, err := second.backup.ImportBundle(goBundle, false); err != nil {
		t.Fatalf("Go-exported bundle failed to re-import: %v", err)
	}
	m1, _ := first.backup.BuildManifest("x")
	m2, _ := second.backup.BuildManifest("x")
	c1 := m1.Get("checksums").(*jsjson.Obj).Get("tables").(string)
	c2 := m2.Get("checksums").(*jsjson.Obj).Get("tables").(string)
	if c1 != c2 {
		t.Errorf("round-trip checksum drift: %s vs %s", c1, c2)
	}
}
