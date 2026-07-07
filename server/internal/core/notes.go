package core

import (
	"fmt"
	"strings"

	"github.com/chinmay28/countroster/server/internal/ids"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// NoteService ports domain/notes.ts. Notes carry an append-only edit log:
// editing a body first records the *previous* body in note_edits.
type NoteService struct {
	st    storage.Storage
	clock timeutil.Clock
}

func (s *NoteService) Create(raw any) (*Note, error) {
	input, err := ParseNoteInput(raw)
	if err != nil {
		return nil, err
	}
	now := s.clock.NowISO()
	id := ids.New()
	occurredAt := now
	if input.OccurredAt.Set() {
		occurredAt = input.OccurredAt.Value
	}

	if err := s.st.Exec(
		`INSERT INTO notes (id, tracker_id, entry_id, body, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, input.TrackerID, nullableString(input.EntryID), input.Body, occurredAt, now, now); err != nil {
		return nil, err
	}

	created, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if created == nil {
		return nil, fmt.Errorf("note insert succeeded but row not found: %s", id)
	}
	return created, nil
}

func (s *NoteService) Update(id string, raw any) (*Note, error) {
	patch, err := ParseNotePatch(raw)
	if err != nil {
		return nil, err
	}

	var result *Note
	err = s.st.Transaction(func(tx storage.Storage) error {
		rows, err := tx.Query(`SELECT * FROM notes WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return &NotFoundError{Kind: "Note", ID: id}
		}
		existing := noteFromRow(rows[0])

		bodyChanged := patch.Body.Set() && patch.Body.Value != existing.Body
		dateChanged := patch.OccurredAt.Set() && patch.OccurredAt.Value != existing.OccurredAt

		// No-op if nothing actually changed.
		if !bodyChanged && !dateChanged {
			result = existing
			return nil
		}

		now := s.clock.NowISO()

		// Capture the previous body in the audit log (body edits only).
		if bodyChanged {
			if err := tx.Exec(
				`INSERT INTO note_edits (id, note_id, prev_body, edited_at)
           VALUES (?, ?, ?, ?)`,
				ids.New(), id, existing.Body, now); err != nil {
				return err
			}
		}

		var sets []string
		var params []any
		if bodyChanged {
			sets = append(sets, "body = ?")
			params = append(params, patch.Body.Value)
		}
		if dateChanged {
			sets = append(sets, "occurred_at = ?")
			params = append(params, patch.OccurredAt.Value)
		}
		sets = append(sets, "updated_at = ?")
		params = append(params, now, id)

		if err := tx.Exec(
			"UPDATE notes SET "+strings.Join(sets, ", ")+" WHERE id = ?", params...); err != nil {
			return err
		}

		updated, err := tx.Query(`SELECT * FROM notes WHERE id = ?`, id)
		if err != nil {
			return err
		}
		result = noteFromRow(updated[0])
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *NoteService) Delete(id string) error {
	return s.st.Exec(`DELETE FROM notes WHERE id = ?`, id)
}

func (s *NoteService) Get(id string) (*Note, error) {
	rows, err := s.st.Query(`SELECT * FROM notes WHERE id = ?`, id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return noteFromRow(rows[0]), nil
}

func (s *NoteService) History(noteID string) ([]NoteEdit, error) {
	rows, err := s.st.Query(
		`SELECT * FROM note_edits WHERE note_id = ?
       ORDER BY edited_at ASC, id ASC`, noteID)
	if err != nil {
		return nil, err
	}
	out := make([]NoteEdit, len(rows))
	for i, r := range rows {
		out[i] = noteEditFromRow(r)
	}
	return out, nil
}

func (s *NoteService) ForTracker(trackerID string, r TimeRange) ([]*Note, error) {
	where := []string{"tracker_id = ?"}
	params := []any{trackerID}
	// Compare by absolute instant (see EntryService.ForTracker): occurred_at
	// is stored in the server's local offset, but range bounds may arrive in
	// a different offset, so lexical comparison is unsafe.
	if r.Start != "" {
		where = append(where, "julianday(occurred_at) >= julianday(?)")
		params = append(params, r.Start)
	}
	if r.End != "" {
		where = append(where, "julianday(occurred_at) < julianday(?)")
		params = append(params, r.End)
	}
	rows, err := s.st.Query(
		`SELECT * FROM notes WHERE `+strings.Join(where, " AND ")+`
       ORDER BY occurred_at ASC, id ASC`, params...)
	if err != nil {
		return nil, err
	}
	out := make([]*Note, len(rows))
	for i, row := range rows {
		out[i] = noteFromRow(row)
	}
	return out, nil
}
