// Package version carries the application version.
//
// The scheme is MAJOR.MINOR.PATCH where the patch number is the repository's
// commit count — every commit is a patch release, so `1.1.311` is the 311th
// commit on the 1.1 line. Major and minor are declared here in source and
// bumped by hand; the patch number can only come from git, which a compiled
// binary has no access to, so it is stamped at link time instead:
//
//	go build -ldflags "-X github.com/chinmay28/countroster/server/internal/version.Patch=$(git rev-list --count HEAD)"
//
// `npm run build` (and `build:server`) does this for you via scripts/version.mjs,
// which is also what the web client's build reads Major/Minor from — keep the
// two constants below in a form that file's regex can still find.
package version

import "strconv"

// Major and minor version. Bump these by hand.
const (
	Major = 1
	Minor = 1
)

// Patch is the repository's commit count, stamped at link time (see the
// package comment). A bare `go build` leaves it at "0": patch 0 means an
// unstamped development build, never a release.
var Patch = "0"

// String renders the full MAJOR.MINOR.PATCH version.
func String() string {
	return strconv.Itoa(Major) + "." + strconv.Itoa(Minor) + "." + Patch
}
