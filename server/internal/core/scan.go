package core

import "github.com/chinmay28/countroster/server/internal/storage"

// SQLite's dynamic typing means the driver hands back int64, float64, string
// or nil; these helpers coerce row values into the row-struct field types.

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asNullString(v any) *string {
	if v == nil {
		return nil
	}
	s := asString(v)
	return &s
}

func asFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	}
	return 0
}

func asNullFloat(v any) *float64 {
	if v == nil {
		return nil
	}
	f := asFloat(v)
	return &f
}

func asInt(v any) int {
	return int(asFloat(v))
}

func trackerFromRow(r storage.Row) *Tracker {
	return &Tracker{
		ID:             asString(r.Get("id")),
		Name:           asString(r.Get("name")),
		Description:    asNullString(r.Get("description")),
		Color:          asString(r.Get("color")),
		Icon:           asNullString(r.Get("icon")),
		Kind:           asString(r.Get("kind")),
		Unit:           asNullString(r.Get("unit")),
		Target:         asNullFloat(r.Get("target")),
		ResetPeriod:    asString(r.Get("reset_period")),
		WeekStart:      asInt(r.Get("week_start")),
		DayStartMinute: asInt(r.Get("day_start_minute")),
		DefaultValue:   asFloat(r.Get("default_value")),
		ArchivedAt:     asNullString(r.Get("archived_at")),
		SortOrder:      asInt(r.Get("sort_order")),
		IsDerived:      asInt(r.Get("is_derived")),
		IsHidden:       asInt(r.Get("is_hidden")),
		IsSnapshot:     asInt(r.Get("is_snapshot")),
		CreatedAt:      asString(r.Get("created_at")),
		UpdatedAt:      asString(r.Get("updated_at")),
	}
}

func trackerLinkFromRow(r storage.Row) TrackerLink {
	return TrackerLink{
		ID:          asString(r.Get("id")),
		TrackerID:   asString(r.Get("tracker_id")),
		SourceID:    asString(r.Get("source_id")),
		Coefficient: asFloat(r.Get("coefficient")),
		SortOrder:   asInt(r.Get("sort_order")),
		CreatedAt:   asString(r.Get("created_at")),
	}
}

func entryFromRow(r storage.Row) *Entry {
	return &Entry{
		ID:         asString(r.Get("id")),
		TrackerID:  asString(r.Get("tracker_id")),
		Value:      asFloat(r.Get("value")),
		OccurredAt: asString(r.Get("occurred_at")),
		CreatedAt:  asString(r.Get("created_at")),
		UpdatedAt:  asString(r.Get("updated_at")),
	}
}

func noteFromRow(r storage.Row) *Note {
	return &Note{
		ID:         asString(r.Get("id")),
		TrackerID:  asString(r.Get("tracker_id")),
		EntryID:    asNullString(r.Get("entry_id")),
		Body:       asString(r.Get("body")),
		OccurredAt: asString(r.Get("occurred_at")),
		CreatedAt:  asString(r.Get("created_at")),
		UpdatedAt:  asString(r.Get("updated_at")),
	}
}

func noteEditFromRow(r storage.Row) NoteEdit {
	return NoteEdit{
		ID:       asString(r.Get("id")),
		NoteID:   asString(r.Get("note_id")),
		PrevBody: asString(r.Get("prev_body")),
		EditedAt: asString(r.Get("edited_at")),
	}
}

func cardTransactionFromRow(r storage.Row) *CardTransaction {
	return &CardTransaction{
		ID:             asString(r.Get("id")),
		PostedAt:       asString(r.Get("posted_at")),
		Amount:         asFloat(r.Get("amount")),
		Name:           asString(r.Get("name")),
		RawDescription: asString(r.Get("raw_description")),
		Account:        asNullString(r.Get("account")),
		Category:       asNullString(r.Get("category")),
		DedupeKey:      asString(r.Get("dedupe_key")),
		Status:         asString(r.Get("status")),
		TrackerID:      asNullString(r.Get("tracker_id")),
		EntryID:        asNullString(r.Get("entry_id")),
		CreatedAt:      asString(r.Get("created_at")),
		UpdatedAt:      asString(r.Get("updated_at")),
	}
}

func groupFromRow(r storage.Row) *TrackerGroup {
	return &TrackerGroup{
		ID:        asString(r.Get("id")),
		Name:      asString(r.Get("name")),
		Color:     asNullString(r.Get("color")),
		SortOrder: asInt(r.Get("sort_order")),
		CreatedAt: asString(r.Get("created_at")),
		UpdatedAt: asString(r.Get("updated_at")),
	}
}
