package engine

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- ConfigStore ---------------------------------------------------------

func TestConfigMissingFileIsLocalMode(t *testing.T) {
	c, err := ConfigStore{Path: filepath.Join(t.TempDir(), "engine.json")}.Load()
	if err != nil || c.Mode != ModeLocal {
		t.Fatalf("Load = %+v, %v", c, err)
	}
}

func TestConfigRoundTrips(t *testing.T) {
	s := ConfigStore{Path: filepath.Join(t.TempDir(), "engine.json")}
	want := Config{Mode: ModeRemote, RemoteURL: "http://pi.local:8787"}
	if err := s.Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load()
	if err != nil || got != want {
		t.Fatalf("Load = %+v, %v; want %+v", got, err, want)
	}
}

func TestConfigRejectsInvalidStates(t *testing.T) {
	s := ConfigStore{Path: filepath.Join(t.TempDir(), "engine.json")}
	for _, c := range []Config{{Mode: "cloud"}, {Mode: ModeRemote}, {Mode: ModeRemote, RemoteURL: "ftp://x"}} {
		if err := s.Save(c); err == nil {
			t.Errorf("Save(%+v) accepted", c)
		}
	}
	os.WriteFile(s.Path, []byte(`{"mode":`), 0o600)
	if _, err := s.Load(); err == nil {
		t.Error("corrupt file loaded without error")
	}
}

// --- Gate ----------------------------------------------------------------

func TestGateAdmitsOnlyTheSecret(t *testing.T) {
	g, err := NewGate(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	h := g.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	cases := []struct {
		name string
		set  func(*http.Request)
		want int
	}{
		{"nothing", func(*http.Request) {}, 403},
		{"cookie", func(r *http.Request) { r.AddCookie(&http.Cookie{Name: SessionCookie, Value: testSecret}) }, 204},
		{"wrong cookie", func(r *http.Request) { r.AddCookie(&http.Cookie{Name: SessionCookie, Value: testSecret + "x"}) }, 403},
		{"bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testSecret) }, 204},
		{"wrong bearer", func(r *http.Request) { r.Header.Set("Authorization", "Bearer nope") }, 403},
		{"basic", func(r *http.Request) { r.Header.Set("Authorization", "Basic "+testSecret) }, 403},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "/api/trackers", nil)
		c.set(req)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s: %d, want %d", c.name, rec.Code, c.want)
		}
	}
	if _, err := NewGate("short"); err == nil {
		t.Error("short secret accepted")
	}
}

// --- DNS -----------------------------------------------------------------

func TestDNSValidatesAndFormatsServers(t *testing.T) {
	var d DNS
	if err := d.Set([]string{"100.100.100.100", "2001:4860:4860::8888", "fe80::1%wlan0"}); err != nil {
		t.Fatal(err)
	}
	want := "100.100.100.100:53,[2001:4860:4860::8888]:53,[fe80::1%wlan0]:53"
	if got := joined(d.Servers()); got != want {
		t.Errorf("Servers = %s, want %s", got, want)
	}
	if err := d.Set([]string{"dns.google"}); err == nil {
		t.Error("hostname accepted as a DNS server")
	}
	d.Set(nil)
	if len(d.Servers()) != 0 {
		t.Error("empty Set didn't clear")
	}
}

func TestDNSResolverDialsTheConfiguredServer(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	d := DNS{port: uint16(pc.LocalAddr().(*net.UDPAddr).Port)}
	d.Set([]string{"127.0.0.1"})

	// Go asks for its default (a resolv.conf that doesn't exist on Android);
	// the query must land on ours instead.
	conn, err := d.Resolver().Dial(context.Background(), "udp", "127.0.0.53:53")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.Write([]byte("query"))
	pc.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	n, _, err := pc.ReadFrom(buf)
	if err != nil || string(buf[:n]) != "query" {
		t.Fatalf("configured server got %q, %v", buf[:n], err)
	}
}

// --- NormalizeURL / Remote -------------------------------------------------

func TestNormalizeURL(t *testing.T) {
	ok := map[string]string{
		"pi.local:8787":                   "http://pi.local:8787",
		" http://10.0.0.5:8787/ ":         "http://10.0.0.5:8787",
		"http://10.0.0.5:8787/api":        "http://10.0.0.5:8787",
		"http://10.0.0.5:8787/api/":       "http://10.0.0.5:8787",
		"https://box.tailnet.ts.net":      "https://box.tailnet.ts.net",
		"https://home.example/roster/":    "https://home.example/roster",
		"https://home.example/roster/api": "https://home.example/roster",
	}
	for in, want := range ok {
		u, err := NormalizeURL(in)
		if err != nil || u.String() != want {
			t.Errorf("NormalizeURL(%q) = %v, %v; want %s", in, u, err, want)
		}
	}
	for _, bad := range []string{"", "  ", "ftp://x", "http://", "http://u:p@x", "http://x/?a=1", "http://x/#f"} {
		if _, err := NormalizeURL(bad); err == nil {
			t.Errorf("NormalizeURL(%q) accepted", bad)
		}
	}
}

func remoteFor(t *testing.T, raw string) Remote {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return Remote{Base: u, Client: http.DefaultClient}
}

func TestProbeReadsARealServer(t *testing.T) {
	srv := newServer(t)
	info, err := remoteFor(t, srv.URL).Probe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !info.Empty || info.APILevel < 1 || info.Version == "" || info.URL != srv.URL {
		t.Errorf("empty server probe = %+v", info)
	}
	(&client{t: t, base: srv.URL}).addTracker("Water")
	info, _ = remoteFor(t, srv.URL).Probe(context.Background())
	if info.Empty {
		t.Error("server with a tracker reported empty")
	}
}

func TestProbeTellsWhatWentWrong(t *testing.T) {
	notUs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			w.Write([]byte(`<html>router login</html>`))
			return
		}
		http.NotFound(w, r)
	}))
	defer notUs.Close()
	if _, err := remoteFor(t, notUs.URL).Probe(context.Background()); !errors.Is(err, ErrNotCountRoster) {
		t.Errorf("non-CountRoster: %v", err)
	}

	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	if _, err := remoteFor(t, gone.URL).Probe(context.Background()); !errors.Is(err, ErrUnreachable) {
		t.Errorf("closed port: %v", err)
	}
}

func TestCheckLevel(t *testing.T) {
	if err := CheckLevel(ServerInfo{APILevel: 2}, 2); err != nil {
		t.Error(err)
	}
	var tooOld *TooOldError
	if err := CheckLevel(ServerInfo{APILevel: 0}, 1); !errors.As(err, &tooOld) || tooOld.Have != 0 || tooOld.Want != 1 {
		t.Errorf("level 0 vs 1: %v", err)
	}
}

// --- Proxy -----------------------------------------------------------------

func TestProxyForwardsVerbatimWithoutTheEngineCredentials(t *testing.T) {
	var got *http.Request
	var body string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		b := make([]byte, 64)
		n, _ := r.Body.Read(b)
		body = string(b[:n])
		w.WriteHeader(201)
		w.Write([]byte(`{"id":"x"}`))
	}))
	defer upstream.Close()
	base, _ := NormalizeURL(upstream.URL + "/roster")

	req := httptest.NewRequest("POST", "/api/trackers?x=1", strings.NewReader(`{"name":"Water"}`))
	req.AddCookie(&http.Cookie{Name: SessionCookie, Value: testSecret})
	req.Header.Set("Authorization", "Bearer "+testSecret)
	rec := httptest.NewRecorder()
	NewProxy(base, http.DefaultTransport).ServeHTTP(rec, req)

	if rec.Code != 201 || rec.Body.String() != `{"id":"x"}` {
		t.Errorf("response %d %s", rec.Code, rec.Body)
	}
	if got.URL.Path != "/roster/api/trackers" || got.URL.RawQuery != "x=1" || body != `{"name":"Water"}` {
		t.Errorf("upstream saw %s %s?%s %q", got.Method, got.URL.Path, got.URL.RawQuery, body)
	}
	if got.Header.Get("Cookie") != "" || got.Header.Get("Authorization") != "" {
		t.Errorf("engine credentials leaked upstream: %v", got.Header)
	}
}

func TestProxyAnswers503WhenTheServerIsGone(t *testing.T) {
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	base, _ := NormalizeURL(gone.URL)
	rec := httptest.NewRecorder()
	NewProxy(base, http.DefaultTransport).ServeHTTP(rec, httptest.NewRequest("GET", "/api/trackers", nil))
	if rec.Code != 503 || errorBody(rec.Body.Bytes()) != UnreachableMessage {
		t.Errorf("%d %s", rec.Code, rec.Body)
	}
}

// --- SafetyStore -------------------------------------------------------------

func TestSafetyStoreKeepsTheNewestAndRefusesStrayNames(t *testing.T) {
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	s := SafetyStore{Dir: filepath.Join(t.TempDir(), "safety"), Keep: 2, Now: func() time.Time { return now }}
	if list, _ := s.List(); len(list) != 0 {
		t.Fatal("missing dir should list nothing")
	}
	for _, reason := range []string{"a", "b", "c"} {
		if _, err := s.Save(reason, []byte(reason)); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Second)
	}
	list, _ := s.List()
	if len(list) != 2 || !strings.HasSuffix(list[0].Name, "-c.countroster.zip") ||
		!strings.HasSuffix(list[1].Name, "-b.countroster.zip") {
		t.Fatalf("kept %+v", list)
	}
	if list[0].CreatedAt != "2026-10-03T12:00:02.000Z" || list[0].Size != 1 {
		t.Errorf("metadata %+v", list[0])
	}
	if _, err := s.Path(list[0].Name); err != nil {
		t.Error(err)
	}
	for _, bad := range []string{"../engine.json", "x.zip", list[0].Name + "/.."} {
		if _, err := s.Path(bad); err == nil {
			t.Errorf("Path(%q) accepted", bad)
		}
	}
	if _, err := s.Save("Bad Reason", nil); err == nil {
		t.Error("bad reason accepted")
	}
}
