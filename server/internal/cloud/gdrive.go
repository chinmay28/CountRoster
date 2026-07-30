package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"
)

// Google Drive scope. The narrower `drive.file` grants access only to files
// the app itself created, which cannot browse the user's existing folders or
// write into one of them — and picking an existing folder is the whole point
// of this feature. `drive` is therefore the scope, and the operator's own
// Cloud project is the one being granted it: CountRoster is self-hosted, so
// the app the user authorizes is one they registered themselves.
const googleScopes = "https://www.googleapis.com/auth/drive " +
	"https://www.googleapis.com/auth/userinfo.email"

// googleRootFolder is Drive's alias for "My Drive" — the folder id to list
// when the user hasn't descended into anything yet.
const googleRootFolder = "root"

// GoogleDrive is the Google Drive provider. Base URLs are fields so tests can
// substitute an httptest server.
type GoogleDrive struct {
	Creds Credentials
	// AuthBase serves the consent screen (browser-facing).
	AuthBase string
	// TokenBase serves the OAuth token endpoint.
	TokenBase string
	// APIBase serves the Drive v3 metadata endpoints.
	APIBase string
	// UploadBase serves the Drive upload endpoint (a distinct path prefix).
	UploadBase string

	client *http.Client
	now    func() time.Time
}

// NewGoogleDrive builds the provider from the operator's registered app.
func NewGoogleDrive(creds Credentials, client *http.Client, now func() time.Time) *GoogleDrive {
	if now == nil {
		now = time.Now
	}
	return &GoogleDrive{
		Creds:      creds,
		AuthBase:   "https://accounts.google.com",
		TokenBase:  "https://oauth2.googleapis.com",
		APIBase:    "https://www.googleapis.com",
		UploadBase: "https://www.googleapis.com",
		client:     httpClient(client),
		now:        now,
	}
}

func (g *GoogleDrive) ID() string   { return ProviderGoogleDrive }
func (g *GoogleDrive) Name() string { return "Google Drive" }

func (g *GoogleDrive) Configured() bool { return g.Creds.Set() }

// WithCredentials returns a copy bound to a different OAuth client.
func (g *GoogleDrive) WithCredentials(creds Credentials) Provider {
	next := *g
	next.Creds = creds
	return &next
}

// RequiresSecret is true: Google's Web application clients — the type whose
// redirect URI can be a real https origin, which is what this server needs —
// must present a client secret at the token endpoint.
func (g *GoogleDrive) RequiresSecret() bool { return true }

func (g *GoogleDrive) SetupURL() string {
	return "https://console.cloud.google.com/apis/credentials"
}

// SupportsCodePaste is false: Google withdrew the out-of-band redirect
// (`urn:ietf:wg:oauth:2.0:oob`) in 2022, so Drive needs a real registered
// https redirect URI and has no paste-a-code alternative.
func (g *GoogleDrive) SupportsCodePaste() bool { return false }

// AuthorizeURL requests offline access with a forced consent prompt: Google
// returns a refresh token only on the *first* consent for a given client, and
// a re-connect after a disconnect would otherwise come back without one,
// leaving a schedule that dies in an hour.
func (g *GoogleDrive) AuthorizeURL(redirectURI, state, codeChallenge string) string {
	q := url.Values{
		"client_id":              {g.Creds.ClientID},
		"response_type":          {"code"},
		"redirect_uri":           {redirectURI},
		"state":                  {state},
		"scope":                  {googleScopes},
		"access_type":            {"offline"},
		"prompt":                 {"consent"},
		"include_granted_scopes": {"true"},
		"code_challenge":         {codeChallenge},
		"code_challenge_method":  {"S256"},
	}
	return g.AuthBase + "/o/oauth2/v2/auth?" + q.Encode()
}

func (g *GoogleDrive) Exchange(ctx context.Context, code, verifier, redirectURI string) (Token, Account, error) {
	if !g.Configured() {
		return Token{}, Account{}, ErrNotConfigured
	}
	form := url.Values{
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {redirectURI},
		"client_id":     {g.Creds.ClientID},
		"code_verifier": {verifier},
	}
	if g.Creds.ClientSecret != "" {
		form.Set("client_secret", g.Creds.ClientSecret)
	}
	var body tokenResponse
	if err := g.postForm(ctx, g.TokenBase+"/token", form, "Google token exchange", &body); err != nil {
		return Token{}, Account{}, err
	}
	token := body.toToken(g.now(), "")
	account, err := g.account(ctx, token.AccessToken)
	if err != nil {
		account = Account{Label: "Google Drive"}
	}
	return token, account, nil
}

func (g *GoogleDrive) Refresh(ctx context.Context, refreshToken string) (Token, error) {
	if !g.Configured() {
		return Token{}, ErrNotConfigured
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {g.Creds.ClientID},
	}
	if g.Creds.ClientSecret != "" {
		form.Set("client_secret", g.Creds.ClientSecret)
	}
	var body tokenResponse
	if err := g.postForm(ctx, g.TokenBase+"/token", form, "Google token refresh", &body); err != nil {
		return Token{}, err
	}
	return body.toToken(g.now(), refreshToken), nil
}

func (g *GoogleDrive) account(ctx context.Context, accessToken string) (Account, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		g.APIBase+"/drive/v3/about?fields=user", nil)
	if err != nil {
		return Account{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	res, err := g.client.Do(req)
	if err != nil {
		return Account{}, err
	}
	var body struct {
		User struct {
			DisplayName  string `json:"displayName"`
			EmailAddress string `json:"emailAddress"`
		} `json:"user"`
	}
	if err := decodeJSON(res, "Google account lookup", &body); err != nil {
		return Account{}, err
	}
	label := body.User.EmailAddress
	if label == "" {
		label = body.User.DisplayName
	}
	if label == "" {
		label = "Google Drive"
	}
	return Account{Label: label}, nil
}

// ListFolders lists the folders directly inside folderID (empty = My Drive).
// Trashed items are excluded — offering to back up into the bin would be a
// quiet way to lose every backup.
func (g *GoogleDrive) ListFolders(ctx context.Context, accessToken, folderID string) ([]Folder, error) {
	parent := strings.TrimSpace(folderID)
	if parent == "" {
		parent = googleRootFolder
	}
	q := url.Values{
		"q": {fmt.Sprintf(
			"'%s' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
			strings.ReplaceAll(parent, "'", `\'`))},
		"fields":   {"files(id,name)"},
		"orderBy":  {"name"},
		"pageSize": {"200"},
		// Personal accounts don't need these, shared drives do; harmless
		// either way and it keeps a Workspace user's folders visible.
		"supportsAllDrives":         {"true"},
		"includeItemsFromAllDrives": {"true"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		g.APIBase+"/drive/v3/files?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	res, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	var body struct {
		Files []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"files"`
	}
	if err := decodeJSON(res, "Google Drive folder listing", &body); err != nil {
		return nil, err
	}
	folders := []Folder{}
	for _, f := range body.Files {
		folders = append(folders, Folder{ID: f.ID, Name: f.Name, Path: f.Name})
	}
	return folders, nil
}

// Upload creates the bundle as a new Drive file via a multipart/related
// request: the metadata part names it and places it in the folder, the media
// part carries the zip.
func (g *GoogleDrive) Upload(ctx context.Context, accessToken, folderID, name string, data []byte) error {
	parent := strings.TrimSpace(folderID)
	if parent == "" {
		parent = googleRootFolder
	}
	metadata, err := json.Marshal(map[string]any{
		"name":    name,
		"parents": []string{parent},
	})
	if err != nil {
		return err
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	meta, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Type": {"application/json; charset=UTF-8"},
	})
	if err != nil {
		return err
	}
	if _, err := meta.Write(metadata); err != nil {
		return err
	}
	media, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Type": {"application/zip"},
	})
	if err != nil {
		return err
	}
	if _, err := media.Write(data); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		g.UploadBase+"/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
		bytes.NewReader(buf.Bytes()))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	// Drive wants `multipart/related`, which mime/multipart doesn't write on
	// its own — only the boundary comes from the writer.
	req.Header.Set("Content-Type", "multipart/related; boundary="+mw.Boundary())
	res, err := g.client.Do(req)
	if err != nil {
		return err
	}
	return decodeJSON(res, "Google Drive upload", nil)
}

func (g *GoogleDrive) postForm(ctx context.Context, endpoint string, form url.Values, what string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint,
		strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := g.client.Do(req)
	if err != nil {
		return err
	}
	if err := decodeJSON(res, what, out); err != nil {
		return err
	}
	if body, ok := out.(*tokenResponse); ok && body.AccessToken == "" {
		return fmt.Errorf("%s returned no access token", what)
	}
	return nil
}
