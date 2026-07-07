package core

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// This file ports the Zod input schemas (schema/validators.ts). Inputs are
// pre-decoded JSON (json.Number for numbers); unknown keys are ignored, just
// as Zod strips them. Patches must distinguish "absent" from "explicit null"
// from "value" — Opt carries that tri-state.

// Opt is a tri-state patch field: absent, explicit null, or a value.
type Opt[T any] struct {
	Present bool
	Null    bool
	Value   T
}

// Set reports whether the field carries a usable value (present, non-null).
func (o Opt[T]) Set() bool { return o.Present && !o.Null }

var (
	hexColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	datetimeRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)
)

var trackerKinds = map[string]bool{
	"count": true, "number": true, "duration": true, "boolean": true, "choice": true,
}

var resetPeriods = map[string]bool{
	"never": true, "daily": true, "weekly": true, "monthly": true, "yearly": true,
}

type vctx struct{ issues []Issue }

func (c *vctx) add(code, msg string, path ...any) {
	if path == nil {
		path = []any{}
	}
	c.issues = append(c.issues, Issue{Code: code, Path: path, Message: msg})
}

func (c *vctx) err() error {
	if len(c.issues) == 0 {
		return nil
	}
	return &ValidationError{Issues: c.issues}
}

// utf16Len counts UTF-16 code units — JavaScript's String.length, which is
// what the Zod min/max limits measure.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func asObject(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func numVal(v any) (float64, bool) {
	var f float64
	switch n := v.(type) {
	case json.Number:
		parsed, err := n.Float64()
		if err != nil {
			return 0, false
		}
		f = parsed
	case float64:
		f = n
	case int:
		f = float64(n)
	default:
		return 0, false
	}
	if math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, false
	}
	return f, true
}

func isInt(f float64) bool { return f == math.Trunc(f) }

// str validates an optional string field with a UTF-16 length range.
// required + absent → issue. Returns the tri-state.
func (c *vctx) str(m map[string]any, key string, required, nullable bool, minLen, maxLen int, trim bool) Opt[string] {
	v, present := m[key]
	if !present {
		if required {
			c.add("invalid_type", "Required", key)
		}
		return Opt[string]{}
	}
	if v == nil {
		if !nullable {
			c.add("invalid_type", "Expected string, received null", key)
			return Opt[string]{}
		}
		return Opt[string]{Present: true, Null: true}
	}
	s, ok := v.(string)
	if !ok {
		c.add("invalid_type", "Expected string", key)
		return Opt[string]{}
	}
	if trim {
		s = strings.TrimSpace(s)
	}
	if l := utf16Len(s); l < minLen {
		c.add("too_small", "String must contain at least "+itoa(minLen)+" character(s)", key)
	} else if maxLen >= 0 && l > maxLen {
		c.add("too_big", "String must contain at most "+itoa(maxLen)+" character(s)", key)
	}
	return Opt[string]{Present: true, Value: s}
}

// num validates an optional number field. integer requires an integral
// value; min/max are inclusive bounds applied when bounded is true.
func (c *vctx) num(m map[string]any, key string, nullable, integer, bounded bool, min, max float64) Opt[float64] {
	v, present := m[key]
	if !present {
		return Opt[float64]{}
	}
	if v == nil {
		if !nullable {
			c.add("invalid_type", "Expected number, received null", key)
			return Opt[float64]{}
		}
		return Opt[float64]{Present: true, Null: true}
	}
	f, ok := numVal(v)
	if !ok {
		c.add("invalid_type", "Expected number", key)
		return Opt[float64]{}
	}
	if integer && !isInt(f) {
		c.add("invalid_type", "Expected integer, received float", key)
	}
	if bounded {
		if f < min {
			c.add("too_small", "Number must be greater than or equal to "+ftoa(min), key)
		} else if f > max {
			c.add("too_big", "Number must be less than or equal to "+ftoa(max), key)
		}
	}
	return Opt[float64]{Present: true, Value: f}
}

// zeroOne validates a 0|1 literal-union flag.
func (c *vctx) zeroOne(m map[string]any, key string) Opt[int] {
	v, present := m[key]
	if !present {
		return Opt[int]{}
	}
	f, ok := numVal(v)
	if !ok || (f != 0 && f != 1) {
		c.add("invalid_union", "Expected 0 or 1", key)
		return Opt[int]{}
	}
	return Opt[int]{Present: true, Value: int(f)}
}

// enum validates a string enum field.
func (c *vctx) enum(m map[string]any, key string, allowed map[string]bool) Opt[string] {
	v, present := m[key]
	if !present {
		return Opt[string]{}
	}
	s, ok := v.(string)
	if !ok || !allowed[s] {
		c.add("invalid_enum_value", "Invalid enum value for "+key, key)
		return Opt[string]{}
	}
	return Opt[string]{Present: true, Value: s}
}

// datetime validates an optional ISO 8601 timestamp with offset (or Z).
func (c *vctx) datetime(m map[string]any, key string) Opt[string] {
	v, present := m[key]
	if !present {
		return Opt[string]{}
	}
	s, ok := v.(string)
	if !ok || !datetimeRe.MatchString(s) {
		c.add("invalid_string", "Invalid datetime", key)
		return Opt[string]{}
	}
	return Opt[string]{Present: true, Value: s}
}

func itoa(n int) string { return strconv.Itoa(n) }

func ftoa(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) }

// --- Tracker DTOs -----------------------------------------------------------

// TrackerLinkInput is one operand of a derived tracker.
type TrackerLinkInput struct {
	SourceID    string
	Coefficient float64
}

// TrackerPatch mirrors trackerPatchSchema: every field optional, presence
// tracked. TrackerInput (create) reuses it and then applies the schema
// defaults.
type TrackerPatch struct {
	Name           Opt[string]
	Description    Opt[string]
	Color          Opt[string]
	Icon           Opt[string]
	Kind           Opt[string]
	Unit           Opt[string]
	Target         Opt[float64]
	ResetPeriod    Opt[string]
	WeekStart      Opt[int]
	DayStartMinute Opt[int]
	DefaultValue   Opt[float64]
	SortOrder      Opt[int]
	IsHidden       Opt[int]
	IsSnapshot     Opt[int]
	Links          []TrackerLinkInput
	HasLinks       bool
}

func parseTrackerFields(c *vctx, m map[string]any, nameRequired bool) TrackerPatch {
	p := TrackerPatch{
		Name:           c.str(m, "name", nameRequired, false, 1, 120, true),
		Description:    c.str(m, "description", false, true, 0, 2000, false),
		Icon:           c.str(m, "icon", false, true, 0, 60, false),
		Unit:           c.str(m, "unit", false, true, 0, 30, false),
		Kind:           c.enum(m, "kind", trackerKinds),
		Target:         c.num(m, "target", true, false, false, 0, 0),
		ResetPeriod:    c.enum(m, "reset_period", resetPeriods),
		DayStartMinute: optInt(c.num(m, "day_start_minute", false, true, true, 0, 1439)),
		DefaultValue:   c.num(m, "default_value", false, false, false, 0, 0),
		SortOrder:      optInt(c.num(m, "sort_order", false, true, false, 0, 0)),
		IsHidden:       c.zeroOne(m, "is_hidden"),
		IsSnapshot:     c.zeroOne(m, "is_snapshot"),
	}

	if v, present := m["color"]; present {
		s, ok := v.(string)
		if !ok || !hexColorRe.MatchString(s) {
			c.add("invalid_string", "expected a 6-digit hex color like #4ECDC4", "color")
		} else {
			p.Color = Opt[string]{Present: true, Value: s}
		}
	}

	if v, present := m["week_start"]; present {
		f, ok := numVal(v)
		if !ok || (f != 0 && f != 1) {
			c.add("invalid_union", "Expected 0 or 1", "week_start")
		} else {
			p.WeekStart = Opt[int]{Present: true, Value: int(f)}
		}
	}

	if v, present := m["links"]; present && v != nil {
		arr, ok := v.([]any)
		if !ok {
			c.add("invalid_type", "Expected array", "links")
		} else if len(arr) > 50 {
			c.add("too_big", "Array must contain at most 50 element(s)", "links")
		} else {
			p.HasLinks = true
			for i, item := range arr {
				lm, ok := asObject(item)
				if !ok {
					c.add("invalid_type", "Expected object", "links", i)
					continue
				}
				lc := &vctx{}
				sourceID := lc.str(lm, "source_id", true, false, 1, -1, false)
				coefficient := lc.num(lm, "coefficient", false, false, false, 0, 0)
				for _, iss := range lc.issues {
					c.add(iss.Code, iss.Message, append([]any{"links", i}, iss.Path...)...)
				}
				link := TrackerLinkInput{SourceID: sourceID.Value, Coefficient: 1}
				if coefficient.Set() {
					link.Coefficient = coefficient.Value
				}
				p.Links = append(p.Links, link)
			}
		}
	}
	return p
}

func optInt(o Opt[float64]) Opt[int] {
	return Opt[int]{Present: o.Present, Null: o.Null, Value: int(o.Value)}
}

// ParseTrackerInput validates a create body and applies the schema defaults.
func ParseTrackerInput(v any) (*TrackerPatch, error) {
	m, ok := asObject(v)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_type", Path: []any{}, Message: "Expected object"}}}
	}
	c := &vctx{}
	p := parseTrackerFields(c, m, true)
	if err := c.err(); err != nil {
		return nil, err
	}
	applyDefault(&p.Color, "#888888")
	applyDefault(&p.Kind, "count")
	applyDefault(&p.ResetPeriod, "never")
	applyDefault(&p.WeekStart, 1)
	applyDefault(&p.DayStartMinute, 0)
	applyDefault(&p.DefaultValue, 1)
	applyDefault(&p.SortOrder, 0)
	applyDefault(&p.IsHidden, 0)
	applyDefault(&p.IsSnapshot, 0)
	return &p, nil
}

// ParseTrackerPatch validates an update body (all fields optional, no
// defaults applied).
func ParseTrackerPatch(v any) (*TrackerPatch, error) {
	m, ok := asObject(v)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_type", Path: []any{}, Message: "Expected object"}}}
	}
	c := &vctx{}
	p := parseTrackerFields(c, m, false)
	if err := c.err(); err != nil {
		return nil, err
	}
	return &p, nil
}

func applyDefault[T any](o *Opt[T], def T) {
	if !o.Present || o.Null {
		*o = Opt[T]{Present: true, Value: def}
	}
}

// ParseLinksInput validates the body of PUT /trackers/:id/links.
func ParseLinksInput(v any) ([]TrackerLinkInput, error) {
	c := &vctx{}
	m := map[string]any{"links": v}
	p := parseTrackerFields(c, m, false)
	if err := c.err(); err != nil {
		return nil, err
	}
	return p.Links, nil
}

// --- Entry DTOs --------------------------------------------------------------

// EntryLogInput is the body of a single entry log.
type EntryLogInput struct {
	Value      Opt[float64]
	OccurredAt Opt[string]
}

// EntryLogItem is one item of a batch log.
type EntryLogItem struct {
	TrackerID string
	EntryLogInput
}

// ParseEntryLogInput validates an entry-log body.
func ParseEntryLogInput(v any) (*EntryLogInput, error) {
	if v == nil {
		v = map[string]any{}
	}
	m, ok := asObject(v)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_type", Path: []any{}, Message: "Expected object"}}}
	}
	c := &vctx{}
	in := EntryLogInput{
		Value:      c.num(m, "value", false, false, false, 0, 0),
		OccurredAt: c.datetime(m, "occurred_at"),
	}
	if err := c.err(); err != nil {
		return nil, err
	}
	return &in, nil
}

// ParseEntryLogMany validates a batch-log body: 1..500 items, each an entry
// log targeted at a tracker.
func ParseEntryLogMany(v any) ([]EntryLogItem, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_type", Path: []any{}, Message: "Expected array"}}}
	}
	c := &vctx{}
	if len(arr) < 1 {
		c.add("too_small", "Array must contain at least 1 element(s)")
	}
	if len(arr) > 500 {
		c.add("too_big", "Array must contain at most 500 element(s)")
	}
	var items []EntryLogItem
	for i, raw := range arr {
		m, ok := asObject(raw)
		if !ok {
			c.add("invalid_type", "Expected object", i)
			continue
		}
		ic := &vctx{}
		trackerID := ic.str(m, "tracker_id", true, false, 1, -1, false)
		value := ic.num(m, "value", false, false, false, 0, 0)
		occurredAt := ic.datetime(m, "occurred_at")
		for _, iss := range ic.issues {
			c.add(iss.Code, iss.Message, append([]any{i}, iss.Path...)...)
		}
		items = append(items, EntryLogItem{
			TrackerID:     trackerID.Value,
			EntryLogInput: EntryLogInput{Value: value, OccurredAt: occurredAt},
		})
	}
	if err := c.err(); err != nil {
		return nil, err
	}
	return items, nil
}

// ParseEntryPatch validates an entry update body.
func ParseEntryPatch(v any) (*EntryLogInput, error) {
	return ParseEntryLogInput(v)
}

// --- Note DTOs ---------------------------------------------------------------

// NoteInput is the body of POST /notes.
type NoteInput struct {
	TrackerID  string
	EntryID    Opt[string]
	Body       string
	OccurredAt Opt[string]
}

// ParseNoteInput validates a note-create body.
func ParseNoteInput(v any) (*NoteInput, error) {
	m, ok := asObject(v)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_type", Path: []any{}, Message: "Expected object"}}}
	}
	c := &vctx{}
	trackerID := c.str(m, "tracker_id", true, false, 1, -1, false)
	entryID := c.str(m, "entry_id", false, true, 0, -1, false)
	body := c.str(m, "body", true, false, 0, 100_000, false)
	occurredAt := c.datetime(m, "occurred_at")
	if err := c.err(); err != nil {
		return nil, err
	}
	return &NoteInput{
		TrackerID:  trackerID.Value,
		EntryID:    entryID,
		Body:       body.Value,
		OccurredAt: occurredAt,
	}, nil
}

// NotePatch is the body of PATCH /notes/:id.
type NotePatch struct {
	Body       Opt[string]
	OccurredAt Opt[string]
}

// ParseNotePatch validates a note update body.
func ParseNotePatch(v any) (*NotePatch, error) {
	m, ok := asObject(v)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_type", Path: []any{}, Message: "Expected object"}}}
	}
	c := &vctx{}
	p := NotePatch{
		Body:       c.str(m, "body", false, false, 0, 100_000, false),
		OccurredAt: c.datetime(m, "occurred_at"),
	}
	if err := c.err(); err != nil {
		return nil, err
	}
	return &p, nil
}

// --- Group DTOs ----------------------------------------------------------------

// GroupPatch mirrors groupPatchSchema (and groupInputSchema after defaults).
type GroupPatch struct {
	Name      Opt[string]
	Color     Opt[string]
	SortOrder Opt[int]
}

func parseGroupFields(c *vctx, m map[string]any, nameRequired bool) GroupPatch {
	p := GroupPatch{
		Name:      c.str(m, "name", nameRequired, false, 1, 120, true),
		SortOrder: optInt(c.num(m, "sort_order", false, true, false, 0, 0)),
	}
	if v, present := m["color"]; present {
		if v == nil {
			p.Color = Opt[string]{Present: true, Null: true}
		} else if s, ok := v.(string); ok && hexColorRe.MatchString(s) {
			p.Color = Opt[string]{Present: true, Value: s}
		} else {
			c.add("invalid_string", "expected a 6-digit hex color like #4ECDC4", "color")
		}
	}
	return p
}

// ParseGroupInput validates a group-create body and applies defaults.
func ParseGroupInput(v any) (*GroupPatch, error) {
	m, ok := asObject(v)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_type", Path: []any{}, Message: "Expected object"}}}
	}
	c := &vctx{}
	p := parseGroupFields(c, m, true)
	if err := c.err(); err != nil {
		return nil, err
	}
	applyDefault(&p.SortOrder, 0)
	return &p, nil
}

// ParseGroupPatch validates a group update body.
func ParseGroupPatch(v any) (*GroupPatch, error) {
	m, ok := asObject(v)
	if !ok {
		return nil, &ValidationError{Issues: []Issue{{Code: "invalid_type", Path: []any{}, Message: "Expected object"}}}
	}
	c := &vctx{}
	p := parseGroupFields(c, m, false)
	if err := c.err(); err != nil {
		return nil, err
	}
	return &p, nil
}
