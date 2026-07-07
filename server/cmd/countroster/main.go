// Command countroster is the CountRoster server: the REST API plus the built
// PWA, served from one origin — a single static binary replacing the Node
// process of the TypeScript era. Runtime interface (env vars, endpoints,
// on-disk SQLite format) is unchanged.
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
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
	if err := run(); err != nil {
		log.Fatalf("[countroster] failed to start: %v", err)
	}
}

func run() error {
	port := envOr("PORT", "8787")
	host := envOr("HOST", "0.0.0.0")
	dbEnv := envOr("COUNTROSTER_DB", "./data/countroster.sqlite")
	// ':memory:' is a SQLite sentinel, not a path — don't resolve it to a file.
	dbPath := dbEnv
	if dbEnv != ":memory:" {
		abs, err := filepath.Abs(dbEnv)
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

	handler := withWebClient(apiHandler)

	addr := net.JoinHostPort(host, port)
	log.Printf("[countroster] API listening on http://%s:%s (db: %s, schema v%d)",
		host, port, dbPath, schemaVersion)
	return http.ListenAndServe(addr, handler)
}

// withWebClient serves the built PWA from the same origin as the API so the
// mobile browser shell behaves like an installed app with no CORS hops. Any
// non-API GET that misses a file returns index.html (SPA fallback), so deep
// links like /trackers/:id survive a refresh.
func withWebClient(apiHandler http.Handler) http.Handler {
	files, origin := webFiles()
	if files == nil {
		log.Printf("[countroster] no web build embedded and no WEB_DIST on disk — API only " +
			"(run the web dev server separately).")
		return apiHandler
	}
	log.Printf("[countroster] serving web client from %s", origin)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api") {
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
			http.ServeFileFS(w, r, files, "index.html")
			return
		}
		http.NotFound(w, r)
	})
}

// webFiles picks the client asset source: an explicit WEB_DIST directory
// wins, then the assets embedded at build time, then the default
// apps/web/dist of a source checkout.
func webFiles() (fs.FS, string) {
	if dir := os.Getenv("WEB_DIST"); dir != "" {
		if hasIndex(os.DirFS(dir)) {
			return os.DirFS(dir), dir
		}
		log.Printf("[countroster] WEB_DIST=%s has no index.html — ignoring", dir)
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
