package core

import (
	"fmt"
	"testing"
	"time"
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
	start := bucketStart(instant, PeriodDay, 1)
	if start.Hour() != 0 || start.Minute() != 0 || start.Day() != 25 {
		t.Errorf("day start wrong: %v", start)
	}
}

func TestBucketStartWeekMonday(t *testing.T) {
	wed := time.Date(2026, 5, 27, 14, 0, 0, 0, time.Local)
	start := bucketStart(wed, PeriodWeek, 1)
	if start.Weekday() != time.Monday || start.Day() != 25 {
		t.Errorf("week start wrong: %v", start)
	}
}

func TestBucketStartWeekSunday(t *testing.T) {
	wed := time.Date(2026, 5, 27, 14, 0, 0, 0, time.Local)
	start := bucketStart(wed, PeriodWeek, 0)
	if start.Weekday() != time.Sunday || start.Day() != 24 {
		t.Errorf("week start wrong: %v", start)
	}
}

func TestBucketStartMonthYear(t *testing.T) {
	instant := time.Date(2026, 5, 25, 14, 0, 0, 0, time.Local)
	if s := bucketStart(instant, PeriodMonth, 1); s.Day() != 1 || s.Month() != 5 {
		t.Errorf("month start wrong: %v", s)
	}
	if s := bucketStart(instant, PeriodYear, 1); s.Month() != 1 || s.Day() != 1 || s.Year() != 2026 {
		t.Errorf("year start wrong: %v", s)
	}
}

func TestBucketEnds(t *testing.T) {
	instant := time.Date(2026, 5, 25, 14, 0, 0, 0, time.Local)
	if e := bucketEnd(instant, PeriodDay, 1); e.Day() != 26 || e.Hour() != 0 {
		t.Errorf("day end wrong: %v", e)
	}
	wed := time.Date(2026, 5, 27, 14, 0, 0, 0, time.Local)
	start := bucketStart(wed, PeriodWeek, 1)
	end := bucketEnd(wed, PeriodWeek, 1)
	if end.Sub(start) != 7*24*time.Hour {
		t.Errorf("week span wrong: %v", end.Sub(start))
	}
	if e := bucketEnd(instant, PeriodMonth, 1); e.Day() != 1 || e.Month() != 6 {
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
