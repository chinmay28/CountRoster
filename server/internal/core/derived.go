package core

import "github.com/chinmay28/countroster/server/internal/storage"

// entrySource is a parenthesized subquery yielding a tracker's *effective*
// entries (id, tracker_id, value, occurred_at, created_at, updated_at) plus
// its bound parameters. Callers wrap it as `... FROM <source> WHERE …`; the
// returned params bind first, before any range filters the caller appends.
type entrySource struct {
	sql    string
	params []any
}

// effectiveEntrySource ports domain/derived.ts.
//
// For an ordinary tracker this is just its own `entries`. For a derived
// tracker it's a virtual stream: every source entry `(value v at time t)`
// becomes a row of `coefficient × v` at `t`, so every sum-based aggregation
// works on a derived tracker without special-casing. A derived *snapshot*
// tracker combines levels, not amounts: every source reading becomes a row
// whose value is the combined level at that instant — Σ coefficient × (that
// source's latest reading at or before it).
func effectiveEntrySource(st storage.Storage, trackerID string) (entrySource, error) {
	rows, err := st.Query(
		`SELECT is_derived, is_snapshot FROM trackers WHERE id = ?`, trackerID)
	if err != nil {
		return entrySource{}, err
	}
	isDerived, isSnapshot := 0, 0
	if len(rows) > 0 {
		isDerived = asInt(rows[0].Get("is_derived"))
		isSnapshot = asInt(rows[0].Get("is_snapshot"))
	}
	if isDerived != 1 {
		return entrySource{
			sql: `(SELECT id, tracker_id, value, occurred_at, created_at, updated_at
               FROM entries WHERE tracker_id = ?)`,
			params: []any{trackerID},
		}, nil
	}
	if isSnapshot == 1 {
		// Instants compare by julianday, not lexically, because occurred_at may
		// carry mixed offsets; simultaneous readings tie-break on id (UUIDv7,
		// time-sortable). SUM skips a NULL operand — a source with no reading
		// at or before the row's instant — which is what carries partial data.
		return entrySource{
			sql: `(SELECT e.id AS id, ? AS tracker_id,
                    (SELECT SUM(l2.coefficient * (
                       SELECT e2.value FROM entries e2
                        WHERE e2.tracker_id = l2.source_id
                          AND (julianday(e2.occurred_at) < julianday(e.occurred_at)
                               OR (julianday(e2.occurred_at) = julianday(e.occurred_at)
                                   AND e2.id <= e.id))
                        ORDER BY julianday(e2.occurred_at) DESC, e2.id DESC
                        LIMIT 1))
                       FROM tracker_links l2
                      WHERE l2.tracker_id = ?) AS value,
                    e.occurred_at AS occurred_at,
                    e.created_at AS created_at,
                    e.updated_at AS updated_at
               FROM tracker_links l
               JOIN entries e ON e.tracker_id = l.source_id
              WHERE l.tracker_id = ?)`,
			params: []any{trackerID, trackerID, trackerID},
		}, nil
	}
	return entrySource{
		sql: `(SELECT e.id AS id, ? AS tracker_id,
                  e.value * l.coefficient AS value,
                  e.occurred_at AS occurred_at,
                  e.created_at AS created_at,
                  e.updated_at AS updated_at
             FROM tracker_links l
             JOIN entries e ON e.tracker_id = l.source_id
            WHERE l.tracker_id = ?)`,
		params: []any{trackerID, trackerID},
	}, nil
}
