// Package core is the CountRoster domain layer — a faithful Go port of the
// TypeScript @countroster/core services. The wire shapes (JSON field names,
// 0/1 integer flags, explicit nulls) and the SQL are contract: they must stay
// byte-compatible with what the PWA client already speaks.
package core

// Tracker mirrors the trackers table row (schema/tables.ts).
type Tracker struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    *string  `json:"description"`
	Color          string   `json:"color"`
	Icon           *string  `json:"icon"`
	Kind           string   `json:"kind"`
	Unit           *string  `json:"unit"`
	Target         *float64 `json:"target"`
	ResetPeriod    string   `json:"reset_period"`
	WeekStart      int      `json:"week_start"`
	DayStartMinute int      `json:"day_start_minute"`
	DefaultValue   float64  `json:"default_value"`
	ArchivedAt     *string  `json:"archived_at"`
	SortOrder      int      `json:"sort_order"`
	IsDerived      int      `json:"is_derived"`
	IsHidden       int      `json:"is_hidden"`
	IsSnapshot     int      `json:"is_snapshot"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

// TrackerLink is one operand of a derived tracker.
type TrackerLink struct {
	ID          string  `json:"id"`
	TrackerID   string  `json:"tracker_id"`
	SourceID    string  `json:"source_id"`
	Coefficient float64 `json:"coefficient"`
	SortOrder   int     `json:"sort_order"`
	CreatedAt   string  `json:"created_at"`
}

// Entry is one logged value.
type Entry struct {
	ID         string  `json:"id"`
	TrackerID  string  `json:"tracker_id"`
	Value      float64 `json:"value"`
	OccurredAt string  `json:"occurred_at"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

// Note is a free-text annotation, optionally linked to an entry.
type Note struct {
	ID         string  `json:"id"`
	TrackerID  string  `json:"tracker_id"`
	EntryID    *string `json:"entry_id"`
	Body       string  `json:"body"`
	OccurredAt string  `json:"occurred_at"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

// NoteEdit is one row of a note's append-only edit log: what the body WAS
// before the edit.
type NoteEdit struct {
	ID       string `json:"id"`
	NoteID   string `json:"note_id"`
	PrevBody string `json:"prev_body"`
	EditedAt string `json:"edited_at"`
}

// TrackerGroup is a named collection of trackers.
type TrackerGroup struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Color     *string `json:"color"`
	SortOrder int     `json:"sort_order"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

// StatBucket is a period bucket with its aggregated value.
type StatBucket struct {
	Start string  `json:"start"`
	End   string  `json:"end"`
	Label string  `json:"label"`
	Value float64 `json:"value"`
	Count int     `json:"count"`
}

// TargetProgress reports progress toward a tracker's target.
type TargetProgress struct {
	Target  *float64 `json:"target"`
	Current float64  `json:"current"`
	Ratio   *float64 `json:"ratio"`
}

// CompositionSlice is one source operand's contribution to a derived
// tracker's total.
type CompositionSlice struct {
	SourceID    string  `json:"source_id"`
	Name        string  `json:"name"`
	Color       string  `json:"color"`
	Coefficient float64 `json:"coefficient"`
	Total       float64 `json:"total"`
	Count       int     `json:"count"`
}

// Streak is the consecutive-day logging streak.
type Streak struct {
	Current int `json:"current"`
	Longest int `json:"longest"`
}

// TimeRange bounds a query: inclusive Start, exclusive End, both ISO 8601.
// Empty string means unbounded.
type TimeRange struct {
	Start string
	End   string
}
