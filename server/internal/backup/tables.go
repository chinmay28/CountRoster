// Package backup ports the TS core's backup bundle: a .countroster.zip
// holding manifest.json, all.json (the restorable artifact) and per-table
// CSVs. Bundles produced by either implementation import into the other —
// the manifest checksum is SHA-256 over the jsjson canonical serialization.
package backup

// backupTable names a captured table with its columns in a fixed order.
// Order matters for import: parents before children so foreign keys resolve;
// delete walks the list in reverse.
type backupTable struct {
	Name    string
	Columns []string
}

var backupTables = []backupTable{
	{Name: "app_meta", Columns: []string{"key", "value"}},
	{Name: "trackers", Columns: []string{
		"id", "name", "description", "color", "icon", "kind", "unit", "target",
		"reset_period", "week_start", "day_start_minute", "default_value",
		"archived_at", "sort_order", "is_derived", "is_hidden", "is_snapshot",
		"created_at", "updated_at",
	}},
	{Name: "tracker_groups", Columns: []string{
		"id", "name", "color", "sort_order", "created_at", "updated_at",
	}},
	{Name: "tracker_options", Columns: []string{
		"id", "tracker_id", "label", "value", "color", "sort_order",
	}},
	{Name: "entries", Columns: []string{
		"id", "tracker_id", "value", "occurred_at", "created_at", "updated_at",
	}},
	{Name: "notes", Columns: []string{
		"id", "tracker_id", "entry_id", "body", "occurred_at", "created_at", "updated_at",
	}},
	{Name: "note_edits", Columns: []string{
		"id", "note_id", "prev_body", "edited_at",
	}},
	{Name: "tracker_group_memberships", Columns: []string{
		"tracker_id", "group_id", "sort_order",
	}},
	{Name: "tracker_links", Columns: []string{
		"id", "tracker_id", "source_id", "coefficient", "sort_order", "created_at",
	}},
	{Name: "reminders", Columns: []string{
		"id", "tracker_id", "time_minute", "days_mask", "enabled",
		"created_at", "updated_at",
	}},
	{Name: "category_rules", Columns: []string{
		"id", "merchant", "tracker_id", "created_at", "updated_at",
	}},
	{Name: "card_transactions", Columns: []string{
		"id", "posted_at", "amount", "name", "raw_description", "account",
		"category", "dedupe_key", "status", "tracker_id", "entry_id",
		"created_at", "updated_at",
	}},
}
