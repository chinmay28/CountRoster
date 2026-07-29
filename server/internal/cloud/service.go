package cloud

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chinmay28/countroster/server/internal/backup"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// CallbackPath is where a provider sends the browser back after consent. It
// is part of the deployment contract, not just an internal route: the
// operator registers `<public origin>` + this path as the app's redirect URI.
const CallbackPath = "/api/cloud/backup/callback"

// refreshSkew renews an access token this far before it actually expires, so
// a long upload can't start on a token that dies mid-request.
const refreshSkew = 2 * time.Minute

// ConfigError is a request that can't proceed because cloud backup isn't set
// up: no account connected, no folder chosen, a provider the operator never
// registered. It maps to HTTP 400 — the caller can fix it.
type ConfigError struct{ Message string }

func (e *ConfigError) Error() string { return e.Message }

// ProviderError wraps a failure that came from Dropbox or Google rather than
// from us — a rejected token, a deleted folder, a network timeout. It maps to
// HTTP 502 so the UI can say honestly whose problem it is.
type ProviderError struct {
	Provider string
	Err      error
}

func (e *ProviderError) Error() string {
	return fmt.Sprintf("%s: %v", e.Provider, e.Err)
}

func (e *ProviderError) Unwrap() error { return e.Err }

// Service is the provider-agnostic half of cloud backup: it owns the settings
// row, keeps the access token fresh, and turns "a run is due" into an
// exported bundle sitting in someone's Dropbox.
type Service struct {
	St         storage.Storage
	Clock      timeutil.Clock
	Backup     *backup.Service
	Registry   Registry
	AppVersion string
	// PublicURL, when set, is the origin the OAuth redirect URI is built
	// from. Left empty, the request's own scheme and host are used — right
	// for a LAN or Tailscale address reached directly, wrong behind a proxy
	// that rewrites neither.
	PublicURL string

	pending *pendingStore
}

// NewService wires a service and its in-flight-authorization store.
func NewService(st storage.Storage, clock timeutil.Clock, bk *backup.Service,
	reg Registry, appVersion, publicURL string) *Service {
	s := &Service{
		St: st, Clock: clock, Backup: bk, Registry: reg,
		AppVersion: appVersion, PublicURL: strings.TrimRight(publicURL, "/"),
	}
	s.pending = newPendingStore(s.Now)
	return s
}

// Now is the service's clock as a time.Time. Everything schedule-related goes
// through it so a test can pin the instant, exactly as the domain services do.
func (s *Service) Now() time.Time {
	if t, ok := timeutil.ParseInstant(s.Clock.NowISO()); ok {
		return t
	}
	return time.Now()
}

// Settings reads the current configuration.
func (s *Service) Settings() (*Settings, error) { return loadSettings(s.St) }

// PublicProviders lists the destinations this build offers, with whether the
// operator has registered an OAuth client for each.
func (s *Service) PublicProviders() []PublicProvider {
	out := make([]PublicProvider, 0, len(s.Registry))
	for _, p := range s.Registry {
		configured := 0
		if p.Configured() {
			configured = 1
		}
		out = append(out, PublicProvider{ID: p.ID(), Name: p.Name(), Configured: configured})
	}
	return out
}

// Update applies a settings patch: the schedule and the destination folder,
// the only two things the browser owns. Anything absent is left alone.
//
// Changing the frequency re-bases the schedule from now, so picking "daily"
// means "a day from now", not "some leftover deadline from the hourly setting
// you just changed".
func (s *Service) Update(frequency *string, folderID, folderPath *string) (*Settings, error) {
	current, err := s.Settings()
	if err != nil {
		return nil, err
	}
	now := s.Now()

	if frequency != nil {
		if err := validateFrequency(*frequency); err != nil {
			return nil, err
		}
		if *frequency != FrequencyOff && !current.Connected() {
			return nil, &ConfigError{Message: "Connect a cloud account before scheduling backups."}
		}
		current.Frequency = *frequency
		current.NextRunAt = nextRunISO(now, *frequency)
	}
	if folderID != nil {
		current.FolderID = folderID
		current.FolderPath = folderPath
		// A folder chosen after the schedule was set shouldn't have to wait
		// out a deadline that was pinned before there was anywhere to write.
		if current.Frequency != FrequencyOff && current.NextRunAt == nil {
			current.NextRunAt = nextRunISO(now, current.Frequency)
		}
	}
	if err := saveSettings(s.St, current, s.Clock.NowISO()); err != nil {
		return nil, err
	}
	return s.Settings()
}

// StartConnect begins an OAuth authorization and returns the URL the browser
// should visit. The PKCE verifier and the exact redirect URI are remembered
// against the returned `state` — the token exchange has to repeat both.
func (s *Service) StartConnect(providerID, requestOrigin string) (string, error) {
	provider := s.Registry.Get(providerID)
	if provider == nil {
		return "", &ConfigError{Message: `Unknown cloud provider "` + providerID + `"`}
	}
	if !provider.Configured() {
		return "", &ConfigError{Message: provider.Name() +
			" is not set up on this server: the operator needs to register an OAuth app and start the server with its client id."}
	}
	state, err := randomURLSafe(24)
	if err != nil {
		return "", err
	}
	// RFC 7636 wants 43–128 characters; 48 random bytes lands at 64.
	verifier, err := randomURLSafe(48)
	if err != nil {
		return "", err
	}
	redirectURI := s.redirectURI(requestOrigin)
	s.pending.put(state, pending{
		provider:    provider.ID(),
		verifier:    verifier,
		redirectURI: redirectURI,
	})
	return provider.AuthorizeURL(redirectURI, state, codeChallenge(verifier)), nil
}

// redirectURI is where the provider sends the browser back. An explicitly
// configured public URL wins; otherwise the origin the request arrived on is
// the best guess available.
func (s *Service) redirectURI(requestOrigin string) string {
	origin := s.PublicURL
	if origin == "" {
		origin = strings.TrimRight(requestOrigin, "/")
	}
	return origin + CallbackPath
}

// CompleteConnect finishes the authorization: trade the code for a token,
// remember whose account it is, and leave the schedule off until the user
// picks a folder.
func (s *Service) CompleteConnect(ctx context.Context, state, code string) (*Settings, error) {
	p, ok := s.pending.take(state)
	if !ok {
		return nil, &ConfigError{Message: ErrUnknownState.Error()}
	}
	provider := s.Registry.Get(p.provider)
	if provider == nil {
		return nil, &ConfigError{Message: `Unknown cloud provider "` + p.provider + `"`}
	}
	token, account, err := provider.Exchange(ctx, code, p.verifier, p.redirectURI)
	if err != nil {
		return nil, &ProviderError{Provider: provider.Name(), Err: err}
	}

	current, err := s.Settings()
	if err != nil {
		return nil, err
	}
	// A fresh connection starts clean: a folder from a previous account is
	// meaningless, and so is that account's run history.
	next := &Settings{
		Provider:     ptr(provider.ID()),
		AccountLabel: ptr(account.Label),
		AccessToken:  ptr(token.AccessToken),
		Frequency:    FrequencyOff,
	}
	if token.RefreshToken != "" {
		next.RefreshToken = ptr(token.RefreshToken)
	}
	if !token.ExpiresAt.IsZero() {
		next.TokenExpiresAt = ptr(timeutil.ToLocalISO(token.ExpiresAt))
	}
	// Reconnecting the same account keeps its folder and schedule — that's a
	// token refresh in the user's eyes, not a reset.
	if current.Provider != nil && *current.Provider == provider.ID() &&
		current.AccountLabel != nil && *current.AccountLabel == account.Label {
		next.FolderID = current.FolderID
		next.FolderPath = current.FolderPath
		next.Frequency = current.Frequency
		next.NextRunAt = current.NextRunAt
		next.LastRunAt = current.LastRunAt
		next.LastStatus = current.LastStatus
		next.LastError = current.LastError
		next.LastFileName = current.LastFileName
	}
	if err := saveSettings(s.St, next, s.Clock.NowISO()); err != nil {
		return nil, err
	}
	return s.Settings()
}

// Disconnect forgets the account. The tokens are dropped rather than kept
// "in case" — a disconnect the user asked for should leave nothing behind
// that could still write to their Drive.
func (s *Service) Disconnect() (*Settings, error) {
	cleared := &Settings{Frequency: FrequencyOff}
	if err := saveSettings(s.St, cleared, s.Clock.NowISO()); err != nil {
		return nil, err
	}
	return s.Settings()
}

// ListFolders browses the connected account for the folder picker. An empty
// folderID lists the account root.
func (s *Service) ListFolders(ctx context.Context, folderID string) ([]Folder, error) {
	provider, token, err := s.authorize(ctx)
	if err != nil {
		return nil, err
	}
	folders, err := provider.ListFolders(ctx, token, folderID)
	if err != nil {
		return nil, &ProviderError{Provider: provider.Name(), Err: err}
	}
	return folders, nil
}

// authorize resolves the connected provider and a usable access token,
// refreshing first when the stored one is at or near expiry.
func (s *Service) authorize(ctx context.Context) (Provider, string, error) {
	set, err := s.Settings()
	if err != nil {
		return nil, "", err
	}
	if !set.Connected() {
		return nil, "", &ConfigError{Message: "No cloud account is connected."}
	}
	provider := s.Registry.Get(*set.Provider)
	if provider == nil {
		return nil, "", &ConfigError{Message: `This server has no "` + *set.Provider + `" provider.`}
	}
	if !provider.Configured() {
		return nil, "", &ConfigError{Message: provider.Name() +
			" is no longer set up on this server: its client id is missing, so the stored connection can't be used."}
	}

	if !s.tokenExpiring(set) {
		return provider, *set.AccessToken, nil
	}
	if set.RefreshToken == nil || *set.RefreshToken == "" {
		return nil, "", &ConfigError{Message: provider.Name() +
			" access has expired and there is no refresh token — reconnect the account."}
	}
	token, err := provider.Refresh(ctx, *set.RefreshToken)
	if err != nil {
		return nil, "", &ProviderError{Provider: provider.Name(), Err: err}
	}
	if err := s.saveToken(token); err != nil {
		return nil, "", err
	}
	return provider, token.AccessToken, nil
}

// tokenExpiring reports whether the stored access token is inside the refresh
// window. A token with no recorded expiry is used until the provider rejects
// it — that's the contract for the providers that don't tell us.
func (s *Service) tokenExpiring(set *Settings) bool {
	if set.TokenExpiresAt == nil || *set.TokenExpiresAt == "" {
		return false
	}
	at, ok := timeutil.ParseInstant(*set.TokenExpiresAt)
	if !ok {
		return true
	}
	return !at.After(s.Now().Add(refreshSkew))
}

// saveToken writes just the credential columns, leaving the schedule and the
// run history to whoever owns them.
func (s *Service) saveToken(token Token) error {
	var expires any
	if !token.ExpiresAt.IsZero() {
		expires = timeutil.ToLocalISO(token.ExpiresAt)
	}
	var refresh any
	if token.RefreshToken != "" {
		refresh = token.RefreshToken
	}
	return s.St.Exec(
		`UPDATE cloud_backup_settings
        SET access_token     = ?,
            token_expires_at = ?,
            refresh_token    = COALESCE(?, refresh_token),
            updated_at       = ?
      WHERE id = ?`,
		token.AccessToken, expires, refresh, s.Clock.NowISO(), settingsID)
}

// RunResult reports one backup attempt.
type RunResult struct {
	FileName string
	Bytes    int
}

// Run exports a bundle and uploads it to the chosen folder, then records the
// outcome — success or failure — on the settings row and re-bases the
// schedule. The error is both stored and returned: the scheduler logs it, a
// manual "back up now" surfaces it to the user.
func (s *Service) Run(ctx context.Context) (*RunResult, error) {
	set, err := s.Settings()
	if err != nil {
		return nil, err
	}
	if !set.Connected() {
		return nil, &ConfigError{Message: "No cloud account is connected."}
	}
	if set.FolderID == nil {
		return nil, &ConfigError{Message: "Choose a folder in the connected account first."}
	}

	name := s.fileName()
	result, runErr := s.upload(ctx, *set.FolderID, name)
	if err := s.recordRun(name, runErr); err != nil {
		return nil, err
	}
	if runErr != nil {
		return nil, runErr
	}
	return result, nil
}

func (s *Service) upload(ctx context.Context, folderID, name string) (*RunResult, error) {
	provider, token, err := s.authorize(ctx)
	if err != nil {
		return nil, err
	}
	data, err := s.Backup.ExportBundle(s.AppVersion)
	if err != nil {
		return nil, err
	}
	if err := provider.Upload(ctx, token, folderID, name, data); err != nil {
		return nil, &ProviderError{Provider: provider.Name(), Err: err}
	}
	return &RunResult{FileName: name, Bytes: len(data)}, nil
}

// recordRun stamps the outcome and schedules the next attempt. A failure is
// rescheduled on the same interval rather than retried tightly: the usual
// causes (revoked access, a deleted folder) need a human, and hammering the
// provider wouldn't help.
func (s *Service) recordRun(name string, runErr error) error {
	set, err := s.Settings()
	if err != nil {
		return err
	}
	nowISO := s.Clock.NowISO()
	set.LastRunAt = ptr(nowISO)
	if runErr != nil {
		set.LastStatus = ptr(StatusError)
		set.LastError = ptr(runErr.Error())
	} else {
		set.LastStatus = ptr(StatusOK)
		set.LastError = nil
		set.LastFileName = ptr(name)
	}
	set.NextRunAt = nextRunISO(s.Now(), set.Frequency)
	return saveSettings(s.St, set, nowISO)
}

// RunIfDue runs a scheduled backup when one is owed. It reports whether it
// ran, so the caller can log at the right volume.
func (s *Service) RunIfDue(ctx context.Context) (bool, error) {
	set, err := s.Settings()
	if err != nil {
		return false, err
	}
	if !set.due(s.Now()) {
		return false, nil
	}
	if _, err := s.Run(ctx); err != nil {
		return true, err
	}
	return true, nil
}

// fileName stamps the bundle with the local minute it was taken, so a folder
// of them sorts chronologically and an hourly schedule doesn't collide.
func (s *Service) fileName() string {
	stamp := s.Now().Format("2006-01-02-1504")
	return "countroster-" + stamp + ".countroster.zip"
}

// IsConfigError reports whether err is a user-fixable configuration problem.
func IsConfigError(err error) bool {
	var ce *ConfigError
	return errors.As(err, &ce)
}

// IsProviderError reports whether err came from the upstream cloud service.
func IsProviderError(err error) bool {
	var pe *ProviderError
	return errors.As(err, &pe)
}
