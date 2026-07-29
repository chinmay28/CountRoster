package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/chinmay28/countroster/server/internal/cloud"
)

// Automatic cloud backup endpoints. They follow the same conventions as the
// rest of the API — snake_case JSON, 0|1 integer flags, explicit nulls,
// `{"error": …}` bodies — with two statuses the older routes never needed:
// 400 for a setup gap (`cloud.ConfigError`) and 502 for a failure that came
// from the provider (`cloud.ProviderError`). Both are mapped in handleErr.
//
// The whole surface is unauthenticated, like every other route: the server is
// meant for a trusted network. What it will *not* do is hand tokens back out
// — settings responses are redacted (see cloud.PublicSettings), so a stored
// grant can be used by this server and read by nobody.

// cloudSettingsBody is the GET payload: the current configuration plus the
// destinations this build can offer, so the settings screen renders in one
// round trip.
type cloudSettingsBody struct {
	Settings  cloud.PublicSettings   `json:"settings"`
	Providers []cloud.PublicProvider `json:"providers"`
	// RedirectURI is the exact string the user must register with their
	// provider. It's derived from the origin the request arrived on, so the
	// setup form can show what to paste rather than asking them to assemble
	// it from a hostname and a path.
	RedirectURI string `json:"redirect_uri"`
}

func (s *server) writeCloudSettings(w http.ResponseWriter, r *http.Request, status int) {
	set, err := s.cloud.Settings()
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, status, cloudSettingsBody{
		Settings:    set.Public(),
		Providers:   s.cloud.PublicProviders(),
		RedirectURI: s.cloud.RedirectURI(requestOrigin(r)),
	})
}

func (s *server) cloudBackupSettings(w http.ResponseWriter, r *http.Request) {
	s.writeCloudSettings(w, r, http.StatusOK)
}

// cloudBackupSetCredentials stores the OAuth client for one provider — the
// client id (and secret, where the provider needs one) from an app the user
// registered. This is what makes the whole feature reachable from a phone:
// the alternative is a startup flag, and a phone has no command line.
func (s *server) cloudBackupSetCredentials(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	clientID, _ := bodyField(body, "client_id").(string)
	clientSecret, _ := bodyField(body, "client_secret").(string)
	if err := s.cloud.SetCredentials(r.PathValue("provider"), clientID, clientSecret); err != nil {
		handleErr(w, err)
		return
	}
	s.writeCloudSettings(w, r, http.StatusOK)
}

// cloudBackupClearCredentials forgets a stored OAuth client, falling back to
// whatever the startup flags carry.
func (s *server) cloudBackupClearCredentials(w http.ResponseWriter, r *http.Request) {
	if err := s.cloud.ClearCredentials(r.PathValue("provider")); err != nil {
		handleErr(w, err)
		return
	}
	s.writeCloudSettings(w, r, http.StatusOK)
}

// cloudBackupUpdate patches the schedule and the destination folder. Absent
// keys are left alone; `folder_id` and `folder_path` move together, since a
// path without its handle is just a label.
func (s *server) cloudBackupUpdate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	var frequency, folderID, folderPath *string
	if v, ok := bodyField(body, "frequency").(string); ok {
		frequency = &v
	}
	if v, ok := bodyField(body, "folder_id").(string); ok {
		folderID = &v
		path := v
		if p, ok := bodyField(body, "folder_path").(string); ok {
			path = p
		}
		folderPath = &path
	}
	if _, err := s.cloud.Update(frequency, folderID, folderPath); err != nil {
		handleErr(w, err)
		return
	}
	s.writeCloudSettings(w, r, http.StatusOK)
}

// cloudBackupConnect starts an OAuth authorization and returns where to send
// the browser. The client navigates there itself rather than being redirected
// — it's a cross-origin hop out of a single-page app, and a fetch that
// followed a 302 would land the consent page in an XHR.
func (s *server) cloudBackupConnect(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	provider, _ := bodyField(body, "provider").(string)
	authorizeURL, err := s.cloud.StartConnect(provider, requestOrigin(r))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"authorize_url": authorizeURL})
}

// cloudBackupCallback is where the provider returns the browser. It is a
// *navigation*, not an API call, so it answers with a redirect back into the
// app rather than JSON — the outcome rides along in the query string and the
// Data page reports it.
func (s *server) cloudBackupCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if desc := q.Get("error"); desc != "" {
		// The user pressed "Cancel" on the consent screen, or the provider
		// refused. Either way there's nothing to exchange.
		cloudCallbackRedirect(w, r, "error", desc)
		return
	}
	code, state := q.Get("code"), q.Get("state")
	if code == "" || state == "" {
		cloudCallbackRedirect(w, r, "error", "The sign-in response was incomplete.")
		return
	}
	if _, err := s.cloud.CompleteConnect(r.Context(), state, code); err != nil {
		cloudCallbackRedirect(w, r, "error", err.Error())
		return
	}
	cloudCallbackRedirect(w, r, "connected", "")
}

// cloudCallbackRedirect sends the browser back to the Data page carrying the
// outcome. `cloud=connected` or `cloud=error&cloud_error=…`.
func cloudCallbackRedirect(w http.ResponseWriter, r *http.Request, status, message string) {
	q := url.Values{"cloud": {status}}
	if message != "" {
		q.Set("cloud_error", message)
	}
	http.Redirect(w, r, "/data?"+q.Encode(), http.StatusFound)
}

func (s *server) cloudBackupDisconnect(w http.ResponseWriter, r *http.Request) {
	if _, err := s.cloud.Disconnect(); err != nil {
		handleErr(w, err)
		return
	}
	s.writeCloudSettings(w, r, http.StatusOK)
}

// cloudBackupFolders lists the sub-folders of `folder_id` (absent = the
// account root) so the client can walk down to a destination. The client
// keeps its own breadcrumb trail on the way down, which is why there's no
// parent in the response.
func (s *server) cloudBackupFolders(w http.ResponseWriter, r *http.Request) {
	folders, err := s.cloud.ListFolders(r.Context(), r.URL.Query().Get("folder_id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if folders == nil {
		folders = []cloud.Folder{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"folders": folders})
}

// cloudBackupRun exports and uploads a bundle right now. A failure is
// recorded on the settings row *and* returned, so the button reports it
// instead of quietly looking successful.
func (s *server) cloudBackupRun(w http.ResponseWriter, r *http.Request) {
	result, err := s.cloud.Run(r.Context())
	if err != nil {
		handleErr(w, err)
		return
	}
	set, err := s.cloud.Settings()
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"file_name": result.FileName,
		"bytes":     result.Bytes,
		"settings":  set.Public(),
	})
}

// requestOrigin reconstructs the origin the browser used, which is what the
// OAuth redirect URI has to be built from. Forwarded headers win: behind a
// TLS-terminating proxy the request itself looks like plain HTTP on an
// internal name, and a redirect URI built from that would never match the one
// registered with the provider. (An operator whose proxy sets neither header
// can pin the origin with --public-url.)
func requestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if proto := forwardedFirst(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		scheme = proto
	}
	host := r.Host
	if fwd := forwardedFirst(r.Header.Get("X-Forwarded-Host")); fwd != "" {
		host = fwd
	}
	return scheme + "://" + host
}

// forwardedFirst takes the left-most value of a comma-separated X-Forwarded-*
// header — the one the original client reached.
func forwardedFirst(v string) string {
	first, _, _ := strings.Cut(v, ",")
	return strings.TrimSpace(first)
}
