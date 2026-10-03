package engine

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

// SessionCookie is the cookie the native shell plants in its WebView.
const SessionCookie = "cr_session"

// MinSecretLen is the shortest secret Gate accepts (hex of 16 random bytes).
const MinSecretLen = 32

// Gate admits only callers holding the per-launch secret: the WebView via
// the SessionCookie the native shell set in its cookie jar, the native shell
// itself via "Authorization: Bearer <secret>".
//
// A loopback port is reachable by every app on the device, not just ours.
// "No auth, trusted network" suits a LAN server; it does not suit the local
// mode of a phone app holding someone's meds and moods. The secret is minted
// by the shell for each engine launch and reaches the engine through its
// environment, so no other app ever sees it.
type Gate struct{ secret []byte }

// NewGate builds a Gate for secret.
func NewGate(secret string) (*Gate, error) {
	if len(secret) < MinSecretLen {
		return nil, errors.New("engine secret too short")
	}
	return &Gate{secret: []byte(secret)}, nil
}

// Allows reports whether r carries the secret.
func (g *Gate) Allows(r *http.Request) bool {
	if c, err := r.Cookie(SessionCookie); err == nil && g.matches(c.Value) {
		return true
	}
	if token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return g.matches(token)
	}
	return false
}

func (g *Gate) matches(v string) bool {
	return subtle.ConstantTimeCompare([]byte(v), g.secret) == 1
}

// Wrap refuses every request without the secret with 403.
func (g *Gate) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !g.Allows(r) {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		next.ServeHTTP(w, r)
	})
}
