package core

import (
	"strings"

	"github.com/chinmay28/countroster/server/internal/ids"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// FieldService owns a tracker's custom fields: the extra details captured
// alongside each entry's primary value, and the options a `choice` field
// offers. A milk-feeding tracker counts millilitres (the value) and records
// how it was fed and whether the diaper was wet (the fields).
type FieldService struct {
	st    storage.Storage
	clock timeutil.Clock
}

const derivedFieldsMessage = "Cannot define fields on a derived tracker; it has no entries of its own."

// List returns a tracker's fields in sort order, each with its options.
func (s *FieldService) List(trackerID string) ([]*TrackerField, error) {
	return listFields(s.st, trackerID)
}

func listFields(st storage.Storage, trackerID string) ([]*TrackerField, error) {
	rows, err := st.Query(
		`SELECT * FROM tracker_fields WHERE tracker_id = ?
      ORDER BY sort_order ASC, created_at ASC`, trackerID)
	if err != nil {
		return nil, err
	}
	fields := make([]*TrackerField, len(rows))
	byID := map[string]*TrackerField{}
	for i, r := range rows {
		f := trackerFieldFromRow(r)
		fields[i] = f
		byID[f.ID] = f
	}
	if len(fields) == 0 {
		return fields, nil
	}

	optionRows, err := st.Query(
		`SELECT o.* FROM tracker_field_options o
       JOIN tracker_fields f ON f.id = o.field_id
      WHERE f.tracker_id = ?
      ORDER BY o.sort_order ASC, o.id ASC`, trackerID)
	if err != nil {
		return nil, err
	}
	for _, r := range optionRows {
		opt := trackerFieldOptionFromRow(r)
		if f, ok := byID[opt.FieldID]; ok {
			f.Options = append(f.Options, opt)
		}
	}
	return fields, nil
}

// Replace rewrites a tracker's whole field set. An input item carrying the
// `id` of an existing field (or option) updates that row in place, so the
// answers already recorded against it survive the edit; anything the payload
// leaves out is deleted, taking its recorded answers with it.
func (s *FieldService) Replace(trackerID string, inputs []TrackerFieldInput) ([]*TrackerField, error) {
	rows, err := s.st.Query(`SELECT is_derived FROM trackers WHERE id = ?`, trackerID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, &NotFoundError{Kind: "Tracker", ID: trackerID}
	}
	if asInt(rows[0].Get("is_derived")) == 1 {
		return nil, &DerivedTrackerError{Message: derivedFieldsMessage}
	}

	now := s.clock.NowISO()
	err = s.st.Transaction(func(tx storage.Storage) error {
		existing, err := tx.Query(
			`SELECT id, kind FROM tracker_fields WHERE tracker_id = ?`, trackerID)
		if err != nil {
			return err
		}
		kindByID := map[string]string{}
		for _, r := range existing {
			kindByID[asString(r.Get("id"))] = asString(r.Get("kind"))
		}

		// An id the payload doesn't recognize belongs to a field the user
		// removed — drop it and everything recorded against it.
		keep := map[string]bool{}
		for _, in := range inputs {
			if in.ID.Set() && kindByID[in.ID.Value] != "" {
				keep[in.ID.Value] = true
			}
		}
		for id := range kindByID {
			if keep[id] {
				continue
			}
			if err := tx.Exec(`DELETE FROM tracker_fields WHERE id = ?`, id); err != nil {
				return err
			}
		}

		for i, in := range inputs {
			fieldID := in.ID.Value
			if !keep[fieldID] {
				fieldID = ids.New()
				if err := tx.Exec(
					`INSERT INTO tracker_fields
             (id, tracker_id, name, kind, unit, sort_order,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					fieldID, trackerID, in.Name, in.Kind, nullableString(in.Unit),
					i, now, now); err != nil {
					return err
				}
			} else {
				if err := tx.Exec(
					`UPDATE tracker_fields
              SET name = ?, kind = ?, unit = ?, sort_order = ?, updated_at = ?
            WHERE id = ?`,
					in.Name, in.Kind, nullableString(in.Unit), i,
					now, fieldID); err != nil {
					return err
				}
				// Answers are stored in the column the old kind dictated, so
				// they mean nothing under the new one — clear them rather than
				// leaving a flag reading as an orphaned option id.
				if kindByID[fieldID] != in.Kind {
					if err := tx.Exec(
						`DELETE FROM entry_field_values WHERE field_id = ?`, fieldID); err != nil {
						return err
					}
				}
			}
			if err := replaceFieldOptions(tx, fieldID, in.Options); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.List(trackerID)
}

// replaceFieldOptions reconciles one field's options the same way Replace
// reconciles fields: named ids are updated in place, the rest are dropped.
func replaceFieldOptions(tx storage.Storage, fieldID string, inputs []TrackerFieldOptionInput) error {
	existing, err := tx.Query(
		`SELECT id FROM tracker_field_options WHERE field_id = ?`, fieldID)
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, r := range existing {
		known[asString(r.Get("id"))] = true
	}

	keep := map[string]bool{}
	for _, in := range inputs {
		if in.ID.Set() && known[in.ID.Value] {
			keep[in.ID.Value] = true
		}
	}
	for id := range known {
		if keep[id] {
			continue
		}
		if err := tx.Exec(`DELETE FROM tracker_field_options WHERE id = ?`, id); err != nil {
			return err
		}
	}

	for i, in := range inputs {
		if keep[in.ID.Value] {
			if err := tx.Exec(
				`UPDATE tracker_field_options SET label = ?, color = ?, sort_order = ?
          WHERE id = ?`,
				in.Label, nullableString(in.Color), i, in.ID.Value); err != nil {
				return err
			}
			continue
		}
		if err := tx.Exec(
			`INSERT INTO tracker_field_options (id, field_id, label, color, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
			ids.New(), fieldID, in.Label, nullableString(in.Color), i); err != nil {
			return err
		}
	}
	return nil
}

// --- writing entry answers ----------------------------------------------------

// fieldDef is a field's definition reduced to what validating an answer needs.
type fieldDef struct {
	id        string
	name      string
	kind      string
	optionIDs map[string]bool
}

// loadFieldDefs reads a tracker's field definitions, keyed by id.
func loadFieldDefs(st storage.Storage, trackerID string) (map[string]*fieldDef, error) {
	rows, err := st.Query(
		`SELECT id, name, kind FROM tracker_fields WHERE tracker_id = ?
      ORDER BY sort_order ASC, created_at ASC`, trackerID)
	if err != nil {
		return nil, err
	}
	defs := map[string]*fieldDef{}
	for _, r := range rows {
		d := &fieldDef{
			id:        asString(r.Get("id")),
			name:      asString(r.Get("name")),
			kind:      asString(r.Get("kind")),
			optionIDs: map[string]bool{},
		}
		defs[d.id] = d
	}
	if len(defs) == 0 {
		return defs, nil
	}

	optionRows, err := st.Query(
		`SELECT o.id AS id, o.field_id AS field_id FROM tracker_field_options o
       JOIN tracker_fields f ON f.id = o.field_id
      WHERE f.tracker_id = ?`, trackerID)
	if err != nil {
		return nil, err
	}
	for _, r := range optionRows {
		if d, ok := defs[asString(r.Get("field_id"))]; ok {
			d.optionIDs[asString(r.Get("id"))] = true
		}
	}
	return defs, nil
}

// resolvedField is one answer ready to persist. `set` false means the answer
// was cleared — no row is written for it.
type resolvedField struct {
	fieldID string
	set     bool
	option  *string
	number  *float64
	text    *string
}

// resolveEntryFields interprets raw answers against the tracker's field
// definitions. An answer that is given must match its field's kind, but no
// field is ever *obliged* to have one: leaving a field blank is a legitimate
// state, not an error.
//
// That is what keeps fields backward compatible. Adding a field to a tracker
// can't retroactively invalidate the entries logged before it existed, and an
// older client — or any write path that predates the field, like a batch log
// or a confirmed card transaction — keeps working untouched. "Unanswered" is
// carried through to the breakdown as its own bucket rather than being
// guessed at.
func resolveEntryFields(
	st storage.Storage,
	trackerID string,
	inputs []EntryFieldInput,
) ([]resolvedField, error) {
	defs, err := loadFieldDefs(st, trackerID)
	if err != nil {
		return nil, err
	}
	c := &vctx{}
	resolved := make([]resolvedField, 0, len(inputs))

	for _, in := range inputs {
		def, ok := defs[in.FieldID]
		if !ok {
			c.add("invalid_type", "Unknown field for this tracker", "fields", in.FieldID)
			continue
		}
		out := resolvedField{fieldID: def.id}
		switch {
		case in.Raw == nil:
			// Explicit null clears the answer.
		case def.kind == "choice":
			s, ok := in.Raw.(string)
			if !ok {
				c.add("invalid_type", "Expected an option id", "fields", in.FieldID)
				continue
			}
			if s == "" {
				break
			}
			if !def.optionIDs[s] {
				c.add("invalid_enum_value", "Unknown option for field \""+def.name+"\"", "fields", in.FieldID)
				continue
			}
			out.set, out.option = true, &s
		case def.kind == "flag":
			n, ok := flagValue(in.Raw)
			if !ok {
				c.add("invalid_type", "Expected true, false, 0, or 1", "fields", in.FieldID)
				continue
			}
			out.set, out.number = true, &n
		case def.kind == "number":
			n, ok := numVal(in.Raw)
			if !ok {
				c.add("invalid_type", "Expected number", "fields", in.FieldID)
				continue
			}
			out.set, out.number = true, &n
		case def.kind == "text":
			s, ok := in.Raw.(string)
			if !ok {
				c.add("invalid_type", "Expected string", "fields", in.FieldID)
				continue
			}
			s = strings.TrimSpace(s)
			if s == "" {
				break
			}
			if utf16Len(s) > maxFieldTextValueLen {
				c.add("too_big", "String must contain at most "+itoa(maxFieldTextValueLen)+" character(s)",
					"fields", in.FieldID)
				continue
			}
			out.set, out.text = true, &s
		}
		resolved = append(resolved, out)
	}

	if err := c.err(); err != nil {
		return nil, err
	}
	return resolved, nil
}

// flagValue coerces a flag answer to 0 or 1.
func flagValue(raw any) (float64, bool) {
	if b, ok := raw.(bool); ok {
		if b {
			return 1, true
		}
		return 0, true
	}
	n, ok := numVal(raw)
	if !ok || (n != 0 && n != 1) {
		return 0, false
	}
	return n, true
}

// writeEntryFields persists an entry's answers. Only the fields named in
// `resolved` are touched, so a patch that mentions one field leaves the rest
// of the entry's answers alone.
func writeEntryFields(tx storage.Storage, entryID string, resolved []resolvedField) error {
	for _, r := range resolved {
		if err := tx.Exec(
			`DELETE FROM entry_field_values WHERE entry_id = ? AND field_id = ?`,
			entryID, r.fieldID); err != nil {
			return err
		}
		if !r.set {
			continue
		}
		if err := tx.Exec(
			`INSERT INTO entry_field_values
         (id, entry_id, field_id, option_id, number_value, text_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
			ids.New(), entryID, r.fieldID,
			nullablePtr(r.option), nullablePtr(r.number), nullablePtr(r.text)); err != nil {
			return err
		}
	}
	return nil
}

// nullablePtr unwraps a pointer into a SQL param (nil pointer → NULL).
func nullablePtr[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

// --- reading entry answers ------------------------------------------------------

// loadEntryFieldValues fetches the answers for a batch of entries, keyed by
// entry id and ordered by the owning field's sort order. One query for the
// whole page rather than one per entry.
func loadEntryFieldValues(st storage.Storage, entryIDs []string) (map[string][]EntryFieldValue, error) {
	out := map[string][]EntryFieldValue{}
	if len(entryIDs) == 0 {
		return out, nil
	}
	placeholders := make([]string, len(entryIDs))
	params := make([]any, len(entryIDs))
	for i, id := range entryIDs {
		placeholders[i] = "?"
		params[i] = id
	}
	rows, err := st.Query(
		`SELECT v.* FROM entry_field_values v
       JOIN tracker_fields f ON f.id = v.field_id
      WHERE v.entry_id IN (`+strings.Join(placeholders, ", ")+`)
      ORDER BY f.sort_order ASC, f.created_at ASC`, params...)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		v := entryFieldValueFromRow(r)
		out[v.EntryID] = append(out[v.EntryID], v)
	}
	return out, nil
}

// attachEntryFields fills in the Fields of a batch of entries in place.
func attachEntryFields(st storage.Storage, entries []*Entry) error {
	if len(entries) == 0 {
		return nil
	}
	entryIDs := make([]string, 0, len(entries))
	seen := map[string]bool{}
	for _, e := range entries {
		if !seen[e.ID] {
			seen[e.ID] = true
			entryIDs = append(entryIDs, e.ID)
		}
	}
	byEntry, err := loadEntryFieldValues(st, entryIDs)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if values, ok := byEntry[e.ID]; ok {
			e.Fields = values
		}
	}
	return nil
}
