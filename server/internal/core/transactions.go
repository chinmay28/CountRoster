package core

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/chinmay28/countroster/server/internal/ids"
	"github.com/chinmay28/countroster/server/internal/jsjson"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

const derivedFileMessage = "Cannot file transactions into a derived tracker; its value is computed from its sources."

// TransactionService ports domain/transactions.ts: the staging inbox for
// imported credit-card transactions. Rows arrive `pending`, get a suggested
// tracker (via learned category_rules, falling back to the CSV category
// matching a tracker name), and on confirm become an Entry plus a linked Note
// carrying the transaction name. Deleting a pending row marks it `ignored`
// instead of removing it so a later import of an overlapping CSV can't
// resurrect it.
type TransactionService struct {
	st    storage.Storage
	clock timeutil.Clock
}

// dedupeSep joins the parts of a dedupe key. The unit separator can't appear
// in CSV-derived text, so composite keys never collide across fields.
const dedupeSep = "\x1f"

var (
	collapseWSRe = regexp.MustCompile(`\s+`)
	// Card processors prefix the merchant: "SQ *BLUE BOTTLE", "TST* CHIPOTLE",
	// "PAYPAL *SPOTIFY". Strip the "<TAG>*" marker, keep the merchant.
	processorPrefixRe = regexp.MustCompile(`^[A-Za-z]{2,10} ?\* *`)
	// Trailing store/reference numbers: "TRADER JOE'S #552", "COSTCO 1021".
	// A bare number needs 4+ digits so names like "PIER 1" survive.
	trailingRefRe  = regexp.MustCompile(`( (#\d{2,}|\d{4,}))+$`)
	merchantJunkRe = regexp.MustCompile(`[^a-z0-9]+`)
	importDateRe   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// SanitizeMerchantName turns a raw card descriptor into a display name:
// collapses whitespace, strips processor prefixes and trailing reference
// numbers, and title-cases all-caps descriptors. Mirrors the TS core's
// sanitizeMerchantName — the two must produce identical names.
func SanitizeMerchantName(raw string) string {
	s := strings.TrimSpace(collapseWSRe.ReplaceAllString(raw, " "))
	cleaned := processorPrefixRe.ReplaceAllString(s, "")
	cleaned = strings.TrimSpace(trailingRefRe.ReplaceAllString(cleaned, ""))
	if cleaned == "" {
		cleaned = s
	}
	return titleCaseIfShouty(cleaned)
}

// titleCaseIfShouty title-cases a string that has letters but no lowercase
// ones ("TRADER JOE'S #552" came from a terminal, not a person). A letter is
// uppercased at the start and after a space, '-', '/', '.', or '&' — but not
// after an apostrophe, so "JOE'S" becomes "Joe's".
func titleCaseIfShouty(s string) string {
	hasLetter, hasLower := false, false
	for _, r := range s {
		if r >= 'a' && r <= 'z' {
			hasLower = true
		}
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			hasLetter = true
		}
	}
	if !hasLetter || hasLower {
		return s
	}
	var b strings.Builder
	boundary := true
	for _, r := range s {
		if r >= 'A' && r <= 'Z' {
			if boundary {
				b.WriteRune(r)
			} else {
				b.WriteRune(r + ('a' - 'A'))
			}
		} else {
			b.WriteRune(r)
		}
		boundary = r == ' ' || r == '-' || r == '/' || r == '.' || r == '&'
	}
	return b.String()
}

// MerchantKey normalizes a sanitized name into the key category_rules match
// on: lowercase alphanumerics with single spaces, apostrophes dropped.
func MerchantKey(name string) string {
	s := strings.ToLower(name)
	s = strings.NewReplacer("'", "", "’", "").Replace(s)
	s = merchantJunkRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// localNoonISO renders a plain YYYY-MM-DD as local noon — mid-day keeps the
// transaction inside its calendar day regardless of DST or day_start_minute.
func localNoonISO(date string) (string, error) {
	t, err := time.ParseInLocation("2006-01-02", date, time.Local)
	if err != nil {
		return "", err
	}
	noon := time.Date(t.Year(), t.Month(), t.Day(), 12, 0, 0, 0, time.Local)
	return timeutil.ToLocalISO(noon), nil
}

// Import stages parsed CSV rows. Rows already imported (same date, amount,
// description, account and in-batch ordinal) count as duplicates and are
// skipped, so re-uploading an overlapping export is idempotent. Each new row
// gets a suggested tracker: a learned category_rules match on the merchant
// key, else a tracker whose name equals the CSV category.
func (s *TransactionService) Import(raw any) (*TransactionImportResult, error) {
	items, err := ParseTransactionImport(raw)
	if err != nil {
		return nil, err
	}

	res := &TransactionImportResult{Transactions: []*CardTransaction{}}
	var newIDs []string
	err = s.st.Transaction(func(tx storage.Storage) error {
		now := s.clock.NowISO()
		seen := map[string]int{}
		for _, in := range items {
			account := ""
			if in.Account.Set() {
				account = in.Account.Value
			}
			base := strings.Join([]string{
				in.Date, jsjson.NumberString(in.Amount), in.Description, account,
			}, dedupeSep)
			ordinal := seen[base]
			seen[base] = ordinal + 1
			key := base + dedupeSep + strconv.Itoa(ordinal)

			existing, err := tx.Query(
				`SELECT id FROM card_transactions WHERE dedupe_key = ?`, key)
			if err != nil {
				return err
			}
			if len(existing) > 0 {
				res.Duplicates++
				continue
			}

			name := SanitizeMerchantName(in.Description)
			trackerID, err := suggestTracker(tx, MerchantKey(name), in.Category)
			if err != nil {
				return err
			}

			postedAt, err := localNoonISO(in.Date)
			if err != nil {
				return err
			}

			id := ids.New()
			if err := tx.Exec(
				`INSERT INTO card_transactions
           (id, posted_at, amount, name, raw_description, account, category,
            dedupe_key, status, tracker_id, entry_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
				id, postedAt, in.Amount, name, in.Description,
				nullable(in.Account), nullable(in.Category), key, trackerID,
				now, now); err != nil {
				return err
			}
			newIDs = append(newIDs, id)
			res.Imported++
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	for _, id := range newIDs {
		txn, err := s.Get(id)
		if err != nil {
			return nil, err
		}
		if txn == nil {
			return nil, fmt.Errorf("transaction insert succeeded but row not found: %s", id)
		}
		res.Transactions = append(res.Transactions, txn)
	}
	return res, nil
}

// suggestTracker resolves the auto-categorization for a new transaction:
// a learned rule wins; otherwise the CSV's category column is matched
// against active, non-derived tracker names.
func suggestTracker(tx storage.Storage, merchant string, category Opt[string]) (any, error) {
	if merchant != "" {
		rows, err := tx.Query(
			`SELECT tracker_id FROM category_rules WHERE merchant = ?`, merchant)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			return rows[0].Get("tracker_id"), nil
		}
	}
	if category.Set() && strings.TrimSpace(category.Value) != "" {
		rows, err := tx.Query(
			`SELECT id FROM trackers
        WHERE archived_at IS NULL AND is_derived = 0 AND lower(name) = lower(?)
        ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT 1`,
			strings.TrimSpace(category.Value))
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			return rows[0].Get("id"), nil
		}
	}
	return nil, nil
}

func nullable(o Opt[string]) any {
	if !o.Set() {
		return nil
	}
	return o.Value
}

// List returns transactions by status — "pending" (default), "confirmed",
// "ignored", or "all" — newest first.
func (s *TransactionService) List(status string) ([]*CardTransaction, error) {
	if status == "" {
		status = "pending"
	}
	var rows []storage.Row
	var err error
	switch status {
	case "all":
		rows, err = s.st.Query(
			`SELECT * FROM card_transactions ORDER BY posted_at DESC, id DESC`)
	case "pending", "confirmed", "ignored":
		rows, err = s.st.Query(
			`SELECT * FROM card_transactions WHERE status = ?
        ORDER BY posted_at DESC, id DESC`, status)
	default:
		return nil, &ValidationError{Issues: []Issue{{
			Code: "invalid_enum_value", Path: []any{"status"},
			Message: `Invalid status "` + status + `"; expected pending, confirmed, ignored, or all`,
		}}}
	}
	if err != nil {
		return nil, err
	}
	out := make([]*CardTransaction, len(rows))
	for i, r := range rows {
		out[i] = cardTransactionFromRow(r)
	}
	return out, nil
}

func (s *TransactionService) Get(id string) (*CardTransaction, error) {
	rows, err := s.st.Query(`SELECT * FROM card_transactions WHERE id = ?`, id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return cardTransactionFromRow(rows[0]), nil
}

func onlyPendingError(action string) error {
	return &ValidationError{Issues: []Issue{{
		Code: "invalid_state", Path: []any{"status"},
		Message: "Only pending transactions can be " + action,
	}}}
}

// checkAssignableTracker validates a tracker a transaction is being pointed
// at: it must exist and not be derived.
func checkAssignableTracker(st storage.Storage, trackerID string) error {
	rows, err := st.Query(`SELECT is_derived FROM trackers WHERE id = ?`, trackerID)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return &NotFoundError{Kind: "Tracker", ID: trackerID}
	}
	if asInt(rows[0].Get("is_derived")) == 1 {
		return &DerivedTrackerError{Message: derivedFileMessage}
	}
	return nil
}

// Update patches a pending transaction: name (the future note body),
// tracker_id (the categorization; null clears it), amount, posted_at.
func (s *TransactionService) Update(id string, raw any) (*CardTransaction, error) {
	patch, err := ParseTransactionPatch(raw)
	if err != nil {
		return nil, err
	}
	existing, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, &NotFoundError{Kind: "Transaction", ID: id}
	}
	if existing.Status != "pending" {
		return nil, onlyPendingError("edited")
	}

	var sets []string
	var params []any
	if patch.Name.Set() {
		sets = append(sets, "name = ?")
		params = append(params, patch.Name.Value)
	}
	if patch.TrackerID.Present {
		if patch.TrackerID.Null {
			sets = append(sets, "tracker_id = NULL")
		} else {
			if err := checkAssignableTracker(s.st, patch.TrackerID.Value); err != nil {
				return nil, err
			}
			sets = append(sets, "tracker_id = ?")
			params = append(params, patch.TrackerID.Value)
		}
	}
	if patch.Amount.Set() {
		sets = append(sets, "amount = ?")
		params = append(params, patch.Amount.Value)
	}
	if patch.PostedAt.Set() {
		sets = append(sets, "posted_at = ?")
		params = append(params, patch.PostedAt.Value)
	}
	if len(sets) == 0 {
		return existing, nil
	}

	sets = append(sets, "updated_at = ?")
	params = append(params, s.clock.NowISO(), id)
	if err := s.st.Exec(
		"UPDATE card_transactions SET "+strings.Join(sets, ", ")+" WHERE id = ?",
		params...); err != nil {
		return nil, err
	}

	updated, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, &NotFoundError{Kind: "Transaction", ID: id}
	}
	return updated, nil
}

// Delete dismisses or purges a transaction. A pending row is kept as
// `ignored` (not removed) so the dedupe key still blocks re-import; deleting
// an already-ignored row removes it for good (a future import of the same
// CSV row will stage it again). Confirmed transactions are refused — delete
// their entry instead.
func (s *TransactionService) Delete(id string) error {
	existing, err := s.Get(id)
	if err != nil || existing == nil {
		return err
	}
	switch existing.Status {
	case "confirmed":
		return &ValidationError{Issues: []Issue{{
			Code: "invalid_state", Path: []any{"status"},
			Message: "Confirmed transactions cannot be deleted; delete their entry instead",
		}}}
	case "ignored":
		return s.st.Exec(`DELETE FROM card_transactions WHERE id = ?`, id)
	default:
		return s.st.Exec(
			`UPDATE card_transactions SET status = 'ignored', updated_at = ? WHERE id = ?`,
			s.clock.NowISO(), id)
	}
}

// Unfile reverses Confirm: it deletes the entry that filing created (and the
// notes attached to it, including the one carrying the transaction name) and
// returns the row to `pending`, keeping the tracker as the suggestion. The
// learned category rule is left in place — re-confirming (or confirming into
// a different tracker) overwrites it anyway.
func (s *TransactionService) Unfile(id string) (*CardTransaction, error) {
	txn, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if txn == nil {
		return nil, &NotFoundError{Kind: "Transaction", ID: id}
	}
	if txn.Status != "confirmed" {
		return nil, &ValidationError{Issues: []Issue{{
			Code: "invalid_state", Path: []any{"status"},
			Message: "Only filed transactions can be unfiled",
		}}}
	}

	err = s.st.Transaction(func(tx storage.Storage) error {
		if txn.EntryID != nil {
			if err := tx.Exec(`DELETE FROM notes WHERE entry_id = ?`, *txn.EntryID); err != nil {
				return err
			}
			if err := tx.Exec(`DELETE FROM entries WHERE id = ?`, *txn.EntryID); err != nil {
				return err
			}
		}
		return tx.Exec(
			`UPDATE card_transactions
          SET status = 'pending', entry_id = NULL, updated_at = ?
        WHERE id = ?`,
			s.clock.NowISO(), id)
	})
	if err != nil {
		return nil, err
	}

	restored, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if restored == nil {
		return nil, fmt.Errorf("transaction unfile succeeded but row not found: %s", id)
	}
	return restored, nil
}

// Clear bulk-purges every transaction in a terminal status — "confirmed"
// (their tracker entries stay) or "ignored". Purged rows lose their dedupe
// keys, so re-importing an old CSV can stage them again.
func (s *TransactionService) Clear(status string) (int, error) {
	if status != "confirmed" && status != "ignored" {
		return 0, &ValidationError{Issues: []Issue{{
			Code: "invalid_enum_value", Path: []any{"status"},
			Message: `Invalid status "` + status + `"; expected confirmed or ignored`,
		}}}
	}
	cleared := 0
	err := s.st.Transaction(func(tx storage.Storage) error {
		rows, err := tx.Query(
			`SELECT COUNT(*) AS n FROM card_transactions WHERE status = ?`, status)
		if err != nil {
			return err
		}
		if len(rows) > 0 {
			cleared = asInt(rows[0].Get("n"))
		}
		return tx.Exec(`DELETE FROM card_transactions WHERE status = ?`, status)
	})
	if err != nil {
		return 0, err
	}
	return cleared, nil
}

// Confirm files a pending transaction into a tracker: it creates the Entry
// (spend-positive: bank exports carry debits as negative amounts, so the
// entry value defaults to -amount), a Note on that entry carrying the
// transaction name, marks the row confirmed, and learns a category rule so
// the merchant auto-categorizes next import.
func (s *TransactionService) Confirm(id string, raw any) (*TransactionConfirmResult, error) {
	input, err := ParseTransactionConfirm(raw)
	if err != nil {
		return nil, err
	}
	txn, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if txn == nil {
		return nil, &NotFoundError{Kind: "Transaction", ID: id}
	}
	if txn.Status != "pending" {
		return nil, onlyPendingError("confirmed")
	}

	trackerID := ""
	if input.TrackerID.Set() {
		trackerID = input.TrackerID.Value
	} else if txn.TrackerID != nil {
		trackerID = *txn.TrackerID
	}
	if trackerID == "" {
		return nil, &ValidationError{Issues: []Issue{{
			Code: "invalid_type", Path: []any{"tracker_id"},
			Message: "Required (no tracker suggested for this transaction)",
		}}}
	}
	if err := checkAssignableTracker(s.st, trackerID); err != nil {
		return nil, err
	}

	value := -txn.Amount
	if input.Value.Set() {
		value = input.Value.Value
	}

	entryID := ids.New()
	noteID := ids.New()
	err = s.st.Transaction(func(tx storage.Storage) error {
		now := s.clock.NowISO()
		if err := tx.Exec(
			`INSERT INTO entries (id, tracker_id, value, occurred_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
			entryID, trackerID, value, txn.PostedAt, now, now); err != nil {
			return err
		}
		if err := tx.Exec(
			`INSERT INTO notes (id, tracker_id, entry_id, body, occurred_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			noteID, trackerID, entryID, txn.Name, txn.PostedAt, now, now); err != nil {
			return err
		}
		if err := tx.Exec(
			`UPDATE card_transactions
          SET status = 'confirmed', tracker_id = ?, entry_id = ?, updated_at = ?
        WHERE id = ?`,
			trackerID, entryID, now, id); err != nil {
			return err
		}
		// Learn the categorization, keyed on the *raw* descriptor's merchant so
		// future imports of the same merchant match even if the name was edited.
		merchant := MerchantKey(SanitizeMerchantName(txn.RawDescription))
		if merchant != "" {
			if err := tx.Exec(
				`INSERT INTO category_rules (id, merchant, tracker_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (merchant)
           DO UPDATE SET tracker_id = excluded.tracker_id, updated_at = excluded.updated_at`,
				ids.New(), merchant, trackerID, now, now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	confirmed, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	entryRows, err := s.st.Query(`SELECT * FROM entries WHERE id = ?`, entryID)
	if err != nil {
		return nil, err
	}
	noteRows, err := s.st.Query(`SELECT * FROM notes WHERE id = ?`, noteID)
	if err != nil {
		return nil, err
	}
	if confirmed == nil || len(entryRows) == 0 || len(noteRows) == 0 {
		return nil, fmt.Errorf("transaction confirm succeeded but rows not found: %s", id)
	}
	return &TransactionConfirmResult{
		Transaction: confirmed,
		Entry:       entryFromRow(entryRows[0]),
		Note:        noteFromRow(noteRows[0]),
	}, nil
}
