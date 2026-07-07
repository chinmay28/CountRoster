package core

import (
	"strings"
	"time"

	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

// StatsService ports aggregations/stats.ts.
type StatsService struct {
	st    storage.Storage
	clock timeutil.Clock
}

func (s *StatsService) getTracker(trackerID string) (*Tracker, error) {
	rows, err := s.st.Query(`SELECT * FROM trackers WHERE id = ?`, trackerID)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return trackerFromRow(rows[0]), nil
}

// Bucket sums entry values into period buckets spanning [start, end).
func (s *StatsService) Bucket(trackerID, start, end string, period BucketPeriod) ([]StatBucket, error) {
	tracker, err := s.getTracker(trackerID)
	if err != nil {
		return nil, err
	}
	weekStart := 1
	isSnapshot := false
	if tracker != nil {
		weekStart = tracker.WeekStart
		isSnapshot = tracker.IsSnapshot == 1
	}

	source, err := effectiveEntrySource(s.st, trackerID)
	if err != nil {
		return nil, err
	}
	// Compare by absolute instant (julianday), not lexically: occurred_at is
	// stored with the server's local offset while the range bounds may arrive
	// in a different offset.
	params := append(append([]any{}, source.params...), start, end)
	entries, err := s.st.Query(
		`SELECT occurred_at, value FROM `+source.sql+`
        WHERE julianday(occurred_at) >= julianday(?)
          AND julianday(occurred_at) < julianday(?)
        ORDER BY occurred_at ASC`, params...)
	if err != nil {
		return nil, err
	}

	// Pre-build the empty buckets spanning the range so gaps show as zeroes.
	startInstant, ok := timeutil.ParseInstant(start)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_string", Path: []any{"start"}, Message: "Invalid datetime"}}}
	}
	rangeEnd, ok := timeutil.ParseInstant(end)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_string", Path: []any{"end"}, Message: "Invalid datetime"}}}
	}

	buckets := []StatBucket{}
	index := map[string]int{}
	cursor := bucketStart(startInstant, period, weekStart)
	for cursor.Before(rangeEnd) {
		bEnd := bucketEnd(cursor, period, weekStart)
		label := bucketLabel(cursor, period)
		buckets = append(buckets, StatBucket{
			Start: timeutil.ToUTCISO(cursor),
			End:   timeutil.ToUTCISO(bEnd),
			Label: label,
		})
		index[label] = len(buckets) - 1
		cursor = bEnd
	}

	for _, e := range entries {
		occurred, ok := timeutil.ParseInstant(asString(e.Get("occurred_at")))
		if !ok {
			continue
		}
		label := bucketLabel(bucketStart(occurred, period, weekStart), period)
		if i, hit := index[label]; hit {
			// Snapshots are levels, not amounts: the bucket takes the latest
			// reading (entries arrive in occurred_at order) instead of a sum.
			if isSnapshot {
				buckets[i].Value = asFloat(e.Get("value"))
			} else {
				buckets[i].Value += asFloat(e.Get("value"))
			}
			buckets[i].Count++
		}
	}

	if isSnapshot {
		// A level persists between readings, so a bucket without one holds
		// the last known level instead of dropping to zero (count stays 0).
		// Seed from the latest reading before the range so the leading
		// buckets carry too; before the first-ever reading there is nothing
		// to carry.
		priorParams := append(append([]any{}, source.params...), start)
		prior, err := s.st.Query(
			`SELECT value FROM `+source.sql+`
          WHERE julianday(occurred_at) < julianday(?)
          ORDER BY julianday(occurred_at) DESC, id DESC LIMIT 1`, priorParams...)
		if err != nil {
			return nil, err
		}
		var carry *float64
		if len(prior) > 0 {
			v := asFloat(prior[0].Get("value"))
			carry = &v
		}
		for i := range buckets {
			if buckets[i].Count > 0 {
				v := buckets[i].Value
				carry = &v
			} else if carry != nil {
				buckets[i].Value = *carry
			}
		}
	}

	return buckets, nil
}

// StreakFor computes the consecutive-day logging streak: current run and
// longest ever.
func (s *StatsService) StreakFor(trackerID string) (Streak, error) {
	source, err := effectiveEntrySource(s.st, trackerID)
	if err != nil {
		return Streak{}, err
	}
	rows, err := s.st.Query(
		`SELECT DISTINCT substr(occurred_at, 1, 10) AS occurred_at
         FROM `+source.sql+`
        ORDER BY occurred_at ASC`, source.params...)
	if err != nil {
		return Streak{}, err
	}
	days := make([]string, len(rows))
	present := map[string]bool{}
	for i, r := range rows {
		days[i] = asString(r.Get("occurred_at"))
		present[days[i]] = true
	}
	if len(days) == 0 {
		return Streak{}, nil
	}

	// Longest run of consecutive calendar days.
	longest, run := 1, 1
	for i := 1; i < len(days); i++ {
		if addDays(days[i-1], 1) == days[i] {
			run++
		} else {
			run = 1
		}
		if run > longest {
			longest = run
		}
	}

	// Current run: walk back from today (or yesterday, if today isn't logged
	// yet).
	today := s.clock.NowISO()[:10]
	anchor := ""
	if present[today] {
		anchor = today
	} else if present[addDays(today, -1)] {
		anchor = addDays(today, -1)
	}

	current := 0
	if anchor != "" {
		day := anchor
		for present[day] {
			current++
			day = addDays(day, -1)
		}
	}

	return Streak{Current: current, Longest: longest}, nil
}

// TargetProgressFor reports progress toward the tracker's target within its
// current reset period (or as of `at`).
func (s *StatsService) TargetProgressFor(trackerID, at string) (TargetProgress, error) {
	tracker, err := s.getTracker(trackerID)
	if err != nil {
		return TargetProgress{}, err
	}
	if tracker == nil {
		return TargetProgress{Target: nil, Current: 0, Ratio: nil}, nil
	}

	target := tracker.Target
	instantStr := at
	if instantStr == "" {
		instantStr = s.clock.NowISO()
	}
	instant, ok := timeutil.ParseInstant(instantStr)
	if !ok {
		return TargetProgress{}, &ValidationError{Issues: []Issue{{Code: "invalid_string", Path: []any{"at"}, Message: "Invalid datetime"}}}
	}

	source, err := effectiveEntrySource(s.st, trackerID)
	if err != nil {
		return TargetProgress{}, err
	}

	// A snapshot tracker's "current" is its most recent reading — there is no
	// window to sum over.
	if tracker.IsSnapshot == 1 {
		rows, err := s.st.Query(
			`SELECT value FROM `+source.sql+`
          ORDER BY occurred_at DESC, id DESC LIMIT 1`, source.params...)
		if err != nil {
			return TargetProgress{}, err
		}
		current := 0.0
		if len(rows) > 0 {
			current = asFloat(rows[0].Get("value"))
		}
		return TargetProgress{Target: target, Current: current, Ratio: ratioFor(target, current)}, nil
	}

	params := append([]any{}, source.params...)
	whereSQL := ""
	if tracker.ResetPeriod != "never" {
		period := resetToPeriod[tracker.ResetPeriod]
		// Instant-based bounds: the window edges are UTC ("Z") strings while
		// occurred_at carries a local offset, so lexical compare would
		// misplace entries near the window edges.
		whereSQL = " WHERE julianday(occurred_at) >= julianday(?)" +
			" AND julianday(occurred_at) < julianday(?)"
		params = append(params,
			timeutil.ToUTCISO(bucketStart(instant, period, tracker.WeekStart)),
			timeutil.ToUTCISO(bucketEnd(instant, period, tracker.WeekStart)))
	}
	rows, err := s.st.Query(
		`SELECT SUM(value) AS total FROM `+source.sql+whereSQL, params...)
	if err != nil {
		return TargetProgress{}, err
	}
	current := 0.0
	if len(rows) > 0 && rows[0].Get("total") != nil {
		current = asFloat(rows[0].Get("total"))
	}
	return TargetProgress{Target: target, Current: current, Ratio: ratioFor(target, current)}, nil
}

// Composition reports how a derived tracker's total splits across its source
// operands, one slice per link in derivation order. Empty for an ordinary
// tracker.
func (s *StatsService) Composition(trackerID string, r TimeRange) ([]CompositionSlice, error) {
	tracker, err := s.getTracker(trackerID)
	if err != nil {
		return nil, err
	}
	if tracker != nil && tracker.IsSnapshot == 1 {
		return s.snapshotComposition(trackerID, r)
	}

	// One row per link: the source's identity plus its weighted entry sum.
	// LEFT JOIN keeps sources with no entries in range (a 0-total slice,
	// count 0), which is why the range filter lives in the ON clause — in a
	// WHERE it would drop those rows.
	on := []string{"e.tracker_id = l.source_id"}
	var params []any
	if r.Start != "" {
		on = append(on, "julianday(e.occurred_at) >= julianday(?)")
		params = append(params, r.Start)
	}
	if r.End != "" {
		on = append(on, "julianday(e.occurred_at) < julianday(?)")
		params = append(params, r.End)
	}
	params = append(params, trackerID)
	rows, err := s.st.Query(
		`SELECT l.source_id AS source_id,
              s.name AS name,
              s.color AS color,
              l.coefficient AS coefficient,
              COALESCE(l.coefficient * SUM(e.value), 0) AS total,
              COUNT(e.id) AS count
         FROM tracker_links l
         JOIN trackers s ON s.id = l.source_id
         LEFT JOIN entries e ON `+strings.Join(on, " AND ")+`
        WHERE l.tracker_id = ?
        GROUP BY l.id
        ORDER BY l.sort_order ASC, l.created_at ASC`, params...)
	if err != nil {
		return nil, err
	}
	return slicesFromRows(rows), nil
}

// snapshotComposition: levels don't sum over a range, so each slice is
// `coefficient × the source's latest reading` strictly before the range's
// end (as of now when unbounded). The range's start only scopes count.
func (s *StatsService) snapshotComposition(trackerID string, r TimeRange) ([]CompositionSlice, error) {
	levelWhere := []string{"e.tracker_id = l.source_id"}
	countWhere := []string{"e.tracker_id = l.source_id"}
	var params []any
	if r.End != "" {
		levelWhere = append(levelWhere, "julianday(e.occurred_at) < julianday(?)")
		params = append(params, r.End)
	}
	if r.Start != "" {
		countWhere = append(countWhere, "julianday(e.occurred_at) >= julianday(?)")
		params = append(params, r.Start)
	}
	if r.End != "" {
		countWhere = append(countWhere, "julianday(e.occurred_at) < julianday(?)")
		params = append(params, r.End)
	}
	params = append(params, trackerID)
	rows, err := s.st.Query(
		`SELECT l.source_id AS source_id,
              s.name AS name,
              s.color AS color,
              l.coefficient AS coefficient,
              COALESCE(l.coefficient * (
                SELECT e.value FROM entries e
                 WHERE `+strings.Join(levelWhere, " AND ")+`
                 ORDER BY julianday(e.occurred_at) DESC, e.id DESC LIMIT 1
              ), 0) AS total,
              (SELECT COUNT(*) FROM entries e
                WHERE `+strings.Join(countWhere, " AND ")+`) AS count
         FROM tracker_links l
         JOIN trackers s ON s.id = l.source_id
        WHERE l.tracker_id = ?
        ORDER BY l.sort_order ASC, l.created_at ASC`, params...)
	if err != nil {
		return nil, err
	}
	return slicesFromRows(rows), nil
}

func slicesFromRows(rows []storage.Row) []CompositionSlice {
	out := make([]CompositionSlice, len(rows))
	for i, r := range rows {
		out[i] = CompositionSlice{
			SourceID:    asString(r.Get("source_id")),
			Name:        asString(r.Get("name")),
			Color:       asString(r.Get("color")),
			Coefficient: asFloat(r.Get("coefficient")),
			Total:       asFloat(r.Get("total")),
			Count:       asInt(r.Get("count")),
		}
	}
	return out
}

// ratioFor clamps current/target to [0, 1]; nil when there is no usable
// target.
func ratioFor(target *float64, current float64) *float64 {
	if target == nil || *target == 0 {
		return nil
	}
	r := current / *target
	if r < 0 {
		r = 0
	}
	if r > 1 {
		r = 1
	}
	return &r
}

var resetToPeriod = map[string]BucketPeriod{
	"daily":   PeriodDay,
	"weekly":  PeriodWeek,
	"monthly": PeriodMonth,
	"yearly":  PeriodYear,
}

// addDays adds delta days to a YYYY-MM-DD string, returning YYYY-MM-DD.
func addDays(day string, delta int) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, delta).Format("2006-01-02")
}
