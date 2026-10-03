package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// NormalizeURL turns what a person types ("pi.local:8787",
// "https://box.tailnet.ts.net/", "http://10.0.0.5:8787/api") into the
// server's base URL: scheme and host, any path prefix kept, no trailing
// slash, no /api suffix. A bare host defaults to http — a CountRoster server
// on a LAN or tailnet usually has no certificate.
func NormalizeURL(raw string) (*url.URL, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("server URL is empty")
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return nil, fmt.Errorf("not a URL: %q", raw)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("server URL must be http or https, not %q", u.Scheme)
	}
	if u.Host == "" || u.Hostname() == "" {
		return nil, fmt.Errorf("server URL has no host: %q", raw)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("server URL must be just the address: %q", raw)
	}
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/api")
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawPath = ""
	return u, nil
}

// ServerInfo is what Probe learns about a server.
type ServerInfo struct {
	URL      string `json:"url"`
	Version  string `json:"version"`
	APILevel int    `json:"api_level"`
	// Empty means the server has no trackers — the same test its backup
	// import uses to decide whether an import would overwrite anything.
	Empty bool `json:"empty"`
}

// Errors a remote server can produce, mapped to HTTP statuses by Engine.
var (
	ErrUnreachable    = errors.New("can't reach the server")
	ErrNotCountRoster = errors.New("that address answers, but it isn't a CountRoster server")
)

// TooOldError: the server's API is below what this build relies on.
type TooOldError struct{ Have, Want int }

func (e *TooOldError) Error() string {
	return fmt.Sprintf("the server is older than this app (API level %d, need %d) — "+
		"update the server first", e.Have, e.Want)
}

// RemoteError is a failure the server reported (its {"error"} body).
type RemoteError struct {
	Status int
	Msg    string
}

func (e *RemoteError) Error() string { return fmt.Sprintf("server: %s", e.Msg) }

// CheckLevel returns a *TooOldError when info is below want.
func CheckLevel(info ServerInfo, want int) error {
	if info.APILevel < want {
		return &TooOldError{Have: info.APILevel, Want: want}
	}
	return nil
}

// Remote is a client for the few server endpoints the engine itself calls.
type Remote struct {
	Base   *url.URL
	Client *http.Client
}

func (r Remote) url(path string) string { return r.Base.String() + path }

func (r Remote) do(ctx context.Context, method, path string, body []byte, contentType string) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, r.url(path), rd)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := r.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	if res.StatusCode >= 300 {
		var eb struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &eb) == nil && eb.Error != "" {
			return nil, &RemoteError{Status: res.StatusCode, Msg: eb.Error}
		}
		return nil, &RemoteError{Status: res.StatusCode, Msg: res.Status}
	}
	return data, nil
}

// Probe asks the server who it is and whether it holds any data.
func (r Remote) Probe(ctx context.Context) (ServerInfo, error) {
	data, err := r.do(ctx, http.MethodGet, "/api/health", nil, "")
	var re *RemoteError
	if errors.As(err, &re) {
		return ServerInfo{}, ErrNotCountRoster
	}
	if err != nil {
		return ServerInfo{}, err
	}
	var health struct {
		OK       bool   `json:"ok"`
		Version  string `json:"version"`
		APILevel int    `json:"api_level"`
	}
	if json.Unmarshal(data, &health) != nil || !health.OK {
		return ServerInfo{}, ErrNotCountRoster
	}

	data, err = r.do(ctx, http.MethodGet, "/api/backup/manifest", nil, "")
	if err != nil {
		return ServerInfo{}, err
	}
	var manifest struct {
		RowCounts map[string]float64 `json:"row_counts"`
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.RowCounts == nil {
		return ServerInfo{}, ErrNotCountRoster
	}
	return ServerInfo{
		URL:      r.Base.String(),
		Version:  health.Version,
		APILevel: health.APILevel,
		Empty:    manifest.RowCounts["trackers"] == 0,
	}, nil
}

// Export downloads the server's backup bundle.
func (r Remote) Export(ctx context.Context) ([]byte, error) {
	return r.do(ctx, http.MethodGet, "/api/backup/bundle", nil, "")
}

// Import uploads a bundle. Without overwrite the server refuses to replace
// existing data, which is exactly the guard "move my data" relies on.
func (r Remote) Import(ctx context.Context, bundle []byte, overwrite bool) error {
	path := "/api/backup/import"
	if overwrite {
		path += "?confirmOverwrite=1"
	}
	_, err := r.do(ctx, http.MethodPost, path, bundle, "application/zip")
	return err
}
