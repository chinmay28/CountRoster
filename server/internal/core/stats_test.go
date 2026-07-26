package core

import (
	"fmt"
	"testing"
	"time"

	"github.com/chinmay28/countroster/server/internal/timeutil"
)

func mayDay(d string, h int) string {
	return fmt.Sprintf("2026-05-%sT%02d:00:00.000-07:00", d, h)
}

func TestBucketSumsPerDayZeroFillingGaps(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Steps", "kind", "number"))
	mustLog(t, a, tr.ID, obj("value", 3, "occurred_at", mayDay("20", 12)))
	mustLog(t, a, tr.ID, obj("value", 4, "occurred_at", mayDay("20", 18)))
	mustLog(t, a, tr.ID, obj("value", 5, "occurred_at", mayDay("22", 12)))

	buckets, err := a.Stats.Bucket(tr.ID, mayDay("20", 0), mayDay("23", 0), PeriodDay)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(buckets); i++ {
		if buckets[i].Start != buckets[i-1].End {
			t.Error("buckets should tile the range contiguously")
		}
	}
	total, count, hasEmpty := 0.0, 0, false
	for _, b := range buckets {
		total += b.Value
		count += b.Count
		if b.Value == 0 && b.Count == 0 {
			hasEmpty = true
		}
	}
	if total != 12 || count != 3 || !hasEmpty {
		t.Errorf("total=%v count=%d hasEmpty=%v", total, count, hasEmpty)
	}
}

func TestBucketFiltersByInstantAcrossOffsets(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Steps", "kind", "number"))
	// 2026-05-20T12:00-07:00 is 19:00Z — inside the range by instant, but
	// lexically "…T12" sorts before the "…T15" start bound.
	mustLog(t, a, tr.ID, obj("value", 7, "occurred_at", mayDay("20", 12)))

	buckets, err := a.Stats.Bucket(tr.ID,
		"2026-05-20T15:00:00.000Z", "2026-05-21T00:00:00.000Z", PeriodDay)
	if err != nil {
		t.Fatal(err)
	}
	total, count := 0.0, 0
	for _, b := range buckets {
		total += b.Value
		count += b.Count
	}
	if total != 7 || count != 1 {
		t.Errorf("total=%v count=%d", total, count)
	}
}

func TestStreakCurrentRunEndingToday(t *testing.T) {
	a := newTestApp(t) // clock = 2026-05-25
	tr := mustCreate(t, a, obj("name", "Floss", "kind", "boolean"))
	for _, d := range []string{"23", "24", "25"} {
		mustLog(t, a, tr.ID, obj("value", 1, "occurred_at", mayDay(d, 12)))
	}
	s, _ := a.Stats.StreakFor(tr.ID)
	if s.Current != 3 || s.Longest != 3 {
		t.Errorf("streak wrong: %+v", s)
	}
}

func TestStreakAnchorsToYesterday(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Floss", "kind", "boolean"))
	for _, d := range []string{"23", "24"} {
		mustLog(t, a, tr.ID, obj("value", 1, "occurred_at", mayDay(d, 12)))
	}
	s, _ := a.Stats.StreakFor(tr.ID)
	if s.Current != 2 || s.Longest != 2 {
		t.Errorf("streak wrong: %+v", s)
	}
}

func TestStreakBreaksOnGap(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Floss", "kind", "boolean"))
	for _, d := range []string{"18", "19", "20", "25"} {
		mustLog(t, a, tr.ID, obj("value", 1, "occurred_at", mayDay(d, 12)))
	}
	s, _ := a.Stats.StreakFor(tr.ID)
	if s.Current != 1 || s.Longest != 3 {
		t.Errorf("streak wrong: %+v", s)
	}
}

func TestStreakEmptyTracker(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Empty"))
	s, _ := a.Stats.StreakFor(tr.ID)
	if s.Current != 0 || s.Longest != 0 {
		t.Errorf("streak wrong: %+v", s)
	}
}

func TestTargetProgressAllTime(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Books", "kind", "count",
		"target", 10, "reset_period", "never"))
	mustLog(t, a, tr.ID, obj("value", 4, "occurred_at", mayDay("01", 12)))
	mustLog(t, a, tr.ID, obj("value", 3, "occurred_at", mayDay("20", 12)))

	p, _ := a.Stats.TargetProgressFor(tr.ID, "")
	if p.Target == nil || *p.Target != 10 || p.Current != 7 {
		t.Errorf("progress wrong: %+v", p)
	}
	if p.Ratio == nil || *p.Ratio < 0.699 || *p.Ratio > 0.701 {
		t.Errorf("ratio wrong: %v", p.Ratio)
	}
}

func TestTargetProgressDailyClampsRatio(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Water", "kind", "count",
		"target", 2, "reset_period", "daily"))
	mustLog(t, a, tr.ID, obj("value", 2))
	mustLog(t, a, tr.ID, obj("value", 3))

	p, _ := a.Stats.TargetProgressFor(tr.ID, "")
	if p.Current != 5 || p.Ratio == nil || *p.Ratio != 1 {
		t.Errorf("progress wrong: %+v", p)
	}
}

func TestTargetProgressNullTarget(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Mood", "kind", "number"))
	mustLog(t, a, tr.ID, obj("value", 1))
	p, _ := a.Stats.TargetProgressFor(tr.ID, "")
	if p.Target != nil || p.Ratio != nil || p.Current != 1 {
		t.Errorf("progress wrong: %+v", p)
	}
}

// --- period bucketing (ports periods.test.ts) --------------------------------

func TestBucketStartDay(t *testing.T) {
	instant := time.Date(2026, 5, 25, 14, 32, 0, 0, time.Local)
	start := bucketStart(instant, PeriodDay, DefaultPeriodWindow)
	if start.Hour() != 0 || start.Minute() != 0 || start.Day() != 25 {
		t.Errorf("day start wrong: %v", start)
	}
}

func TestBucketStartWeekMonday(t *testing.T) {
	wed := time.Date(2026, 5, 27, 14, 0, 0, 0, time.Local)
	start := bucketStart(wed, PeriodWeek, DefaultPeriodWindow)
	if start.Weekday() != time.Monday || start.Day() != 25 {
		t.Errorf("week start wrong: %v", start)
	}
}

var sundayWeek = NewPeriodWindow(0, 0, 1, 1)

func TestBucketStartWeekSunday(t *testing.T) {
	wed := time.Date(2026, 5, 27, 14, 0, 0, 0, time.Local)
	start := bucketStart(wed, PeriodWeek, sundayWeek)
	if start.Weekday() != time.Sunday || start.Day() != 24 {
		t.Errorf("week start wrong: %v", start)
	}
}

func TestBucketStartMonthYear(t *testing.T) {
	instant := time.Date(2026, 5, 25, 14, 0, 0, 0, time.Local)
	if s := bucketStart(instant, PeriodMonth, DefaultPeriodWindow); s.Day() != 1 || s.Month() != 5 {
		t.Errorf("month start wrong: %v", s)
	}
	if s := bucketStart(instant, PeriodYear, DefaultPeriodWindow); s.Month() != 1 || s.Day() != 1 || s.Year() != 2026 {
		t.Errorf("year start wrong: %v", s)
	}
}

func TestBucketEnds(t *testing.T) {
	instant := time.Date(2026, 5, 25, 14, 0, 0, 0, time.Local)
	if e := bucketEnd(instant, PeriodDay, DefaultPeriodWindow); e.Day() != 26 || e.Hour() != 0 {
		t.Errorf("day end wrong: %v", e)
	}
	wed := time.Date(2026, 5, 27, 14, 0, 0, 0, time.Local)
	start := bucketStart(wed, PeriodWeek, DefaultPeriodWindow)
	end := bucketEnd(wed, PeriodWeek, DefaultPeriodWindow)
	if end.Sub(start) != 7*24*time.Hour {
		t.Errorf("week span wrong: %v", end.Sub(start))
	}
	if e := bucketEnd(instant, PeriodMonth, DefaultPeriodWindow); e.Day() != 1 || e.Month() != 6 {
		t.Errorf("month end wrong: %v", e)
	}
}

func TestBucketLabels(t *testing.T) {
	if l := bucketLabel(time.Date(2026, 1, 5, 0, 0, 0, 0, time.Local), PeriodDay); l != "2026-01-05" {
		t.Errorf("day label wrong: %s", l)
	}
	if l := bucketLabel(time.Date(2026, 5, 1, 0, 0, 0, 0, time.Local), PeriodMonth); l != "2026-05" {
		t.Errorf("month label wrong: %s", l)
	}
	if l := bucketLabel(time.Date(2026, 1, 1, 0, 0, 0, 0, time.Local), PeriodYear); l != "2026" {
		t.Errorf("year label wrong: %s", l)
	}
	if l := bucketLabel(time.Date(2026, 1, 5, 0, 0, 0, 0, time.Local), PeriodWeek); l != "2026-W02" {
		t.Errorf("week label wrong: %s", l)
	}
}

// --- custom period windows ---------------------------------------------------

// localISO renders a local wall-clock instant the way entries are stored.
func localISO(y int, m time.Month, d, h, min int) string {
	return timeutil.ToLocalISO(time.Date(y, m, d, h, min, 0, 0, time.Local))
}

func TestDayWindowStartsAtDayStartMinute(t *testing.T) {
	// A day running 7:00 AM → 6:59 AM.
	w := NewPeriodWindow(7*60, 1, 1, 1)

	// 3:30 AM on the 25th is still the 24th's day.
	early := time.Date(2026, 5, 25, 3, 30, 0, 0, time.Local)
	if s := bucketStart(early, PeriodDay, w); s.Day() != 24 || s.Hour() != 7 || s.Minute() != 0 {
		t.Errorf("pre-dawn instant should fall in the previous day: %v", s)
	}
	if e := bucketEnd(early, PeriodDay, w); e.Day() != 25 || e.Hour() != 7 {
		t.Errorf("day end wrong: %v", e)
	}
	// 9:00 AM is in the 25th's day.
	late := time.Date(2026, 5, 25, 9, 0, 0, 0, time.Local)
	if s := bucketStart(late, PeriodDay, w); s.Day() != 25 || s.Hour() != 7 {
		t.Errorf("morning instant should open the day: %v", s)
	}
	// Exactly at the boundary the new day opens.
	if s := bucketStart(time.Date(2026, 5, 25, 7, 0, 0, 0, time.Local), PeriodDay, w); s.Day() != 25 {
		t.Errorf("boundary instant should open the day: %v", s)
	}
	// The label names the day the window opens in, so a 3:30 AM entry is
	// labelled with the previous date.
	if l := bucketLabel(bucketStart(early, PeriodDay, w), PeriodDay); l != "2026-05-24" {
		t.Errorf("day label wrong: %s", l)
	}
}

func TestWeekAndMonthWindowsShiftWithDayStart(t *testing.T) {
	w := NewPeriodWindow(7*60, 1, 1, 1)
	// Monday 3:30 AM still belongs to the week that opened the previous Monday.
	mondayEarly := time.Date(2026, 5, 25, 3, 30, 0, 0, time.Local) // Mon
	if s := bucketStart(mondayEarly, PeriodWeek, w); s.Day() != 18 || s.Hour() != 7 {
		t.Errorf("week start wrong: %v", s)
	}
	// The 1st at 3:30 AM still belongs to the previous month's window.
	firstEarly := time.Date(2026, 5, 1, 3, 30, 0, 0, time.Local)
	if s := bucketStart(firstEarly, PeriodMonth, w); s.Month() != 4 || s.Day() != 1 || s.Hour() != 7 {
		t.Errorf("month start wrong: %v", s)
	}
}

func TestMonthWindowStartsOnMonthStartDay(t *testing.T) {
	// Months running the 8th → the 7th of the next month.
	w := NewPeriodWindow(0, 1, 8, 1)

	if s := bucketStart(time.Date(2026, 5, 20, 12, 0, 0, 0, time.Local), PeriodMonth, w); s.Month() != 5 || s.Day() != 8 {
		t.Errorf("after the 8th should open in May: %v", s)
	}
	// The 3rd is still inside the window that opened on April 8th.
	before := time.Date(2026, 5, 3, 12, 0, 0, 0, time.Local)
	if s := bucketStart(before, PeriodMonth, w); s.Month() != 4 || s.Day() != 8 {
		t.Errorf("before the 8th should open in April: %v", s)
	}
	if e := bucketEnd(before, PeriodMonth, w); e.Month() != 5 || e.Day() != 8 {
		t.Errorf("month end wrong: %v", e)
	}
	// January's window opens the 8th; the 3rd belongs to December's.
	if s := bucketStart(time.Date(2026, 1, 3, 12, 0, 0, 0, time.Local), PeriodMonth, w); s.Year() != 2025 || s.Month() != 12 || s.Day() != 8 {
		t.Errorf("year boundary wrong: %v", s)
	}
	if l := bucketLabel(bucketStart(before, PeriodMonth, w), PeriodMonth); l != "2026-04" {
		t.Errorf("month label wrong: %s", l)
	}
}

func TestYearWindowStartsOnYearStartMonth(t *testing.T) {
	// A fiscal year running April 1 → March 31.
	w := NewPeriodWindow(0, 1, 1, 4)
	if s := bucketStart(time.Date(2026, 5, 20, 12, 0, 0, 0, time.Local), PeriodYear, w); s.Year() != 2026 || s.Month() != 4 {
		t.Errorf("May should sit in the year that opened April 2026: %v", s)
	}
	feb := time.Date(2026, 2, 10, 12, 0, 0, 0, time.Local)
	if s := bucketStart(feb, PeriodYear, w); s.Year() != 2025 || s.Month() != 4 {
		t.Errorf("February should sit in the year that opened April 2025: %v", s)
	}
	if e := bucketEnd(feb, PeriodYear, w); e.Year() != 2026 || e.Month() != 4 || e.Day() != 1 {
		t.Errorf("year end wrong: %v", e)
	}
	// A year opening on the 6th of April (UK tax year).
	uk := NewPeriodWindow(0, 1, 6, 4)
	if s := bucketStart(time.Date(2026, 4, 5, 12, 0, 0, 0, time.Local), PeriodYear, uk); s.Year() != 2025 || s.Month() != 4 || s.Day() != 6 {
		t.Errorf("April 5th should still be the previous tax year: %v", s)
	}
}

func TestOutOfRangeWindowComponentsFallBackToCalendar(t *testing.T) {
	// A row written before migration 006 reads back as 0/0 for the new
	// columns; those must not produce a month starting on day 0.
	w := NewPeriodWindow(0, 1, 0, 0)
	if w.MonthStartDay != 1 || w.YearStartMonth != 1 {
		t.Errorf("window should fall back to the calendar: %+v", w)
	}
}

func TestBucketUsesTrackerPeriodWindow(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Rent", "kind", "number", "month_start_day", 8))
	if tr.MonthStartDay != 8 {
		t.Fatalf("month_start_day not persisted: %+v", tr)
	}
	// May 3rd belongs to the window that opened April 8th; May 20th to May's.
	mustLog(t, a, tr.ID, obj("value", 10, "occurred_at", localISO(2026, 5, 3, 12, 0)))
	mustLog(t, a, tr.ID, obj("value", 4, "occurred_at", localISO(2026, 5, 20, 12, 0)))

	buckets, err := a.Stats.Bucket(tr.ID,
		localISO(2026, 4, 8, 0, 0), localISO(2026, 6, 8, 0, 0), PeriodMonth)
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 2 {
		t.Fatalf("expected 2 monthly buckets, got %d: %+v", len(buckets), buckets)
	}
	if buckets[0].Label != "2026-04" || buckets[0].Value != 10 {
		t.Errorf("first bucket wrong: %+v", buckets[0])
	}
	if buckets[1].Label != "2026-05" || buckets[1].Value != 4 {
		t.Errorf("second bucket wrong: %+v", buckets[1])
	}
}

func TestTargetProgressUsesDayWindow(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Water", "kind", "number",
		"reset_period", "daily", "target", 8, "day_start_minute", 7*60))
	// Logged at 3:00 AM on the 25th — still the 24th's day…
	mustLog(t, a, tr.ID, obj("value", 5, "occurred_at", localISO(2026, 5, 25, 3, 0)))

	// …so at 9:00 AM on the 25th, today's total is 0.
	p, err := a.Stats.TargetProgressFor(tr.ID, localISO(2026, 5, 25, 9, 0))
	if err != nil {
		t.Fatal(err)
	}
	if p.Current != 0 {
		t.Errorf("post-rollover total should be 0, got %v", p.Current)
	}
	// At 4:00 AM the same night it's still counted.
	p, err = a.Stats.TargetProgressFor(tr.ID, localISO(2026, 5, 25, 4, 0))
	if err != nil {
		t.Fatal(err)
	}
	if p.Current != 5 {
		t.Errorf("pre-rollover total should be 5, got %v", p.Current)
	}
}

func TestStreakUsesDayWindow(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Journal", "kind", "count", "day_start_minute", 7*60))
	// Three consecutive days' worth of logging, the last one written after
	// midnight — which the day window folds back into the 24th.
	mustLog(t, a, tr.ID, obj("value", 1, "occurred_at", localISO(2026, 5, 23, 20, 0)))
	mustLog(t, a, tr.ID, obj("value", 1, "occurred_at", localISO(2026, 5, 24, 20, 0)))
	mustLog(t, a, tr.ID, obj("value", 1, "occurred_at", localISO(2026, 5, 25, 2, 0)))

	a.setTime(localISO(2026, 5, 25, 3, 0)) // still the 24th's day
	s, err := a.Stats.StreakFor(tr.ID)
	if err != nil {
		t.Fatal(err)
	}
	if s.Current != 2 || s.Longest != 2 {
		t.Errorf("streak should fold the 2 AM entry into the 24th: %+v", s)
	}
}
