package engine

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// UnreachableMessage is the error body /api answers with in sync mode when
// the server can't be reached. The web client keys its banner on it.
const UnreachableMessage = "server unreachable"

// NewProxy forwards requests verbatim to the server at base, keeping the
// request path (/api/... lands on base/api/...). It never forwards the
// engine's credentials: the session cookie and bearer secret are the
// device's, not the server's business.
func NewProxy(base *url.URL, transport http.RoundTripper) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(base)
			r.Out.Header.Del("Cookie")
			r.Out.Header.Del("Authorization")
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			writeError(w, http.StatusServiceUnavailable, UnreachableMessage)
		},
	}
}
