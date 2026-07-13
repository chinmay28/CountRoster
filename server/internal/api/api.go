// Package api is the REST layer over the core services — a route-for-route,
// status-for-status port of the Express app (apps/server/src/app.ts in the
// TypeScript era). The PWA client is compiled against this exact contract:
// paths, JSON field names, status codes and error bodies must not drift.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/chinmay28/countroster/server/internal/backup"
	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/jsjson"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// AppVersion mirrors APP_VERSION in the TS server.
const AppVersion = "0.1.0"

const (
	jsonBodyLimit   = 5 << 20   // express.json({ limit: '5mb' })
	importBodyLimit = 100 << 20 // express.raw({ limit: '100mb' })
)

// FileSource is the optional capability the raw-SQLite download route needs.
type FileSource struct {
	// Path is the on-disk SQLite file (":memory:" disables the route).
	Path string
	// Checkpoint flushes pending WAL frames before the file is streamed.
	Checkpoint func() error
}

type server struct {
	app    *core.App
	backup *backup.Service
	file   FileSource
}

// New builds the /api handler. Pure wiring — no listening — so tests can
// mount it against a memory-backed core.
func New(app *core.App, bk *backup.Service, file FileSource) http.Handler {
	s := &server{app: app, backup: bk, file: file}
	mux := http.NewServeMux()

	// Trackers.
	mux.HandleFunc("GET /api/trackers", s.listTrackers)
	mux.HandleFunc("POST /api/trackers", s.createTracker)
	mux.HandleFunc("POST /api/trackers/reorder", s.reorderTrackers)
	mux.HandleFunc("GET /api/trackers/{id}", s.getTracker)
	mux.HandleFunc("PATCH /api/trackers/{id}", s.updateTracker)
	mux.HandleFunc("POST /api/trackers/{id}/archive", s.archiveTracker)
	mux.HandleFunc("POST /api/trackers/{id}/unarchive", s.unarchiveTracker)
	mux.HandleFunc("GET /api/trackers/{id}/links", s.trackerLinks)
	mux.HandleFunc("PUT /api/trackers/{id}/links", s.setTrackerLinks)
	mux.HandleFunc("DELETE /api/trackers/{id}", s.deleteTracker)

	// Entries.
	mux.HandleFunc("GET /api/trackers/{id}/entries", s.entriesForTracker)
	mux.HandleFunc("POST /api/trackers/{id}/entries", s.logEntry)
	mux.HandleFunc("POST /api/entries/batch", s.logEntryBatch)
	mux.HandleFunc("GET /api/entries/{id}", s.getEntry)
	mux.HandleFunc("PATCH /api/entries/{id}", s.updateEntry)
	mux.HandleFunc("DELETE /api/entries/{id}", s.deleteEntry)

	// Notes.
	mux.HandleFunc("GET /api/trackers/{id}/notes", s.notesForTracker)
	mux.HandleFunc("POST /api/notes", s.createNote)
	mux.HandleFunc("GET /api/notes/{id}/history", s.noteHistory)
	mux.HandleFunc("PATCH /api/notes/{id}", s.updateNote)
	mux.HandleFunc("DELETE /api/notes/{id}", s.deleteNote)

	// Groups.
	mux.HandleFunc("GET /api/groups", s.listGroups)
	mux.HandleFunc("POST /api/groups", s.createGroup)
	mux.HandleFunc("POST /api/groups/reorder", s.reorderGroups)
	mux.HandleFunc("GET /api/groups/{id}", s.getGroup)
	mux.HandleFunc("PATCH /api/groups/{id}", s.updateGroup)
	mux.HandleFunc("DELETE /api/groups/{id}", s.deleteGroup)
	mux.HandleFunc("GET /api/groups/{id}/trackers", s.groupTrackers)
	mux.HandleFunc("POST /api/groups/{id}/trackers", s.addGroupTracker)
	mux.HandleFunc("POST /api/groups/{id}/reorder", s.reorderGroupMembers)
	mux.HandleFunc("DELETE /api/groups/{id}/trackers/{trackerId}", s.removeGroupTracker)

	// Transactions (imported credit-card rows staged for review).
	mux.HandleFunc("GET /api/transactions", s.listTransactions)
	mux.HandleFunc("DELETE /api/transactions", s.clearTransactions)
	mux.HandleFunc("POST /api/transactions/import", s.importTransactions)
	mux.HandleFunc("GET /api/transactions/{id}", s.getTransaction)
	mux.HandleFunc("PATCH /api/transactions/{id}", s.updateTransaction)
	mux.HandleFunc("DELETE /api/transactions/{id}", s.deleteTransaction)
	mux.HandleFunc("POST /api/transactions/{id}/confirm", s.confirmTransaction)
	mux.HandleFunc("POST /api/transactions/{id}/unfile", s.unfileTransaction)

	// Stats.
	mux.HandleFunc("GET /api/trackers/{id}/stats/buckets", s.statsBuckets)
	mux.HandleFunc("GET /api/trackers/{id}/stats/streak", s.statsStreak)
	mux.HandleFunc("GET /api/trackers/{id}/stats/target-progress", s.statsTargetProgress)
	mux.HandleFunc("GET /api/trackers/{id}/stats/composition", s.statsComposition)

	// Backup.
	mux.HandleFunc("GET /api/backup/manifest", s.backupManifest)
	mux.HandleFunc("GET /api/backup/bundle", s.backupBundle)
	mux.HandleFunc("GET /api/backup/sqlite", s.backupSqlite)
	mux.HandleFunc("POST /api/backup/import", s.backupImport)

	mux.HandleFunc("GET /api/health", s.health)

	return mux
}

// --- plumbing ---------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		http.Error(w, `{"error":"Internal server error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(data)
}

// writeOrderedJSON emits a jsjson tree, preserving key insertion order the
// way Express's res.json did for the backup manifest / import result.
func writeOrderedJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(jsjson.Stringify(v))
}

func noContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }

func notFoundEntity(w http.ResponseWriter, what string) {
	writeJSON(w, http.StatusNotFound, map[string]string{"error": what + " not found"})
}

// decodeBody parses a JSON request body into generic values (json.Number for
// numbers). An absent/empty body decodes to nil, like express.json leaving
// req.body undefined.
func decodeBody(w http.ResponseWriter, r *http.Request) (any, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, jsonBodyLimit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request entity too large"})
			return nil, false
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return nil, false
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return nil, true
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body: " + err.Error()})
		return nil, false
	}
	return v, true
}

// handleErr maps domain errors to HTTP statuses exactly like the Express
// error middleware: ValidationError→400, *NotFoundError→404,
// DerivedTrackerError→400, TrackerInUseError→409, anything else→500.
func handleErr(w http.ResponseWriter, err error) {
	var ve *core.ValidationError
	if errors.As(err, &ve) {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":  "Validation failed",
			"issues": ve.Issues,
		})
		return
	}
	var nf *core.NotFoundError
	if errors.As(err, &nf) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": nf.Error()})
		return
	}
	var de *core.DerivedTrackerError
	if errors.As(err, &de) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": de.Error()})
		return
	}
	var iu *core.TrackerInUseError
	if errors.As(err, &iu) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": iu.Error()})
		return
	}
	log.Printf("[countroster] unhandled error: %v", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

func timeRange(r *http.Request) core.TimeRange {
	q := r.URL.Query()
	return core.TimeRange{Start: q.Get("start"), End: q.Get("end")}
}

// bodyField extracts body[key] from a decoded JSON object (nil-safe).
func bodyField(body any, key string) any {
	if m, ok := body.(map[string]any); ok {
		return m[key]
	}
	return nil
}

// stringList coerces a decoded JSON array into its string members.
func stringList(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// --- trackers ----------------------------------------------------------------

func (s *server) listTrackers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	list, err := s.app.Trackers.List(core.ListOptions{
		IncludeArchived: q.Get("includeArchived") == "1",
		IncludeHidden:   q.Get("includeHidden") == "1",
	})
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) createTracker(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	t, err := s.app.Trackers.Create(body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (s *server) reorderTrackers(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	if err := s.app.Trackers.Reorder(stringList(bodyField(body, "orderedIds"))); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

func (s *server) getTracker(w http.ResponseWriter, r *http.Request) {
	t, err := s.app.Trackers.Get(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if t == nil {
		notFoundEntity(w, "tracker")
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *server) updateTracker(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	t, err := s.app.Trackers.Update(r.PathValue("id"), body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *server) archiveTracker(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Trackers.Archive(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

func (s *server) unarchiveTracker(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Trackers.Unarchive(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

func (s *server) trackerLinks(w http.ResponseWriter, r *http.Request) {
	links, err := s.app.Trackers.Links(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if links == nil {
		links = []core.TrackerLink{}
	}
	writeJSON(w, http.StatusOK, links)
}

func (s *server) setTrackerLinks(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	linksField := bodyField(body, "links")
	if linksField == nil {
		linksField = []any{}
	}
	links, err := core.ParseLinksInput(linksField)
	if err != nil {
		handleErr(w, err)
		return
	}
	out, err := s.app.Trackers.SetLinks(r.PathValue("id"), links)
	if err != nil {
		handleErr(w, err)
		return
	}
	if out == nil {
		out = []core.TrackerLink{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) deleteTracker(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Trackers.Delete(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

// --- entries -------------------------------------------------------------------

func (s *server) entriesForTracker(w http.ResponseWriter, r *http.Request) {
	entries, err := s.app.Entries.ForTracker(r.PathValue("id"), timeRange(r))
	if err != nil {
		handleErr(w, err)
		return
	}
	if entries == nil {
		entries = []*core.Entry{}
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *server) logEntry(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	e, err := s.app.Entries.Log(r.PathValue("id"), body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, e)
}

func (s *server) logEntryBatch(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	entries, err := s.app.Entries.LogMany(body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, entries)
}

func (s *server) getEntry(w http.ResponseWriter, r *http.Request) {
	e, err := s.app.Entries.Get(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if e == nil {
		notFoundEntity(w, "entry")
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (s *server) updateEntry(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	e, err := s.app.Entries.Update(r.PathValue("id"), body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (s *server) deleteEntry(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Entries.Delete(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

// --- notes ---------------------------------------------------------------------

func (s *server) notesForTracker(w http.ResponseWriter, r *http.Request) {
	notes, err := s.app.Notes.ForTracker(r.PathValue("id"), timeRange(r))
	if err != nil {
		handleErr(w, err)
		return
	}
	if notes == nil {
		notes = []*core.Note{}
	}
	writeJSON(w, http.StatusOK, notes)
}

func (s *server) createNote(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	n, err := s.app.Notes.Create(body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (s *server) noteHistory(w http.ResponseWriter, r *http.Request) {
	history, err := s.app.Notes.History(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if history == nil {
		history = []core.NoteEdit{}
	}
	writeJSON(w, http.StatusOK, history)
}

func (s *server) updateNote(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	n, err := s.app.Notes.Update(r.PathValue("id"), body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *server) deleteNote(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Notes.Delete(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

// --- groups --------------------------------------------------------------------

func (s *server) listGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.app.Groups.List()
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

func (s *server) createGroup(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	g, err := s.app.Groups.Create(body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

func (s *server) reorderGroups(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	if err := s.app.Groups.Reorder(stringList(bodyField(body, "orderedGroupIds"))); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

func (s *server) getGroup(w http.ResponseWriter, r *http.Request) {
	g, err := s.app.Groups.Get(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if g == nil {
		notFoundEntity(w, "group")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func (s *server) updateGroup(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	g, err := s.app.Groups.Update(r.PathValue("id"), body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func (s *server) deleteGroup(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Groups.Delete(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

func (s *server) groupTrackers(w http.ResponseWriter, r *http.Request) {
	trackers, err := s.app.Groups.TrackersIn(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if trackers == nil {
		trackers = []*core.Tracker{}
	}
	writeJSON(w, http.StatusOK, trackers)
}

func (s *server) addGroupTracker(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	trackerID, _ := bodyField(body, "tracker_id").(string)
	if err := s.app.Groups.AddTracker(r.PathValue("id"), trackerID); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

func (s *server) reorderGroupMembers(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	if err := s.app.Groups.ReorderMembers(
		r.PathValue("id"), stringList(bodyField(body, "orderedTrackerIds"))); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

func (s *server) removeGroupTracker(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Groups.RemoveTracker(r.PathValue("id"), r.PathValue("trackerId")); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

// --- transactions ----------------------------------------------------------------

func (s *server) listTransactions(w http.ResponseWriter, r *http.Request) {
	list, err := s.app.Transactions.List(r.URL.Query().Get("status"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if list == nil {
		list = []*core.CardTransaction{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) importTransactions(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	result, err := s.app.Transactions.Import(body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *server) getTransaction(w http.ResponseWriter, r *http.Request) {
	txn, err := s.app.Transactions.Get(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	if txn == nil {
		notFoundEntity(w, "transaction")
		return
	}
	writeJSON(w, http.StatusOK, txn)
}

func (s *server) updateTransaction(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	txn, err := s.app.Transactions.Update(r.PathValue("id"), body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, txn)
}

func (s *server) deleteTransaction(w http.ResponseWriter, r *http.Request) {
	if err := s.app.Transactions.Delete(r.PathValue("id")); err != nil {
		handleErr(w, err)
		return
	}
	noContent(w)
}

func (s *server) confirmTransaction(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeBody(w, r)
	if !ok {
		return
	}
	result, err := s.app.Transactions.Confirm(r.PathValue("id"), body)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *server) unfileTransaction(w http.ResponseWriter, r *http.Request) {
	txn, err := s.app.Transactions.Unfile(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, txn)
}

func (s *server) clearTransactions(w http.ResponseWriter, r *http.Request) {
	cleared, err := s.app.Transactions.Clear(r.URL.Query().Get("status"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"cleared": cleared})
}

// --- stats ---------------------------------------------------------------------

func (s *server) statsBuckets(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	start := q.Get("start")
	end := q.Get("end")
	period := q.Get("period")
	if period == "" {
		period = "day"
	}
	if !core.ValidBucketPeriod(period) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": `Invalid period "` + period + `"; expected day, week, month, or year`,
		})
		return
	}
	if _, ok := timeutil.ParseInstant(start); !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "start and end must be valid ISO 8601 timestamps",
		})
		return
	}
	if _, ok := timeutil.ParseInstant(end); !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "start and end must be valid ISO 8601 timestamps",
		})
		return
	}
	buckets, err := s.app.Stats.Bucket(r.PathValue("id"), start, end, core.BucketPeriod(period))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, buckets)
}

func (s *server) statsStreak(w http.ResponseWriter, r *http.Request) {
	streak, err := s.app.Stats.StreakFor(r.PathValue("id"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, streak)
}

func (s *server) statsTargetProgress(w http.ResponseWriter, r *http.Request) {
	progress, err := s.app.Stats.TargetProgressFor(r.PathValue("id"), r.URL.Query().Get("at"))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, progress)
}

func (s *server) statsComposition(w http.ResponseWriter, r *http.Request) {
	slices, err := s.app.Stats.Composition(r.PathValue("id"), timeRange(r))
	if err != nil {
		handleErr(w, err)
		return
	}
	if slices == nil {
		slices = []core.CompositionSlice{}
	}
	writeJSON(w, http.StatusOK, slices)
}

// --- backup ---------------------------------------------------------------------

func (s *server) backupManifest(w http.ResponseWriter, r *http.Request) {
	manifest, err := s.backup.BuildManifest(AppVersion)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeOrderedJSON(w, http.StatusOK, manifest)
}

func (s *server) backupBundle(w http.ResponseWriter, r *http.Request) {
	data, err := s.backup.ExportBundle(AppVersion)
	if err != nil {
		handleErr(w, err)
		return
	}
	stamp := time.Now().UTC().Format("2006-01-02")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		`attachment; filename="countroster-`+stamp+`.countroster.zip"`)
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

func (s *server) backupSqlite(w http.ResponseWriter, r *http.Request) {
	// Raw SQLite download streams the on-disk file directly (engine-specific,
	// so it lives at the server level rather than in the SQL-only core).
	if s.file.Path == "" || s.file.Path == ":memory:" {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error": "Raw SQLite export unavailable for an in-memory database",
		})
		return
	}
	if s.file.Checkpoint != nil {
		if err := s.file.Checkpoint(); err != nil {
			handleErr(w, err)
			return
		}
	}
	stamp := time.Now().UTC().Format("2006-01-02")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition",
		`attachment; filename="countroster-`+stamp+`.sqlite"`)
	http.ServeFile(w, r, s.file.Path)
}

func (s *server) backupImport(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, importBodyLimit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request entity too large"})
			return
		}
		handleErr(w, err)
		return
	}
	result, err := s.backup.ImportBundle(body, r.URL.Query().Get("confirmOverwrite") == "1")
	if err != nil {
		handleErr(w, err)
		return
	}
	out := jsjson.NewObj()
	out.Set("imported_rows", result.ImportedRows)
	out.Set("schema_version", result.SchemaVersion)
	writeOrderedJSON(w, http.StatusOK, out)
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": AppVersion})
}
