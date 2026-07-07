package core

import (
	"fmt"
	"strings"

	"github.com/chinmay28/countroster/server/internal/ids"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// GroupService ports domain/groups.ts.
type GroupService struct {
	st    storage.Storage
	clock timeutil.Clock
}

func (s *GroupService) Create(raw any) (*TrackerGroup, error) {
	input, err := ParseGroupInput(raw)
	if err != nil {
		return nil, err
	}
	id := ids.New()
	now := s.clock.NowISO()

	if err := s.st.Exec(
		`INSERT INTO tracker_groups (id, name, color, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
		id, input.Name.Value, nullableString(input.Color), input.SortOrder.Value, now, now); err != nil {
		return nil, err
	}

	created, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if created == nil {
		return nil, fmt.Errorf("group insert succeeded but row not found: %s", id)
	}
	return created, nil
}

func (s *GroupService) Update(id string, raw any) (*TrackerGroup, error) {
	patch, err := ParseGroupPatch(raw)
	if err != nil {
		return nil, err
	}
	existing, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, &NotFoundError{Kind: "Group", ID: id}
	}

	var sets []string
	var params []any
	if patch.Name.Set() {
		sets = append(sets, "name = ?")
		params = append(params, patch.Name.Value)
	}
	if patch.Color.Present {
		sets = append(sets, "color = ?")
		params = append(params, nullableString(patch.Color))
	}
	if patch.SortOrder.Set() {
		sets = append(sets, "sort_order = ?")
		params = append(params, patch.SortOrder.Value)
	}
	if len(sets) == 0 {
		return existing, nil
	}

	sets = append(sets, "updated_at = ?")
	params = append(params, s.clock.NowISO(), id)
	if err := s.st.Exec(
		"UPDATE tracker_groups SET "+strings.Join(sets, ", ")+" WHERE id = ?", params...); err != nil {
		return nil, err
	}

	updated, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, &NotFoundError{Kind: "Group", ID: id}
	}
	return updated, nil
}

func (s *GroupService) Delete(id string) error {
	// Memberships cascade via the FK ON DELETE CASCADE.
	return s.st.Exec(`DELETE FROM tracker_groups WHERE id = ?`, id)
}

func (s *GroupService) Get(id string) (*TrackerGroup, error) {
	rows, err := s.st.Query(`SELECT * FROM tracker_groups WHERE id = ?`, id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return groupFromRow(rows[0]), nil
}

func (s *GroupService) List() ([]*TrackerGroup, error) {
	rows, err := s.st.Query(
		`SELECT * FROM tracker_groups ORDER BY sort_order ASC, created_at ASC`)
	if err != nil {
		return nil, err
	}
	out := make([]*TrackerGroup, len(rows))
	for i, r := range rows {
		out[i] = groupFromRow(r)
	}
	return out, nil
}

func (s *GroupService) Reorder(orderedGroupIDs []string) error {
	now := s.clock.NowISO()
	return s.st.Transaction(func(tx storage.Storage) error {
		for i, id := range orderedGroupIDs {
			if err := tx.Exec(
				`UPDATE tracker_groups SET sort_order = ?, updated_at = ? WHERE id = ?`,
				i, now, id); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *GroupService) TrackersIn(groupID string) ([]*Tracker, error) {
	rows, err := s.st.Query(
		`SELECT t.* FROM trackers t
         JOIN tracker_group_memberships m ON m.tracker_id = t.id
        WHERE m.group_id = ?
        ORDER BY m.sort_order ASC, t.created_at ASC`, groupID)
	if err != nil {
		return nil, err
	}
	out := make([]*Tracker, len(rows))
	for i, r := range rows {
		out[i] = trackerFromRow(r)
	}
	return out, nil
}

func (s *GroupService) AddTracker(groupID, trackerID string) error {
	// Append to the end of the group's current order.
	rows, err := s.st.Query(
		`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
         FROM tracker_group_memberships WHERE group_id = ?`, groupID)
	if err != nil {
		return err
	}
	next := 0
	if len(rows) > 0 {
		next = asInt(rows[0].Get("next"))
	}
	return s.st.Exec(
		`INSERT INTO tracker_group_memberships (tracker_id, group_id, sort_order)
       VALUES (?, ?, ?)
       ON CONFLICT(tracker_id, group_id) DO NOTHING`,
		trackerID, groupID, next)
}

func (s *GroupService) RemoveTracker(groupID, trackerID string) error {
	return s.st.Exec(
		`DELETE FROM tracker_group_memberships WHERE group_id = ? AND tracker_id = ?`,
		groupID, trackerID)
}

func (s *GroupService) ReorderMembers(groupID string, orderedTrackerIDs []string) error {
	return s.st.Transaction(func(tx storage.Storage) error {
		for i, id := range orderedTrackerIDs {
			if err := tx.Exec(
				`UPDATE tracker_group_memberships SET sort_order = ?
            WHERE group_id = ? AND tracker_id = ?`,
				i, groupID, id); err != nil {
				return err
			}
		}
		return nil
	})
}
