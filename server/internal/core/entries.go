package core

import (
	"fmt"
	"strings"

	"github.com/chinmay28/countroster/server/internal/ids"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

const derivedLogMessage = "Cannot log entries on a derived tracker; its value is computed from its sources."

// EntryService ports domain/entries.ts.
type EntryService struct {
	st    storage.Storage
	clock timeutil.Clock
}

func (s *EntryService) Log(trackerID string, raw any) (*Entry, error) {
	input, err := ParseEntryLogInput(raw)
	if err != nil {
		return nil, err
	}

	// Look up the tracker's default_value so a bare log does the right thing.
	rows, err := s.st.Query(
		`SELECT default_value, is_derived FROM trackers WHERE id = ?`, trackerID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, &NotFoundError{Kind: "Tracker", ID: trackerID}
	}
	if asInt(rows[0].Get("is_derived")) == 1 {
		return nil, &DerivedTrackerError{Message: derivedLogMessage}
	}

	now := s.clock.NowISO()
	id := ids.New()
	value := asFloat(rows[0].Get("default_value"))
	if input.Value.Set() {
		value = input.Value.Value
	}
	occurredAt := now
	if input.OccurredAt.Set() {
		occurredAt = input.OccurredAt.Value
	}

	if err := s.st.Exec(
		`INSERT INTO entries (id, tracker_id, value, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
		id, trackerID, value, occurredAt, now, now); err != nil {
		return nil, err
	}

	created, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if created == nil {
		return nil, fmt.Errorf("entry insert succeeded but row not found: %s", id)
	}
	return created, nil
}

func (s *EntryService) LogMany(raw any) ([]*Entry, error) {
	inputs, err := ParseEntryLogMany(raw)
	if err != nil {
		return nil, err
	}

	var insertedIDs []string
	err = s.st.Transaction(func(tx storage.Storage) error {
		// Validate every distinct tracker up front so a bad item rolls back
		// the whole batch before any row lands.
		defaults := map[string]float64{}
		for _, in := range inputs {
			if _, seen := defaults[in.TrackerID]; seen {
				continue
			}
			rows, err := tx.Query(
				`SELECT default_value, is_derived FROM trackers WHERE id = ?`, in.TrackerID)
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				return &NotFoundError{Kind: "Tracker", ID: in.TrackerID}
			}
			if asInt(rows[0].Get("is_derived")) == 1 {
				return &DerivedTrackerError{Message: derivedLogMessage}
			}
			defaults[in.TrackerID] = asFloat(rows[0].Get("default_value"))
		}

		now := s.clock.NowISO()
		for _, in := range inputs {
			id := ids.New()
			value := defaults[in.TrackerID]
			if in.Value.Set() {
				value = in.Value.Value
			}
			occurredAt := now
			if in.OccurredAt.Set() {
				occurredAt = in.OccurredAt.Value
			}
			if err := tx.Exec(
				`INSERT INTO entries (id, tracker_id, value, occurred_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
				id, in.TrackerID, value, occurredAt, now, now); err != nil {
				return err
			}
			insertedIDs = append(insertedIDs, id)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	placeholders := make([]string, len(insertedIDs))
	params := make([]any, len(insertedIDs))
	for i, id := range insertedIDs {
		placeholders[i] = "?"
		params[i] = id
	}
	rows, err := s.st.Query(
		`SELECT * FROM entries WHERE id IN (`+strings.Join(placeholders, ", ")+`)`, params...)
	if err != nil {
		return nil, err
	}
	byID := map[string]*Entry{}
	for _, r := range rows {
		e := entryFromRow(r)
		byID[e.ID] = e
	}
	out := make([]*Entry, len(insertedIDs))
	for i, id := range insertedIDs {
		e, ok := byID[id]
		if !ok {
			return nil, fmt.Errorf("entry insert succeeded but row not found: %s", id)
		}
		out[i] = e
	}
	return out, nil
}

func (s *EntryService) Update(id string, raw any) (*Entry, error) {
	patch, err := ParseEntryPatch(raw)
	if err != nil {
		return nil, err
	}
	existing, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, &NotFoundError{Kind: "Entry", ID: id}
	}

	var sets []string
	var params []any
	if patch.Value.Set() {
		sets = append(sets, "value = ?")
		params = append(params, patch.Value.Value)
	}
	if patch.OccurredAt.Set() {
		sets = append(sets, "occurred_at = ?")
		params = append(params, patch.OccurredAt.Value)
	}
	if len(sets) == 0 {
		return existing, nil
	}

	sets = append(sets, "updated_at = ?")
	params = append(params, s.clock.NowISO(), id)
	if err := s.st.Exec(
		"UPDATE entries SET "+strings.Join(sets, ", ")+" WHERE id = ?", params...); err != nil {
		return nil, err
	}

	updated, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, &NotFoundError{Kind: "Entry", ID: id}
	}
	return updated, nil
}

func (s *EntryService) Delete(id string) error {
	return s.st.Exec(`DELETE FROM entries WHERE id = ?`, id)
}

func (s *EntryService) Get(id string) (*Entry, error) {
	rows, err := s.st.Query(`SELECT * FROM entries WHERE id = ?`, id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return entryFromRow(rows[0]), nil
}

func (s *EntryService) ForTracker(trackerID string, r TimeRange) ([]*Entry, error) {
	// For a derived tracker this resolves to a virtual stream of its sources'
	// entries (each scaled by its coefficient); for an ordinary tracker it's
	// just its own `entries`.
	source, err := effectiveEntrySource(s.st, trackerID)
	if err != nil {
		return nil, err
	}
	var where []string
	params := append([]any{}, source.params...)
	// Compare by absolute instant, not lexically: occurred_at is stored with
	// the *server's* local offset, but a client may request a range in a
	// *different* offset. `julianday()` parses the offset so both sides are
	// compared as the same moment in time.
	if r.Start != "" {
		where = append(where, "julianday(occurred_at) >= julianday(?)")
		params = append(params, r.Start)
	}
	if r.End != "" {
		where = append(where, "julianday(occurred_at) < julianday(?)")
		params = append(params, r.End)
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " WHERE " + strings.Join(where, " AND ")
	}
	rows, err := s.st.Query(
		`SELECT * FROM `+source.sql+whereSQL+`
       ORDER BY occurred_at ASC, id ASC`, params...)
	if err != nil {
		return nil, err
	}
	out := make([]*Entry, len(rows))
	for i, row := range rows {
		out[i] = entryFromRow(row)
	}
	return out, nil
}
