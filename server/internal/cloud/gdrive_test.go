package cloud

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Google Drive speaks a different dialect from Dropbox at every step — a
// query language for listing, multipart/related for upload — so it gets its
// own fake rather than sharing one.
type fakeDrive struct {
	srv *httptest.Server

	listQuery    string
	uploadedMeta map[string]any
	uploadedBody []byte
}

func newFakeDrive(t *testing.T) *fakeDrive {
	t.Helper()
	f := &fakeDrive{}
	mux := http.NewServeMux()

	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, map[string]any{
			"access_token": "gd-access", "refresh_token": "gd-refresh", "expires_in": 3600,
		})
	})
	mux.HandleFunc("GET /drive/v3/about", func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(w, map[string]any{
			"user": map[string]any{"emailAddress": "ada@example.com"},
		})
	})
	mux.HandleFunc("GET /drive/v3/files", func(w http.ResponseWriter, r *http.Request) {
		f.listQuery = r.URL.Query().Get("q")
		writeTestJSON(w, map[string]any{"files": []any{
			map[string]any{"id": "folder-1", "name": "Backups"},
		}})
	})
	mux.HandleFunc("POST /upload/drive/v3/files", func(w http.ResponseWriter, r *http.Request) {
		_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mr := multipart.NewReader(r.Body, params["boundary"])
		// Part one is the metadata, part two the bytes — the order Drive's
		// multipart upload requires.
		meta, err := mr.NextPart()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		json.NewDecoder(meta).Decode(&f.uploadedMeta)
		media, err := mr.NextPart()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.uploadedBody, _ = io.ReadAll(media)
		writeTestJSON(w, map[string]any{"id": "file-1"})
	})

	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeDrive) provider() *GoogleDrive {
	p := NewGoogleDrive(Credentials{ClientID: "gid", ClientSecret: "gsecret"},
		f.srv.Client(), func() time.Time { return time.Unix(0, 0).UTC() })
	p.AuthBase = f.srv.URL
	p.TokenBase = f.srv.URL
	p.APIBase = f.srv.URL
	p.UploadBase = f.srv.URL
	return p
}

func TestGoogleAuthorizeURLRequestsOfflineConsent(t *testing.T) {
	p := newFakeDrive(t).provider()
	raw := p.AuthorizeURL("https://roster.example/api/cloud/backup/callback", "st", "ch")
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("access_type") != "offline" {
		t.Error("Drive must be asked for offline access, or there's no refresh token")
	}
	// Without prompt=consent a re-connect comes back with no refresh token
	// and the schedule dies an hour later.
	if q.Get("prompt") != "consent" {
		t.Error("re-consent must be forced so a reconnect reissues a refresh token")
	}
	if q.Get("code_challenge") != "ch" || q.Get("code_challenge_method") != "S256" {
		t.Errorf("missing PKCE challenge in %s", raw)
	}
	if !strings.Contains(q.Get("scope"), "auth/drive") {
		t.Errorf("scope = %q, want Drive access", q.Get("scope"))
	}
}

func TestGoogleExchangeNamesTheAccount(t *testing.T) {
	p := newFakeDrive(t).provider()
	token, account, err := p.Exchange(context.Background(), "code", "verifier", "https://roster.example/cb")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if token.AccessToken != "gd-access" || token.RefreshToken != "gd-refresh" {
		t.Errorf("token = %+v, want the fake's grant", token)
	}
	if token.ExpiresAt.IsZero() {
		t.Error("expires_in should resolve to a concrete expiry")
	}
	if account.Label != "ada@example.com" {
		t.Errorf("account = %q, want the address from Drive", account.Label)
	}
}

func TestGoogleListFoldersQueriesOnlyFoldersInTheParent(t *testing.T) {
	f := newFakeDrive(t)
	folders, err := f.provider().ListFolders(context.Background(), "gd-token", "")
	if err != nil {
		t.Fatalf("ListFolders: %v", err)
	}
	// An empty folder id means "My Drive", which Drive spells "root".
	if !strings.Contains(f.listQuery, "'root' in parents") {
		t.Errorf("query = %q, want it rooted at My Drive", f.listQuery)
	}
	if !strings.Contains(f.listQuery, "application/vnd.google-apps.folder") {
		t.Errorf("query = %q, want folders only", f.listQuery)
	}
	// Backing up into the bin would be a quiet way to lose every backup.
	if !strings.Contains(f.listQuery, "trashed = false") {
		t.Errorf("query = %q, want trashed items excluded", f.listQuery)
	}
	if len(folders) != 1 || folders[0].ID != "folder-1" {
		t.Errorf("folders = %+v, want the one the fake returned", folders)
	}
}

func TestGoogleUploadPlacesTheFileInTheChosenFolder(t *testing.T) {
	f := newFakeDrive(t)
	payload := []byte("PK\x03\x04 pretend bundle")
	err := f.provider().Upload(context.Background(), "gd-token", "folder-1",
		"countroster-2026-05-25-1200.countroster.zip", payload)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if got := f.uploadedMeta["name"]; got != "countroster-2026-05-25-1200.countroster.zip" {
		t.Errorf("uploaded name = %v", got)
	}
	parents, _ := f.uploadedMeta["parents"].([]any)
	if len(parents) != 1 || parents[0] != "folder-1" {
		t.Errorf("parents = %v, want the chosen folder", parents)
	}
	if string(f.uploadedBody) != string(payload) {
		t.Errorf("uploaded %q, want the bundle bytes unchanged", f.uploadedBody)
	}
}

// A provider with no client id must refuse the OAuth calls outright rather
// than sending a half-formed request to Google.
func TestGoogleWithoutCredentialsIsNotConfigured(t *testing.T) {
	p := NewGoogleDrive(Credentials{}, nil, time.Now)
	if p.Configured() {
		t.Fatal("a provider with no client id is not configured")
	}
	if _, _, err := p.Exchange(context.Background(), "c", "v", "r"); err != ErrNotConfigured {
		t.Errorf("Exchange error = %v, want ErrNotConfigured", err)
	}
	if _, err := p.Refresh(context.Background(), "r"); err != ErrNotConfigured {
		t.Errorf("Refresh error = %v, want ErrNotConfigured", err)
	}
}
