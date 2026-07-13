package core

import (
	"errors"
	"strings"
	"testing"
)

func txnRow(date, description string, amount float64, extra ...any) map[string]any {
	m := obj("date", date, "description", description, "amount", amount)
	for i := 0; i+1 < len(extra); i += 2 {
		m[extra[i].(string)] = extra[i+1]
	}
	return m
}

func importRows(t *testing.T, a *testApp, rows ...map[string]any) *TransactionImportResult {
	t.Helper()
	anyRows := make([]any, len(rows))
	for i, r := range rows {
		anyRows[i] = r
	}
	res, err := a.Transactions.Import(obj("transactions", anyRows))
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	return res
}

func TestSanitizeMerchantName(t *testing.T) {
	cases := map[string]string{
		"TRADER JOE'S #552":        "Trader Joe's",
		"SQ *BLUE BOTTLE COFFEE":   "Blue Bottle Coffee",
		"TST* CHIPOTLE 0417":       "Chipotle",
		"PAYPAL *SPOTIFY":          "Spotify",
		"7-ELEVEN 34123":           "7-Eleven",
		"  Whole   Foods  Market ": "Whole Foods Market",
		"AMZN Mktp US":             "AMZN Mktp US", // has lowercase — left as-is
		"COSTCO WHSE #1021":        "Costco Whse",
	}
	for in, want := range cases {
		if got := SanitizeMerchantName(in); got != want {
			t.Errorf("SanitizeMerchantName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMerchantKey(t *testing.T) {
	if got := MerchantKey("Trader Joe's"); got != "trader joes" {
		t.Errorf("MerchantKey = %q", got)
	}
	if got := MerchantKey("7-Eleven"); got != "7 eleven" {
		t.Errorf("MerchantKey = %q", got)
	}
}

func TestImportSanitizesAndSuggestsByCategory(t *testing.T) {
	a := newTestApp(t)
	groceries := mustCreate(t, a, obj("name", "Groceries", "unit", "$"))

	res := importRows(t, a,
		txnRow("2026-07-01", "TRADER JOE'S #552", -43.21,
			"account", "Amex Gold", "category", "groceries"),
		txnRow("2026-07-02", "SOME NEW PLACE", -10),
	)
	if res.Imported != 2 || res.Duplicates != 0 {
		t.Fatalf("imported=%d duplicates=%d", res.Imported, res.Duplicates)
	}

	tj := res.Transactions[0]
	if tj.Name != "Trader Joe's" {
		t.Errorf("name = %q", tj.Name)
	}
	if tj.RawDescription != "TRADER JOE'S #552" {
		t.Errorf("raw_description = %q", tj.RawDescription)
	}
	if !strings.HasPrefix(tj.PostedAt, "2026-07-01T12:00:00.000") {
		t.Errorf("posted_at = %q", tj.PostedAt)
	}
	if tj.Status != "pending" {
		t.Errorf("status = %q", tj.Status)
	}
	// Category "groceries" matches the tracker name case-insensitively.
	if tj.TrackerID == nil || *tj.TrackerID != groceries.ID {
		t.Errorf("tracker_id = %v, want %s", tj.TrackerID, groceries.ID)
	}
	// No rule, no category → no suggestion.
	if res.Transactions[1].TrackerID != nil {
		t.Errorf("unexpected suggestion: %v", *res.Transactions[1].TrackerID)
	}
}

func TestImportDeduplicates(t *testing.T) {
	a := newTestApp(t)
	row := txnRow("2026-07-01", "CHIPOTLE 0417", -12.5, "account", "Visa")

	first := importRows(t, a, row, row) // two identical rows: two real purchases
	if first.Imported != 2 || first.Duplicates != 0 {
		t.Fatalf("first: imported=%d duplicates=%d", first.Imported, first.Duplicates)
	}

	// Re-importing an overlapping export skips both, imports the third.
	second := importRows(t, a, row, row, txnRow("2026-07-01", "CHIPOTLE 0417", -12.5, "account", "Visa"), txnRow("2026-07-03", "CHIPOTLE 0417", -9))
	if second.Imported != 2 || second.Duplicates != 2 {
		t.Fatalf("second: imported=%d duplicates=%d", second.Imported, second.Duplicates)
	}
}

func TestConfirmCreatesEntryNoteAndRule(t *testing.T) {
	a := newTestApp(t)
	dining := mustCreate(t, a, obj("name", "Restaurants", "unit", "$"))

	res := importRows(t, a, txnRow("2026-07-01", "TST* CHIPOTLE 0417", -12.5))
	txn := res.Transactions[0]
	if txn.TrackerID != nil {
		t.Fatalf("expected no suggestion yet")
	}

	out, err := a.Transactions.Confirm(txn.ID, obj("tracker_id", dining.ID))
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if out.Entry.TrackerID != dining.ID || out.Entry.Value != 12.5 {
		t.Errorf("entry = %+v", out.Entry)
	}
	if out.Entry.OccurredAt != txn.PostedAt {
		t.Errorf("entry occurred_at = %q, want %q", out.Entry.OccurredAt, txn.PostedAt)
	}
	if out.Note.Body != "Chipotle" || out.Note.EntryID == nil || *out.Note.EntryID != out.Entry.ID {
		t.Errorf("note = %+v", out.Note)
	}
	if out.Transaction.Status != "confirmed" ||
		out.Transaction.EntryID == nil || *out.Transaction.EntryID != out.Entry.ID {
		t.Errorf("transaction = %+v", out.Transaction)
	}

	// The rule was learned from the raw descriptor: a future import of the
	// same merchant (different store number) auto-categorizes.
	next := importRows(t, a, txnRow("2026-07-09", "TST* CHIPOTLE 0533", -14))
	if next.Transactions[0].TrackerID == nil || *next.Transactions[0].TrackerID != dining.ID {
		t.Errorf("rule not applied: %+v", next.Transactions[0])
	}

	// Confirming twice is refused.
	if _, err := a.Transactions.Confirm(txn.ID, nil); err == nil {
		t.Fatal("expected error confirming a confirmed transaction")
	}
}

func TestConfirmDefaultsAndOverrides(t *testing.T) {
	a := newTestApp(t)
	dining := mustCreate(t, a, obj("name", "Restaurants"))

	// Confirm with no body uses the stored suggestion.
	res := importRows(t, a, txnRow("2026-07-01", "CAFE", -5, "category", "Restaurants"))
	out, err := a.Transactions.Confirm(res.Transactions[0].ID, nil)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if out.Entry.TrackerID != dining.ID || out.Entry.Value != 5 {
		t.Errorf("entry = %+v", out.Entry)
	}

	// Value override wins over -amount.
	res2 := importRows(t, a, txnRow("2026-07-02", "CAFE", -8, "category", "Restaurants"))
	out2, err := a.Transactions.Confirm(res2.Transactions[0].ID, obj("value", 100))
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if out2.Entry.Value != 100 {
		t.Errorf("value = %v", out2.Entry.Value)
	}

	// No suggestion and no tracker_id → validation error.
	res3 := importRows(t, a, txnRow("2026-07-03", "MYSTERY", -1))
	if _, err := a.Transactions.Confirm(res3.Transactions[0].ID, nil); err == nil {
		t.Fatal("expected validation error")
	} else {
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Fatalf("want ValidationError, got %T", err)
		}
	}
}

func TestConfirmRejectsDerivedAndMissingTracker(t *testing.T) {
	a := newTestApp(t)
	src := mustCreate(t, a, obj("name", "Src"))
	derived := mustCreate(t, a, obj("name", "Total",
		"links", []any{obj("source_id", src.ID)}))

	res := importRows(t, a, txnRow("2026-07-01", "CAFE", -5))
	txn := res.Transactions[0]

	if _, err := a.Transactions.Confirm(txn.ID, obj("tracker_id", derived.ID)); err == nil {
		t.Fatal("expected derived tracker error")
	} else {
		var de *DerivedTrackerError
		if !errors.As(err, &de) {
			t.Fatalf("want DerivedTrackerError, got %T: %v", err, err)
		}
	}
	if _, err := a.Transactions.Confirm(txn.ID, obj("tracker_id", "nope")); err == nil {
		t.Fatal("expected not found error")
	} else {
		var nf *NotFoundError
		if !errors.As(err, &nf) {
			t.Fatalf("want NotFoundError, got %T: %v", err, err)
		}
	}
}

func TestUpdateTransaction(t *testing.T) {
	a := newTestApp(t)
	groceries := mustCreate(t, a, obj("name", "Groceries"))

	res := importRows(t, a, txnRow("2026-07-01", "WM SUPERCENTER", -60))
	txn := res.Transactions[0]

	updated, err := a.Transactions.Update(txn.ID,
		obj("name", "Walmart", "tracker_id", groceries.ID, "amount", -59.5))
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != "Walmart" || updated.Amount != -59.5 ||
		updated.TrackerID == nil || *updated.TrackerID != groceries.ID {
		t.Errorf("updated = %+v", updated)
	}

	// Null clears the categorization.
	cleared, err := a.Transactions.Update(txn.ID, map[string]any{"tracker_id": nil})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if cleared.TrackerID != nil {
		t.Errorf("tracker_id = %v", *cleared.TrackerID)
	}

	// The edited name is what the note carries on confirm.
	out, err := a.Transactions.Confirm(txn.ID, obj("tracker_id", groceries.ID))
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if out.Note.Body != "Walmart" {
		t.Errorf("note body = %q", out.Note.Body)
	}

	// Confirmed transactions can't be edited.
	if _, err := a.Transactions.Update(txn.ID, obj("name", "X")); err == nil {
		t.Fatal("expected error editing a confirmed transaction")
	}
}

func TestDeleteMarksIgnoredAndKeepsDedupe(t *testing.T) {
	a := newTestApp(t)
	row := txnRow("2026-07-01", "SPAM MERCHANT", -3)

	res := importRows(t, a, row)
	if err := a.Transactions.Delete(res.Transactions[0].ID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	pending, err := a.Transactions.List("")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("pending = %d", len(pending))
	}
	ignored, err := a.Transactions.List("ignored")
	if err != nil {
		t.Fatal(err)
	}
	if len(ignored) != 1 {
		t.Fatalf("ignored = %d", len(ignored))
	}

	// Re-importing the same row does not resurrect it.
	again := importRows(t, a, row)
	if again.Imported != 0 || again.Duplicates != 1 {
		t.Fatalf("imported=%d duplicates=%d", again.Imported, again.Duplicates)
	}

	// Deleting the ignored row purges it for good…
	if err := a.Transactions.Delete(res.Transactions[0].ID); err != nil {
		t.Fatalf("delete ignored: %v", err)
	}
	ignored, err = a.Transactions.List("ignored")
	if err != nil {
		t.Fatal(err)
	}
	if len(ignored) != 0 {
		t.Fatalf("ignored after purge = %d", len(ignored))
	}
	// …so the same CSV row imports fresh next time.
	fresh := importRows(t, a, row)
	if fresh.Imported != 1 || fresh.Duplicates != 0 {
		t.Fatalf("imported=%d duplicates=%d", fresh.Imported, fresh.Duplicates)
	}

	// Deleting an unknown id is a silent no-op (like entries/notes).
	if err := a.Transactions.Delete("nope"); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

func TestListFiltersAndOrder(t *testing.T) {
	a := newTestApp(t)
	dining := mustCreate(t, a, obj("name", "Restaurants"))

	res := importRows(t, a,
		txnRow("2026-07-01", "A", -1),
		txnRow("2026-07-05", "B", -2),
		txnRow("2026-07-03", "C", -3),
	)
	if _, err := a.Transactions.Confirm(res.Transactions[1].ID, obj("tracker_id", dining.ID)); err != nil {
		t.Fatal(err)
	}

	pending, err := a.Transactions.List("pending")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 2 || pending[0].Name != "C" || pending[1].Name != "A" {
		t.Fatalf("pending order wrong: %+v", pending)
	}
	all, err := a.Transactions.List("all")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 || all[0].Name != "B" {
		t.Fatalf("all order wrong")
	}
	if _, err := a.Transactions.List("bogus"); err == nil {
		t.Fatal("expected validation error for bad status")
	}
}

func TestUnfileRestoresPendingAndRemovesEntry(t *testing.T) {
	a := newTestApp(t)
	dining := mustCreate(t, a, obj("name", "Restaurants"))

	res := importRows(t, a, txnRow("2026-07-01", "CAFE", -5))
	txn := res.Transactions[0]
	out, err := a.Transactions.Confirm(txn.ID, obj("tracker_id", dining.ID))
	if err != nil {
		t.Fatal(err)
	}

	restored, err := a.Transactions.Unfile(txn.ID)
	if err != nil {
		t.Fatalf("unfile: %v", err)
	}
	if restored.Status != "pending" || restored.EntryID != nil {
		t.Fatalf("restored = %+v", restored)
	}
	// The tracker stays as the suggestion for a quick re-file.
	if restored.TrackerID == nil || *restored.TrackerID != dining.ID {
		t.Fatalf("suggestion lost: %+v", restored)
	}

	// The entry and its note are gone from the tracker.
	entries, err := a.Entries.ForTracker(dining.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %d", len(entries))
	}
	notes, err := a.Notes.ForTracker(dining.ID, TimeRange{})
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 0 {
		t.Fatalf("notes = %d", len(notes))
	}
	_ = out

	// Re-confirming works; unfiling a pending row is refused.
	if _, err := a.Transactions.Confirm(txn.ID, nil); err != nil {
		t.Fatalf("re-confirm: %v", err)
	}
	res2 := importRows(t, a, txnRow("2026-07-02", "OTHER", -1))
	if _, err := a.Transactions.Unfile(res2.Transactions[0].ID); err == nil {
		t.Fatal("expected error unfiling a pending transaction")
	}
}

func TestClearPurgesTerminalStatuses(t *testing.T) {
	a := newTestApp(t)
	dining := mustCreate(t, a, obj("name", "Restaurants"))

	res := importRows(t, a,
		txnRow("2026-07-01", "A", -1),
		txnRow("2026-07-02", "B", -2),
		txnRow("2026-07-03", "C", -3),
	)
	if _, err := a.Transactions.Confirm(res.Transactions[0].ID, obj("tracker_id", dining.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Transactions.Confirm(res.Transactions[1].ID, obj("tracker_id", dining.ID)); err != nil {
		t.Fatal(err)
	}
	if err := a.Transactions.Delete(res.Transactions[2].ID); err != nil {
		t.Fatal(err)
	}

	n, err := a.Transactions.Clear("confirmed")
	if err != nil || n != 2 {
		t.Fatalf("clear confirmed: n=%d err=%v", n, err)
	}
	// Entries survive the clear — only the staging rows go.
	entries, _ := a.Entries.ForTracker(dining.ID, TimeRange{})
	if len(entries) != 2 {
		t.Fatalf("entries after clear = %d", len(entries))
	}

	n, err = a.Transactions.Clear("ignored")
	if err != nil || n != 1 {
		t.Fatalf("clear ignored: n=%d err=%v", n, err)
	}
	all, _ := a.Transactions.List("all")
	if len(all) != 0 {
		t.Fatalf("all after clears = %d", len(all))
	}

	// Pending rows are not clearable.
	if _, err := a.Transactions.Clear("pending"); err == nil {
		t.Fatal("expected validation error clearing pending")
	}
	if _, err := a.Transactions.Clear(""); err == nil {
		t.Fatal("expected validation error clearing empty status")
	}
}

func TestImportValidation(t *testing.T) {
	a := newTestApp(t)
	bad := []any{
		obj("transactions", []any{}),
		obj("transactions", []any{txnRow("07/01/2026", "X", -1.0)}),
		obj("transactions", []any{obj("date", "2026-07-01", "description", "X")}),
		obj("transactions", []any{obj("date", "2026-07-01", "amount", -1.0)}),
		obj(),
	}
	for i, body := range bad {
		if _, err := a.Transactions.Import(body); err == nil {
			t.Errorf("case %d: expected validation error", i)
		} else {
			var ve *ValidationError
			if !errors.As(err, &ve) {
				t.Errorf("case %d: want ValidationError, got %T", i, err)
			}
		}
	}
}
