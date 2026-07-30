package cloud

import (
	"strings"
	"unicode"

	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/storage"
)

// Where a provider's active credentials came from. The UI shows this so a
// user can tell an entry they can edit from one the operator pinned at
// startup.
const (
	// SourceSettings — entered on the Data page, stored in the database.
	SourceSettings = "settings"
	// SourceServer — a --dropbox-client-id / --google-client-id flag (or its
	// env var), which the settings row overrides.
	SourceServer = "server"
)

// maxCredentialLen bounds what the setup form will store. Real client ids and
// secrets are well under this; the limit is here so a paste accident can't put
// a megabyte in the row.
const maxCredentialLen = 512

// loadCredentials reads every stored OAuth client, keyed by provider id.
func loadCredentials(st storage.Storage) (map[string]Credentials, error) {
	rows, err := st.Query(
		`SELECT provider, client_id, client_secret FROM cloud_provider_credentials`)
	if err != nil {
		return nil, err
	}
	out := make(map[string]Credentials, len(rows))
	for _, r := range rows {
		out[asString(r.Get("provider"))] = Credentials{
			ClientID:     asString(r.Get("client_id")),
			ClientSecret: asString(r.Get("client_secret")),
		}
	}
	return out, nil
}

// saveCredentials upserts one provider's OAuth client.
func saveCredentials(st storage.Storage, provider string, creds Credentials, nowISO string) error {
	var secret any
	if creds.ClientSecret != "" {
		secret = creds.ClientSecret
	}
	return st.Exec(
		`INSERT INTO cloud_provider_credentials (provider, client_id, client_secret, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       client_id     = excluded.client_id,
       client_secret = excluded.client_secret,
       updated_at    = excluded.updated_at`,
		provider, creds.ClientID, secret, nowISO)
}

func deleteCredentials(st storage.Storage, provider string) error {
	return st.Exec(`DELETE FROM cloud_provider_credentials WHERE provider = ?`, provider)
}

// validateCredentials checks what a user pasted into the setup form. It is
// deliberately forgiving about *shape* — client ids differ wildly between
// providers and are not ours to second-guess — and strict only about the
// things that would produce a broken authorize URL: emptiness, embedded
// whitespace (the classic "copied the surrounding line too" mistake), and
// control characters.
func validateCredentials(provider Provider, clientID, clientSecret string) (Credentials, error) {
	v := &credentialIssues{}
	clientID = strings.TrimSpace(clientID)
	clientSecret = strings.TrimSpace(clientSecret)

	switch {
	case clientID == "":
		v.add("client_id", "A client id is required.")
	case len(clientID) > maxCredentialLen:
		v.add("client_id", "That client id is implausibly long — check what was pasted.")
	case hasSpaceOrControl(clientID):
		v.add("client_id", "The client id contains a space or line break; paste just the id itself.")
	}

	if len(clientSecret) > maxCredentialLen {
		v.add("client_secret", "That client secret is implausibly long — check what was pasted.")
	} else if clientSecret != "" && hasSpaceOrControl(clientSecret) {
		v.add("client_secret", "The client secret contains a space or line break; paste just the secret itself.")
	}
	// Catching this here turns a confusing failure at the provider's token
	// endpoint — after the user has already been through a consent screen —
	// into a message on the form they're already looking at.
	if clientSecret == "" && provider.RequiresSecret() {
		v.add("client_secret", provider.Name()+" requires a client secret as well as a client id.")
	}

	if err := v.err(); err != nil {
		return Credentials{}, err
	}
	return Credentials{ClientID: clientID, ClientSecret: clientSecret}, nil
}

// hasSpaceOrControl reports whether s carries anything that can't legitimately
// be part of a pasted credential.
func hasSpaceOrControl(s string) bool {
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// credentialIssues accumulates validation failures in the domain's shape, so
// api.handleErr renders them as the same 400 body every other invalid input
// produces.
type credentialIssues struct{ issues []core.Issue }

func (c *credentialIssues) add(field, message string) {
	c.issues = append(c.issues, core.Issue{
		Code: "invalid_string", Path: []any{field}, Message: message,
	})
}

func (c *credentialIssues) err() error {
	if len(c.issues) == 0 {
		return nil
	}
	return &core.ValidationError{Issues: c.issues}
}
