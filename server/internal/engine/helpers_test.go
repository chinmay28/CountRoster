package engine

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chinmay28/countroster/server/internal/stack"
)

const testSecret = "0123456789abcdef0123456789abcdef"

// newServer is a real CountRoster server: the same stack the binary runs,
// over an in-memory database.
func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := stack.Open(stack.Options{DBPath: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(st.API)
	t.Cleanup(func() { srv.Close(); st.Close() })
	return srv
}

// newEngine opens an engine on dir and serves it.
func newEngine(t *testing.T, dir string) (*Engine, *client) {
	t.Helper()
	e, err := New(Options{DataDir: dir, Secret: testSecret})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(e.Handler())
	t.Cleanup(func() { srv.Close(); e.Close() })
	return e, &client{t: t, base: srv.URL, cookie: testSecret}
}

// client talks JSON to a base URL, carrying the session cookie when set —
// the WebView's view of the engine, or a PWA's view of a server.
type client struct {
	t      *testing.T
	base   string
	cookie string
}

func (c *client) do(method, path string, body any) (int, []byte) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		c.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.cookie != "" {
		req.AddCookie(&http.Cookie{Name: SessionCookie, Value: c.cookie})
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, data
}

func (c *client) json(method, path string, body, out any) int {
	c.t.Helper()
	status, data := c.do(method, path, body)
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s: %d %s", method, path, status, data)
		}
	}
	return status
}

func (c *client) mustJSON(method, path string, body, out any, want int) {
	c.t.Helper()
	status, data := c.do(method, path, body)
	if status != want {
		c.t.Fatalf("%s %s = %d, want %d: %s", method, path, status, want, data)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s: %v: %s", method, path, err, data)
		}
	}
}

type tracker struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (c *client) addTracker(name string) tracker {
	c.t.Helper()
	var tr tracker
	c.mustJSON("POST", "/api/trackers", map[string]any{"name": name, "kind": "count"}, &tr, 201)
	return tr
}

func (c *client) trackerNames() []string {
	c.t.Helper()
	var list []tracker
	c.mustJSON("GET", "/api/trackers", nil, &list, 200)
	names := []string{}
	for _, tr := range list {
		names = append(names, tr.Name)
	}
	return names
}

func (c *client) status() Status {
	c.t.Helper()
	var s Status
	c.mustJSON("GET", "/_engine/status", nil, &s, 200)
	return s
}

func errorBody(data []byte) string {
	var eb struct {
		Error string `json:"error"`
	}
	json.Unmarshal(data, &eb)
	return eb.Error
}

func joined(names []string) string { return strings.Join(names, ",") }
