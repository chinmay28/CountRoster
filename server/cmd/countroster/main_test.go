package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/chinmay28/countroster/server/internal/core"
)

// The tracker a quick-log URL names. Anything else is "no such tracker", so
// the shell is served untouched.
func testLookup(id string) (*core.Tracker, error) {
	if id != "019f97b1" {
		return nil, nil
	}
	return &core.Tracker{ID: id, Name: "Papu Feed Log", Color: "#ff5ca8"}, nil
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) " +
	"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/140.0 Safari/537.36"

// The built shell, in the order vite-plugin-pwa emits it: the manifest link
// lands at the end of <head>, *after* the inline script that would rewrite
// it — which is exactly why the server has to do the rewrite.
const shell = `<!doctype html><html><head>` +
	`<meta name="theme-color" content="#1f2933" />` +
	`<meta name="apple-mobile-web-app-capable" content="yes" />` +
	`<meta name="apple-mobile-web-app-title" content="CountRoster" />` +
	`<script>/* rewrites the manifest link, but runs before it exists */</script>` +
	`<link rel="manifest" href="/manifest.webmanifest">` +
	`</head><body><div id="root"></div></body></html>`

func testFiles() fstest.MapFS {
	return fstest.MapFS{
		"index.html":           {Data: []byte(shell)},
		"manifest.webmanifest": {Data: []byte(`{"start_url":"/"}`)},
		"assets/app.js":        {Data: []byte(`console.log(1)`)},
	}
}

// get drives the real web routing against an in-memory build. The stand-in
// API handler answers with its own marker so "went to the API" is visible.
func get(t *testing.T, path string, userAgent ...string) (*http.Response, string) {
	t.Helper()
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("API"))
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if len(userAgent) > 0 {
		req.Header.Set("User-Agent", userAgent[0])
	}
	webHandler(api, testFiles(), testLookup).ServeHTTP(rec, req)
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	return res, string(body)
}

func TestQuickURLIsServedAShellNamingItsTracker(t *testing.T) {
	res, body := get(t, "/trackers/019f97b1/quick", DESKTOP_UA)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	// This markup is what decides where the Home Screen icon points.
	if !strings.Contains(body, `href="/trackers/019f97b1/app.webmanifest"`) {
		t.Errorf("served shell doesn't name the tracker:\n%s", body)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", cc)
	}
	// The icon is labelled and tinted for the tracker on every platform.
	if !strings.Contains(body, `content="Papu Feed Log"`) {
		t.Errorf("apple-mobile-web-app-title not set:\n%s", body)
	}
	if !strings.Contains(body, `content="#ff5ca8"`) {
		t.Errorf("theme-color not set to the tracker color:\n%s", body)
	}
}

// iOS installs the page being viewed only when there is no manifest telling
// it otherwise, so the quick shell drops the link entirely there.
func TestQuickURLDropsTheManifestForIOS(t *testing.T) {
	_, body := get(t, "/trackers/019f97b1/quick", IPHONE_UA)

	if strings.Contains(body, "rel=\"manifest\"") {
		t.Errorf("iOS shell still links a manifest — the icon would follow its start_url:\n%s", body)
	}
	// Standalone display and the icon label come from the apple metas instead.
	if !strings.Contains(body, `content="Papu Feed Log"`) {
		t.Errorf("apple-mobile-web-app-title not set:\n%s", body)
	}
}

func TestUnknownTrackerGetsThePlainShell(t *testing.T) {
	_, body := get(t, "/trackers/nosuchtracker/quick", IPHONE_UA)
	if !strings.Contains(body, `href="/manifest.webmanifest"`) {
		t.Errorf("unknown tracker should fall through to the app shell:\n%s", body)
	}
}

func TestTrackerNameIsEscapedIntoTheShell(t *testing.T) {
	tracker := &core.Tracker{ID: "x", Name: `Papu "quotes" & <script>`, Color: "#fff"}
	out := string(quickShell([]byte(shell), tracker, true))
	// The quote would close the attribute and the tag would become markup.
	if strings.Contains(out, `content="Papu "quotes"`) {
		t.Errorf("tracker name broke out of the attribute:\n%s", out)
	}
	if !strings.Contains(out, "&#34;quotes&#34;") || !strings.Contains(out, "&lt;script&gt;") {
		t.Errorf("name not escaped as expected:\n%s", out)
	}
}

func TestIsIOS(t *testing.T) {
	for ua, want := range map[string]bool{
		IPHONE_UA:  true,
		DESKTOP_UA: false,
		"Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X)":     true,
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)":   false,
		"Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile": false,
	} {
		if got := isIOS(ua); got != want {
			t.Errorf("isIOS(%q) = %v, want %v", ua, got, want)
		}
	}
}

func TestWebRoutingLeavesEverythingElseAlone(t *testing.T) {
	// Other deep links get the shell untouched, so they install the app.
	if _, body := get(t, "/trackers/019f97b1"); !strings.Contains(body, `href="/manifest.webmanifest"`) {
		t.Errorf("detail deep link should get the app manifest:\n%s", body)
	}
	// Real files still win over the SPA fallback.
	if _, body := get(t, "/assets/app.js"); body != "console.log(1)" {
		t.Errorf("asset not served: %q", body)
	}
	// The API and the generated per-tracker manifests go to the handler.
	if _, body := get(t, "/api/health"); body != "API" {
		t.Errorf("/api not routed to the API: %q", body)
	}
	if _, body := get(t, "/trackers/019f97b1/app.webmanifest"); body != "API" {
		t.Errorf("manifest not routed to the API: %q", body)
	}
}

func TestQuickShellPointsAtTheTrackerManifest(t *testing.T) {
	tracker := &core.Tracker{ID: "019f97b1-22b3-77d0", Name: "Papu Feed Log", Color: "#ff5ca8"}
	out := string(quickShell([]byte(shell), tracker, false))
	want := `<link rel="manifest" href="/trackers/019f97b1-22b3-77d0/app.webmanifest">`
	if !strings.Contains(out, want) {
		t.Errorf("manifest link not rewritten:\n%s", out)
	}
	if strings.Contains(out, `href="/manifest.webmanifest"`) {
		t.Error("app manifest link still present — the icon would install start_url \"/\"")
	}
	// The rest of the shell survives, and the theme color follows the tracker.
	if !strings.Contains(out, `<div id="root">`) || !strings.Contains(out, `content="#ff5ca8"`) {
		t.Errorf("shell damaged by the rewrite:\n%s", out)
	}
	// Standalone display must survive: it's what makes the icon feel like an app.
	if !strings.Contains(out, `name="apple-mobile-web-app-capable" content="yes"`) {
		t.Errorf("standalone meta lost:\n%s", out)
	}
}

func TestQuickShellHandlesHrefBeforeRel(t *testing.T) {
	in := `<link href="/manifest.webmanifest" rel="manifest">`
	out := string(quickShell([]byte(in), &core.Tracker{ID: "abc", Name: "n", Color: "#fff"}, false))
	if !strings.Contains(out, `href="/trackers/abc/app.webmanifest"`) {
		t.Errorf("href-first link not rewritten: %s", out)
	}
}

func TestQuickPathMatching(t *testing.T) {
	cases := map[string]bool{
		"/trackers/019f97b1/quick":  true,
		"/trackers/019f97b1/quick/": true,
		"/trackers/019f97b1":        false,
		"/trackers/019f97b1/edit":   false,
		"/":                         false,
		// An id that can't be substituted into an attribute safely is left
		// to the plain shell rather than escaped.
		`/trackers/"><script>/quick`: false,
	}
	for path, want := range cases {
		if got := quickPathRe.MatchString(path); got != want {
			t.Errorf("quickPathRe.MatchString(%q) = %v, want %v", path, got, want)
		}
	}
}
