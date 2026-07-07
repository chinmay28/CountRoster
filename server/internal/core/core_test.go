package core

import (
	"errors"
	"testing"

	"github.com/chinmay28/countroster/server/internal/migrate"
	"github.com/chinmay28/countroster/server/internal/storage"
)

// testClock mirrors the TS makeTestApp fixed clock: pinned at an ISO instant
// tests can advance with setTime.
type testClock struct{ iso string }

func (c *testClock) NowISO() string { return c.iso }

const defaultTestTime = "2026-05-25T12:00:00.000-07:00"

type testApp struct {
	*App
	st    *storage.DB
	clock *testClock
}

func (a *testApp) setTime(iso string) { a.clock.iso = iso }

func newTestApp(t *testing.T) *testApp {
	t.Helper()
	st, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := migrate.Run(st); err != nil {
		t.Fatal(err)
	}
	clock := &testClock{iso: defaultTestTime}
	return &testApp{App: New(st, clock), st: st, clock: clock}
}

func obj(pairs ...any) map[string]any {
	m := map[string]any{}
	for i := 0; i < len(pairs); i += 2 {
		m[pairs[i].(string)] = pairs[i+1]
	}
	return m
}

func mustCreate(t *testing.T, a *testApp, spec map[string]any) *Tracker {
	t.Helper()
	tr, err := a.Trackers.Create(spec)
	if err != nil {
		t.Fatalf("create tracker: %v", err)
	}
	return tr
}

func mustLog(t *testing.T, a *testApp, trackerID string, input map[string]any) *Entry {
	t.Helper()
	e, err := a.Entries.Log(trackerID, input)
	if err != nil {
		t.Fatalf("log entry: %v", err)
	}
	return e
}

func isNotFound(err error) bool {
	var nf *NotFoundError
	return errors.As(err, &nf)
}

func isDerivedErr(err error) bool {
	var de *DerivedTrackerError
	return errors.As(err, &de)
}

func isInUseErr(err error) bool {
	var iu *TrackerInUseError
	return errors.As(err, &iu)
}

func isValidationErr(err error) bool {
	var ve *ValidationError
	return errors.As(err, &ve)
}

func entryValues(entries []*Entry) []float64 {
	out := make([]float64, len(entries))
	for i, e := range entries {
		out[i] = e.Value
	}
	return out
}

func entryIDs(entries []*Entry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.ID
	}
	return out
}

func trackerIDs(trackers []*Tracker) []string {
	out := make([]string, len(trackers))
	for i, tr := range trackers {
		out[i] = tr.ID
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalFloats(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sumValues(entries []*Entry) float64 {
	s := 0.0
	for _, e := range entries {
		s += e.Value
	}
	return s
}
