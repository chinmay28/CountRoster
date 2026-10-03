package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chinmay28/countroster/server/internal/api"
	"github.com/chinmay28/countroster/server/internal/cloud"
	"github.com/chinmay28/countroster/server/internal/stack"
	"github.com/chinmay28/countroster/server/internal/web"
)

// File names inside DataDir.
const (
	DBFile     = "countroster.sqlite"
	ConfigFile = "engine.json"
	SafetyDir  = "safety"
)

// Strategies for moving data when sync is turned on or off (MOBILE.md §6).
const (
	// StrategyUseServer switches to the server's data; this device's data
	// stays in its (now dormant) local database, with a safety bundle.
	StrategyUseServer = "use_server"
	// StrategyMoveToServer uploads this device's data to an empty server.
	StrategyMoveToServer = "move_to_server"
	// StrategyReplaceServer overwrites the server with this device's data,
	// keeping a safety bundle of what the server held.
	StrategyReplaceServer = "replace_server"
	// StrategyCopyFromServer (turning sync off) replaces the local database
	// with a copy of the server's data, so the device carries on where it was.
	StrategyCopyFromServer = "copy_from_server"
	// StrategyUseLocal (turning sync off) goes back to the dormant local data.
	StrategyUseLocal = "use_local"
)

// Timeouts for the engine's own calls to a server.
const (
	probeTimeout  = 15 * time.Second
	bundleTimeout = 5 * time.Minute
)

// Options configures New.
type Options struct {
	// DataDir holds the database, engine.json and safety bundles.
	DataDir string
	// Secret admits the app's own WebView and shell (see Gate).
	Secret string
	// Web is the built client; nil serves the API alone.
	Web fs.FS
	// DNS, when set, resolves server hostnames (see DNS). Nil uses Go's
	// default resolver, which is right everywhere but Android.
	DNS *DNS
	// Transport overrides how the engine reaches servers (tests).
	Transport http.RoundTripper
	// Log receives operational lines; nil discards them.
	Log *log.Logger
	// Now stamps safety bundles; nil is time.Now.
	Now func() time.Time
}

// Engine is the on-device server. Build one with New, serve Handler, and
// Close it when the process ends.
type Engine struct {
	opts    Options
	st      *stack.Stack
	gate    *Gate
	configs ConfigStore
	safety  SafetyStore
	client  *http.Client
	sched   *cloud.Scheduler
	handler http.Handler

	mu     sync.Mutex // serializes mode switches
	target atomic.Pointer[target]
}

// target is where /api goes right now. Swapped whole, so a request in flight
// finishes on the delegate it started with.
type target struct {
	cfg     Config
	base    *url.URL     // nil in local mode
	handler http.Handler // the local API, or the proxy
	// info is the server's last probe result: nil until one succeeds.
	info atomic.Pointer[ServerInfo]
}

// New opens (and migrates) the local database and restores the persisted
// mode. A corrupt engine.json is logged and treated as local mode — the app
// must always open.
func New(opts Options) (*Engine, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Log == nil {
		opts.Log = log.New(discard{}, "", 0)
	}
	gate, err := NewGate(opts.Secret)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(opts.DataDir, 0o700); err != nil {
		return nil, err
	}
	st, err := stack.Open(stack.Options{DBPath: filepath.Join(opts.DataDir, DBFile)})
	if err != nil {
		return nil, err
	}

	transport := opts.Transport
	if transport == nil {
		dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
		if opts.DNS != nil {
			dialer.Resolver = opts.DNS.Resolver()
		}
		transport = &http.Transport{
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 2 * time.Minute,
			IdleConnTimeout:       90 * time.Second,
			MaxIdleConnsPerHost:   4,
			ForceAttemptHTTP2:     true,
		}
	}

	e := &Engine{
		opts:    opts,
		st:      st,
		gate:    gate,
		configs: ConfigStore{Path: filepath.Join(opts.DataDir, ConfigFile)},
		safety:  SafetyStore{Dir: filepath.Join(opts.DataDir, SafetyDir), Keep: 5, Now: opts.Now},
		client:  &http.Client{Transport: transport},
		sched:   &cloud.Scheduler{Service: st.Cloud, Log: opts.Log},
	}

	cfg, err := e.configs.Load()
	if err != nil {
		opts.Log.Printf("[engine] %v — starting in local mode", err)
		cfg = Config{Mode: ModeLocal}
	}
	e.setTarget(cfg)
	e.handler = e.routes()
	return e, nil
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// Handler is the engine's whole HTTP surface, behind the Gate.
func (e *Engine) Handler() http.Handler { return e.handler }

// Close releases the database.
func (e *Engine) Close() error { return e.st.Close() }

// Mode reports the current mode.
func (e *Engine) Mode() Mode { return e.target.Load().cfg.Mode }

// Run does the engine's background work until ctx ends: the cloud backup
// scheduler while in local mode (a synced device leaves backups to its
// server), and one compatibility check of the server when starting synced.
func (e *Engine) Run(ctx context.Context) {
	if t := e.target.Load(); t.cfg.Mode == ModeRemote {
		go e.refreshInfo(ctx, t)
	}
	ticker := time.NewTicker(cloud.TickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.tick(ctx)
		}
	}
}

func (e *Engine) tick(ctx context.Context) {
	if e.Mode() == ModeLocal {
		e.sched.Tick(ctx)
	}
}

func (e *Engine) refreshInfo(ctx context.Context, t *target) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	info, err := e.remote(t.base).Probe(ctx)
	if err != nil {
		e.opts.Log.Printf("[engine] server check: %v", err)
		return
	}
	t.info.Store(&info)
}

func (e *Engine) setTarget(cfg Config) *target {
	t := &target{cfg: cfg, handler: e.st.API}
	if cfg.Mode == ModeRemote {
		t.base, _ = NormalizeURL(cfg.RemoteURL) // validated on load/save
		t.handler = NewProxy(t.base, e.client.Transport)
	}
	e.target.Store(t)
	return t
}

func (e *Engine) remote(base *url.URL) Remote { return Remote{Base: base, Client: e.client} }

func (e *Engine) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /_engine/status", e.handleStatus)
	mux.HandleFunc("POST /_engine/sync/probe", e.handleProbe)
	mux.HandleFunc("POST /_engine/sync/enable", e.handleEnable)
	mux.HandleFunc("POST /_engine/sync/disable", e.handleDisable)
	mux.HandleFunc("GET /_engine/safety/{name}", e.handleSafetyBundle)
	mux.HandleFunc("PUT /_engine/network", e.handleNetwork)
	mux.HandleFunc("POST /_engine/cloud/tick", e.handleCloudTick)
	mux.HandleFunc("/_engine/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "Not found")
	})

	var rest http.Handler = http.HandlerFunc(e.serveAPI)
	if e.opts.Web != nil {
		// No tracker lookup: the quick-log shell personalization exists for
		// a browser's "Add to Home Screen", which a native app doesn't use.
		rest = web.Handler(rest, e.opts.Web, nil)
	}
	mux.Handle("/", rest)
	return e.gate.Wrap(mux)
}

// serveAPI hands /api to the current target. Synced to a server known to be
// older than this build, writes are refused: its validators would silently
// drop fields it doesn't know, and losing data quietly is worse than failing.
func (e *Engine) serveAPI(w http.ResponseWriter, r *http.Request) {
	t := e.target.Load()
	if t.cfg.Mode == ModeRemote && r.Method != http.MethodGet && r.Method != http.MethodHead {
		if info := t.info.Load(); info != nil {
			if err := CheckLevel(*info, api.APILevel); err != nil {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
		}
	}
	t.handler.ServeHTTP(w, r)
}

// Status is GET /_engine/status.
type Status struct {
	Mode             Mode           `json:"mode"`
	RemoteURL        *string        `json:"remote_url"`
	RemoteVersion    *string        `json:"remote_version"`
	RemoteAPILevel   *int           `json:"remote_api_level"`
	RemoteCompatible bool           `json:"remote_compatible"`
	LocalEmpty       bool           `json:"local_empty"`
	Version          string         `json:"version"`
	APILevel         int            `json:"api_level"`
	SafetyBundles    []SafetyBundle `json:"safety_bundles"`
}

func (e *Engine) status() (Status, error) {
	t := e.target.Load()
	empty, err := e.localEmpty()
	if err != nil {
		return Status{}, err
	}
	bundles, err := e.safety.List()
	if err != nil {
		return Status{}, err
	}
	s := Status{
		Mode:             t.cfg.Mode,
		RemoteCompatible: true,
		LocalEmpty:       empty,
		Version:          api.AppVersion,
		APILevel:         api.APILevel,
		SafetyBundles:    bundles,
	}
	if t.base != nil {
		u := t.base.String()
		s.RemoteURL = &u
		if info := t.info.Load(); info != nil {
			s.RemoteVersion = &info.Version
			s.RemoteAPILevel = &info.APILevel
			s.RemoteCompatible = CheckLevel(*info, api.APILevel) == nil
		}
	}
	return s, nil
}

// localEmpty applies the backup import's own test: no trackers, nothing to
// lose.
func (e *Engine) localEmpty() (bool, error) {
	rows, err := e.st.DB.Query(`SELECT COUNT(*) AS n FROM trackers`)
	if err != nil {
		return false, err
	}
	n, _ := rows[0].Get("n").(int64)
	return n == 0, nil
}

func (e *Engine) handleStatus(w http.ResponseWriter, _ *http.Request) {
	s, err := e.status()
	if err != nil {
		e.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// ProbeResult is POST /_engine/sync/probe: the server, and what the enable
// dialog needs to offer the right choices.
type ProbeResult struct {
	ServerInfo
	Compatible bool `json:"compatible"`
	LocalEmpty bool `json:"local_empty"`
}

func (e *Engine) handleProbe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if !decode(w, r, &req) {
		return
	}
	base, err := NormalizeURL(req.URL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), probeTimeout)
	defer cancel()
	info, err := e.remote(base).Probe(ctx)
	if err != nil {
		e.fail(w, err)
		return
	}
	empty, err := e.localEmpty()
	if err != nil {
		e.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ProbeResult{
		ServerInfo: info,
		Compatible: CheckLevel(info, api.APILevel) == nil,
		LocalEmpty: empty,
	})
}

func (e *Engine) handleEnable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL      string `json:"url"`
		Strategy string `json:"strategy"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := e.EnableSync(r.Context(), req.URL, req.Strategy); err != nil {
		e.fail(w, err)
		return
	}
	e.handleStatus(w, r)
}

func (e *Engine) handleDisable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Strategy string `json:"strategy"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := e.DisableSync(r.Context(), req.Strategy); err != nil {
		e.fail(w, err)
		return
	}
	e.handleStatus(w, r)
}

// EnableSync points /api at the server at rawURL, first moving data as the
// strategy says. Every data step happens before the mode flips, so a failure
// leaves the device exactly as it was.
func (e *Engine) EnableSync(ctx context.Context, rawURL, strategy string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.Mode() != ModeLocal {
		return conflict("already syncing — turn sync off first")
	}
	base, err := NormalizeURL(rawURL)
	if err != nil {
		return badRequest(err.Error())
	}
	remote := e.remote(base)

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	info, err := remote.Probe(probeCtx)
	cancel()
	if err != nil {
		return err
	}
	if err := CheckLevel(info, api.APILevel); err != nil {
		return err
	}
	localEmpty, err := e.localEmpty()
	if err != nil {
		return err
	}

	ctx, cancel = context.WithTimeout(ctx, bundleTimeout)
	defer cancel()
	switch strategy {
	case StrategyUseServer:
		if !localEmpty {
			if err := e.saveLocal("before-sync"); err != nil {
				return err
			}
		}
	case StrategyMoveToServer:
		if localEmpty {
			break // nothing to move
		}
		if !info.Empty {
			return conflict("the server already has data — use the server's data, or replace it")
		}
		bundle, err := e.st.Backup.ExportBundle(api.AppVersion)
		if err != nil {
			return err
		}
		if err := remote.Import(ctx, bundle, false); err != nil {
			return err
		}
	case StrategyReplaceServer:
		serverBundle, err := remote.Export(ctx)
		if err != nil {
			return err
		}
		if _, err := e.safety.Save("server-before-replace", serverBundle); err != nil {
			return err
		}
		bundle, err := e.st.Backup.ExportBundle(api.AppVersion)
		if err != nil {
			return err
		}
		if err := remote.Import(ctx, bundle, true); err != nil {
			return err
		}
	default:
		return badRequest(fmt.Sprintf("unknown strategy %q", strategy))
	}

	cfg := Config{Mode: ModeRemote, RemoteURL: base.String()}
	if err := e.configs.Save(cfg); err != nil {
		return err
	}
	t := e.setTarget(cfg)
	t.info.Store(&info)
	e.opts.Log.Printf("[engine] sync on: %s (%s)", base, strategy)
	return nil
}

// DisableSync points /api back at the local database, first copying the
// server's data down if the strategy says so.
func (e *Engine) DisableSync(ctx context.Context, strategy string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.target.Load()
	if t.cfg.Mode != ModeRemote {
		return conflict("not syncing")
	}
	switch strategy {
	case StrategyUseLocal:
	case StrategyCopyFromServer:
		ctx, cancel := context.WithTimeout(ctx, bundleTimeout)
		defer cancel()
		bundle, err := e.remote(t.base).Export(ctx)
		if err != nil {
			return err
		}
		empty, err := e.localEmpty()
		if err != nil {
			return err
		}
		if !empty {
			if err := e.saveLocal("before-copy-from-server"); err != nil {
				return err
			}
		}
		if _, err := e.st.Backup.ImportBundle(bundle, true); err != nil {
			return err
		}
	default:
		return badRequest(fmt.Sprintf("unknown strategy %q", strategy))
	}

	cfg := Config{Mode: ModeLocal}
	if err := e.configs.Save(cfg); err != nil {
		return err
	}
	e.setTarget(cfg)
	e.opts.Log.Printf("[engine] sync off (%s)", strategy)
	return nil
}

func (e *Engine) saveLocal(reason string) error {
	bundle, err := e.st.Backup.ExportBundle(api.AppVersion)
	if err != nil {
		return err
	}
	_, err = e.safety.Save(reason, bundle)
	return err
}

func (e *Engine) handleSafetyBundle(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	path, err := e.safety.Path(name)
	if err != nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeFile(w, r, path)
}

func (e *Engine) handleNetwork(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DNSServers []string `json:"dns_servers"`
	}
	if !decode(w, r, &req) {
		return
	}
	if e.opts.DNS == nil {
		writeError(w, http.StatusNotImplemented, "this engine uses the system resolver")
		return
	}
	if err := e.opts.DNS.Set(req.DNSServers); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleCloudTick runs one scheduler pass now — the hook for the OS's
// background job, since the in-process ticker only runs while the app does.
func (e *Engine) handleCloudTick(w http.ResponseWriter, r *http.Request) {
	e.tick(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

// requestError is a failure the caller can act on, with its HTTP status.
type requestError struct {
	status int
	msg    string
}

func (e *requestError) Error() string { return e.msg }

func badRequest(msg string) error { return &requestError{http.StatusBadRequest, msg} }
func conflict(msg string) error   { return &requestError{http.StatusConflict, msg} }

// fail maps an error to the response the web client shows: its own problem
// (400/409), the server's problem (502), or ours (500).
func (e *Engine) fail(w http.ResponseWriter, err error) {
	var re *requestError
	var tooOld *TooOldError
	var remoteErr *RemoteError
	switch {
	case errors.As(err, &re):
		writeError(w, re.status, re.msg)
	case errors.As(err, &tooOld):
		writeError(w, http.StatusConflict, tooOld.Error())
	case errors.Is(err, ErrUnreachable), errors.Is(err, ErrNotCountRoster):
		writeError(w, http.StatusBadGateway, err.Error())
	case errors.As(err, &remoteErr):
		writeError(w, http.StatusBadGateway, remoteErr.Error())
	default:
		e.opts.Log.Printf("[engine] %v", err)
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}
