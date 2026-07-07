package core

import (
	"fmt"
	"strings"
)

// NotFoundError maps to HTTP 404. Kind is the entity name used in the
// message ("Tracker", "Entry", "Note", "Group").
type NotFoundError struct {
	Kind string
	ID   string
}

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("%s not found: %s", e.Kind, e.ID)
}

// DerivedTrackerError flags an invalid derivation (logging on a derived
// tracker, self/missing/derived/duplicate source, mixed visibility). Maps to
// HTTP 400.
type DerivedTrackerError struct{ Message string }

func (e *DerivedTrackerError) Error() string { return e.Message }

// TrackerInUseError is raised when archiving or deleting a tracker that
// derived trackers still use as a source. Maps to HTTP 409.
type TrackerInUseError struct {
	TrackerID  string
	Dependents []struct{ ID, Name string }
	Action     string
}

func (e *TrackerInUseError) Error() string {
	names := make([]string, len(e.Dependents))
	for i, d := range e.Dependents {
		names[i] = `"` + d.Name + `"`
	}
	plural, them := "", "it"
	if len(e.Dependents) != 1 {
		plural, them = "s", "them"
	}
	return fmt.Sprintf(
		"Cannot %s this tracker: it is a source for derived tracker%s %s. Delete or unlink %s first.",
		e.Action, plural, strings.Join(names, ", "), them)
}

// Issue is one validation failure, in the same rough shape as a Zod issue so
// the 400 response body stays familiar.
type Issue struct {
	Code    string `json:"code"`
	Path    []any  `json:"path"`
	Message string `json:"message"`
}

// ValidationError maps to HTTP 400 with body
// {"error":"Validation failed","issues":[...]}.
type ValidationError struct{ Issues []Issue }

func (e *ValidationError) Error() string {
	if len(e.Issues) == 0 {
		return "Validation failed"
	}
	return fmt.Sprintf("Validation failed: %s", e.Issues[0].Message)
}
