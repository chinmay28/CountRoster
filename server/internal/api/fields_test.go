package api

import (
	"encoding/json"
	"testing"
)

// The custom-fields half of the REST contract: a tracker's field set, the
// answers carried on its entries, and the breakdown that splits its total
// across those answers.

func putJSON(t *testing.T, c *client, path string, body, out any) int {
	t.Helper()
	res, data := c.do("PUT", path, body)
	if len(data) > 0 && out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			t.Fatalf("PUT %s: bad JSON %q: %v", path, data, err)
		}
	}
	return res.StatusCode
}

func TestTrackerFieldsRoundTrip(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}

	var tracker m
	c.postJSON("/api/trackers", m{"name": "Milk", "kind": "number", "unit": "ml"}, &tracker)
	id := tracker["id"].(string)

	// A tracker with no fields answers with an empty array, never null.
	var initial []m
	if status := c.getJSON("/api/trackers/"+id+"/fields", &initial); status != 200 {
		t.Fatalf("list status %d", status)
	}
	if len(initial) != 0 {
		t.Errorf("expected no fields, got %v", initial)
	}

	var fields []m
	status := putJSON(t, c, "/api/trackers/"+id+"/fields", m{"fields": []m{
		{"name": "Feed type", "kind": "choice", "options": []m{
			{"label": "Bottle", "color": "#4ECDC4"},
			{"label": "Formula"},
			{"label": "Breast"},
		}},
		{"name": "Wet diaper", "kind": "flag"},
	}}, &fields)
	if status != 200 {
		t.Fatalf("put status %d", status)
	}
	if len(fields) != 2 {
		t.Fatalf("expected 2 fields, got %v", fields)
	}

	feedType := fields[0]
	if feedType["name"] != "Feed type" || feedType["kind"] != "choice" {
		t.Errorf("first field wrong: %v", feedType)
	}
	if feedType["unit"] != nil {
		t.Errorf("absent unit should be an explicit null, got %v", feedType["unit"])
	}
	options, _ := feedType["options"].([]any)
	if len(options) != 3 {
		t.Fatalf("expected 3 options, got %v", feedType["options"])
	}
	bottle := options[0].(map[string]any)
	if bottle["label"] != "Bottle" || bottle["color"] != "#4ECDC4" {
		t.Errorf("first option wrong: %v", bottle)
	}
	// A non-choice field still carries the key, as an empty array.
	if opts, ok := fields[1]["options"].([]any); !ok || len(opts) != 0 {
		t.Errorf("flag field should carry an empty options array, got %v", fields[1]["options"])
	}

	// The list route agrees with what the write returned.
	var listed []m
	c.getJSON("/api/trackers/"+id+"/fields", &listed)
	if len(listed) != 2 || listed[0]["id"] != feedType["id"] {
		t.Errorf("list disagrees with put: %v", listed)
	}

	// A malformed field set is a 400, not a 500.
	if status := putJSON(t, c, "/api/trackers/"+id+"/fields", m{"fields": []m{
		{"name": "Broken", "kind": "choice"},
	}}, nil); status != 400 {
		t.Errorf("expected 400 for a choice field with no options, got %d", status)
	}
	// …and on a tracker that doesn't exist, a 404.
	if status := putJSON(t, c, "/api/trackers/nope/fields", m{"fields": []m{}}, nil); status != 404 {
		t.Errorf("expected 404 for an unknown tracker, got %d", status)
	}
}

func TestEntryFieldAnswersOverHTTP(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}

	var tracker m
	c.postJSON("/api/trackers", m{"name": "Milk", "kind": "number"}, &tracker)
	id := tracker["id"].(string)

	var fields []m
	putJSON(t, c, "/api/trackers/"+id+"/fields", m{"fields": []m{
		{"name": "Feed type", "kind": "choice", "options": []m{
			{"label": "Bottle"}, {"label": "Breast"},
		}},
		{"name": "Wet diaper", "kind": "flag"},
	}}, &fields)
	feedTypeID := fields[0]["id"].(string)
	wetDiaperID := fields[1]["id"].(string)
	bottleID := fields[0]["options"].([]any)[0].(map[string]any)["id"].(string)

	var entry m
	status := c.postJSON("/api/trackers/"+id+"/entries", m{
		"value":  120,
		"fields": m{feedTypeID: bottleID, wetDiaperID: true},
	}, &entry)
	if status != 201 {
		t.Fatalf("log status %d", status)
	}
	answers, _ := entry["fields"].([]any)
	if len(answers) != 2 {
		t.Fatalf("expected 2 answers on the entry, got %v", entry["fields"])
	}
	choice := answers[0].(map[string]any)
	if choice["field_id"] != feedTypeID || choice["option_id"] != bottleID {
		t.Errorf("choice answer wrong: %v", choice)
	}
	if choice["number_value"] != nil || choice["text_value"] != nil {
		t.Errorf("unused answer columns should be explicit nulls: %v", choice)
	}
	if flag := answers[1].(map[string]any); flag["number_value"] != 1.0 {
		t.Errorf("flag should serialize as 1: %v", flag)
	}

	// An entry logged without answers still carries the key as an empty array.
	var bare m
	c.postJSON("/api/trackers/"+id+"/entries", m{"value": 60}, &bare)
	if answers, ok := bare["fields"].([]any); !ok || len(answers) != 0 {
		t.Errorf("expected an empty fields array, got %v", bare["fields"])
	}

	// Answers survive the round trip through the list route.
	var entries []m
	c.getJSON("/api/trackers/"+id+"/entries", &entries)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if got, _ := entries[0]["fields"].([]any); len(got) != 2 {
		t.Errorf("list dropped the answers: %v", entries[0]["fields"])
	}

	// Patching repoints one answer and leaves the other alone.
	breastID := fields[0]["options"].([]any)[1].(map[string]any)["id"].(string)
	res, data := c.do("PATCH", "/api/entries/"+entry["id"].(string), m{
		"fields": m{feedTypeID: breastID},
	})
	if res.StatusCode != 200 {
		t.Fatalf("patch status %d: %s", res.StatusCode, data)
	}
	var patched m
	if err := json.Unmarshal(data, &patched); err != nil {
		t.Fatal(err)
	}
	updated, _ := patched["fields"].([]any)
	if len(updated) != 2 {
		t.Fatalf("patch disturbed the untouched answer: %v", patched["fields"])
	}
	if updated[0].(map[string]any)["option_id"] != breastID {
		t.Errorf("choice not repointed: %v", updated[0])
	}

	// An answer that doesn't match the field is a 400.
	res, _ = c.do("POST", "/api/trackers/"+id+"/entries", m{
		"value": 10, "fields": m{feedTypeID: "not-an-option"},
	})
	if res.StatusCode != 400 {
		t.Errorf("expected 400 for an unknown option, got %d", res.StatusCode)
	}
}

func TestStatsFieldBreakdownRoute(t *testing.T) {
	c := &client{t: t, base: newServer(t).URL}

	var tracker m
	c.postJSON("/api/trackers", m{"name": "Milk", "kind": "number"}, &tracker)
	id := tracker["id"].(string)

	var fields []m
	putJSON(t, c, "/api/trackers/"+id+"/fields", m{"fields": []m{
		{"name": "Feed type", "kind": "choice", "options": []m{
			{"label": "Bottle"}, {"label": "Breast"},
		}},
	}}, &fields)
	fieldID := fields[0]["id"].(string)
	bottleID := fields[0]["options"].([]any)[0].(map[string]any)["id"].(string)

	c.postJSON("/api/trackers/"+id+"/entries", m{"value": 120, "fields": m{fieldID: bottleID}}, nil)
	c.postJSON("/api/trackers/"+id+"/entries", m{"value": 80, "fields": m{fieldID: bottleID}}, nil)
	c.postJSON("/api/trackers/"+id+"/entries", m{"value": 30}, nil)

	var slices []m
	status := c.getJSON("/api/trackers/"+id+"/stats/field-breakdown?field_id="+fieldID, &slices)
	if status != 200 {
		t.Fatalf("breakdown status %d", status)
	}
	if len(slices) != 3 {
		t.Fatalf("expected 2 options + Not set, got %v", slices)
	}
	if slices[0]["label"] != "Bottle" || slices[0]["total"] != 200.0 || slices[0]["count"] != 2.0 {
		t.Errorf("first slice wrong: %v", slices[0])
	}
	if slices[1]["label"] != "Breast" || slices[1]["total"] != 0.0 {
		t.Errorf("empty option should still be reported: %v", slices[1])
	}
	if slices[2]["key"] != "" || slices[2]["label"] != "Not set" || slices[2]["total"] != 30.0 {
		t.Errorf("unanswered bucket wrong: %v", slices[2])
	}
	if slices[0]["color"] != nil {
		t.Errorf("colorless option should serialize as null: %v", slices[0])
	}

	// field_id is not optional, and an unknown one is a 404.
	if status := c.getJSON("/api/trackers/"+id+"/stats/field-breakdown", nil); status != 400 {
		t.Errorf("expected 400 without field_id, got %d", status)
	}
	if status := c.getJSON("/api/trackers/"+id+"/stats/field-breakdown?field_id=nope", nil); status != 404 {
		t.Errorf("expected 404 for an unknown field, got %d", status)
	}
}
