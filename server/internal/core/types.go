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
	MonthStartDay  int      `json:"month_start_day"`
	YearStartMonth int      `json:"year_start_month"`
	DefaultValue   float64  `json:"default_value"`
	ArchivedAt     *string  `json:"archived_at"`
	SortOrder      int      `json:"sort_order"`
	IsDerived      int      `json:"is_derived"`
	IsHidden       int      `json:"is_hidden"`
	IsSnapshot     int      `json:"is_snapshot"`
	// SectionOrder is the user's preferred order for the detail page's
	// sections: a comma-separated list of opaque section keys, or nil for the
	// default order. See migration 006.
	SectionOrder *string `json:"section_order"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
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

// TrackerField is one piece of custom data a tracker captures alongside each
// entry's primary value. A milk-feeding tracker counts millilitres and carries
// a "Feed type" choice field and a "Wet diaper" flag field, so the same volume
// can be broken down by either.
//
// Options is the choice field's alternatives, empty for every other kind. It
// is a join, not a column — always present in JSON so the client never has to
// second-guess a missing key.
type TrackerField struct {
	ID        string               `json:"id"`
	TrackerID string               `json:"tracker_id"`
	Name      string               `json:"name"`
	Kind      string               `json:"kind"`
	Unit      *string              `json:"unit"`
	SortOrder int                  `json:"sort_order"`
	CreatedAt string               `json:"created_at"`
	UpdatedAt string               `json:"updated_at"`
	Options   []TrackerFieldOption `json:"options"`
}

// TrackerFieldOption is one alternative of a `choice` field.
type TrackerFieldOption struct {
	ID        string  `json:"id"`
	FieldID   string  `json:"field_id"`
	Label     string  `json:"label"`
	Color     *string `json:"color"`
	SortOrder int     `json:"sort_order"`
}

// EntryFieldValue is one entry's answer to one field. Which column carries it
// follows the field's kind: choice → OptionID, flag/number → NumberValue
// (0|1 for a flag), text → TextValue. The other two are null.
type EntryFieldValue struct {
	ID          string   `json:"id"`
	EntryID     string   `json:"entry_id"`
	FieldID     string   `json:"field_id"`
	OptionID    *string  `json:"option_id"`
	NumberValue *float64 `json:"number_value"`
	TextValue   *string  `json:"text_value"`
}

// Entry is one logged value.
type Entry struct {
	ID         string  `json:"id"`
	TrackerID  string  `json:"tracker_id"`
	Value      float64 `json:"value"`
	OccurredAt string  `json:"occurred_at"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
	// Fields holds this entry's custom-field answers, ordered by the field's
	// sort_order. Always an array — `[]` for a tracker that defines no fields.
	Fields []EntryFieldValue `json:"fields"`
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
	// Min and Max are the smallest and largest single entry value in the
	// bucket — the readable spread a snapshot tracker reports per period. A
	// bucket with no entries reports Min = Max = Value (0, or the level a
	// snapshot carried forward), so a row never shows a range it didn't see.
	Min float64 `json:"min"`
	Max float64 `json:"max"`
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

// FieldBreakdownSlice is one bucket of a custom-field breakdown: how much of
// a tracker's total was logged against a given answer. Key identifies the
// bucket — an option id for a `choice` field, "1"/"0" for a `flag`, and ""
// for entries that left the field blank.
type FieldBreakdownSlice struct {
	FieldID string  `json:"field_id"`
	Key     string  `json:"key"`
	Label   string  `json:"label"`
	Color   *string `json:"color"`
	Total   float64 `json:"total"`
	Count   int     `json:"count"`
}

// Streak is the consecutive-day logging streak.
type Streak struct {
	Current int `json:"current"`
	Longest int `json:"longest"`
}

// CardTransaction mirrors the card_transactions table row: one imported
// credit-card transaction staged for review. Confirming it files an Entry
// (plus a Note carrying the name) into a tracker.
type CardTransaction struct {
	ID             string  `json:"id"`
	PostedAt       string  `json:"posted_at"`
	Amount         float64 `json:"amount"`
	Name           string  `json:"name"`
	RawDescription string  `json:"raw_description"`
	Account        *string `json:"account"`
	Category       *string `json:"category"`
	DedupeKey      string  `json:"dedupe_key"`
	Status         string  `json:"status"`
	TrackerID      *string `json:"tracker_id"`
	EntryID        *string `json:"entry_id"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

// CategoryRule maps a normalized merchant key to the tracker its
// transactions should be filed into. Learned from confirmations.
type CategoryRule struct {
	ID        string `json:"id"`
	Merchant  string `json:"merchant"`
	TrackerID string `json:"tracker_id"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// TransactionImportResult summarizes one CSV import: how many rows landed,
// how many were already known, and the created rows.
type TransactionImportResult struct {
	Imported     int                `json:"imported"`
	Duplicates   int                `json:"duplicates"`
	Transactions []*CardTransaction `json:"transactions"`
}

// TransactionConfirmResult is what confirming a transaction produced.
type TransactionConfirmResult struct {
	Transaction *CardTransaction `json:"transaction"`
	Entry       *Entry           `json:"entry"`
	Note        *Note            `json:"note"`
}

// TimeRange bounds a query: inclusive Start, exclusive End, both ISO 8601.
// Empty string means unbounded.
type TimeRange struct {
	Start string
	End   string
}
