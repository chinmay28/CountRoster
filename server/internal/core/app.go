package core

import (
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// App is the composed domain layer — the Go equivalent of the TS core's
// createApp(). Build one after opening the storage adapter, then run
// migrations (migrate.Run) before serving.
type App struct {
	Trackers *TrackerService
	Entries  *EntryService
	Notes    *NoteService
	Groups   *GroupService
	Stats    *StatsService
}

// New wires every service over one Storage and Clock.
func New(st storage.Storage, clock timeutil.Clock) *App {
	if clock == nil {
		clock = timeutil.SystemClock
	}
	return &App{
		Trackers: &TrackerService{st: st, clock: clock},
		Entries:  &EntryService{st: st, clock: clock},
		Notes:    &NoteService{st: st, clock: clock},
		Groups:   &GroupService{st: st, clock: clock},
		Stats:    &StatsService{st: st, clock: clock},
	}
}
