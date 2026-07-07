// Package timeutil carries the Clock the domain layer stamps rows with.
//
// The domain never calls time.Now() directly — it goes through a Clock, which
// tests substitute with a fixed instant. Persisted timestamps are ISO 8601
// with the *local* offset (not UTC "Z"): the offset is what lets period
// bucketing later answer "what day was this in the user's local time".
package timeutil

import "time"

// Clock yields the current instant as an ISO 8601 string with a timezone
// offset.
type Clock interface {
	NowISO() string
}

type systemClock struct{}

func (systemClock) NowISO() string { return ToLocalISO(time.Now()) }

// SystemClock is the production clock: wall time in the host's local zone.
var SystemClock Clock = systemClock{}

// FixedClock returns a clock pinned at the given ISO instant — for tests.
type FixedClock struct{ ISO string }

func (c *FixedClock) NowISO() string { return c.ISO }

// ToLocalISO formats t in its own location as ISO 8601 with millisecond
// precision and a numeric offset, e.g. "2026-05-25T14:32:00.123-07:00" —
// byte-identical to the TypeScript core's toLocalISO.
func ToLocalISO(t time.Time) string {
	return t.Format("2006-01-02T15:04:05.000-07:00")
}

// instantLayouts covers the ISO 8601 shapes the API accepts for range bounds
// and occurred_at values: with/without fractional seconds, "Z" or ±hh:mm.
var instantLayouts = []string{
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05Z07:00",
}

// ParseInstant parses an ISO 8601 timestamp the way JavaScript's Date
// constructor does for the forms this app exchanges: full timestamps with an
// offset or "Z", and bare "YYYY-MM-DD" dates (which JS reads as UTC midnight).
func ParseInstant(s string) (time.Time, bool) {
	for _, layout := range instantLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t, true
	}
	// JS also accepts a timestamp with no offset, read as *local* time.
	if t, err := time.ParseInLocation("2006-01-02T15:04:05.999999999", s, time.Local); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// ToUTCISO formats t like JavaScript's Date.prototype.toISOString():
// millisecond precision, always UTC with a "Z" suffix.
func ToUTCISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
