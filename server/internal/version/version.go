// Package version carries the application version.
//
// The scheme is calendar-based: vYEAR.MONTH.PATCH. YEAR.MONTH is the month of
// the commit being built (its committer date, in UTC), and PATCH is the
// repository's commit count, so every commit is a patch release and the
// version moves to a new month by itself with the first commit made in it.
// The month is written as a plain number, not zero-padded: that keeps the
// string valid semver, which forbids a leading zero, and nothing here orders
// versions by sorting text.
//
// Both halves come from the commit, never from the build clock: building the
// same commit twice — today, or in a year — yields the same version, which is
// what lets the release workflow refuse a tag that isn't the version its
// commit builds. A compiled binary can't ask git, so the values are stamped at
// link time; scripts/version.mjs assembles them (`--ldflags` prints the flags):
//
//	go build -ldflags "$(node scripts/version.mjs --ldflags)"
//
// A plain `go build` inside a git checkout still gets YEAR.MONTH right: Go
// records the commit time in the binary's build info (vcs.time). Only the
// commit count is missing then, and patch 0 marks the build as unstamped.
package version

import (
	"runtime/debug"
	"strconv"
	"time"
)

// Year, Month and Patch are stamped at link time (see the package comment).
// Unstamped, Year and Month fall back to the commit time Go embedded, then to
// "0"; Patch stays "0", the marker of a development build, never a release.
var (
	Year  = ""
	Month = ""
	Patch = "0"
)

// String renders the full version, `v`-prefixed to match how the project tags
// releases (v2026.10.512). This is the one rendering — it's what the CLI
// prints, what /api/health reports, what a backup manifest records, and what
// the PWA shows.
func String() string {
	year, month := Year, Month
	if year == "" || month == "" {
		year, month = fromBuildInfo()
	}
	return render(year, month, Patch)
}

func render(year, month, patch string) string {
	return "v" + year + "." + month + "." + patch
}

// fromBuildInfo reads YEAR.MONTH from the commit time Go stamps into binaries
// built from a git checkout; "0", "0" when there is none (go run, go test, a
// tarball build).
func fromBuildInfo() (year, month string) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "0", "0"
	}
	return yearMonthOf(info.Settings)
}

func yearMonthOf(settings []debug.BuildSetting) (year, month string) {
	for _, s := range settings {
		if s.Key != "vcs.time" {
			continue
		}
		t, err := time.Parse(time.RFC3339, s.Value)
		if err != nil {
			break
		}
		t = t.UTC()
		return strconv.Itoa(t.Year()), strconv.Itoa(int(t.Month()))
	}
	return "0", "0"
}
