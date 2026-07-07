package core

import "testing"

func TestSnapshotDefaultsOff(t *testing.T) {
	a := newTestApp(t)
	if tr := mustCreate(t, a, obj("name", "Coffee")); tr.IsSnapshot != 0 {
		t.Error("ordinary tracker should not be a snapshot")
	}
}

func TestSnapshotNormalizesResetPeriodOnCreate(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Net worth", "kind", "number",
		"is_snapshot", 1, "reset_period", "monthly"))
	if tr.IsSnapshot != 1 || tr.ResetPeriod != "never" {
		t.Errorf("snapshot should force reset_period=never: %+v", tr)
	}
}

func TestSnapshotNormalizesResetPeriodOnUpdate(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Weight", "reset_period", "weekly"))
	updated, err := a.Trackers.Update(tr.ID, obj("is_snapshot", 1))
	if err != nil {
		t.Fatal(err)
	}
	if updated.IsSnapshot != 1 || updated.ResetPeriod != "never" {
		t.Errorf("becoming a snapshot should repair reset_period: %+v", updated)
	}

	patched, err := a.Trackers.Update(tr.ID, obj("reset_period", "daily"))
	if err != nil {
		t.Fatal(err)
	}
	if patched.ResetPeriod != "never" {
		t.Errorf("snapshot reset_period must stay never: %+v", patched)
	}
}

func TestSnapshotBucketsTakeLastReading(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Net worth", "kind", "number", "is_snapshot", 1))

	mustLog(t, a, tr.ID, obj("value", 1000, "occurred_at", "2026-04-05T10:00:00.000-07:00"))
	mustLog(t, a, tr.ID, obj("value", 1200, "occurred_at", "2026-04-20T10:00:00.000-07:00"))
	mustLog(t, a, tr.ID, obj("value", 1100, "occurred_at", "2026-05-10T10:00:00.000-07:00"))

	buckets, err := a.Stats.Bucket(tr.ID,
		"2026-03-01T00:00:00.000-07:00", "2026-06-01T00:00:00.000-07:00", PeriodMonth)
	if err != nil {
		t.Fatal(err)
	}
	var populated []StatBucket
	hasEmpty := false
	for _, b := range buckets {
		if b.Count > 0 {
			populated = append(populated, b)
		} else {
			hasEmpty = true
		}
	}
	if len(populated) != 2 ||
		populated[0].Value != 1200 || populated[0].Count != 2 ||
		populated[1].Value != 1100 || populated[1].Count != 1 {
		t.Errorf("populated buckets wrong: %+v", populated)
	}
	if !hasEmpty {
		t.Error("March should stay empty")
	}
}

func TestOrdinaryBucketsStillSum(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Sales", "kind", "number"))
	mustLog(t, a, tr.ID, obj("value", 10, "occurred_at", "2026-04-05T10:00:00.000-07:00"))
	mustLog(t, a, tr.ID, obj("value", 15, "occurred_at", "2026-04-20T10:00:00.000-07:00"))

	buckets, err := a.Stats.Bucket(tr.ID,
		"2026-04-01T00:00:00.000-07:00", "2026-05-01T00:00:00.000-07:00", PeriodMonth)
	if err != nil {
		t.Fatal(err)
	}
	if buckets[0].Value != 25 {
		t.Errorf("ordinary bucket should sum: %+v", buckets[0])
	}
}

func TestSnapshotTargetProgressUsesLatest(t *testing.T) {
	a := newTestApp(t)
	tr := mustCreate(t, a, obj("name", "Net worth", "kind", "number",
		"is_snapshot", 1, "target", 2000))
	mustLog(t, a, tr.ID, obj("value", 800, "occurred_at", "2026-05-01T10:00:00.000-07:00"))
	mustLog(t, a, tr.ID, obj("value", 1000, "occurred_at", "2026-05-20T10:00:00.000-07:00"))

	p, err := a.Stats.TargetProgressFor(tr.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Current != 1000 || p.Ratio == nil || *p.Ratio != 0.5 {
		t.Errorf("snapshot progress wrong: %+v", p)
	}
}
