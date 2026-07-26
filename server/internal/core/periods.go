package core

import (
	"fmt"
	"time"
)

// Period bucketing helpers, ported from aggregations/periods.ts.
//
// This is host-local-time math: it respects the server's timezone, honors the
// tracker's custom period window (PeriodWindow), and doesn't yet support a
// tracker-specific timezone. When that lands, this file is where it goes.

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

// PeriodWindow is a tracker's definition of where its periods begin: the four
// tracker columns that shift bucket boundaries off the plain calendar.
//
// The zero value is not meaningful — build one with NewPeriodWindow (or
// windowOf for a tracker), which fills in the schema defaults and clamps
// out-of-range values, so a window built from a hand-written row still
// produces calendar buckets rather than nonsense.
type PeriodWindow struct {
	// Minutes after local midnight a day begins: 420 runs a day 7:00 AM →
	// 6:59 AM. Shifts every period, since all of them start on a day.
	DayStartMinute int
	// Weekday a week begins on: 0 = Sunday, 1 = Monday.
	WeekStart int
	// Day-of-month a month begins on, 1..28: 8 runs a month the 8th → the
	// 7th of the next month. Also the day a year begins on.
	MonthStartDay int
	// Month a year begins on, 1..12: 4 runs a year April → March.
	YearStartMonth int
}

// DefaultPeriodWindow is plain calendar bucketing: midnight, Monday weeks, the
// 1st of the month, January. It matches the columns' SQL defaults.
var DefaultPeriodWindow = PeriodWindow{DayStartMinute: 0, WeekStart: 1, MonthStartDay: 1, YearStartMonth: 1}

// NewPeriodWindow builds a window, replacing out-of-range components with the
// calendar default.
func NewPeriodWindow(dayStartMinute, weekStart, monthStartDay, yearStartMonth int) PeriodWindow {
	w := DefaultPeriodWindow
	if dayStartMinute >= 0 && dayStartMinute <= 1439 {
		w.DayStartMinute = dayStartMinute
	}
	if weekStart == 0 || weekStart == 1 {
		w.WeekStart = weekStart
	}
	if monthStartDay >= 1 && monthStartDay <= 28 {
		w.MonthStartDay = monthStartDay
	}
	if yearStartMonth >= 1 && yearStartMonth <= 12 {
		w.YearStartMonth = yearStartMonth
	}
	return w
}

// windowOf reads a tracker's period window; a missing tracker buckets by the
// plain calendar.
func windowOf(t *Tracker) PeriodWindow {
	if t == nil {
		return DefaultPeriodWindow
	}
	return NewPeriodWindow(t.DayStartMinute, t.WeekStart, t.MonthStartDay, t.YearStartMonth)
}

// dayStart returns the start of the *logical* day containing instant — local
// midnight plus DayStartMinute, stepping back a calendar day for an instant
// that falls before the day has opened (03:30 with a 7:00 AM day start still
// belongs to the previous day).
func (w PeriodWindow) dayStart(instant time.Time) time.Time {
	l := instant.In(time.Local)
	y, m, d := l.Date()
	if l.Hour()*60+l.Minute() < w.DayStartMinute {
		d--
	}
	return time.Date(y, m, d, 0, w.DayStartMinute, 0, 0, time.Local)
}

// bucketStart returns the local-time start of the bucket containing instant.
func bucketStart(instant time.Time, period BucketPeriod, w PeriodWindow) time.Time {
	// Every period opens at a day boundary, so start from the logical day and
	// walk back to the period's first day. Date() below therefore reads the
	// logical day's calendar date, not the raw instant's.
	day := w.dayStart(instant)
	y, m, d := day.Date()

	switch period {
	case PeriodDay:
		return day
	case PeriodWeek:
		dow := int(day.Weekday()) // 0 = Sunday … 6 = Saturday
		diff := (dow - w.WeekStart + 7) % 7
		return w.at(y, m, d-diff)
	case PeriodMonth:
		// Before this month's opening day, we're still in the window that
		// opened last month. time.Date normalizes month 0 to last December.
		if d < w.MonthStartDay {
			m--
		}
		return w.at(y, m, w.MonthStartDay)
	case PeriodYear:
		start := w.at(y, time.Month(w.YearStartMonth), w.MonthStartDay)
		if day.Before(start) {
			start = w.at(y-1, time.Month(w.YearStartMonth), w.MonthStartDay)
		}
		return start
	}
	return day
}

// at builds a bucket boundary: the given local date at the window's day-start
// minute. Out-of-range components normalize as time.Date does (month 0 = last
// December, day 0 = last day of the previous month).
func (w PeriodWindow) at(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, w.DayStartMinute, 0, 0, time.Local)
}

// bucketEnd returns the start of the next bucket after the one containing
// instant.
func bucketEnd(instant time.Time, period BucketPeriod, w PeriodWindow) time.Time {
	start := bucketStart(instant, period, w)
	y, m, d := start.Date()
	switch period {
	case PeriodDay:
		return w.at(y, m, d+1)
	case PeriodWeek:
		return w.at(y, m, d+7)
	case PeriodMonth:
		// d is MonthStartDay (≤ 28), so the next month always has it.
		return w.at(y, m+1, d)
	case PeriodYear:
		return w.at(y+1, m, d)
	}
	return start
}

// bucketLabel renders the stable identifier for a bucket starting at start,
// e.g. "2026-05-25", "2026-W21", "2026-05", "2026". With a custom window the
// label names the calendar date/month/year the bucket *opens* in: a month
// window running May 8 → June 7 is labelled "2026-05".
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
