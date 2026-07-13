package api

// Port of apps/server/test/api.test.ts — the REST contract the PWA client is
// compiled against. Same requests, same expected statuses and shapes.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chinmay28/countroster/server/internal/backup"
	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/migrate"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := migrate.Run(st); err != nil {
		t.Fatal(err)
	}
	app := core.New(st, timeutil.SystemClock)
	bk := &backup.Service{St: st, Clock: timeutil.SystemClock}
	srv := httptest.NewServer(New(app, bk, FileSource{Path: st.Path}))
	t.Cleanup(srv.Close)
	return srv
}

type client struct {
	t    *testing.T
	base string
}

func (c *client) do(method, path string, body any) (*http.Response, []byte) {
	c.t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		c.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	data, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		c.t.Fatal(err)
	}
	return res, data
}

func (c *client) getJSON(path string, out any) int {
	c.t.Helper()
	res, data := c.do("GET", path, nil)
	if len(data) > 0 && out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("GET %s: bad JSON %q: %v", path, data, err)
		}
	}
	return res.StatusCode
}

func (c *client) postJSON(path string, body, out any) int {
	c.t.Helper()
	res, data := c.do("POST", path, body)
	if len(data) > 0 && out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("POST %s: bad JSON %q: %v", path, data, err)
		}
	}
	return res.StatusCode
}

type m = map[string]any

func idsOf(list []m) []string {
	out := make([]string, len(list))
	for i, item := range list {
		out[i], _ = item["id"].(string)
	}
	return out
}

func contains(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}

func TestHealth(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var body m
	if status := c.getJSON("/api/health", &body); status != 200 {
		t.Fatalf("status %d", status)
	}
	if body["ok"] != true {
		t.Errorf("health body wrong: %v", body)
	}
}

func TestTrackerEntryNoteLifecycle(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}

	var tracker m
	if status := c.postJSON("/api/trackers", m{"name": "Coffee", "target": 3}, &tracker); status != 201 {
		t.Fatalf("create status %d", status)
	}
	if tracker["name"] != "Coffee" {
		t.Errorf("tracker wrong: %v", tracker)
	}
	id := tracker["id"].(string)

	var list []m
	c.getJSON("/api/trackers", &list)
	if !contains(idsOf(list), id) {
		t.Error("tracker missing from list")
	}

	c.postJSON("/api/trackers/"+id+"/entries", m{"value": 1}, nil)
	c.postJSON("/api/trackers/"+id+"/entries", m{"value": 2}, nil)
	var entries []m
	c.getJSON("/api/trackers/"+id+"/entries", &entries)
	if len(entries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(entries))
	}

	var prog m
	c.getJSON("/api/trackers/"+id+"/stats/target-progress", &prog)
	if prog["current"] != 3.0 {
		t.Errorf("target progress wrong: %v", prog)
	}

	var note m
	c.postJSON("/api/notes", m{"tracker_id": id, "body": "first"}, &note)
	res, _ := c.do("PATCH", "/api/notes/"+note["id"].(string), m{"body": "second"})
	if res.StatusCode != 200 {
		t.Fatalf("note patch status %d", res.StatusCode)
	}
	var history []m
	c.getJSON("/api/notes/"+note["id"].(string)+"/history", &history)
	if len(history) != 1 || history[0]["prev_body"] != "first" {
		t.Errorf("history wrong: %v", history)
	}
}

func TestArchiveRestoreDelete(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var tracker m
	c.postJSON("/api/trackers", m{"name": "Temp"}, &tracker)
	id := tracker["id"].(string)

	if status := c.postJSON("/api/trackers/"+id+"/archive", nil, nil); status != 204 {
		t.Fatalf("archive status %d", status)
	}
	var active []m
	c.getJSON("/api/trackers", &active)
	if contains(idsOf(active), id) {
		t.Error("archived tracker should be hidden from default list")
	}
	var archived []m
	c.getJSON("/api/trackers?includeArchived=1", &archived)
	if !contains(idsOf(archived), id) {
		t.Error("archived tracker should appear with includeArchived")
	}

	if status := c.postJSON("/api/trackers/"+id+"/unarchive", nil, nil); status != 204 {
		t.Fatalf("unarchive failed")
	}
	var restored []m
	c.getJSON("/api/trackers", &restored)
	if !contains(idsOf(restored), id) {
		t.Error("unarchived tracker should be listed")
	}

	res, _ := c.do("DELETE", "/api/trackers/"+id, nil)
	if res.StatusCode != 204 {
		t.Fatalf("delete status %d", res.StatusCode)
	}
	if status := c.getJSON("/api/trackers/"+id, nil); status != 404 {
		t.Errorf("deleted tracker should 404, got %d", status)
	}
}

func TestHiddenTrackers(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var tracker m
	c.postJSON("/api/trackers", m{"name": "Covert", "is_hidden": 1}, &tracker)
	if tracker["is_hidden"] != 1.0 {
		t.Errorf("is_hidden should be the number 1, got %v", tracker["is_hidden"])
	}
	id := tracker["id"].(string)

	var def []m
	c.getJSON("/api/trackers", &def)
	if contains(idsOf(def), id) {
		t.Error("hidden tracker leaked into default list")
	}
	var withHidden []m
	c.getJSON("/api/trackers?includeHidden=1", &withHidden)
	if !contains(idsOf(withHidden), id) {
		t.Error("includeHidden should reveal it")
	}

	var visible m
	c.postJSON("/api/trackers", m{"name": "Overt"}, &visible)
	status := c.postJSON("/api/trackers", m{
		"name": "Mixed", "is_hidden": 1,
		"links": []m{{"source_id": visible["id"], "coefficient": 1}},
	}, nil)
	if status != 400 {
		t.Errorf("mixed-visibility derivation should 400, got %d", status)
	}
}

func TestBatchLogging(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var a, b m
	c.postJSON("/api/trackers", m{"name": "Batch A"}, &a)
	c.postJSON("/api/trackers", m{"name": "Batch B", "default_value": 4}, &b)

	var logged []m
	status := c.postJSON("/api/entries/batch", []m{
		{"tracker_id": a["id"], "value": 2, "occurred_at": "2026-05-24T12:00:00.000-07:00"},
		{"tracker_id": b["id"]},
	}, &logged)
	if status != 201 {
		t.Fatalf("batch status %d", status)
	}
	if logged[0]["value"] != 2.0 || logged[1]["value"] != 4.0 {
		t.Errorf("batch values wrong: %v", logged)
	}

	status = c.postJSON("/api/entries/batch", []m{
		{"tracker_id": a["id"], "value": 9},
		{"tracker_id": "does-not-exist"},
	}, nil)
	if status != 404 {
		t.Errorf("bad batch should 404, got %d", status)
	}
	var entries []m
	c.getJSON("/api/trackers/"+a["id"].(string)+"/entries", &entries)
	if len(entries) != 1 {
		t.Errorf("bad batch should roll back; got %d entries", len(entries))
	}
}

func TestUnknownTracker404(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var body m
	if status := c.getJSON("/api/trackers/does-not-exist", &body); status != 404 {
		t.Fatalf("status %d", status)
	}
	if body["error"] != "tracker not found" {
		t.Errorf("error body wrong: %v", body)
	}
}

func TestValidation400(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var body m
	if status := c.postJSON("/api/trackers", m{"name": ""}, &body); status != 400 {
		t.Fatalf("status %d", status)
	}
	if !strings.Contains(body["error"].(string), "Validation") {
		t.Errorf("error should mention Validation: %v", body)
	}
}

func TestGroupsEndpoints(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var tracker, group m
	c.postJSON("/api/trackers", m{"name": "Meds"}, &tracker)
	c.postJSON("/api/groups", m{"name": "Health"}, &group)

	status := c.postJSON("/api/groups/"+group["id"].(string)+"/trackers",
		m{"tracker_id": tracker["id"]}, nil)
	if status != 204 {
		t.Fatalf("add tracker status %d", status)
	}
	var members []m
	c.getJSON("/api/groups/"+group["id"].(string)+"/trackers", &members)
	if len(members) != 1 || members[0]["id"] != tracker["id"] {
		t.Errorf("members wrong: %v", members)
	}
}

func TestDerivedTrackerOverAPI(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var revenue, expenses m
	c.postJSON("/api/trackers", m{"name": "Rev", "kind": "number"}, &revenue)
	c.postJSON("/api/trackers", m{"name": "Exp", "kind": "number"}, &expenses)
	c.postJSON("/api/trackers/"+revenue["id"].(string)+"/entries", m{"value": 100}, nil)
	c.postJSON("/api/trackers/"+expenses["id"].(string)+"/entries", m{"value": 30}, nil)

	var profit m
	c.postJSON("/api/trackers", m{
		"name": "Profit", "kind": "number",
		"links": []m{
			{"source_id": revenue["id"], "coefficient": 1},
			{"source_id": expenses["id"], "coefficient": -1},
		},
	}, &profit)
	if profit["is_derived"] != 1.0 {
		t.Fatalf("is_derived wrong: %v", profit["is_derived"])
	}
	profitID := profit["id"].(string)

	var links []m
	c.getJSON("/api/trackers/"+profitID+"/links", &links)
	if len(links) != 2 {
		t.Errorf("links wrong: %v", links)
	}

	var entries []m
	c.getJSON("/api/trackers/"+profitID+"/entries", &entries)
	total := 0.0
	for _, e := range entries {
		total += e["value"].(float64)
	}
	if total != 70 {
		t.Errorf("derived total wrong: %v", total)
	}

	var slices []m
	c.getJSON("/api/trackers/"+profitID+"/stats/composition", &slices)
	if len(slices) != 2 ||
		slices[0]["name"] != "Rev" || slices[0]["total"] != 100.0 ||
		slices[1]["name"] != "Exp" || slices[1]["total"] != -30.0 {
		t.Errorf("composition wrong: %v", slices)
	}

	var scoped []m
	c.getJSON("/api/trackers/"+profitID+"/stats/composition?end=2000-01-01T00:00:00.000Z", &scoped)
	if scoped[0]["total"] != 0.0 || scoped[1]["total"] != 0.0 {
		t.Errorf("scoped composition wrong: %v", scoped)
	}

	if status := c.postJSON("/api/trackers/"+profitID+"/entries", m{"value": 5}, nil); status != 400 {
		t.Errorf("logging on derived should 400, got %d", status)
	}

	res, _ := c.do("PUT", "/api/trackers/"+profitID+"/links",
		m{"links": []m{{"source_id": profitID, "coefficient": 1}}})
	if res.StatusCode != 400 {
		t.Errorf("self-referential links should 400, got %d", res.StatusCode)
	}

	var conflictBody m
	revenueID := revenue["id"].(string)
	res, data := c.do("POST", "/api/trackers/"+revenueID+"/archive", nil)
	json.Unmarshal(data, &conflictBody)
	if res.StatusCode != 409 || !strings.Contains(conflictBody["error"].(string), "Profit") {
		t.Errorf("archive of in-use source should 409 naming dependent: %d %v", res.StatusCode, conflictBody)
	}
	res, _ = c.do("DELETE", "/api/trackers/"+revenueID, nil)
	if res.StatusCode != 409 {
		t.Errorf("delete of in-use source should 409, got %d", res.StatusCode)
	}

	res, _ = c.do("DELETE", "/api/trackers/"+profitID, nil)
	if res.StatusCode != 204 {
		t.Errorf("delete derived should 204, got %d", res.StatusCode)
	}
	res, _ = c.do("DELETE", "/api/trackers/"+revenueID, nil)
	if res.StatusCode != 204 {
		t.Errorf("delete freed source should 204, got %d", res.StatusCode)
	}
}

func TestBucketsQueryValidation(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var tracker m
	c.postJSON("/api/trackers", m{"name": "Validated"}, &tracker)
	id := tracker["id"].(string)

	if status := c.getJSON("/api/trackers/"+id+
		"/stats/buckets?start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z&period=fortnight", nil); status != 400 {
		t.Errorf("bad period should 400, got %d", status)
	}
	if status := c.getJSON("/api/trackers/"+id+
		"/stats/buckets?start=nonsense&end=alsononsense&period=day", nil); status != 400 {
		t.Errorf("bad dates should 400, got %d", status)
	}
	if status := c.getJSON("/api/trackers/"+id+
		"/stats/buckets?start=2026-01-01T00:00:00.000Z&end=2026-01-08T00:00:00.000Z&period=day", nil); status != 200 {
		t.Errorf("valid request should 200, got %d", status)
	}
}

func TestReorderWithNoBody(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	req, _ := http.NewRequest("POST", c.base+"/api/trackers/reorder", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Errorf("bodyless reorder should 204, got %d", res.StatusCode)
	}
}

func TestBackupEndpoints(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	var manifest m
	c.getJSON("/api/backup/manifest", &manifest)
	tables := manifest["checksums"].(map[string]any)["tables"].(string)
	if !strings.HasPrefix(tables, "sha256:") {
		t.Errorf("manifest checksum wrong: %v", tables)
	}

	res, data := c.do("GET", "/api/backup/bundle", nil)
	if res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Type"), "application/zip") {
		t.Fatalf("bundle response wrong: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	if !strings.Contains(res.Header.Get("Content-Disposition"), ".countroster.zip") {
		t.Errorf("disposition wrong: %s", res.Header.Get("Content-Disposition"))
	}
	if len(data) < 4 || data[0] != 0x50 || data[1] != 0x4b || data[2] != 0x03 || data[3] != 0x04 {
		t.Error("bundle should start with the ZIP local header magic")
	}

	// Import it back (empty DB → no confirmOverwrite needed).
	req, _ := http.NewRequest("POST", c.base+"/api/backup/import", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/zip")
	res2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res2.Body)
	res2.Body.Close()
	if res2.StatusCode != 200 {
		t.Errorf("import failed: %d %s", res2.StatusCode, body)
	}

	// In-memory DB → raw sqlite download is a 501.
	res3, _ := c.do("GET", "/api/backup/sqlite", nil)
	if res3.StatusCode != 501 {
		t.Errorf("raw sqlite on :memory: should 501, got %d", res3.StatusCode)
	}
}

func TestTrackerPatch404(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}
	res, data := c.do("PATCH", "/api/trackers/nope", m{"name": "X"})
	if res.StatusCode != 404 {
		t.Errorf("patch of unknown tracker should 404, got %d %s", res.StatusCode, data)
	}
}

// TestTransactionsOverAPI pins the credit-card transactions contract: import
// with dedupe, list by status, patch, dismiss (DELETE = ignored), and confirm
// producing an entry plus a note carrying the transaction name.
func TestTransactionsOverAPI(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}

	var groceries m
	if status := c.postJSON("/api/trackers", m{"name": "Groceries", "unit": "$"}, &groceries); status != 201 {
		t.Fatalf("create tracker: %d", status)
	}

	// Import two rows; one auto-categorizes via the CSV category column.
	var imported m
	status := c.postJSON("/api/transactions/import", m{
		"transactions": []m{
			{"date": "2026-07-01", "description": "TRADER JOE'S #552",
				"amount": -43.21, "account": "Amex", "category": "Groceries"},
			{"date": "2026-07-02", "description": "SOME CAFE", "amount": -5.5},
		},
	}, &imported)
	if status != 201 {
		t.Fatalf("import: %d %v", status, imported)
	}
	if imported["imported"] != float64(2) || imported["duplicates"] != float64(0) {
		t.Fatalf("import summary: %v", imported)
	}
	txns := imported["transactions"].([]any)
	tj := txns[0].(m)
	if tj["name"] != "Trader Joe's" || tj["status"] != "pending" ||
		tj["raw_description"] != "TRADER JOE'S #552" || tj["tracker_id"] != groceries["id"] {
		t.Fatalf("transaction shape: %v", tj)
	}

	// Re-import → all duplicates.
	var again m
	c.postJSON("/api/transactions/import", m{
		"transactions": []m{
			{"date": "2026-07-01", "description": "TRADER JOE'S #552",
				"amount": -43.21, "account": "Amex", "category": "Groceries"},
		},
	}, &again)
	if again["imported"] != float64(0) || again["duplicates"] != float64(1) {
		t.Fatalf("re-import summary: %v", again)
	}

	// Pending list (default), newest first.
	var pending []m
	if status := c.getJSON("/api/transactions", &pending); status != 200 || len(pending) != 2 {
		t.Fatalf("pending list: %d %v", status, pending)
	}
	if status := c.getJSON("/api/transactions?status=bogus", nil); status != 400 {
		t.Fatalf("bad status filter should 400, got %d", status)
	}

	// Patch the name.
	tjID := tj["id"].(string)
	res, data := c.do("PATCH", "/api/transactions/"+tjID, m{"name": "Trader Joe's Run"})
	if res.StatusCode != 200 {
		t.Fatalf("patch: %d %s", res.StatusCode, data)
	}

	// Confirm: 201 with transaction+entry+note; note body is the edited name.
	var confirmed m
	if status := c.postJSON("/api/transactions/"+tjID+"/confirm", m{}, &confirmed); status != 201 {
		t.Fatalf("confirm: %d %v", status, confirmed)
	}
	entry := confirmed["entry"].(m)
	note := confirmed["note"].(m)
	txn := confirmed["transaction"].(m)
	if entry["tracker_id"] != groceries["id"] || entry["value"] != 43.21 {
		t.Fatalf("entry: %v", entry)
	}
	if note["body"] != "Trader Joe's Run" || note["entry_id"] != entry["id"] {
		t.Fatalf("note: %v", note)
	}
	if txn["status"] != "confirmed" || txn["entry_id"] != entry["id"] {
		t.Fatalf("transaction: %v", txn)
	}

	// Confirmed rows can't be edited, re-confirmed, or deleted.
	if res, _ := c.do("PATCH", "/api/transactions/"+tjID, m{"name": "X"}); res.StatusCode != 400 {
		t.Fatalf("patch confirmed should 400, got %d", res.StatusCode)
	}
	if status := c.postJSON("/api/transactions/"+tjID+"/confirm", m{}, nil); status != 400 {
		t.Fatalf("re-confirm should 400, got %d", status)
	}
	if res, _ := c.do("DELETE", "/api/transactions/"+tjID, nil); res.StatusCode != 400 {
		t.Fatalf("delete confirmed should 400, got %d", res.StatusCode)
	}

	// DELETE a pending row dismisses it into `ignored`.
	cafeID := txns[1].(m)["id"].(string)
	if res, _ := c.do("DELETE", "/api/transactions/"+cafeID, nil); res.StatusCode != 204 {
		t.Fatalf("delete pending: %d", res.StatusCode)
	}
	var ignored []m
	if status := c.getJSON("/api/transactions?status=ignored", &ignored); status != 200 || len(ignored) != 1 {
		t.Fatalf("ignored list: %d %v", status, ignored)
	}

	// DELETE on an ignored row purges it for good.
	if res, _ := c.do("DELETE", "/api/transactions/"+cafeID, nil); res.StatusCode != 204 {
		t.Fatalf("delete ignored: %d", res.StatusCode)
	}
	if status := c.getJSON("/api/transactions?status=ignored", &ignored); status != 200 || len(ignored) != 0 {
		t.Fatalf("ignored list after purge: %d %v", status, ignored)
	}

	// Confirm without any tracker (no suggestion) → 400; unknown id → 404.
	if status := c.getJSON("/api/transactions/nope", nil); status != 404 {
		t.Fatalf("get unknown: %d", status)
	}
	var out m
	if status := c.postJSON("/api/transactions/import", m{"transactions": []m{
		{"date": "2026-07-03", "description": "MYSTERY", "amount": -1},
	}}, &out); status != 201 {
		t.Fatalf("import: %d", status)
	}
	mysteryID := out["transactions"].([]any)[0].(m)["id"].(string)
	if status := c.postJSON("/api/transactions/"+mysteryID+"/confirm", nil, nil); status != 400 {
		t.Fatalf("confirm with no tracker should 400, got %d", status)
	}
}
