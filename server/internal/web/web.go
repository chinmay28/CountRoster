// Package web serves the built PWA from the same origin as the API: static
// assets, an SPA fallback so deep links survive a refresh, and the quick-log
// shell personalization. Shared by the server binary and the mobile engine.
package web

import (
	"html"
	"io/fs"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/chinmay28/countroster/server/internal/core"
)

// TrackerLookup resolves the tracker a quick-log URL names, so its shell can
// carry that tracker's identity (see quickShell). Nil tracker, nil error means
// "no such tracker".
type TrackerLookup func(id string) (*core.Tracker, error)

// Handler routes /api (and the per-tracker manifests) to apiHandler and
// serves everything else from files, falling back to index.html. lookup may
// be nil, which serves the plain shell for quick-log URLs.
func Handler(apiHandler http.Handler, files fs.FS, lookup TrackerLookup) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The per-tracker web app manifest is generated from the database
		// (name, color), so it goes to the handler rather than the SPA
		// fallback — which would hand the browser index.html and leave
		// "Add to Home Screen" installing the app's start_url instead.
		if strings.HasPrefix(r.URL.Path, "/api") ||
			strings.HasSuffix(r.URL.Path, "/app.webmanifest") {
			apiHandler.ServeHTTP(w, r)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		if info, err := fs.Stat(files, name); err == nil && !info.IsDir() {
			// Go's mime table doesn't know .webmanifest, so it would go out
			// as text/plain; say what it is.
			if strings.HasSuffix(name, ".webmanifest") {
				w.Header().Set("Content-Type", "application/manifest+json")
			}
			http.ServeFileFS(w, r, files, name)
			return
		}
		if r.Method == http.MethodGet {
			// A quick-log deep link gets the app shell with its manifest link
			// already pointing at that tracker (see quickShell).
			if m := quickPathRe.FindStringSubmatch(r.URL.Path); m != nil && lookup != nil {
				tracker, err := lookup(m[1])
				if shell, readErr := fs.ReadFile(files, "index.html"); err == nil &&
					tracker != nil && readErr == nil {
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					// Never let a cached shell keep pointing at the app's
					// manifest — the icon it installs depends on this markup.
					w.Header().Set("Cache-Control", "no-cache")
					w.Write(quickShell(shell, tracker, isIOS(r.UserAgent())))
					return
				}
			}
			http.ServeFileFS(w, r, files, "index.html")
			return
		}
		http.NotFound(w, r)
	})
}

// A quick-log screen's URL. The id charset is deliberately narrow: it is
// substituted into an HTML attribute below, so anything else is served the
// unmodified shell rather than escaped (the SPA reports the tracker missing,
// which is what such a URL deserves anyway).
var quickPathRe = regexp.MustCompile(`^/trackers/([A-Za-z0-9_-]{1,64})/quick/?$`)

// The app shell's web app manifest link, either attribute order, and the
// metas the quick shell personalizes.
var (
	manifestLinkRe    = regexp.MustCompile(`(?i)<link[^>]*\brel="manifest"[^>]*>`)
	manifestRelFirst  = regexp.MustCompile(`(?i)(<link[^>]*\brel="manifest"[^>]*\bhref=")([^"]*)(")`)
	manifestHrefFirst = regexp.MustCompile(`(?i)(<link[^>]*\bhref=")([^"]*)("[^>]*\brel="manifest")`)
)

// iOS reports itself as iPhone/iPad/iPod in every browser on the platform
// (they're all WebKit, and they all share the Home Screen behavior below).
var iosUARe = regexp.MustCompile(`(?i)(iphone|ipad|ipod)`)

func isIOS(userAgent string) bool { return iosUARe.MatchString(userAgent) }

// quickShell gives the quick-log screen an app shell that carries its
// tracker's identity, so "Add to Home Screen" produces an icon for *that*
// tracker rather than for CountRoster's home screen.
//
// The app's own manifest declares start_url "/", and browsers install what
// the manifest declares rather than the page you added — hence an icon that
// opened the home screen. Two different treatments, because the two families
// behave differently:
//
//   - Everywhere else, point the link at the tracker's generated manifest
//     (start_url is that tracker's quick screen). Doing it here in the markup
//     rather than from script matters: the PWA plugin injects the link at the
//     end of the built <head>, after the inline script that would rewrite it,
//     so a fresh load parses the app manifest first.
//
//   - On iOS, drop the manifest link altogether. Without one, Safari falls
//     back to the behavior it has had for over a decade: bookmark the URL
//     actually being viewed, standalone via apple-mobile-web-app-capable and
//     named by apple-mobile-web-app-title. That path cannot be overridden by
//     a start_url, which is the whole failure mode here — it doesn't depend
//     on how a given iOS version reads a manifest.
//
// Both paths get the tracker's name and color in the metas, so the icon is
// labelled for the tracker and the status bar is tinted from first paint.
func quickShell(shell []byte, tracker *core.Tracker, ios bool) []byte {
	out := shell
	if ios {
		out = manifestLinkRe.ReplaceAll(out, []byte(
			`<!-- manifest omitted: iOS installs the page being viewed -->`))
	} else {
		href := "/trackers/" + tracker.ID + "/app.webmanifest"
		if manifestRelFirst.Match(out) {
			out = manifestRelFirst.ReplaceAll(out, []byte("${1}"+href+"${3}"))
		} else {
			out = manifestHrefFirst.ReplaceAll(out, []byte("${1}"+href+"${3}"))
		}
	}
	out = setMetaContent(out, "apple-mobile-web-app-title", tracker.Name)
	return setMetaContent(out, "theme-color", tracker.Color)
}

// setMetaContent rewrites a <meta name="…" content="…"> in the shell.
func setMetaContent(shell []byte, name, value string) []byte {
	re, err := regexp.Compile(`(?i)(<meta[^>]*\bname="` + regexp.QuoteMeta(name) + `"[^>]*\bcontent=")([^"]*)(")`)
	if err != nil {
		return shell
	}
	// The value lands inside an HTML attribute *and* inside a regexp
	// replacement, so it has to survive both: escape the markup, then the
	// `$` that ReplaceAll would read as a capture group reference.
	safe := strings.ReplaceAll(html.EscapeString(value), "$", "$$")
	return re.ReplaceAll(shell, []byte("${1}"+safe+"${3}"))
}

// Files picks the client asset source: an explicit web-dist directory wins,
// then embedded (already rooted at the build), then the default
// apps/web/dist of a source checkout. Nil means no client is available.
func Files(webDist string, embedded fs.FS) (fs.FS, string) {
	if webDist != "" {
		if hasIndex(os.DirFS(webDist)) {
			return os.DirFS(webDist), webDist
		}
		log.Printf("[countroster] web-dist %s has no index.html — ignoring", webDist)
	}
	if embedded != nil && hasIndex(embedded) {
		return embedded, "embedded assets"
	}
	if hasIndex(os.DirFS("apps/web/dist")) {
		return os.DirFS("apps/web/dist"), "apps/web/dist"
	}
	return nil, ""
}

func hasIndex(files fs.FS) bool {
	info, err := fs.Stat(files, "index.html")
	return err == nil && !info.IsDir()
}
