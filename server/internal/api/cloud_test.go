package api

// The REST contract for automatic cloud backup. The PWA is compiled against
// these exact shapes — snake_case names, 0|1 flags, explicit nulls — the same
// way it is for the older routes.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/chinmay28/countroster/server/internal/backup"
	"github.com/chinmay28/countroster/server/internal/cloud"
	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/migrate"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

type cloudFixture struct {
	srv      *httptest.Server
	provider *fakeCloudProvider
}

// fakeCloudProvider is a Provider that records calls instead of reaching the
// network — the API tests are about routing, statuses and JSON shapes, not
// about Dropbox's dialect (internal/cloud covers that against fake hosts).
type fakeCloudProvider struct {
	configured bool
	folders    []cloud.Folder
	uploads    int
	uploadErr  error
}

func (f *fakeCloudProvider) ID() string       { return cloud.ProviderDropbox }
func (f *fakeCloudProvider) Name() string     { return "Dropbox" }
func (f *fakeCloudProvider) Configured() bool { return f.configured }

func (f *fakeCloudProvider) AuthorizeURL(redirectURI, state, challenge string) string {
	return "https://provider.test/authorize?state=" + url.QueryEscape(state) +
		"&redirect_uri=" + url.QueryEscape(redirectURI)
}

func (f *fakeCloudProvider) Exchange(ctx context.Context, code, verifier, redirectURI string) (cloud.Token, cloud.Account, error) {
	return cloud.Token{AccessToken: "tok", RefreshToken: "ref", ExpiresAt: time.Now().Add(time.Hour)},
		cloud.Account{Label: "hedy@example.com"}, nil
}

func (f *fakeCloudProvider) Refresh(ctx context.Context, refreshToken string) (cloud.Token, error) {
	return cloud.Token{AccessToken: "tok2", RefreshToken: refreshToken}, nil
}

func (f *fakeCloudProvider) ListFolders(ctx context.Context, accessToken, folderID string) ([]cloud.Folder, error) {
	return f.folders, nil
}

func (f *fakeCloudProvider) Upload(ctx context.Context, accessToken, folderID, name string, data []byte) error {
	if f.uploadErr != nil {
		return &cloud.ProviderError{Provider: "Dropbox", Err: f.uploadErr}
	}
	f.uploads++
	return nil
}

// errUploadRefused stands in for a provider rejecting the upload.
var errUploadRefused = errors.New("insufficient space in the destination account")

func newCloudServer(t *testing.T) *cloudFixture {
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
	provider := &fakeCloudProvider{
		configured: true,
		folders:    []cloud.Folder{{ID: "/Apps", Name: "Apps", Path: "/Apps"}},
	}
	svc := cloud.NewService(st, timeutil.SystemClock, bk, cloud.Registry{provider},
		AppVersion, "https://roster.example")
	srv := httptest.NewServer(New(app, bk, FileSource{Path: st.Path}, svc))
	t.Cleanup(srv.Close)
	return &cloudFixture{srv: srv, provider: provider}
}

// connect walks the fixture through a full authorization.
func (f *cloudFixture) connect(t *testing.T) {
	t.Helper()
	c := &client{t: t, base: f.srv.URL}
	var out map[string]any
	if code := c.postJSON("/api/cloud/backup/connect", m{"provider": "dropbox"}, &out); code != 200 {
		t.Fatalf("connect status = %d", code)
	}
	u, err := url.Parse(out["authorize_url"].(string))
	if err != nil {
		t.Fatal(err)
	}
	// Follow the callback the way the browser would, without chasing the
	// redirect it answers with.
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	res, err := noRedirect.Get(f.srv.URL + cloud.CallbackPath +
		"?code=abc&state=" + url.QueryEscape(u.Query().Get("state")))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("callback status = %d, want 302", res.StatusCode)
	}
}

func TestCloudBackupSettingsShape(t *testing.T) {
	f := newCloudServer(t)
	c := &client{t: t, base: f.srv.URL}

	var body struct {
		Settings map[string]any `json:"settings"`
		Provider []struct {
			ID         string `json:"id"`
			Name       string `json:"name"`
			Configured int    `json:"configured"`
		} `json:"providers"`
	}
	if code := c.getJSON("/api/cloud/backup", &body); code != 200 {
		t.Fatalf("status = %d, want 200", code)
	}
	// Every key the client reads must be present, nulls included.
	for _, key := range []string{
		"provider", "account_label", "connected", "folder_id", "folder_path",
		"frequency", "next_run_at", "last_run_at", "last_status", "last_error",
		"last_file_name",
	} {
		if _, ok := body.Settings[key]; !ok {
			t.Errorf("settings are missing %q: %v", key, body.Settings)
		}
	}
	if body.Settings["connected"] != float64(0) {
		t.Errorf("connected = %v, want the integer flag 0", body.Settings["connected"])
	}
	if body.Settings["frequency"] != "off" {
		t.Errorf("frequency = %v, want off", body.Settings["frequency"])
	}
	if len(body.Provider) != 1 || body.Provider[0].Configured != 1 {
		t.Errorf("providers = %+v, want the configured Dropbox entry", body.Provider)
	}
}

// A server built without a cloud service simply doesn't have these routes;
// the client reads that as "this deployment doesn't do cloud backup".
func TestCloudRoutesAbsentWithoutAService(t *testing.T) {
	srv := newServer(t)
	c := &client{t: t, base: srv.URL}
	if code := c.getJSON("/api/cloud/backup", nil); code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", code)
	}
}

func TestCloudConnectAndCallback(t *testing.T) {
	f := newCloudServer(t)
	f.connect(t)

	c := &client{t: t, base: f.srv.URL}
	var body struct {
		Settings map[string]any `json:"settings"`
	}
	c.getJSON("/api/cloud/backup", &body)
	if body.Settings["connected"] != float64(1) {
		t.Errorf("connected = %v, want 1", body.Settings["connected"])
	}
	if body.Settings["account_label"] != "hedy@example.com" {
		t.Errorf("account_label = %v", body.Settings["account_label"])
	}
	// Tokens must never come back out over the wire.
	raw, _ := json.Marshal(body.Settings)
	if strings.Contains(string(raw), "tok") || strings.Contains(string(raw), "ref") {
		t.Errorf("settings response leaks a token: %s", raw)
	}
}

// The callback is a browser navigation, so it redirects into the app rather
// than answering with JSON — and a refusal on the consent screen has to come
// back as a message the Data page can show, not a dead end.
func TestCloudCallbackRedirectsWithTheOutcome(t *testing.T) {
	f := newCloudServer(t)
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	res, err := noRedirect.Get(f.srv.URL + cloud.CallbackPath + "?error=access_denied")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want 302", res.StatusCode)
	}
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if loc.Path != "/data" {
		t.Errorf("redirect path = %q, want /data", loc.Path)
	}
	if loc.Query().Get("cloud") != "error" || loc.Query().Get("cloud_error") == "" {
		t.Errorf("redirect query = %q, want the failure carried back", loc.RawQuery)
	}
}

func TestCloudUpdateRejectsABadFrequency(t *testing.T) {
	f := newCloudServer(t)
	f.connect(t)
	c := &client{t: t, base: f.srv.URL}
	res, data := c.do("PATCH", "/api/cloud/backup", m{"frequency": "fortnightly"})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", res.StatusCode, data)
	}
	if !strings.Contains(string(data), `"error"`) {
		t.Errorf("body = %s, want an {\"error\": …} shape", data)
	}
}

func TestCloudUpdateSetsFolderAndSchedule(t *testing.T) {
	f := newCloudServer(t)
	f.connect(t)
	c := &client{t: t, base: f.srv.URL}

	var body struct {
		Settings map[string]any `json:"settings"`
	}
	res, data := c.do("PATCH", "/api/cloud/backup",
		m{"folder_id": "/Apps/CountRoster", "folder_path": "/Apps/CountRoster"})
	if res.StatusCode != 200 {
		t.Fatalf("status = %d: %s", res.StatusCode, data)
	}
	res, data = c.do("PATCH", "/api/cloud/backup", m{"frequency": "daily"})
	if res.StatusCode != 200 {
		t.Fatalf("status = %d: %s", res.StatusCode, data)
	}
	json.Unmarshal(data, &body)
	if body.Settings["frequency"] != "daily" {
		t.Errorf("frequency = %v, want daily", body.Settings["frequency"])
	}
	if body.Settings["folder_path"] != "/Apps/CountRoster" {
		t.Errorf("folder_path = %v", body.Settings["folder_path"])
	}
	if body.Settings["next_run_at"] == nil {
		t.Error("next_run_at should be set once a schedule exists")
	}
}

func TestCloudFoldersListing(t *testing.T) {
	f := newCloudServer(t)
	f.connect(t)
	c := &client{t: t, base: f.srv.URL}
	var body struct {
		Folders []cloud.Folder `json:"folders"`
	}
	if code := c.getJSON("/api/cloud/backup/folders", &body); code != 200 {
		t.Fatalf("status = %d", code)
	}
	if len(body.Folders) != 1 || body.Folders[0].ID != "/Apps" {
		t.Errorf("folders = %+v", body.Folders)
	}
}

// Browsing without an account is a setup gap, not a server fault.
func TestCloudFoldersWithoutAnAccountIs400(t *testing.T) {
	f := newCloudServer(t)
	c := &client{t: t, base: f.srv.URL}
	if code := c.getJSON("/api/cloud/backup/folders", nil); code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", code)
	}
}

func TestCloudRunUploadsNow(t *testing.T) {
	f := newCloudServer(t)
	f.connect(t)
	c := &client{t: t, base: f.srv.URL}
	c.do("PATCH", "/api/cloud/backup", m{"folder_id": "/Apps", "folder_path": "/Apps"})

	var out struct {
		FileName string         `json:"file_name"`
		Bytes    int            `json:"bytes"`
		Settings map[string]any `json:"settings"`
	}
	if code := c.postJSON("/api/cloud/backup/run", nil, &out); code != 200 {
		t.Fatalf("status = %d", code)
	}
	if f.provider.uploads != 1 {
		t.Errorf("uploads = %d, want 1", f.provider.uploads)
	}
	if !strings.HasSuffix(out.FileName, ".countroster.zip") {
		t.Errorf("file_name = %q, want a bundle name", out.FileName)
	}
	if out.Bytes <= 0 {
		t.Errorf("bytes = %d, want the uploaded size", out.Bytes)
	}
	if out.Settings["last_status"] != "ok" {
		t.Errorf("last_status = %v, want ok", out.Settings["last_status"])
	}
}

// A provider failure is theirs, not ours: 502, with the message intact.
func TestCloudRunReportsAProviderFailureAs502(t *testing.T) {
	f := newCloudServer(t)
	f.connect(t)
	c := &client{t: t, base: f.srv.URL}
	c.do("PATCH", "/api/cloud/backup", m{"folder_id": "/Apps", "folder_path": "/Apps"})
	f.provider.uploadErr = errUploadRefused

	res, data := c.do("POST", "/api/cloud/backup/run", nil)
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", res.StatusCode, data)
	}
	if !strings.Contains(string(data), "insufficient space") {
		t.Errorf("body = %s, want the provider's message", data)
	}
	// And the failure is on the settings row, where the UI reads it.
	var body struct {
		Settings map[string]any `json:"settings"`
	}
	c.getJSON("/api/cloud/backup", &body)
	if body.Settings["last_status"] != "error" {
		t.Errorf("last_status = %v, want error", body.Settings["last_status"])
	}
}

func TestCloudDisconnect(t *testing.T) {
	f := newCloudServer(t)
	f.connect(t)
	c := &client{t: t, base: f.srv.URL}
	var body struct {
		Settings map[string]any `json:"settings"`
	}
	if code := c.postJSON("/api/cloud/backup/disconnect", nil, &body); code != 200 {
		t.Fatalf("status = %d", code)
	}
	if body.Settings["connected"] != float64(0) || body.Settings["provider"] != nil {
		t.Errorf("settings = %v, want a cleared connection", body.Settings)
	}
}

// The redirect URI has to be the origin the *browser* used. Behind a
// TLS-terminating proxy the request looks like plain HTTP internally, and a
// URI built from that would never match the one registered with the provider.
func TestRequestOriginPrefersForwardedHeaders(t *testing.T) {
	r, err := http.NewRequest("POST", "http://internal:8787/api/cloud/backup/connect", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := requestOrigin(r); got != "http://internal:8787" {
		t.Errorf("origin = %q, want the request's own", got)
	}
	r.Header.Set("X-Forwarded-Proto", "https, http")
	r.Header.Set("X-Forwarded-Host", "roster.example")
	if got := requestOrigin(r); got != "https://roster.example" {
		t.Errorf("origin = %q, want the forwarded one", got)
	}
}
