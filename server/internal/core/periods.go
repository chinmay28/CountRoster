package core

import (
	"fmt"
	"time"
)

// Period bucketing helpers, ported from aggregations/periods.ts.
//
// Like the original, this is host-local-time math: it respects the server's
// timezone but doesn't yet honor a tracker-specific timezone or
// day_start_minute. When that lands, this file is where it goes.

// BucketPeriod is one of day, week, month, year.
type BucketPeriod string

const (
	PeriodDay   BucketPeriod = "day"
	PeriodWeek  BucketPeriod = "week"
	PeriodMonth BucketPeriod = "month"
	PeriodYear  BucketPeriod = "year"
)

// ValidBucketPeriod reports whether s names a bucket period.
func ValidBucketPeriod(s string) bool {
	switch BucketPeriod(s) {
	case PeriodDay, PeriodWeek, PeriodMonth, PeriodYear:
		return true
	}
	return false
}

// bucketStart returns the local-time start of the bucket containing instant.
// weekStart: 0 = Sunday, 1 = Monday (only relevant for week buckets).
func bucketStart(instant time.Time, period BucketPeriod, weekStart int) time.Time {
	l := instant.In(time.Local)
	y, m, d := l.Date()
	midnight := time.Date(y, m, d, 0, 0, 0, 0, time.Local)

	switch period {
	case PeriodDay:
		return midnight
	case PeriodWeek:
		dow := int(midnight.Weekday()) // 0 = Sunday … 6 = Saturday
		diff := (dow - weekStart + 7) % 7
		return time.Date(y, m, d-diff, 0, 0, 0, 0, time.Local)
	case PeriodMonth:
		return time.Date(y, m, 1, 0, 0, 0, 0, time.Local)
	case PeriodYear:
		return time.Date(y, 1, 1, 0, 0, 0, 0, time.Local)
	}
	return midnight
}

// bucketEnd returns the start of the next bucket after the one containing
// instant.
func bucketEnd(instant time.Time, period BucketPeriod, weekStart int) time.Time {
	start := bucketStart(instant, period, weekStart)
	y, m, d := start.Date()
	switch period {
	case PeriodDay:
		return time.Date(y, m, d+1, 0, 0, 0, 0, time.Local)
	case PeriodWeek:
		return time.Date(y, m, d+7, 0, 0, 0, 0, time.Local)
	case PeriodMonth:
		return time.Date(y, m+1, d, 0, 0, 0, 0, time.Local)
	case PeriodYear:
		return time.Date(y+1, m, d, 0, 0, 0, 0, time.Local)
	}
	return start
}

// bucketLabel renders the stable identifier for a bucket starting at start,
// e.g. "2026-05-25", "2026-W21", "2026-05", "2026".
func bucketLabel(start time.Time, period BucketPeriod) string {
	l := start.In(time.Local)
	switch period {
	case PeriodDay:
		return l.Format("2006-01-02")
	case PeriodWeek:
		return l.Format("2006") + "-W" + pad2(isoWeekNumber(l))
	case PeriodMonth:
		return l.Format("2006-01")
	case PeriodYear:
		return l.Format("2006")
	}
	return l.Format("2006-01-02")
}

func pad2(n int) string { return fmt.Sprintf("%02d", n) }

// isoWeekNumber ports the TS helper: ISO 8601 week number (1..53) computed
// from the local calendar date. Note the original derives it from the *local*
// year — labels match the TS output exactly, including its week-53/January
// quirk near year boundaries.
func isoWeekNumber(date time.Time) int {
	y, m, d := date.Date()
	// Shift to Thursday of the same week (ISO weeks are anchored on Thursday).
	dt := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	day := int(dt.Weekday())
	if day == 0 {
		day = 7
	}
	dt = dt.AddDate(0, 0, 4-day)
	yearStart := time.Date(dt.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	weekNo := (int(dt.Sub(yearStart).Hours()/24) + 1 + 6) / 7
	return weekNo
}
