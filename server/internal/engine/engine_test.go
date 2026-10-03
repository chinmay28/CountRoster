package engine

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/chinmay28/countroster/server/internal/api"
)

func TestLocalModeServesAndPersistsTheDevicesOwnData(t *testing.T) {
	dir := t.TempDir()
	_, c := newEngine(t, dir)
	c.addTracker("Water")
	s := c.status()
	if s.Mode != ModeLocal || s.LocalEmpty || s.RemoteURL != nil || s.APILevel != api.APILevel ||
		!s.RemoteCompatible || len(s.SafetyBundles) != 0 {
		t.Errorf("status %+v", s)
	}

	// A fresh engine on the same directory — the app relaunched.
	_, c2 := newEngine(t, dir)
	if got := joined(c2.trackerNames()); got != "Water" {
		t.Errorf("after relaunch: %s", got)
	}
}

func TestEverythingNeedsTheSecret(t *testing.T) {
	_, c := newEngine(t, t.TempDir())
	anon := &client{t: t, base: c.base}
	for _, path := range []string{"/api/trackers", "/_engine/status", "/"} {
		if status, _ := anon.do("GET", path, nil); status != 403 {
			t.Errorf("GET %s without secret = %d", path, status)
		}
	}
}

func TestEngineServesTheWebClientWithSPAFallback(t *testing.T) {
	e, err := New(Options{DataDir: t.TempDir(), Secret: testSecret, Web: fstest.MapFS{
		"index.html": {Data: []byte("<html>shell</html>")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	srv := httptest.NewServer(e.Handler())
	defer srv.Close()
	c := &client{t: t, base: srv.URL, cookie: testSecret}
	for _, path := range []string{"/", "/trackers/abc/quick", "/data"} {
		if status, body := c.do("GET", path, nil); status != 200 || string(body) != "<html>shell</html>" {
			t.Errorf("GET %s = %d %s", path, status, body)
		}
	}
	if status, body := c.do("GET", "/api/trackers", nil); status != 200 || strings.TrimSpace(string(body)) != "[]" {
		t.Errorf("api through web handler = %d %s", status, body)
	}
	if status, _ := c.do("GET", "/_engine/nope", nil); status != 404 {
		t.Errorf("unknown engine route = %d", status)
	}
}

func TestProbeReportsCompatibilityAndLocalState(t *testing.T) {
	srv := newServer(t)
	_, c := newEngine(t, t.TempDir())
	var p ProbeResult
	c.mustJSON("POST", "/_engine/sync/probe", map[string]string{"url": srv.URL + "/api/"}, &p, 200)
	if p.URL != srv.URL || !p.Empty || !p.Compatible || !p.LocalEmpty {
		t.Errorf("probe %+v", p)
	}
	if status, _ := c.do("POST", "/_engine/sync/probe", map[string]string{"url": "ftp://x"}); status != 400 {
		t.Errorf("bad url = %d", status)
	}
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	if status, _ := c.do("POST", "/_engine/sync/probe", map[string]string{"url": gone.URL}); status != 502 {
		t.Errorf("unreachable = %d", status)
	}
}

func TestMoveToServerUploadsAndThenServesTheServer(t *testing.T) {
	srv := newServer(t)
	pwa := &client{t: t, base: srv.URL}
	dir := t.TempDir()
	_, c := newEngine(t, dir)
	c.addTracker("Water")

	var s Status
	c.mustJSON("POST", "/_engine/sync/enable",
		map[string]string{"url": srv.URL, "strategy": StrategyMoveToServer}, &s, 200)
	if s.Mode != ModeRemote || s.RemoteURL == nil || *s.RemoteURL != srv.URL ||
		s.RemoteAPILevel == nil || !s.RemoteCompatible {
		t.Errorf("status %+v", s)
	}
	if got := joined(pwa.trackerNames()); got != "Water" {
		t.Errorf("server after move: %s", got)
	}

	// The engine now reads and writes the server.
	pwa.addTracker("Meds")
	if got := joined(c.trackerNames()); got != "Water,Meds" {
		t.Errorf("engine reads server: %s", got)
	}
	c.addTracker("Mood")
	if got := joined(pwa.trackerNames()); got != "Water,Meds,Mood" {
		t.Errorf("server sees engine write: %s", got)
	}

	// Sync survives a relaunch.
	_, c2 := newEngine(t, dir)
	if c2.status().Mode != ModeRemote || joined(c2.trackerNames()) != "Water,Meds,Mood" {
		t.Error("relaunch lost sync mode")
	}
}

func TestMoveToServerRefusesAServerWithData(t *testing.T) {
	srv := newServer(t)
	(&client{t: t, base: srv.URL}).addTracker("Theirs")
	_, c := newEngine(t, t.TempDir())
	c.addTracker("Mine")
	status, data := c.do("POST", "/_engine/sync/enable",
		map[string]string{"url": srv.URL, "strategy": StrategyMoveToServer})
	if status != 409 || !strings.Contains(errorBody(data), "already has data") {
		t.Errorf("%d %s", status, data)
	}
	if c.status().Mode != ModeLocal || joined(c.trackerNames()) != "Mine" {
		t.Error("a refused enable changed the device")
	}
}

func TestUseServerKeepsTheLocalDataDormantWithASafetyBundle(t *testing.T) {
	srv := newServer(t)
	(&client{t: t, base: srv.URL}).addTracker("Theirs")
	_, c := newEngine(t, t.TempDir())
	c.addTracker("Mine")

	var s Status
	c.mustJSON("POST", "/_engine/sync/enable",
		map[string]string{"url": srv.URL, "strategy": StrategyUseServer}, &s, 200)
	if got := joined(c.trackerNames()); got != "Theirs" {
		t.Errorf("synced view: %s", got)
	}
	if len(s.SafetyBundles) != 1 || !strings.HasSuffix(s.SafetyBundles[0].Name, "-before-sync.countroster.zip") {
		t.Errorf("safety bundles %+v", s.SafetyBundles)
	}

	// Going back to the phone's own data finds it untouched.
	c.mustJSON("POST", "/_engine/sync/disable", map[string]string{"strategy": StrategyUseLocal}, &s, 200)
	if s.Mode != ModeLocal || joined(c.trackerNames()) != "Mine" {
		t.Errorf("use_local: %s %s", s.Mode, joined(c.trackerNames()))
	}
}

func TestReplaceServerOverwritesItAfterBackingItUp(t *testing.T) {
	srv := newServer(t)
	pwa := &client{t: t, base: srv.URL}
	pwa.addTracker("Theirs")
	_, c := newEngine(t, t.TempDir())
	c.addTracker("Mine")

	var s Status
	c.mustJSON("POST", "/_engine/sync/enable",
		map[string]string{"url": srv.URL, "strategy": StrategyReplaceServer}, &s, 200)
	if got := joined(pwa.trackerNames()); got != "Mine" {
		t.Errorf("server after replace: %s", got)
	}
	if len(s.SafetyBundles) != 1 || !strings.Contains(s.SafetyBundles[0].Name, "server-before-replace") {
		t.Fatalf("safety bundles %+v", s.SafetyBundles)
	}
	// The server's old data is downloadable from the device.
	status, body := c.do("GET", "/_engine/safety/"+s.SafetyBundles[0].Name, nil)
	if status != 200 || len(body) == 0 || string(body[:2]) != "PK" {
		t.Errorf("safety download = %d (%d bytes)", status, len(body))
	}
	if status, _ := c.do("GET", "/_engine/safety/..%2Fengine.json", nil); status != 404 {
		t.Errorf("traversal = %d", status)
	}
}

func TestCopyFromServerLeavesTheDeviceWithTheServersData(t *testing.T) {
	srv := newServer(t)
	_, c := newEngine(t, t.TempDir())
	c.addTracker("Old phone data")
	c.mustJSON("POST", "/_engine/sync/enable",
		map[string]string{"url": srv.URL, "strategy": StrategyUseServer}, nil, 200)
	c.addTracker("Logged while synced")

	var s Status
	c.mustJSON("POST", "/_engine/sync/disable", map[string]string{"strategy": StrategyCopyFromServer}, &s, 200)
	if s.Mode != ModeLocal {
		t.Errorf("mode %s", s.Mode)
	}
	// The server can vanish now: the device has its own copy.
	srv.Close()
	if got := joined(c.trackerNames()); got != "Logged while synced" {
		t.Errorf("local after copy: %s", got)
	}
	reasons := []string{}
	for _, b := range s.SafetyBundles {
		reasons = append(reasons, strings.SplitN(b.Name, "-", 2)[1])
	}
	if joined(reasons) != "before-copy-from-server.countroster.zip,before-sync.countroster.zip" {
		t.Errorf("safety bundles %v", reasons)
	}
}

func TestSwitchingGuardsAgainstNonsense(t *testing.T) {
	srv := newServer(t)
	_, c := newEngine(t, t.TempDir())
	cases := []struct {
		path string
		body map[string]string
		want int
	}{
		{"/_engine/sync/disable", map[string]string{"strategy": StrategyUseLocal}, 409},
		{"/_engine/sync/enable", map[string]string{"url": srv.URL, "strategy": "yolo"}, 400},
		{"/_engine/sync/enable", map[string]string{"url": "", "strategy": StrategyUseServer}, 400},
	}
	for _, tc := range cases {
		if status, data := c.do("POST", tc.path, tc.body); status != tc.want {
			t.Errorf("POST %s %v = %d %s, want %d", tc.path, tc.body, status, data, tc.want)
		}
	}
	if status, _ := c.do("POST", "/_engine/sync/enable", "not an object"); status != 400 {
		t.Errorf("bad JSON = %d", status)
	}
	c.mustJSON("POST", "/_engine/sync/enable", map[string]string{"url": srv.URL, "strategy": StrategyUseServer}, nil, 200)
	if status, _ := c.do("POST", "/_engine/sync/enable", map[string]string{"url": srv.URL, "strategy": StrategyUseServer}); status != 409 {
		t.Errorf("double enable = %d", status)
	}
	if status, _ := c.do("POST", "/_engine/sync/disable", map[string]string{"strategy": "yolo"}); status != 400 {
		t.Errorf("bad disable strategy = %d", status)
	}
}

// oldServer is a CountRoster server from before api_level existed.
func oldServer(t *testing.T) *httptest.Server {
	t.Helper()
	real := newServer(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			w.Write([]byte(`{"ok":true,"version":"v2026.8.300"}`))
			return
		}
		res, err := http.DefaultTransport.RoundTrip(withHost(r, real.URL))
		if err != nil {
			w.WriteHeader(502)
			return
		}
		defer res.Body.Close()
		w.WriteHeader(res.StatusCode)
		var buf [32 << 10]byte
		for {
			n, err := res.Body.Read(buf[:])
			w.Write(buf[:n])
			if err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func withHost(r *http.Request, base string) *http.Request {
	out := r.Clone(context.Background())
	out.RequestURI = ""
	out.URL.Scheme = "http"
	out.URL.Host = strings.TrimPrefix(base, "http://")
	return out
}

func TestAnOlderServerIsRefusedAndNeverWrittenTo(t *testing.T) {
	old := oldServer(t)
	dir := t.TempDir()
	_, c := newEngine(t, dir)

	var p ProbeResult
	c.mustJSON("POST", "/_engine/sync/probe", map[string]string{"url": old.URL}, &p, 200)
	if p.Compatible || p.APILevel != 0 {
		t.Errorf("probe %+v", p)
	}
	status, data := c.do("POST", "/_engine/sync/enable", map[string]string{"url": old.URL, "strategy": StrategyUseServer})
	if status != 409 || !strings.Contains(errorBody(data), "update the server") {
		t.Errorf("enable = %d %s", status, data)
	}

	// A server downgraded under a synced device: reads work, writes refused.
	os.WriteFile(filepath.Join(dir, ConfigFile), []byte(`{"mode":"remote","remote_url":"`+old.URL+`"}`), 0o600)
	e, c2 := newEngine(t, dir)
	e.refreshInfo(context.Background(), e.target.Load())
	if s := c2.status(); s.RemoteCompatible || s.RemoteAPILevel == nil || *s.RemoteAPILevel != 0 {
		t.Errorf("status %+v", s)
	}
	if status, _ := c2.do("GET", "/api/trackers", nil); status != 200 {
		t.Errorf("read = %d", status)
	}
	if status, _ := c2.do("POST", "/api/trackers", map[string]any{"name": "x", "kind": "count"}); status != 409 {
		t.Errorf("write to old server = %d", status)
	}
}

func TestSyncedDeviceSaysWhenTheServerIsUnreachable(t *testing.T) {
	srv := newServer(t)
	_, c := newEngine(t, t.TempDir())
	c.mustJSON("POST", "/_engine/sync/enable", map[string]string{"url": srv.URL, "strategy": StrategyUseServer}, nil, 200)
	srv.Close()
	status, data := c.do("GET", "/api/trackers", nil)
	if status != 503 || errorBody(data) != UnreachableMessage {
		t.Errorf("%d %s", status, data)
	}
	// Turning sync off without the server still works — back to local data.
	c.mustJSON("POST", "/_engine/sync/disable", map[string]string{"strategy": StrategyUseLocal}, nil, 200)
	if status, data := c.do("POST", "/_engine/sync/disable", map[string]string{"strategy": StrategyCopyFromServer}); status != 409 {
		t.Errorf("already local = %d %s", status, data)
	}
}

func TestCorruptConfigFallsBackToLocalMode(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ConfigFile), []byte(`{"mode":"warp"}`), 0o600)
	e, c := newEngine(t, dir)
	if e.Mode() != ModeLocal || c.status().Mode != ModeLocal {
		t.Error("corrupt config didn't fall back to local")
	}
}

func TestNetworkEndpointFeedsTheResolver(t *testing.T) {
	dns := &DNS{}
	e, err := New(Options{DataDir: t.TempDir(), Secret: testSecret, DNS: dns})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	srv := httptest.NewServer(e.Handler())
	defer srv.Close()
	// The native shell authenticates with the bearer secret, not a cookie.
	put := func(body string) int {
		req, _ := http.NewRequest("PUT", srv.URL+"/_engine/network", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+testSecret)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if s := put(`{"dns_servers":["100.100.100.100","192.168.1.1"]}`); s != 204 {
		t.Fatalf("PUT = %d", s)
	}
	if got := joined(dns.Servers()); got != "100.100.100.100:53,192.168.1.1:53" {
		t.Errorf("servers %s", got)
	}
	if s := put(`{"dns_servers":["not-an-ip"]}`); s != 400 {
		t.Errorf("bad server = %d", s)
	}

	_, c := newEngine(t, t.TempDir()) // no DNS configured
	if status, _ := c.do("PUT", "/_engine/network", map[string]any{"dns_servers": []string{}}); status != 501 {
		t.Errorf("without DNS = %d", status)
	}
	if status, _ := c.do("POST", "/_engine/cloud/tick", nil); status != 204 {
		t.Errorf("cloud tick = %d", status)
	}
}

// The point of sync: every client of one server — synced Android apps and
// PWAs alike — reads every other client's writes.
func TestSyncAcrossDevicesAndThePWA(t *testing.T) {
	srv := newServer(t)
	pwa := &client{t: t, base: srv.URL}
	_, phoneA := newEngine(t, t.TempDir())
	_, phoneB := newEngine(t, t.TempDir())

	phoneA.addTracker("Water")
	phoneA.mustJSON("POST", "/_engine/sync/enable",
		map[string]string{"url": srv.URL, "strategy": StrategyMoveToServer}, nil, 200)
	phoneB.mustJSON("POST", "/_engine/sync/enable",
		map[string]string{"url": srv.URL, "strategy": StrategyUseServer}, nil, 200)

	water := tracker{}
	for _, tr := range func() []tracker {
		var l []tracker
		pwa.mustJSON("GET", "/api/trackers", nil, &l, 200)
		return l
	}() {
		if tr.Name == "Water" {
			water = tr
		}
	}
	if water.ID == "" {
		t.Fatal("phone A's tracker never reached the server")
	}

	// Each client logs one entry against the shared tracker.
	for _, c := range []*client{phoneA, phoneB, pwa} {
		c.mustJSON("POST", "/api/trackers/"+water.ID+"/entries", map[string]any{"value": 1}, nil, 201)
	}
	for name, c := range map[string]*client{"phone A": phoneA, "phone B": phoneB, "PWA": pwa} {
		var entries []json.RawMessage
		c.mustJSON("GET", "/api/trackers/"+water.ID+"/entries", nil, &entries, 200)
		if len(entries) != 3 {
			t.Errorf("%s sees %d entries, want 3", name, len(entries))
		}
	}
}

func TestRunChecksTheServerWhenLaunchedSynced(t *testing.T) {
	srv := newServer(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ConfigFile), []byte(`{"mode":"remote","remote_url":"`+srv.URL+`"}`), 0o600)
	e, c := newEngine(t, dir)
	if c.status().RemoteVersion != nil {
		t.Fatal("version known before any check")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Run(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for c.status().RemoteVersion == nil {
		if time.Now().After(deadline) {
			t.Fatal("Run never checked the server")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if s := c.status(); !s.RemoteCompatible || *s.RemoteAPILevel != api.APILevel {
		t.Errorf("status %+v", s)
	}
}

func TestCloudBackupOnTheDeviceUsesThePasteFlow(t *testing.T) {
	_, c := newEngine(t, t.TempDir())
	var body struct {
		RedirectSupported int `json:"redirect_supported"`
	}
	c.mustJSON("GET", "/api/cloud/backup", nil, &body, 200)
	if body.RedirectSupported != 0 {
		t.Error("the engine offered the OAuth redirect flow; only paste can work on a device")
	}
}
