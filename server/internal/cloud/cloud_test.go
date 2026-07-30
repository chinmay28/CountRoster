package cloud

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/chinmay28/countroster/server/internal/backup"
	"github.com/chinmay28/countroster/server/internal/migrate"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// The clock every test starts on — the same instant the core suites pin, so a
// failure reads the same way across packages.
const defaultTestTime = "2026-05-25T12:00:00.000-07:00"

type testClock struct{ iso string }

func (c *testClock) NowISO() string { return c.iso }

// fakeDropbox stands in for Dropbox's three hosts. It records what it was
// asked to do so the tests can assert on the request, not just the outcome.
type fakeDropbox struct {
	srv *httptest.Server

	// Recorded state.
	exchanges    []url.Values
	refreshes    []url.Values
	uploadedArgs string
	uploaded     []byte
	uploadCalls  int

	// Knobs.
	uploadStatus int
	accessToken  string
	expiresIn    int
}

func newFakeDropbox(t *testing.T) *fakeDropbox {
	t.Helper()
	f := &fakeDropbox{uploadStatus: 200, accessToken: "dbx-access-1", expiresIn: 14400}
	mux := http.NewServeMux()

	mux.HandleFunc("POST /oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("grant_type") == "refresh_token" {
			f.refreshes = append(f.refreshes, r.Form)
			writeTestJSON(w, map[string]any{
				"access_token": "dbx-access-2", "expires_in": f.expiresIn,
			})
			return
		}
		f.exchanges = append(f.exchanges, r.Form)
		writeTestJSON(w, map[string]any{
			"access_token":  f.accessToken,
			"refresh_token": "dbx-refresh",
			"expires_in":    f.expiresIn,
		})
	})
	mux.HandleFunc("POST /2/users/get_current_account", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, map[string]any{"email": "hedy@example.com"})
	})
	mux.HandleFunc("POST /2/files/list_folder", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		writeTestJSON(w, map[string]any{"entries": []any{
			map[string]any{".tag": "folder", "name": "Backups", "path_display": body.Path + "/Backups"},
			map[string]any{".tag": "file", "name": "notes.txt", "path_display": body.Path + "/notes.txt"},
		}})
	})
	mux.HandleFunc("POST /2/files/upload", func(w http.ResponseWriter, r *http.Request) {
		f.uploadCalls++
		f.uploadedArgs = r.Header.Get("Dropbox-API-Arg")
		f.uploaded, _ = io.ReadAll(r.Body)
		if f.uploadStatus != 200 {
			http.Error(w, `{"error_summary":"path/not_found/"}`, f.uploadStatus)
			return
		}
		writeTestJSON(w, map[string]any{"name": "ok"})
	})

	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

// provider builds a Dropbox provider pointed at the fake.
func (f *fakeDropbox) provider(now func() time.Time) *Dropbox {
	p := NewDropbox(Credentials{ClientID: "app-key"}, f.srv.Client(), now)
	p.AuthBase = f.srv.URL
	p.APIBase = f.srv.URL
	p.ContentBase = f.srv.URL
	return p
}

func writeTestJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

type harness struct {
	svc   *Service
	st    *storage.DB
	clock *testClock
	dbx   *fakeDropbox
}

func (h *harness) setTime(iso string) { h.clock.iso = iso }

// settings reads the row, failing the test rather than returning an error —
// every assertion in this file wants the row, not the plumbing.
func (h *harness) settings(t *testing.T) *Settings {
	t.Helper()
	set, err := h.svc.Settings()
	if err != nil {
		t.Fatalf("settings: %v", err)
	}
	return set
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	st, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := migrate.Run(st); err != nil {
		t.Fatal(err)
	}
	clock := &testClock{iso: defaultTestTime}
	dbx := newFakeDropbox(t)
	svc := NewService(st, clock, &backup.Service{St: st, Clock: clock},
		Registry{dbx.provider(func() time.Time {
			at, _ := timeutil.ParseInstant(clock.iso)
			return at
		})},
		"v1.1.0-test", "http://countroster.test")
	return &harness{svc: svc, st: st, clock: clock, dbx: dbx}
}

// connect drives a full authorization against the fake provider, the way the
// browser would: start it, read the state out of the authorize URL, come back
// through the callback.
func (h *harness) connect(t *testing.T) {
	t.Helper()
	start, err := h.svc.StartConnect(ProviderDropbox, "http://countroster.test", false)
	if err != nil {
		t.Fatalf("StartConnect: %v", err)
	}
	if _, err := h.svc.CompleteConnect(context.Background(),
		start.PendingID, "auth-code"); err != nil {
		t.Fatalf("CompleteConnect: %v", err)
	}
}

// --- scheduling math ------------------------------------------------------

func TestNextRunIntervals(t *testing.T) {
	from := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		frequency string
		want      time.Time
	}{
		{FrequencyHourly, from.Add(time.Hour)},
		{FrequencyDaily, from.AddDate(0, 0, 1)},
		{FrequencyWeekly, from.AddDate(0, 0, 7)},
		{FrequencyMonthly, from.AddDate(0, 1, 0)},
	}
	for _, c := range cases {
		got, ok := nextRun(from, c.frequency)
		if !ok {
			t.Fatalf("%s: expected a next run", c.frequency)
		}
		if !got.Equal(c.want) {
			t.Errorf("%s: next run = %v, want %v", c.frequency, got, c.want)
		}
	}
	if _, ok := nextRun(from, FrequencyOff); ok {
		t.Error(`"off" should not schedule a next run`)
	}
}

// A monthly schedule set on the 31st has to land somewhere in a 30-day month;
// what matters is that it advances rather than sticking or skipping a month.
func TestMonthlyScheduleFromMonthEnd(t *testing.T) {
	from := time.Date(2026, 1, 31, 9, 0, 0, 0, time.UTC)
	got, _ := nextRun(from, FrequencyMonthly)
	if !got.After(from) || got.Sub(from) > 32*24*time.Hour {
		t.Errorf("monthly from Jan 31 = %v, want within a month of %v", got, from)
	}
}

func TestDueRespectsNextRunAt(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 0, 0, 0, time.UTC)
	connected := func(next *string) *Settings {
		return &Settings{
			Provider: ptr(ProviderDropbox), AccessToken: ptr("t"),
			FolderID: ptr("/Backups"), Frequency: FrequencyDaily, NextRunAt: next,
		}
	}
	if !connected(nil).due(now) {
		t.Error("a schedule with no deadline yet should be due immediately")
	}
	future := timeutil.ToLocalISO(now.Add(time.Hour))
	if connected(&future).due(now) {
		t.Error("a schedule due in an hour is not due now")
	}
	past := timeutil.ToLocalISO(now.Add(-time.Second))
	if !connected(&past).due(now) {
		t.Error("an overdue schedule should be due")
	}

	// The three ways a schedule can be inert.
	off := connected(&past)
	off.Frequency = FrequencyOff
	if off.due(now) {
		t.Error(`frequency "off" is never due`)
	}
	noFolder := connected(&past)
	noFolder.FolderID = nil
	if noFolder.due(now) {
		t.Error("no destination folder means nothing is due")
	}
	noAccount := connected(&past)
	noAccount.AccessToken = nil
	if noAccount.due(now) {
		t.Error("a disconnected account is never due")
	}
}

// --- settings -------------------------------------------------------------

func TestDefaultSettingsAreOffAndDisconnected(t *testing.T) {
	h := newHarness(t)
	set := h.settings(t)
	if set.Frequency != FrequencyOff {
		t.Errorf("frequency = %q, want %q", set.Frequency, FrequencyOff)
	}
	if set.Connected() {
		t.Error("a fresh database should have no cloud account")
	}
	if pub := set.Public(); pub.Connected != 0 || pub.Provider != nil {
		t.Errorf("public settings = %+v, want disconnected", pub)
	}
}

func TestUpdateRejectsUnknownFrequency(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	if _, err := h.svc.Update(ptr("fortnightly"), nil, nil); err == nil {
		t.Fatal("expected a validation error")
	} else if !strings.Contains(err.Error(), "Invalid frequency") {
		t.Errorf("error = %v, want an invalid-frequency message", err)
	}
}

// Scheduling without an account would produce a schedule that can only fail;
// refuse it up front rather than logging an error an hour later.
func TestUpdateRequiresAnAccountBeforeScheduling(t *testing.T) {
	h := newHarness(t)
	_, err := h.svc.Update(ptr(FrequencyDaily), nil, nil)
	if !IsConfigError(err) {
		t.Fatalf("error = %v, want a ConfigError", err)
	}
}

func TestUpdateSetsScheduleAndFolder(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	if _, err := h.svc.Update(nil, ptr("/Apps/CountRoster"), ptr("/Apps/CountRoster")); err != nil {
		t.Fatalf("set folder: %v", err)
	}
	set, err := h.svc.Update(ptr(FrequencyDaily), nil, nil)
	if err != nil {
		t.Fatalf("set frequency: %v", err)
	}
	if set.Frequency != FrequencyDaily {
		t.Errorf("frequency = %q, want daily", set.Frequency)
	}
	if set.FolderID == nil || *set.FolderID != "/Apps/CountRoster" {
		t.Errorf("folder_id = %v, want /Apps/CountRoster", set.FolderID)
	}
	// A day from the pinned clock, not from whenever the row was last touched.
	want := timeutil.ToLocalISO(h.svc.Now().AddDate(0, 0, 1))
	if set.NextRunAt == nil || *set.NextRunAt != want {
		t.Errorf("next_run_at = %v, want %s", set.NextRunAt, want)
	}
}

// Switching frequency re-bases the deadline; a leftover hourly deadline must
// not make a freshly-chosen weekly schedule fire in ten minutes.
func TestChangingFrequencyRebasesTheDeadline(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyHourly), ptr("/Backups"), ptr("/Backups"))
	h.setTime("2026-05-25T12:30:00.000-07:00")
	set, err := h.svc.Update(ptr(FrequencyWeekly), nil, nil)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	want := timeutil.ToLocalISO(h.svc.Now().AddDate(0, 0, 7))
	if set.NextRunAt == nil || *set.NextRunAt != want {
		t.Errorf("next_run_at = %v, want %s", set.NextRunAt, want)
	}
}

// --- connecting -----------------------------------------------------------

func TestConnectStoresTheGrantAndNamesTheAccount(t *testing.T) {
	h := newHarness(t)
	h.connect(t)

	set := h.settings(t)
	if !set.Connected() {
		t.Fatal("expected a connected account")
	}
	if set.AccountLabel == nil || *set.AccountLabel != "hedy@example.com" {
		t.Errorf("account_label = %v, want the address from the provider", set.AccountLabel)
	}
	if set.RefreshToken == nil || *set.RefreshToken != "dbx-refresh" {
		t.Errorf("refresh_token = %v, want the one the provider issued", set.RefreshToken)
	}
	if set.Frequency != FrequencyOff {
		t.Errorf("frequency = %q; connecting alone must not start a schedule", set.Frequency)
	}
}

func TestAuthorizeURLCarriesPKCEAndOfflineAccess(t *testing.T) {
	h := newHarness(t)
	start, err := h.svc.StartConnect(ProviderDropbox, "http://ignored.test", false)
	if err != nil {
		t.Fatalf("StartConnect: %v", err)
	}
	u, _ := url.Parse(start.AuthorizeURL)
	q := u.Query()
	if q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		t.Errorf("authorize URL is missing an S256 PKCE challenge: %s", start.AuthorizeURL)
	}
	if q.Get("token_access_type") != "offline" {
		t.Error("Dropbox must be asked for offline access or the schedule dies in 4 hours")
	}
	// PublicURL wins over the request's own origin.
	if got := q.Get("redirect_uri"); got != "http://countroster.test"+CallbackPath {
		t.Errorf("redirect_uri = %q, want the configured public URL", got)
	}
}

// The verifier the exchange presents must be the one whose challenge went to
// the consent screen — that's the whole point of PKCE.
func TestExchangeSendsTheMatchingVerifier(t *testing.T) {
	h := newHarness(t)
	start, _ := h.svc.StartConnect(ProviderDropbox, "http://countroster.test", false)
	u, _ := url.Parse(start.AuthorizeURL)
	challenge := u.Query().Get("code_challenge")

	if _, err := h.svc.CompleteConnect(context.Background(),
		start.PendingID, "auth-code"); err != nil {
		t.Fatalf("CompleteConnect: %v", err)
	}
	if len(h.dbx.exchanges) != 1 {
		t.Fatalf("exchanges = %d, want 1", len(h.dbx.exchanges))
	}
	form := h.dbx.exchanges[0]
	if got := codeChallenge(form.Get("code_verifier")); got != challenge {
		t.Errorf("exchanged verifier hashes to %q, want the advertised challenge %q", got, challenge)
	}
	if got := form.Get("redirect_uri"); got != "http://countroster.test"+CallbackPath {
		t.Errorf("exchange redirect_uri = %q, want the one used to authorize", got)
	}
}

// A state is single-use: a replayed callback finds nothing to exchange.
func TestCallbackStateIsSingleUse(t *testing.T) {
	h := newHarness(t)
	start, _ := h.svc.StartConnect(ProviderDropbox, "http://countroster.test", false)
	state := start.PendingID

	if _, err := h.svc.CompleteConnect(context.Background(), state, "code"); err != nil {
		t.Fatalf("first callback: %v", err)
	}
	_, err := h.svc.CompleteConnect(context.Background(), state, "code")
	if !IsConfigError(err) {
		t.Fatalf("replayed callback error = %v, want a ConfigError", err)
	}
}

func TestConnectRejectsAnUnconfiguredProvider(t *testing.T) {
	h := newHarness(t)
	h.svc.Registry = Registry{NewDropbox(Credentials{}, nil, time.Now)}
	_, err := h.svc.StartConnect(ProviderDropbox, "http://countroster.test", false)
	if !IsConfigError(err) {
		t.Fatalf("error = %v, want a ConfigError about setup", err)
	}
}

func TestDisconnectForgetsTheTokens(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyDaily), ptr("/Backups"), ptr("/Backups"))

	set, err := h.svc.Disconnect()
	if err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if set.Connected() || set.AccessToken != nil || set.RefreshToken != nil {
		t.Errorf("settings still hold a grant: %+v", set)
	}
	if set.Frequency != FrequencyOff || set.NextRunAt != nil {
		t.Error("disconnecting must stop the schedule")
	}
	// And it's really gone from the database, not just from this struct.
	rows, err := h.st.Query(`SELECT access_token, refresh_token FROM cloud_backup_settings`)
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Get("access_token") != nil || rows[0].Get("refresh_token") != nil {
		t.Error("tokens survived a disconnect in the database")
	}
}

// Reconnecting the same account is a token refresh in the user's eyes: the
// folder and schedule they set should still be there afterwards.
func TestReconnectingTheSameAccountKeepsTheSchedule(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyWeekly), ptr("/Backups"), ptr("/Backups"))
	h.connect(t)

	set := h.settings(t)
	if set.Frequency != FrequencyWeekly {
		t.Errorf("frequency = %q, want weekly", set.Frequency)
	}
	if set.FolderID == nil || *set.FolderID != "/Backups" {
		t.Errorf("folder_id = %v, want /Backups", set.FolderID)
	}
}

// --- browsing -------------------------------------------------------------

func TestListFoldersReturnsOnlyFolders(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	folders, err := h.svc.ListFolders(context.Background(), "/Apps")
	if err != nil {
		t.Fatalf("ListFolders: %v", err)
	}
	if len(folders) != 1 {
		t.Fatalf("folders = %+v, want just the folder entry", folders)
	}
	if folders[0].Name != "Backups" || folders[0].ID != "/Apps/Backups" {
		t.Errorf("folder = %+v, want Backups at /Apps/Backups", folders[0])
	}
}

func TestListFoldersNeedsAnAccount(t *testing.T) {
	h := newHarness(t)
	_, err := h.svc.ListFolders(context.Background(), "")
	if !IsConfigError(err) {
		t.Fatalf("error = %v, want a ConfigError", err)
	}
}

// --- running --------------------------------------------------------------

func TestRunUploadsARestorableBundle(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyDaily), ptr("/Apps/CountRoster"), ptr("/Apps/CountRoster"))

	result, err := h.svc.Run(context.Background())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if want := "countroster-2026-05-25-1200.countroster.zip"; result.FileName != want {
		t.Errorf("file name = %q, want %q", result.FileName, want)
	}
	if !strings.Contains(h.dbx.uploadedArgs, "/Apps/CountRoster/"+result.FileName) {
		t.Errorf("upload path = %s, want the file inside the chosen folder", h.dbx.uploadedArgs)
	}
	// What landed must be the real bundle, not an empty placeholder.
	zr, err := zip.NewReader(bytes.NewReader(h.dbx.uploaded), int64(len(h.dbx.uploaded)))
	if err != nil {
		t.Fatalf("uploaded bytes are not a zip: %v", err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if !contains(names, "all.json") || !contains(names, "manifest.json") {
		t.Errorf("uploaded bundle holds %v, want the manifest and all.json", names)
	}

	set := h.settings(t)
	if set.LastStatus == nil || *set.LastStatus != StatusOK {
		t.Errorf("last_status = %v, want ok", set.LastStatus)
	}
	if set.LastFileName == nil || *set.LastFileName != result.FileName {
		t.Errorf("last_file_name = %v, want %q", set.LastFileName, result.FileName)
	}
	want := timeutil.ToLocalISO(h.svc.Now().AddDate(0, 0, 1))
	if set.NextRunAt == nil || *set.NextRunAt != want {
		t.Errorf("next_run_at = %v, want the run rescheduled to %s", set.NextRunAt, want)
	}
}

// A failed upload must be visible in the settings row — that's where the UI
// reads it from — and must still reschedule, or the schedule stops forever.
func TestFailedRunIsRecordedAndRescheduled(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyDaily), ptr("/Gone"), ptr("/Gone"))
	h.dbx.uploadStatus = 409

	if _, err := h.svc.Run(context.Background()); err == nil {
		t.Fatal("expected the upload failure to surface")
	} else if !IsProviderError(err) {
		t.Errorf("error = %v, want a ProviderError", err)
	}

	set := h.settings(t)
	if set.LastStatus == nil || *set.LastStatus != StatusError {
		t.Fatalf("last_status = %v, want error", set.LastStatus)
	}
	if set.LastError == nil || !strings.Contains(*set.LastError, "path/not_found") {
		t.Errorf("last_error = %v, want the provider's own message", set.LastError)
	}
	if set.NextRunAt == nil {
		t.Error("a failed run must still schedule the next one")
	}
}

func TestRunNeedsAFolder(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	_, err := h.svc.Run(context.Background())
	if !IsConfigError(err) {
		t.Fatalf("error = %v, want a ConfigError about the folder", err)
	}
}

func TestRunIfDueOnlyRunsWhenOwed(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyDaily), ptr("/Backups"), ptr("/Backups"))

	ran, err := h.svc.RunIfDue(context.Background())
	if err != nil || ran {
		t.Fatalf("RunIfDue at t0 = (%v, %v), want no run", ran, err)
	}
	if h.dbx.uploadCalls != 0 {
		t.Fatalf("uploads = %d, want none before the deadline", h.dbx.uploadCalls)
	}

	// Step past the deadline: now it's owed.
	h.setTime("2026-05-26T12:00:01.000-07:00")
	ran, err = h.svc.RunIfDue(context.Background())
	if err != nil {
		t.Fatalf("RunIfDue past the deadline: %v", err)
	}
	if !ran || h.dbx.uploadCalls != 1 {
		t.Fatalf("ran = %v, uploads = %d, want one run", ran, h.dbx.uploadCalls)
	}
	// And it doesn't run twice for the same deadline.
	if ran, _ := h.svc.RunIfDue(context.Background()); ran {
		t.Error("the same deadline ran twice")
	}
}

// A server that was switched off over its deadline finds the run overdue when
// it comes back — no catch-up bookkeeping, just a stored deadline in the past.
func TestOverdueScheduleRunsAfterDowntime(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyDaily), ptr("/Backups"), ptr("/Backups"))

	h.setTime("2026-06-04T09:00:00.000-07:00") // ten days later
	ran, err := h.svc.RunIfDue(context.Background())
	if err != nil {
		t.Fatalf("RunIfDue: %v", err)
	}
	if !ran {
		t.Fatal("a deadline ten days in the past should be owed")
	}
}

// --- tokens ---------------------------------------------------------------

func TestExpiredTokenIsRefreshedBeforeUse(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(nil, ptr("/Backups"), ptr("/Backups"))

	// The fake issued a 4-hour token; step past it.
	h.setTime("2026-05-25T17:00:00.000-07:00")
	if _, err := h.svc.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(h.dbx.refreshes) != 1 {
		t.Fatalf("refreshes = %d, want 1", len(h.dbx.refreshes))
	}
	if got := h.dbx.refreshes[0].Get("refresh_token"); got != "dbx-refresh" {
		t.Errorf("refreshed with %q, want the stored refresh token", got)
	}
	set := h.settings(t)
	if set.AccessToken == nil || *set.AccessToken != "dbx-access-2" {
		t.Errorf("access_token = %v, want the renewed one", set.AccessToken)
	}
	// The refresh response carried no refresh token; the stored one must survive.
	if set.RefreshToken == nil || *set.RefreshToken != "dbx-refresh" {
		t.Errorf("refresh_token = %v, want it kept", set.RefreshToken)
	}
}

func TestValidTokenIsNotRefreshed(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(nil, ptr("/Backups"), ptr("/Backups"))
	if _, err := h.svc.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(h.dbx.refreshes) != 0 {
		t.Errorf("refreshes = %d, want none while the token is good", len(h.dbx.refreshes))
	}
}

// --- redaction ------------------------------------------------------------

// The wire shape is what the browser sees, and it must never carry a grant.
func TestPublicSettingsCarryNoTokens(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	encoded, err := json.Marshal(h.settings(t).Public())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"dbx-access-1", "dbx-refresh", "access_token", "refresh_token"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Errorf("public settings leak %q: %s", secret, encoded)
		}
	}
}

// The bundle is the documented egress point; a token must not ride along in
// one, or every exported backup becomes a credential file.
func TestTokensAreNotInTheBackupBundle(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	data, err := (&backup.Service{St: h.st, Clock: h.clock}).ExportBundle("v1.1.0-test")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(rc)
		rc.Close()
		if bytes.Contains(body, []byte("dbx-refresh")) {
			t.Fatalf("%s in the bundle carries the refresh token", f.Name)
		}
	}
}

// --- scheduler ------------------------------------------------------------

func TestSchedulerTickRunsDueBackups(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyHourly), ptr("/Backups"), ptr("/Backups"))
	sched := &Scheduler{Service: h.svc}

	sched.Tick(context.Background())
	if h.dbx.uploadCalls != 0 {
		t.Fatalf("uploads = %d, want none before the hour is up", h.dbx.uploadCalls)
	}
	h.setTime("2026-05-25T13:00:01.000-07:00")
	sched.Tick(context.Background())
	if h.dbx.uploadCalls != 1 {
		t.Fatalf("uploads = %d, want one after the hour", h.dbx.uploadCalls)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// --- provider credentials -------------------------------------------------

// The whole point of storing credentials in the database: a phone can reach a
// provider's developer console, but not the server's command line. Entering a
// client id here has to make the provider connectable with no restart.
func TestCredentialsEnteredInSettingsMakeAProviderUsable(t *testing.T) {
	h := newHarness(t)
	// A registry whose provider carries no startup-flag credentials.
	h.svc.Registry = Registry{h.dbx.provider(h.svc.Now)}
	h.svc.Registry[0] = h.svc.Registry[0].WithCredentials(Credentials{})

	if got := h.svc.PublicProviders()[0].Configured; got != 0 {
		t.Fatalf("configured = %d, want 0 before setup", got)
	}
	if _, err := h.svc.StartConnect(ProviderDropbox, "http://countroster.test", false); !IsConfigError(err) {
		t.Fatalf("StartConnect error = %v, want a ConfigError", err)
	}

	if err := h.svc.SetCredentials(ProviderDropbox, "pasted-app-key", ""); err != nil {
		t.Fatalf("SetCredentials: %v", err)
	}
	entry := h.svc.PublicProviders()[0]
	if entry.Configured != 1 || entry.ClientID != "pasted-app-key" {
		t.Errorf("provider = %+v, want it configured from the settings row", entry)
	}
	if entry.Source != SourceSettings {
		t.Errorf("source = %q, want %q", entry.Source, SourceSettings)
	}

	// And the authorize URL is now built with the id that was pasted.
	start, err := h.svc.StartConnect(ProviderDropbox, "http://countroster.test", false)
	if err != nil {
		t.Fatalf("StartConnect after setup: %v", err)
	}
	u, _ := url.Parse(start.AuthorizeURL)
	if got := u.Query().Get("client_id"); got != "pasted-app-key" {
		t.Errorf("client_id = %q, want the pasted one", got)
	}
}

// A startup flag still works — it's the fallback for automated deployments —
// but what the user entered on the page wins.
func TestSettingsCredentialsOverrideTheStartupFlag(t *testing.T) {
	h := newHarness(t)
	if got := h.svc.PublicProviders()[0]; got.Source != SourceServer || got.ClientID != "app-key" {
		t.Fatalf("provider = %+v, want the flag credentials in effect", got)
	}
	if err := h.svc.SetCredentials(ProviderDropbox, "from-the-page", ""); err != nil {
		t.Fatal(err)
	}
	if got := h.svc.PublicProviders()[0]; got.Source != SourceSettings || got.ClientID != "from-the-page" {
		t.Errorf("provider = %+v, want the settings credentials to win", got)
	}
	// Clearing falls back rather than leaving the provider dead.
	if err := h.svc.ClearCredentials(ProviderDropbox); err != nil {
		t.Fatal(err)
	}
	if got := h.svc.PublicProviders()[0]; got.Source != SourceServer || got.ClientID != "app-key" {
		t.Errorf("provider = %+v, want the flag credentials back", got)
	}
}

// Tokens belong to the client that minted them. Swapping the client id has to
// drop the connection now, rather than leaving something that looks connected
// and dies at the next refresh — hours later, in the scheduler.
func TestChangingTheClientIDDisconnectsTheAccount(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyDaily), ptr("/Backups"), ptr("/Backups"))

	if err := h.svc.SetCredentials(ProviderDropbox, "a-different-app-key", ""); err != nil {
		t.Fatalf("SetCredentials: %v", err)
	}
	set := h.settings(t)
	if set.Connected() {
		t.Error("the account should have been disconnected with its issuing client")
	}
	if set.Frequency != FrequencyOff {
		t.Errorf("frequency = %q, want the schedule stopped too", set.Frequency)
	}
}

// Re-saving the same id (to correct a secret, say) is not a client change and
// must not cost the user their connection.
func TestResavingTheSameClientIDKeepsTheAccount(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.svc.Update(ptr(FrequencyDaily), ptr("/Backups"), ptr("/Backups"))

	if err := h.svc.SetCredentials(ProviderDropbox, "app-key", "a-new-secret"); err != nil {
		t.Fatalf("SetCredentials: %v", err)
	}
	set := h.settings(t)
	if !set.Connected() {
		t.Error("re-saving the same client id should not disconnect")
	}
	if set.Frequency != FrequencyDaily {
		t.Errorf("frequency = %q, want daily kept", set.Frequency)
	}
}

func TestCredentialValidation(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		name, clientID, secret, want string
	}{
		{"empty", "", "", "client id is required"},
		{"whitespace inside", "app key with spaces", "", "space or line break"},
		{"newline in secret", "app-key", "sec\nret", "space or line break"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := h.svc.SetCredentials(ProviderDropbox, c.clientID, c.secret)
			if err == nil {
				t.Fatalf("expected a validation error for %q", c.clientID)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error = %v, want it to mention %q", err, c.want)
			}
		})
	}
}

// Google rejects a PKCE-only client, so a missing secret is caught on the form
// rather than at the token endpoint — after the user has already sat through a
// consent screen.
func TestGoogleCredentialsRequireASecret(t *testing.T) {
	h := newHarness(t)
	h.svc.Registry = append(h.svc.Registry, NewGoogleDrive(Credentials{}, nil, time.Now))
	err := h.svc.SetCredentials(ProviderGoogleDrive, "google-client-id", "")
	if err == nil {
		t.Fatal("expected a validation error")
	}
	if !strings.Contains(err.Error(), "requires a client secret") {
		t.Errorf("error = %v, want it to name the missing secret", err)
	}
	if err := h.svc.SetCredentials(ProviderGoogleDrive, "google-client-id", "google-secret"); err != nil {
		t.Errorf("with a secret: %v", err)
	}
}

func TestUnknownProviderCredentialsRejected(t *testing.T) {
	h := newHarness(t)
	if err := h.svc.SetCredentials("icloud", "id", ""); !IsConfigError(err) {
		t.Errorf("error = %v, want a ConfigError", err)
	}
}

// The credentials are a secret store, so they must stay out of the bundle for
// the same reason the tokens do.
func TestCredentialsAreNotInTheBackupBundle(t *testing.T) {
	h := newHarness(t)
	if err := h.svc.SetCredentials(ProviderDropbox, "app-key", "top-secret-value"); err != nil {
		t.Fatal(err)
	}
	data, err := (&backup.Service{St: h.st, Clock: h.clock}).ExportBundle("v1.1.0-test")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if bytes.Contains(data, []byte("top-secret-value")) {
		t.Error("the exported bundle carries the client secret")
	}
}

// --- the paste-a-code flow ------------------------------------------------

// The whole point: no redirect URI anywhere in the authorize URL, so nothing
// has to be pre-registered and the origin needn't be https. PKCE and offline
// access still have to survive — without them the flow would be either
// insecure or useless for a schedule.
func TestPasteModeAuthorizeURLHasNoRedirect(t *testing.T) {
	h := newHarness(t)
	start, err := h.svc.StartConnect(ProviderDropbox, "http://192.168.1.7:8787", true)
	if err != nil {
		t.Fatalf("StartConnect: %v", err)
	}
	if start.Mode != ModePaste {
		t.Errorf("mode = %q, want %q", start.Mode, ModePaste)
	}
	u, _ := url.Parse(start.AuthorizeURL)
	q := u.Query()
	if _, present := q["redirect_uri"]; present {
		t.Errorf("paste mode must send no redirect_uri: %s", start.AuthorizeURL)
	}
	// `state` binds a redirect to the request that started it; with no
	// redirect there is nothing for it to bind.
	if _, present := q["state"]; present {
		t.Errorf("paste mode should omit state: %s", start.AuthorizeURL)
	}
	if q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		t.Errorf("paste mode still needs PKCE: %s", start.AuthorizeURL)
	}
	if q.Get("token_access_type") != "offline" {
		t.Errorf("paste mode still needs offline access: %s", start.AuthorizeURL)
	}
}

// Dropbox rejects the exchange if a code issued without a redirect URI is
// redeemed with one. This is the rule the whole flow turns on.
func TestPasteModeExchangeSendsNoRedirect(t *testing.T) {
	h := newHarness(t)
	start, err := h.svc.StartConnect(ProviderDropbox, "http://192.168.1.7:8787", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.CompleteConnect(context.Background(), start.PendingID, "pasted-code"); err != nil {
		t.Fatalf("CompleteConnect: %v", err)
	}
	if len(h.dbx.exchanges) != 1 {
		t.Fatalf("exchanges = %d, want 1", len(h.dbx.exchanges))
	}
	form := h.dbx.exchanges[0]
	if _, present := form["redirect_uri"]; present {
		t.Errorf("exchange sent redirect_uri = %q; a code issued without one must be redeemed without one",
			form.Get("redirect_uri"))
	}
	if form.Get("code") != "pasted-code" {
		t.Errorf("code = %q, want the pasted one", form.Get("code"))
	}
	// PKCE still binds the exchange to the authorize request.
	u, _ := url.Parse(start.AuthorizeURL)
	if got := codeChallenge(form.Get("code_verifier")); got != u.Query().Get("code_challenge") {
		t.Error("the exchanged verifier doesn't match the advertised challenge")
	}
	if !h.settings(t).Connected() {
		t.Error("a pasted code should leave the account connected")
	}
}

// A provider with no paste flow says so rather than producing an authorize URL
// that would fail at the far end.
func TestPasteModeRefusedWhereUnsupported(t *testing.T) {
	h := newHarness(t)
	h.svc.Registry = append(h.svc.Registry,
		NewGoogleDrive(Credentials{ClientID: "g", ClientSecret: "s"}, nil, time.Now))
	_, err := h.svc.StartConnect(ProviderGoogleDrive, "http://countroster.test", true)
	if !IsConfigError(err) {
		t.Fatalf("error = %v, want a ConfigError", err)
	}
	if !strings.Contains(err.Error(), "paste-a-code") {
		t.Errorf("error = %v, want it to name the missing capability", err)
	}
}

// Which origins can host a registered redirect URI at all. Both providers
// require https, localhost excepted — so a LAN address over plain http has to
// use the paste flow, and the UI needs to know that before offering a button.
func TestRedirectSupportedByOrigin(t *testing.T) {
	h := newHarness(t)
	h.svc.PublicURL = ""
	cases := []struct {
		origin string
		want   bool
	}{
		{"https://roster.example", true},
		{"https://pi.tail1234.ts.net", true},
		{"http://localhost:8787", true},
		{"http://127.0.0.1:8787", true},
		{"http://192.168.1.7:8787", false},
		{"http://countroster.local", false},
	}
	for _, c := range cases {
		if got := h.svc.RedirectSupported(c.origin); got != c.want {
			t.Errorf("RedirectSupported(%q) = %v, want %v", c.origin, got, c.want)
		}
	}
	// A configured public URL is the answer regardless of how the request came in.
	h.svc.PublicURL = "https://roster.example"
	if !h.svc.RedirectSupported("http://192.168.1.7:8787") {
		t.Error("an https public URL should make redirects supported")
	}
}

// Paste-mode handles are single-use too — the same state store backs both.
func TestPasteModePendingIDIsSingleUse(t *testing.T) {
	h := newHarness(t)
	start, _ := h.svc.StartConnect(ProviderDropbox, "http://192.168.1.7:8787", true)
	if _, err := h.svc.CompleteConnect(context.Background(), start.PendingID, "code"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.CompleteConnect(context.Background(), start.PendingID, "code"); !IsConfigError(err) {
		t.Errorf("error = %v, want a ConfigError on reuse", err)
	}
}
