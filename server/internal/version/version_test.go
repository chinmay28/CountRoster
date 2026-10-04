package version

import (
	"regexp"
	"runtime/debug"
	"testing"
)

// The rendered form is a release tag and a string the CLI, /api/health, the
// backup manifest, and the PWA header all carry, so its shape is a contract:
// v, a four-digit year, the month, then the commit count. No leading zero on
// the month — that is what keeps the tag valid semver. Deliberately no literal
// version here: it changes with every commit.
var calendarVersion = regexp.MustCompile(`^v\d{4}\.([1-9]|1[0-2])\.\d+$`)

func TestStringIsCalendarVersionedOrUnstamped(t *testing.T) {
	// A test binary carries no vcs stamp, so v0.0.0 is legitimate here; a
	// built binary is checked through the stamped and build-info paths below.
	if got := String(); got != "v0.0.0" && !calendarVersion.MatchString(got) {
		t.Errorf("String() = %q, want vYEAR.MONTH.PATCH or the unstamped v0.0.0", got)
	}
}

func TestStampedValuesWin(t *testing.T) {
	defer func(y, m, p string) { Year, Month, Patch = y, m, p }(Year, Month, Patch)
	Year, Month, Patch = "2026", "10", "512"
	if got := String(); got != "v2026.10.512" {
		t.Errorf("String() = %q", got)
	}
}

func TestBuildInfoGivesTheCommitsMonthInUTC(t *testing.T) {
	cases := []struct {
		settings    []debug.BuildSetting
		year, month string
	}{
		{[]debug.BuildSetting{{Key: "vcs.time", Value: "2026-10-03T15:54:49Z"}}, "2026", "10"},
		// The month is the commit's in UTC, so every builder agrees on it.
		{[]debug.BuildSetting{{Key: "vcs.time", Value: "2026-10-31T23:30:00-07:00"}}, "2026", "11"},
		{[]debug.BuildSetting{{Key: "vcs", Value: "git"}}, "0", "0"},
		{[]debug.BuildSetting{{Key: "vcs.time", Value: "yesterday"}}, "0", "0"},
	}
	for _, c := range cases {
		y, m := yearMonthOf(c.settings)
		if y != c.year || m != c.month {
			t.Errorf("yearMonthOf(%v) = %s.%s, want %s.%s", c.settings, y, m, c.year, c.month)
		}
		if v := render(y, m, "7"); y != "0" && !calendarVersion.MatchString(v) {
			t.Errorf("render = %q isn't a calendar version", v)
		}
	}
}
