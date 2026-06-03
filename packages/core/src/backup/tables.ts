/**
 * The full set of tables a backup captures, with their columns in a fixed
 * order. Used by the JSON/CSV dumpers (stable column order) and the importer
 * (parameterized INSERTs).
 *
 * Order matters for import: parents before children so foreign keys resolve.
 * Delete on import walks this list in reverse.
 */
export const BACKUP_TABLES: ReadonlyArray<{
  name: string;
  columns: readonly string[];
}> = [
  { name: 'app_meta', columns: ['key', 'value'] },
  {
    name: 'trackers',
    columns: [
      'id', 'name', 'description', 'color', 'icon', 'kind', 'unit', 'target',
      'reset_period', 'week_start', 'day_start_minute', 'default_value',
      'archived_at', 'sort_order', 'created_at', 'updated_at',
    ],
  },
  {
    name: 'tracker_groups',
    columns: ['id', 'name', 'color', 'sort_order', 'created_at', 'updated_at'],
  },
  {
    name: 'tracker_options',
    columns: ['id', 'tracker_id', 'label', 'value', 'color', 'sort_order'],
  },
  {
    name: 'entries',
    columns: ['id', 'tracker_id', 'value', 'occurred_at', 'created_at', 'updated_at'],
  },
  {
    name: 'notes',
    columns: ['id', 'tracker_id', 'entry_id', 'body', 'occurred_at', 'created_at', 'updated_at'],
  },
  {
    name: 'note_edits',
    columns: ['id', 'note_id', 'prev_body', 'edited_at'],
  },
  {
    name: 'tracker_group_memberships',
    columns: ['tracker_id', 'group_id', 'sort_order'],
  },
  {
    name: 'reminders',
    columns: [
      'id', 'tracker_id', 'time_minute', 'days_mask', 'enabled',
      'created_at', 'updated_at',
    ],
  },
];
