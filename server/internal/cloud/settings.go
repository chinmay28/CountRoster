package cloud

import (
	"time"

	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// settingsID is the primary key of the one configuration row (migration 009
// seeds it, and a CHECK constraint keeps it the only one).
const settingsID = "singleton"

// Frequencies the schedule accepts. "off" is a real, storable value — it's
// what a connected-but-paused account looks like, and it's the default.
const (
	FrequencyOff     = "off"
	FrequencyHourly  = "hourly"
	FrequencyDaily   = "daily"
	FrequencyWeekly  = "weekly"
	FrequencyMonthly = "monthly"
)

// Outcome of the most recent run.
const (
	StatusOK    = "ok"
	StatusError = "error"
)

// Settings is the cloud_backup_settings row. Pointer fields are the columns
// that are genuinely nullable — "no account connected", "never run".
type Settings struct {
	Provider       *string
	AccountLabel   *string
	AccessToken    *string
	RefreshToken   *string
	TokenExpiresAt *string
	FolderID       *string
	FolderPath     *string
	Frequency      string
	NextRunAt      *string
	LastRunAt      *string
	LastStatus     *string
	LastError      *string
	LastFileName   *string
	UpdatedAt      *string
}

// Connected reports whether an account is linked and usable.
func (s *Settings) Connected() bool {
	return s != nil && s.Provider != nil && *s.Provider != "" &&
		s.AccessToken != nil && *s.AccessToken != ""
}

// Scheduled reports whether the scheduler should be running this config: an
// account, a destination folder, and a frequency other than "off".
func (s *Settings) Scheduled() bool {
	return s.Connected() && s.Frequency != FrequencyOff &&
		s.FolderID != nil
}

// PublicSettings is the wire shape. It follows the API's existing
// conventions — snake_case names, 0|1 integer flags, explicit nulls — and
// deliberately omits every token: the browser never needs one, and the
// settings screen is reachable by anyone on the network the server trusts.
type PublicSettings struct {
	Provider     *string `json:"provider"`
	AccountLabel *string `json:"account_label"`
	Connected    int     `json:"connected"`
	FolderID     *string `json:"folder_id"`
	FolderPath   *string `json:"folder_path"`
	Frequency    string  `json:"frequency"`
	NextRunAt    *string `json:"next_run_at"`
	LastRunAt    *string `json:"last_run_at"`
	LastStatus   *string `json:"last_status"`
	LastError    *string `json:"last_error"`
	LastFileName *string `json:"last_file_name"`
}

// Public projects the row onto the wire shape.
func (s *Settings) Public() PublicSettings {
	connected := 0
	if s.Connected() {
		connected = 1
	}
	return PublicSettings{
		Provider:     s.Provider,
		AccountLabel: s.AccountLabel,
		Connected:    connected,
		FolderID:     s.FolderID,
		FolderPath:   s.FolderPath,
		Frequency:    s.Frequency,
		NextRunAt:    s.NextRunAt,
		LastRunAt:    s.LastRunAt,
		LastStatus:   s.LastStatus,
		LastError:    s.LastError,
		LastFileName: s.LastFileName,
	}
}

// PublicProvider describes one destination the UI can offer, and everything
// the setup form needs. `configured` is 0 when no OAuth client has been
// registered for it — the button is shown either way, because "Dropbox needs
// setup" is more useful than a screen with nothing on it.
//
// `client_id` is echoed back deliberately: it is not a secret (it travels in
// the authorize URL the browser opens), and showing it is how a user checks
// that what they pasted is what got stored. The secret only ever reports
// whether one is present.
type PublicProvider struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Configured int    `json:"configured"`
	ClientID   string `json:"client_id"`
	HasSecret  int    `json:"has_secret"`
	// SecretRequired is 1 for providers that reject a PKCE-only client.
	SecretRequired int `json:"secret_required"`
	// Source is "settings", "server", or "" — see the Source* constants.
	Source string `json:"source"`
	// SetupURL is the provider's developer console, linked from the form.
	SetupURL string `json:"setup_url"`
}

// loadSettings reads the singleton row. The migration seeds it, but a
// database restored from an older bundle could conceivably arrive without
// one, so an absent row reads as the defaults rather than an error.
func loadSettings(st storage.Storage) (*Settings, error) {
	rows, err := st.Query(`SELECT * FROM cloud_backup_settings WHERE id = ?`, settingsID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return &Settings{Frequency: FrequencyOff}, nil
	}
	return settingsFromRow(rows[0]), nil
}

func settingsFromRow(r storage.Row) *Settings {
	freq := asString(r.Get("frequency"))
	if freq == "" {
		freq = FrequencyOff
	}
	return &Settings{
		Provider:       asNullString(r.Get("provider")),
		AccountLabel:   asNullString(r.Get("account_label")),
		AccessToken:    asNullString(r.Get("access_token")),
		RefreshToken:   asNullString(r.Get("refresh_token")),
		TokenExpiresAt: asNullString(r.Get("token_expires_at")),
		FolderID:       asNullString(r.Get("folder_id")),
		FolderPath:     asNullString(r.Get("folder_path")),
		Frequency:      freq,
		NextRunAt:      asNullString(r.Get("next_run_at")),
		LastRunAt:      asNullString(r.Get("last_run_at")),
		LastStatus:     asNullString(r.Get("last_status")),
		LastError:      asNullString(r.Get("last_error")),
		LastFileName:   asNullString(r.Get("last_file_name")),
		UpdatedAt:      asNullString(r.Get("updated_at")),
	}
}

// saveSettings writes the whole row back. An UPSERT rather than an UPDATE so
// a database missing the seeded row heals itself on the first write.
func saveSettings(st storage.Storage, s *Settings, nowISO string) error {
	return st.Exec(
		`INSERT INTO cloud_backup_settings (
       id, provider, account_label, access_token, refresh_token,
       token_expires_at, folder_id, folder_path, frequency, next_run_at,
       last_run_at, last_status, last_error, last_file_name, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider         = excluded.provider,
       account_label    = excluded.account_label,
       access_token     = excluded.access_token,
       refresh_token    = excluded.refresh_token,
       token_expires_at = excluded.token_expires_at,
       folder_id        = excluded.folder_id,
       folder_path      = excluded.folder_path,
       frequency        = excluded.frequency,
       next_run_at      = excluded.next_run_at,
       last_run_at      = excluded.last_run_at,
       last_status      = excluded.last_status,
       last_error       = excluded.last_error,
       last_file_name   = excluded.last_file_name,
       updated_at       = excluded.updated_at`,
		settingsID, nullable(s.Provider), nullable(s.AccountLabel),
		nullable(s.AccessToken), nullable(s.RefreshToken), nullable(s.TokenExpiresAt),
		nullable(s.FolderID), nullable(s.FolderPath), s.Frequency,
		nullable(s.NextRunAt), nullable(s.LastRunAt), nullable(s.LastStatus),
		nullable(s.LastError), nullable(s.LastFileName), nowISO)
}

// --- scheduling math ----------------------------------------------------------

var frequencies = map[string]bool{
	FrequencyOff:     true,
	FrequencyHourly:  true,
	FrequencyDaily:   true,
	FrequencyWeekly:  true,
	FrequencyMonthly: true,
}

// validateFrequency mirrors the domain's parser style: a bad value is a
// ValidationError, which api.handleErr already turns into a 400.
func validateFrequency(v string) error {
	if frequencies[v] {
		return nil
	}
	return &core.ValidationError{Issues: []core.Issue{{
		Code:    "invalid_enum_value",
		Path:    []any{"frequency"},
		Message: `Invalid frequency "` + v + `"; expected off, hourly, daily, weekly, or monthly`,
	}}}
}

// nextRun is when a backup on this frequency should follow one taken at
// `from`. Intervals run from the last attempt rather than snapping to a wall
// clock boundary: the point is "a backup at least this often", and an
// interval schedule survives a server that was asleep at midnight.
//
// Months are added calendar-wise (AddDate), so a monthly schedule keeps its
// day-of-month instead of drifting by two or three days a year.
func nextRun(from time.Time, frequency string) (time.Time, bool) {
	switch frequency {
	case FrequencyHourly:
		return from.Add(time.Hour), true
	case FrequencyDaily:
		return from.AddDate(0, 0, 1), true
	case FrequencyWeekly:
		return from.AddDate(0, 0, 7), true
	case FrequencyMonthly:
		return from.AddDate(0, 1, 0), true
	}
	return time.Time{}, false
}

// nextRunISO is nextRun in the stored representation: local-offset ISO 8601,
// like every other timestamp in the database, or nil when the schedule is off.
func nextRunISO(from time.Time, frequency string) *string {
	at, ok := nextRun(from, frequency)
	if !ok {
		return nil
	}
	iso := timeutil.ToLocalISO(at)
	return &iso
}

// due reports whether a run is owed at `now`. A schedule with no next_run_at
// — freshly connected, or a row that predates the column being set — is owed
// one immediately, which is also the friendliest first impression.
func (s *Settings) due(now time.Time) bool {
	if !s.Scheduled() {
		return false
	}
	if s.NextRunAt == nil {
		return true
	}
	at, ok := timeutil.ParseInstant(*s.NextRunAt)
	if !ok {
		return true
	}
	return !at.After(now)
}

// --- small helpers ------------------------------------------------------------

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asNullString(v any) *string {
	if v == nil {
		return nil
	}
	s := asString(v)
	return &s
}

// nullable unwraps a *string for binding: a nil pointer must bind as SQL NULL
// rather than as a typed nil the driver would reject.
func nullable(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func ptr(s string) *string { return &s }
