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
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/chinmay28/countroster/server/internal/api"
	"github.com/chinmay28/countroster/server/internal/cloud"
	"github.com/chinmay28/countroster/server/internal/stack"
	"github.com/chinmay28/countroster/server/internal/web"
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
	// Automatic cloud backup. CountRoster is self-hosted, so there is no
	// shipped application identity to borrow: each deployment registers its
	// own OAuth app with Dropbox / Google and passes the credentials here.
	// Leave a client id empty and that provider is simply offered as
	// "needs setup" in the UI.
	dropbox   cloud.Credentials
	google    cloud.Credentials
	publicURL string
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
	fset.StringVar(&cfg.dropbox.ClientID, "dropbox-client-id",
		os.Getenv("COUNTROSTER_DROPBOX_CLIENT_ID"),
		"Dropbox OAuth app key, enabling cloud backup to Dropbox (env COUNTROSTER_DROPBOX_CLIENT_ID)")
	fset.StringVar(&cfg.dropbox.ClientSecret, "dropbox-client-secret",
		os.Getenv("COUNTROSTER_DROPBOX_CLIENT_SECRET"),
		"Dropbox OAuth app secret; omit for a PKCE-only app (env COUNTROSTER_DROPBOX_CLIENT_SECRET)")
	fset.StringVar(&cfg.google.ClientID, "google-client-id",
		os.Getenv("COUNTROSTER_GOOGLE_CLIENT_ID"),
		"Google OAuth client id, enabling cloud backup to Google Drive (env COUNTROSTER_GOOGLE_CLIENT_ID)")
	fset.StringVar(&cfg.google.ClientSecret, "google-client-secret",
		os.Getenv("COUNTROSTER_GOOGLE_CLIENT_SECRET"),
		"Google OAuth client secret (env COUNTROSTER_GOOGLE_CLIENT_SECRET)")
	fset.StringVar(&cfg.publicURL, "public-url", os.Getenv("COUNTROSTER_PUBLIC_URL"),
		"origin this server is reached at, used to build the OAuth redirect URI "+
			"(env COUNTROSTER_PUBLIC_URL; default: the request's own origin)")
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
	st, err := stack.Open(stack.Options{
		DBPath:    cfg.db,
		Dropbox:   cfg.dropbox,
		Google:    cfg.google,
		PublicURL: cfg.publicURL,
	})
	if err != nil {
		return err
	}

	// The scheduler is a background poller over the settings row, so it costs
	// one query a minute when nothing is configured — cheap enough to always
	// run, and it means enabling a schedule from the UI takes effect without
	// a restart.
	scheduler := &cloud.Scheduler{Service: st.Cloud, Log: log.Default()}
	scheduler.Start(context.Background())
	logCloudProviders(st.Cloud)

	handler := withWebClient(st.API, cfg.webDist, st.App.Trackers.Get)

	addr := net.JoinHostPort(cfg.host, cfg.port)
	log.Printf("[countroster] API listening on http://%s:%s (db: %s, schema v%d)",
		cfg.host, cfg.port, st.DBPath, st.SchemaVersion)
	return http.ListenAndServe(addr, handler)
}

// logCloudProviders says at startup which cloud destinations are usable. Not
// having one isn't a misconfiguration to warn about — setup lives on the Data
// page now — so the line just says where to go.
func logCloudProviders(svc *cloud.Service) {
	var ready []string
	for _, p := range svc.PublicProviders() {
		if p.Configured == 1 {
			ready = append(ready, p.Name)
		}
	}
	if len(ready) == 0 {
		log.Printf("[countroster] automatic cloud backup: no provider set up yet " +
			"(Data → Automatic cloud backup, or pass --dropbox-client-id / --google-client-id)")
		return
	}
	log.Printf("[countroster] automatic cloud backup available via %s; OAuth redirect URI is <origin>%s",
		strings.Join(ready, ", "), cloud.CallbackPath)
}

// withWebClient serves the built PWA from the same origin as the API so the
// mobile browser shell behaves like an installed app with no CORS hops.
func withWebClient(apiHandler http.Handler, webDist string, lookup web.TrackerLookup) http.Handler {
	var embedded fs.FS
	if sub, err := fs.Sub(embeddedWeb, "webdist"); err == nil {
		embedded = sub
	}
	files, origin := web.Files(webDist, embedded)
	if files == nil {
		log.Printf("[countroster] no web build embedded and no WEB_DIST on disk — API only " +
			"(run the web dev server separately).")
		return apiHandler
	}
	log.Printf("[countroster] serving web client from %s", origin)
	return web.Handler(apiHandler, files, lookup)
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
