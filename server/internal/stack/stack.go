// Package stack is the composition root shared by every process that serves
// the CountRoster API: open storage → migrate → core → backup → cloud → the
// /api handler. The server binary and the mobile engine both build exactly
// this, so a phone's local database is the same file a server keeps.
package stack

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/chinmay28/countroster/server/internal/api"
	"github.com/chinmay28/countroster/server/internal/backup"
	"github.com/chinmay28/countroster/server/internal/cloud"
	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/migrate"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// Options configures Open. Only DBPath is required.
type Options struct {
	// DBPath is the SQLite file, or ":memory:". A relative path is resolved
	// against the working directory and its parent directory is created.
	DBPath string
	// Dropbox and Google are the deployment's fallback OAuth clients for
	// cloud backup (the Data page's settings row wins over them).
	Dropbox, Google cloud.Credentials
	// PublicURL is the origin used to build the OAuth redirect URI; empty
	// means "the request's own origin".
	PublicURL string
}

// Stack is an opened, migrated database and everything wired over it.
type Stack struct {
	DB            *storage.DB
	DBPath        string // absolute, or ":memory:"
	SchemaVersion int
	App           *core.App
	Backup        *backup.Service
	Cloud         *cloud.Service
	// API is the /api handler (plus the per-tracker manifests).
	API http.Handler
}

// Open builds a Stack. It does not start the cloud scheduler — whether one
// runs is the caller's decision (a synced phone leaves that to its server).
func Open(opts Options) (*Stack, error) {
	// ':memory:' is a SQLite sentinel, not a path — don't resolve it to a file.
	dbPath := opts.DBPath
	if dbPath != ":memory:" {
		abs, err := filepath.Abs(dbPath)
		if err != nil {
			return nil, err
		}
		dbPath = abs
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return nil, err
		}
	}

	db, err := storage.Open(dbPath)
	if err != nil {
		return nil, err
	}
	schemaVersion, err := migrate.Run(db)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("migrations: %w", err)
	}

	app := core.New(db, timeutil.SystemClock)
	backupSvc := &backup.Service{St: db, Clock: timeutil.SystemClock}
	cloudSvc := cloud.NewService(db, timeutil.SystemClock, backupSvc,
		cloud.NewRegistry(opts.Dropbox, opts.Google, nil, time.Now),
		api.AppVersion, opts.PublicURL)

	return &Stack{
		DB:            db,
		DBPath:        dbPath,
		SchemaVersion: schemaVersion,
		App:           app,
		Backup:        backupSvc,
		Cloud:         cloudSvc,
		API: api.New(app, backupSvc, api.FileSource{
			Path:       db.Path,
			Checkpoint: db.Checkpoint,
		}, cloudSvc),
	}, nil
}

// Close releases the database.
func (s *Stack) Close() error { return s.DB.Close() }
