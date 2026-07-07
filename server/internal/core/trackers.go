package core

import (
	"fmt"
	"strings"

	"github.com/chinmay28/countroster/server/internal/ids"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// TrackerService ports domain/trackers.ts.
type TrackerService struct {
	st    storage.Storage
	clock timeutil.Clock
}

// ListOptions filters TrackerService.List.
type ListOptions struct {
	IncludeArchived bool
	IncludeHidden   bool
}

func (s *TrackerService) Create(raw any) (*Tracker, error) {
	input, err := ParseTrackerInput(raw)
	if err != nil {
		return nil, err
	}
	id := ids.New()
	now := s.clock.NowISO()
	isDerived := 0
	if len(input.Links) > 0 {
		isDerived = 1
	}

	// A snapshot stat has no reset window — normalize to 'never'.
	resetPeriod := input.ResetPeriod.Value
	if input.IsSnapshot.Value == 1 {
		resetPeriod = "never"
	}

	err = s.st.Transaction(func(tx storage.Storage) error {
		if err := tx.Exec(
			`INSERT INTO trackers (
          id, name, description, color, icon, kind, unit, target,
          reset_period, week_start, day_start_minute, default_value,
          archived_at, sort_order, is_derived, is_hidden, is_snapshot,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
			id,
			input.Name.Value,
			nullableString(input.Description),
			input.Color.Value,
			nullableString(input.Icon),
			input.Kind.Value,
			nullableString(input.Unit),
			nullableFloat(input.Target),
			resetPeriod,
			input.WeekStart.Value,
			input.DayStartMinute.Value,
			input.DefaultValue.Value,
			input.SortOrder.Value,
			isDerived,
			input.IsHidden.Value,
			input.IsSnapshot.Value,
			now,
			now,
		); err != nil {
			return err
		}
		if len(input.Links) > 0 {
			return s.replaceLinks(tx, id, input.Links, now, input.IsHidden.Value)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	created, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if created == nil {
		return nil, fmt.Errorf("tracker insert succeeded but row not found: %s", id)
	}
	return created, nil
}

func (s *TrackerService) Update(id string, raw any) (*Tracker, error) {
	patch, err := ParseTrackerPatch(raw)
	if err != nil {
		return nil, err
	}
	existing, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, &NotFoundError{Kind: "Tracker", ID: id}
	}

	var sets []string
	var params []any
	assignStr := func(o Opt[string], column string) {
		if o.Present {
			sets = append(sets, column+" = ?")
			params = append(params, nullableString(o))
		}
	}
	assignFloat := func(o Opt[float64], column string) {
		if o.Present {
			sets = append(sets, column+" = ?")
			params = append(params, nullableFloat(o))
		}
	}
	assignInt := func(o Opt[int], column string) {
		if o.Present {
			sets = append(sets, column+" = ?")
			params = append(params, o.Value)
		}
	}

	// Whatever the patch says, a snapshot tracker's reset window is 'never':
	// suppress any patched reset_period and repair a non-'never' one left
	// over from before the tracker became a snapshot.
	nextSnapshot := existing.IsSnapshot
	if patch.IsSnapshot.Present {
		nextSnapshot = patch.IsSnapshot.Value
	}

	assignStr(patch.Name, "name")
	assignStr(patch.Description, "description")
	assignStr(patch.Color, "color")
	assignStr(patch.Icon, "icon")
	assignStr(patch.Kind, "kind")
	assignStr(patch.Unit, "unit")
	assignFloat(patch.Target, "target")
	if nextSnapshot != 1 {
		assignStr(patch.ResetPeriod, "reset_period")
	}
	assignInt(patch.WeekStart, "week_start")
	assignInt(patch.DayStartMinute, "day_start_minute")
	assignFloat(patch.DefaultValue, "default_value")
	assignInt(patch.SortOrder, "sort_order")
	assignInt(patch.IsHidden, "is_hidden")
	assignInt(patch.IsSnapshot, "is_snapshot")

	if nextSnapshot == 1 && existing.ResetPeriod != "never" {
		sets = append(sets, `reset_period = 'never'`)
	}

	// A supplied `links` list replaces the derivation wholesale and re-derives
	// the `is_derived` flag from whether any operands remain.
	replacingLinks := patch.HasLinks
	if replacingLinks {
		sets = append(sets, "is_derived = ?")
		isDerived := 0
		if len(patch.Links) > 0 {
			isDerived = 1
		}
		params = append(params, isDerived)
	}

	if len(sets) == 0 {
		return existing, nil
	}

	// Flipping visibility must not split a derivation across the hidden
	// boundary; check against the operands this tracker keeps (replaced links
	// are validated in replaceLinks below) and against its dependents.
	nextHidden := existing.IsHidden
	if patch.IsHidden.Present {
		nextHidden = patch.IsHidden.Value
	}
	if nextHidden != existing.IsHidden {
		if err := s.assertHiddenMatchesDerivations(id, nextHidden, !replacingLinks); err != nil {
			return nil, err
		}
	}

	now := s.clock.NowISO()
	sets = append(sets, "updated_at = ?")
	params = append(params, now, id)

	err = s.st.Transaction(func(tx storage.Storage) error {
		if err := tx.Exec(
			"UPDATE trackers SET "+strings.Join(sets, ", ")+" WHERE id = ?", params...,
		); err != nil {
			return err
		}
		if replacingLinks {
			return s.replaceLinks(tx, id, patch.Links, now, nextHidden)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	updated, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, &NotFoundError{Kind: "Tracker", ID: id}
	}
	return updated, nil
}

func (s *TrackerService) Archive(id string) error {
	// Archiving a source hides it from the roster while its derivations still
	// depend on it — treat it like deletion and block it the same way.
	if err := s.assertNotUsedAsSource(id, "archive"); err != nil {
		return err
	}
	now := s.clock.NowISO()
	return s.st.Exec(
		`UPDATE trackers SET archived_at = ?, updated_at = ? WHERE id = ?`,
		now, now, id)
}

func (s *TrackerService) Unarchive(id string) error {
	now := s.clock.NowISO()
	return s.st.Exec(
		`UPDATE trackers SET archived_at = NULL, updated_at = ? WHERE id = ?`,
		now, id)
}

func (s *TrackerService) Delete(id string) error {
	// A tracker that feeds a derivation can't be deleted out from under it.
	// Entries, notes (and their edit log), options, reminders, group
	// memberships, and this tracker's own links cascade via ON DELETE CASCADE.
	if err := s.assertNotUsedAsSource(id, "delete"); err != nil {
		return err
	}
	return s.st.Exec(`DELETE FROM trackers WHERE id = ?`, id)
}

func (s *TrackerService) assertNotUsedAsSource(id, action string) error {
	rows, err := s.st.Query(
		`SELECT DISTINCT t.id, t.name
         FROM tracker_links l
         JOIN trackers t ON t.id = l.tracker_id
        WHERE l.source_id = ?
        ORDER BY t.name ASC`, id)
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		e := &TrackerInUseError{TrackerID: id, Action: action}
		for _, r := range rows {
			e.Dependents = append(e.Dependents,
				struct{ ID, Name string }{asString(r.Get("id")), asString(r.Get("name"))})
		}
		return e
	}
	return nil
}

func (s *TrackerService) Reorder(orderedIDs []string) error {
	now := s.clock.NowISO()
	return s.st.Transaction(func(tx storage.Storage) error {
		for i, id := range orderedIDs {
			if err := tx.Exec(
				`UPDATE trackers SET sort_order = ?, updated_at = ? WHERE id = ?`,
				i, now, id); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *TrackerService) Get(id string) (*Tracker, error) {
	rows, err := s.st.Query(`SELECT * FROM trackers WHERE id = ?`, id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return trackerFromRow(rows[0]), nil
}

func (s *TrackerService) List(opts ListOptions) ([]*Tracker, error) {
	var where []string
	if !opts.IncludeArchived {
		where = append(where, "archived_at IS NULL")
	}
	if !opts.IncludeHidden {
		where = append(where, "is_hidden = 0")
	}
	sql := `SELECT * FROM trackers`
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += ` ORDER BY sort_order ASC, created_at ASC`
	rows, err := s.st.Query(sql)
	if err != nil {
		return nil, err
	}
	out := make([]*Tracker, len(rows))
	for i, r := range rows {
		out[i] = trackerFromRow(r)
	}
	return out, nil
}

func (s *TrackerService) Links(trackerID string) ([]TrackerLink, error) {
	rows, err := s.st.Query(
		`SELECT * FROM tracker_links WHERE tracker_id = ?
        ORDER BY sort_order ASC, created_at ASC`, trackerID)
	if err != nil {
		return nil, err
	}
	out := make([]TrackerLink, len(rows))
	for i, r := range rows {
		out[i] = trackerLinkFromRow(r)
	}
	return out, nil
}

func (s *TrackerService) SetLinks(trackerID string, links []TrackerLinkInput) ([]TrackerLink, error) {
	existing, err := s.Get(trackerID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, &NotFoundError{Kind: "Tracker", ID: trackerID}
	}

	now := s.clock.NowISO()
	err = s.st.Transaction(func(tx storage.Storage) error {
		isDerived := 0
		if len(links) > 0 {
			isDerived = 1
		}
		if err := tx.Exec(
			`UPDATE trackers SET is_derived = ?, updated_at = ? WHERE id = ?`,
			isDerived, now, trackerID); err != nil {
			return err
		}
		return s.replaceLinks(tx, trackerID, links, now, existing.IsHidden)
	})
	if err != nil {
		return nil, err
	}
	return s.Links(trackerID)
}

// assertHiddenMatchesDerivations rejects a visibility flip that would split a
// derivation across the hidden boundary.
func (s *TrackerService) assertHiddenMatchesDerivations(id string, hidden int, checkSources bool) error {
	dependents, err := s.st.Query(
		`SELECT DISTINCT t.name
         FROM tracker_links l
         JOIN trackers t ON t.id = l.tracker_id
        WHERE l.source_id = ? AND t.is_hidden != ?`, id, hidden)
	if err != nil {
		return err
	}
	if len(dependents) > 0 {
		return &DerivedTrackerError{Message: "Hidden and visible trackers cannot share a derivation: " +
			"this tracker is a source for " + quotedNames(dependents) + "."}
	}
	if checkSources {
		sources, err := s.st.Query(
			`SELECT DISTINCT s.name
           FROM tracker_links l
           JOIN trackers s ON s.id = l.source_id
          WHERE l.tracker_id = ? AND s.is_hidden != ?`, id, hidden)
		if err != nil {
			return err
		}
		if len(sources) > 0 {
			return &DerivedTrackerError{Message: "Hidden and visible trackers cannot share a derivation: " +
				"this tracker is derived from " + quotedNames(sources) + "."}
		}
	}
	return nil
}

func quotedNames(rows []storage.Row) string {
	names := make([]string, len(rows))
	for i, r := range rows {
		names[i] = `"` + asString(r.Get("name")) + `"`
	}
	return strings.Join(names, ", ")
}

// replaceLinks validates and (re)writes a derived tracker's operands inside a
// transaction. Each source must exist, be ordinary (no derived-of-derived
// nesting), not be the tracker itself, and share the derived tracker's
// visibility — a derivation is either entirely hidden or entirely visible.
func (s *TrackerService) replaceLinks(tx storage.Storage, trackerID string, links []TrackerLinkInput, now string, trackerHidden int) error {
	if err := tx.Exec(`DELETE FROM tracker_links WHERE tracker_id = ?`, trackerID); err != nil {
		return err
	}
	if len(links) == 0 {
		return nil
	}

	// Reject duplicate sources up front — the table's UNIQUE constraint would
	// otherwise fail mid-insert with an opaque error.
	seen := map[string]bool{}
	for _, link := range links {
		if link.SourceID == trackerID {
			return &DerivedTrackerError{Message: "A derived tracker cannot reference itself."}
		}
		if seen[link.SourceID] {
			return &DerivedTrackerError{Message: "Duplicate source tracker in derivation: " + link.SourceID}
		}
		seen[link.SourceID] = true
	}

	placeholders := make([]string, len(links))
	sourceIDs := make([]any, len(links))
	for i, l := range links {
		placeholders[i] = "?"
		sourceIDs[i] = l.SourceID
	}
	sources, err := tx.Query(
		`SELECT id, name, is_derived, is_hidden FROM trackers
        WHERE id IN (`+strings.Join(placeholders, ", ")+`)`, sourceIDs...)
	if err != nil {
		return err
	}
	byID := map[string]storage.Row{}
	for _, r := range sources {
		byID[asString(r.Get("id"))] = r
	}
	for _, link := range links {
		source, ok := byID[link.SourceID]
		if !ok {
			return &DerivedTrackerError{Message: "Source tracker not found: " + link.SourceID}
		}
		if asInt(source.Get("is_derived")) == 1 {
			return &DerivedTrackerError{Message: "A derived tracker cannot be a source of another derived tracker: " + link.SourceID}
		}
		if asInt(source.Get("is_hidden")) != trackerHidden {
			vis := func(hidden int) string {
				if hidden != 0 {
					return "hidden"
				}
				return "visible"
			}
			return &DerivedTrackerError{Message: "Hidden and visible trackers cannot share a derivation: source " +
				`"` + asString(source.Get("name")) + `" is ` + vis(asInt(source.Get("is_hidden"))) +
				" but the derived tracker is " + vis(trackerHidden) + "."}
		}
	}

	for i, link := range links {
		if err := tx.Exec(
			`INSERT INTO tracker_links
           (id, tracker_id, source_id, coefficient, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
			ids.New(), trackerID, link.SourceID, link.Coefficient, i, now); err != nil {
			return err
		}
	}
	return nil
}

func nullableString(o Opt[string]) any {
	if o.Set() {
		return o.Value
	}
	return nil
}

func nullableFloat(o Opt[float64]) any {
	if o.Set() {
		return o.Value
	}
	return nil
}
