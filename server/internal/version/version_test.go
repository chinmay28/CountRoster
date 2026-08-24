package version

import (
	"regexp"
	"testing"
)

// The rendered form is a release tag and a string the CLI, /api/health, the
// backup manifest, and the PWA header all carry, so its shape is a contract:
// v, a four-digit year, the month, then the commit count. No leading zero on
// the month — that is what keeps the tag valid semver. Deliberately no literal
// version here: the patch changes with every commit.
func TestStringIsCalendarVersioned(t *testing.T) {
	want := regexp.MustCompile(`^v\d{4}\.([1-9]|1[0-2])\.\d+$`)
	if got := String(); !want.MatchString(got) {
		t.Errorf("String() = %q, want vYEAR.MONTH.PATCH with an unpadded month", got)
	}
}

func TestMonthIsACalendarMonth(t *testing.T) {
	if Month < 1 || Month > 12 {
		t.Errorf("Month = %d, want a calendar month (1–12)", Month)
	}
}
