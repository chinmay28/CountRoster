package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// The built shell, in the order vite-plugin-pwa emits it: the manifest link
// lands at the end of <head>, *after* the inline script that would rewrite
// it — which is exactly why the server has to do the rewrite.
const shell = `<!doctype html><html><head>` +
	`<meta name="theme-color" content="#1f2933" />` +
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
func get(t *testing.T, path string) (*http.Response, string) {
	t.Helper()
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("API"))
	})
	rec := httptest.NewRecorder()
	webHandler(api, testFiles()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	return res, string(body)
}

func TestQuickURLIsServedAShellNamingItsTracker(t *testing.T) {
	res, body := get(t, "/trackers/019f97b1/quick")
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
	out := string(quickShell([]byte(shell), "019f97b1-22b3-77d0"))
	want := `<link rel="manifest" href="/trackers/019f97b1-22b3-77d0/app.webmanifest">`
	if !strings.Contains(out, want) {
		t.Errorf("manifest link not rewritten:\n%s", out)
	}
	if strings.Contains(out, `href="/manifest.webmanifest"`) {
		t.Error("app manifest link still present — the icon would install start_url \"/\"")
	}
	// Everything else about the shell is untouched.
	if !strings.Contains(out, `<div id="root">`) || !strings.Contains(out, `content="#1f2933"`) {
		t.Errorf("shell damaged by the rewrite:\n%s", out)
	}
}

func TestQuickShellHandlesHrefBeforeRel(t *testing.T) {
	in := `<link href="/manifest.webmanifest" rel="manifest">`
	out := string(quickShell([]byte(in), "abc"))
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
