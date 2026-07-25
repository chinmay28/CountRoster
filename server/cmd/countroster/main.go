// Command countroster is the CountRoster server: the REST API plus the built
// PWA, served from one origin — a single static binary replacing the Node
// process of the TypeScript era. Runtime interface (env vars, endpoints,
// on-disk SQLite format) is unchanged.
//
// The CLI accepts a `serve` subcommand (also the default with no arguments)
// whose flags override the corresponding environment variables, plus
// `version` and `help`.
package main

import (
	"embed"
	"errors"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/chinmay28/countroster/server/internal/api"
	"github.com/chinmay28/countroster/server/internal/backup"
	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/migrate"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// The release build copies apps/web/dist into webdist/ before `go build`, so
// the binary carries the whole client. In a bare checkout the directory holds
// only a README and the server falls back to serving WEB_DIST from disk.
//
//go:embed all:webdist
var embeddedWeb embed.FS

func main() {
	if err := dispatch(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			// Usage already written to stderr by the flag package.
			return
		}
		log.Fatalf("[countroster] failed to start: %v", err)
	}
}

// dispatch routes the first non-flag argument to a subcommand. With no
// arguments (or a leading flag) it serves, preserving the historic behaviour
// of running the bare binary.
func dispatch(args []string) error {
	cmd := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "", "serve":
		return serve(args)
	case "version":
		fmt.Printf("countroster %s\n", api.AppVersion)
		return nil
	case "help":
		printUsage(os.Stdout)
		return nil
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		printUsage(os.Stderr)
		return fmt.Errorf("unknown command %q", cmd)
	}
}

// config holds the resolved server settings. Precedence is CLI flag > env var
// > built-in default: each flag defaults to the env-resolved value, so an
// unset flag falls through to the environment.
type config struct {
	host    string
	port    string
	db      string
	webDist string
}

func serve(args []string) error {
	fset := flag.NewFlagSet("serve", flag.ContinueOnError)
	fset.Usage = func() {
		out := fset.Output()
		fmt.Fprint(out, "Usage: countroster serve [flags]\n\n"+
			"Start the CountRoster server. Flags override the matching environment\n"+
			"variable; an unset flag falls back to the env var, then the default.\n\n"+
			"Flags:\n")
		fset.PrintDefaults()
	}

	var cfg config
	var showVersion bool
	fset.StringVar(&cfg.host, "host", envOr("HOST", "0.0.0.0"), "bind address (env HOST)")
	fset.StringVar(&cfg.port, "port", envOr("PORT", "8787"), "listen port (env PORT)")
	fset.StringVar(&cfg.db, "db", envOr("COUNTROSTER_DB", "./data/countroster.sqlite"),
		"SQLite file, or :memory: (env COUNTROSTER_DB)")
	fset.StringVar(&cfg.webDist, "web-dist", os.Getenv("WEB_DIST"),
		"serve the PWA from this directory, overriding embedded assets (env WEB_DIST)")
	fset.BoolVar(&showVersion, "version", false, "print version and exit")

	if err := fset.Parse(args); err != nil {
		return err
	}
	if showVersion {
		fmt.Printf("countroster %s\n", api.AppVersion)
		return nil
	}
	if extra := fset.Args(); len(extra) > 0 {
		return fmt.Errorf("unexpected argument %q", extra[0])
	}
	return run(cfg)
}

func run(cfg config) error {
	// ':memory:' is a SQLite sentinel, not a path — don't resolve it to a file.
	dbPath := cfg.db
	if cfg.db != ":memory:" {
		abs, err := filepath.Abs(cfg.db)
		if err != nil {
			return err
		}
		dbPath = abs
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return err
		}
	}

	db, err := storage.Open(dbPath)
	if err != nil {
		return err
	}
	schemaVersion, err := migrate.Run(db)
	if err != nil {
		return fmt.Errorf("migrations: %w", err)
	}

	app := core.New(db, timeutil.SystemClock)
	backupSvc := &backup.Service{St: db, Clock: timeutil.SystemClock}
	apiHandler := api.New(app, backupSvc, api.FileSource{
		Path:       db.Path,
		Checkpoint: db.Checkpoint,
	})

	handler := withWebClient(apiHandler, cfg.webDist, app.Trackers.Get)

	addr := net.JoinHostPort(cfg.host, cfg.port)
	log.Printf("[countroster] API listening on http://%s:%s (db: %s, schema v%d)",
		cfg.host, cfg.port, dbPath, schemaVersion)
	return http.ListenAndServe(addr, handler)
}

// withWebClient serves the built PWA from the same origin as the API so the
// mobile browser shell behaves like an installed app with no CORS hops. Any
// non-API GET that misses a file returns index.html (SPA fallback), so deep
// links like /trackers/:id survive a refresh.
func withWebClient(apiHandler http.Handler, webDist string, lookup trackerLookup) http.Handler {
	files, origin := webFiles(webDist)
	if files == nil {
		log.Printf("[countroster] no web build embedded and no WEB_DIST on disk — API only " +
			"(run the web dev server separately).")
		return apiHandler
	}
	log.Printf("[countroster] serving web client from %s", origin)
	return webHandler(apiHandler, files, lookup)
}

// trackerLookup resolves the tracker a quick-log URL names, so its shell can
// carry that tracker's identity (see quickShell). Nil tracker, nil error means
// "no such tracker".
type trackerLookup func(id string) (*core.Tracker, error)

// webHandler is withWebClient's routing, split out from asset discovery so it
// can be exercised against an in-memory file set.
func webHandler(apiHandler http.Handler, files fs.FS, lookup trackerLookup) http.Handler {
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

// webFiles picks the client asset source: an explicit web-dist directory
// (--web-dist flag or WEB_DIST env) wins, then the assets embedded at build
// time, then the default apps/web/dist of a source checkout.
func webFiles(webDist string) (fs.FS, string) {
	if webDist != "" {
		if hasIndex(os.DirFS(webDist)) {
			return os.DirFS(webDist), webDist
		}
		log.Printf("[countroster] web-dist %s has no index.html — ignoring", webDist)
	}
	if sub, err := fs.Sub(embeddedWeb, "webdist"); err == nil && hasIndex(sub) {
		return sub, "embedded assets"
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

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func printUsage(w *os.File) {
	fmt.Fprintf(w, `countroster %s — an anything tracker (REST API + PWA)

Usage:
  countroster [serve] [flags]   start the server (default command)
  countroster version           print version and exit
  countroster help              show this help

Run "countroster serve -h" for the serve flags.
`, api.AppVersion)
}
