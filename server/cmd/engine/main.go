// Command engine is CountRoster's on-device server, launched by the Android
// app as a child process (packaged as lib countroster_engine.so and exec'd
// from the app's native library directory, where Android permits it).
//
// The launcher contract — keep apps/android in step with it:
//
//   - Flags: --data-dir (required), --tz (IANA zone, e.g. America/Los_Angeles),
//     --dns (comma-separated server IPs), --host/--port (default
//     127.0.0.1:0, i.e. loopback and any free port), --web-dist (override the
//     embedded client).
//   - Environment: COUNTROSTER_ENGINE_SECRET (required, ≥32 chars), the
//     per-launch secret the Gate checks. In the environment, not argv.
//   - Stdout: once listening, exactly one line
//     `COUNTROSTER_ENGINE_READY {"port":…,"version":"…","api_level":…}`.
//   - Lifetime: the engine exits when its stdin reaches EOF (the parent died
//     or let go), or on SIGTERM/SIGINT.
//
// The timezone is a flag because Go on Android ignores the system's: there
// is no /etc/localtime and runtime.initLocal sets UTC, which would bucket
// every day in UTC. The shell restarts the engine when the zone changes,
// rather than swapping time.Local under running requests.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	// Fallback zone data: newer Android keeps tzdata in an APEX path Go
	// doesn't search, so LoadLocation would fail without it.
	_ "time/tzdata"

	"github.com/chinmay28/countroster/server/internal/api"
	"github.com/chinmay28/countroster/server/internal/engine"
	"github.com/chinmay28/countroster/server/internal/web"
)

//go:embed all:webdist
var embeddedWeb embed.FS

// ReadyPrefix starts the line the launcher waits for.
const ReadyPrefix = "COUNTROSTER_ENGINE_READY "

// SecretEnv names the environment variable carrying the per-launch secret.
const SecretEnv = "COUNTROSTER_ENGINE_SECRET"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	err := run(ctx, os.Args[1:], os.Getenv, os.Stdin, os.Stdout, log.New(os.Stderr, "", log.LstdFlags))
	if err != nil && !errors.Is(err, flag.ErrHelp) {
		log.Fatalf("[engine] %v", err)
	}
}

type options struct {
	dataDir, tz, dns, host, port, webDist string
}

func parse(args []string) (options, error) {
	var o options
	fset := flag.NewFlagSet("engine", flag.ContinueOnError)
	fset.StringVar(&o.dataDir, "data-dir", "", "directory for the database and engine state (required)")
	fset.StringVar(&o.tz, "tz", "", "IANA timezone for local-day bucketing (Go can't read Android's)")
	fset.StringVar(&o.dns, "dns", "", "comma-separated DNS server IPs")
	fset.StringVar(&o.host, "host", "127.0.0.1", "bind address — keep it loopback")
	fset.StringVar(&o.port, "port", "0", "listen port; 0 picks a free one")
	fset.StringVar(&o.webDist, "web-dist", "", "serve the client from this directory instead of the embedded one")
	if err := fset.Parse(args); err != nil {
		return o, err
	}
	if o.dataDir == "" {
		return o, errors.New("--data-dir is required")
	}
	if fset.NArg() > 0 {
		return o, fmt.Errorf("unexpected argument %q", fset.Arg(0))
	}
	return o, nil
}

// run is main without the process globals, so tests can drive the whole
// launcher contract. It returns when ctx ends or stdin closes.
func run(ctx context.Context, args []string, getenv func(string) string,
	stdin io.Reader, stdout io.Writer, logger *log.Logger) error {
	o, err := parse(args)
	if err != nil {
		return err
	}
	if o.tz != "" {
		// Before anything reads the clock — nothing else is running yet.
		if loc, err := time.LoadLocation(o.tz); err != nil {
			logger.Printf("[engine] timezone %q: %v — using UTC", o.tz, err)
		} else {
			time.Local = loc
		}
	}

	dns := &engine.DNS{}
	if o.dns != "" {
		if err := dns.Set(strings.Split(o.dns, ",")); err != nil {
			return err
		}
	}
	// Process-wide, so the cloud backup's HTTP calls resolve too.
	net.DefaultResolver = dns.Resolver()

	var embedded fs.FS
	if sub, err := fs.Sub(embeddedWeb, "webdist"); err == nil {
		embedded = sub
	}
	files, _ := web.Files(o.webDist, embedded)

	e, err := engine.New(engine.Options{
		DataDir: o.dataDir,
		Secret:  getenv(SecretEnv),
		Web:     files,
		DNS:     dns,
		Log:     logger,
	})
	if err != nil {
		return err
	}
	defer e.Close()

	ln, err := net.Listen("tcp", net.JoinHostPort(o.host, o.port))
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: e.Handler(), ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go e.Run(ctx)
	go func() {
		io.Copy(io.Discard, stdin) // returns at EOF: the launcher is gone
		cancel()
	}()

	ready, _ := json.Marshal(map[string]any{
		"port":      ln.Addr().(*net.TCPAddr).Port,
		"version":   api.AppVersion,
		"api_level": api.APILevel,
	})
	fmt.Fprintf(stdout, "%s%s\n", ReadyPrefix, ready)
	logger.Printf("[engine] listening on %s (%s mode)", ln.Addr(), e.Mode())

	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	return srv.Shutdown(shutdownCtx)
}
