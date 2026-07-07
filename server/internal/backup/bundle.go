package backup

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/chinmay28/countroster/server/internal/core"
	"github.com/chinmay28/countroster/server/internal/jsjson"
	"github.com/chinmay28/countroster/server/internal/storage"
	"github.com/chinmay28/countroster/server/internal/timeutil"
)

const (
	schemaVersionKey = "schema_version"
	formatVersion    = 1
)

// Service ports backup/bundle.ts.
type Service struct {
	St    storage.Storage
	Clock timeutil.Clock
}

// ImportResult reports what a bundle restore wrote.
type ImportResult struct {
	ImportedRows  *jsjson.Obj
	SchemaVersion float64
}

// readAllTables snapshots every backup table via SELECT * so the row key
// order matches the engine's column order — the canonical serialization
// (and therefore the checksum) depends on it.
func (s *Service) readAllTables() (*jsjson.Obj, error) {
	tables := jsjson.NewObj()
	for _, t := range backupTables {
		rows, err := s.St.Query(`SELECT * FROM ` + t.Name)
		if err != nil {
			return nil, err
		}
		arr := make([]any, len(rows))
		for i, r := range rows {
			obj := jsjson.NewObj()
			for c, col := range r.Columns {
				obj.Set(col, jsValue(r.Values[c]))
			}
			arr[i] = obj
		}
		tables.Set(t.Name, arr)
	}
	return tables, nil
}

// jsValue converts a driver value into the jsjson tree's types: SQLite
// INTEGER becomes a JS number (float64), exactly as node:sqlite hands rows
// to JSON.stringify.
func jsValue(v any) any {
	switch n := v.(type) {
	case int64:
		return float64(n)
	case float64, string, nil, bool:
		return v
	}
	return fmt.Sprint(v)
}

func (s *Service) schemaVersion() (float64, error) {
	rows, err := s.St.Query(`SELECT value FROM app_meta WHERE key = ?`, schemaVersionKey)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	str, _ := rows[0].Get("value").(string)
	v, err := strconv.Atoi(str)
	if err != nil {
		return 0, nil
	}
	return float64(v), nil
}

// BuildManifest builds (but doesn't write) the manifest describing the
// current DB, as an ordered object ready for canonical serialization.
func (s *Service) BuildManifest(appVersion string) (*jsjson.Obj, error) {
	tables, err := s.readAllTables()
	if err != nil {
		return nil, err
	}
	return s.manifestFor(tables, appVersion)
}

func (s *Service) manifestFor(tables *jsjson.Obj, appVersion string) (*jsjson.Obj, error) {
	schemaVersion, err := s.schemaVersion()
	if err != nil {
		return nil, err
	}
	rowCounts := jsjson.NewObj()
	for _, t := range backupTables {
		n := 0
		if arr, ok := tables.Get(t.Name).([]any); ok {
			n = len(arr)
		}
		rowCounts.Set(t.Name, float64(n))
	}
	checksums := jsjson.NewObj()
	checksums.Set("tables", checksumTables(tables))

	m := jsjson.NewObj()
	m.Set("format_version", float64(formatVersion))
	m.Set("app_version", appVersion)
	m.Set("schema_version", schemaVersion)
	m.Set("exported_at", s.Clock.NowISO())
	m.Set("row_counts", rowCounts)
	m.Set("checksums", checksums)
	return m, nil
}

// ExportBundle produces the full .countroster.zip: manifest.json, all.json
// (manifest + every table, the restorable artifact) and per-table CSVs, all
// stored uncompressed so any tool — including the TS implementation — can
// read them.
func (s *Service) ExportBundle(appVersion string) ([]byte, error) {
	tables, err := s.readAllTables()
	if err != nil {
		return nil, err
	}
	manifest, err := s.manifestFor(tables, appVersion)
	if err != nil {
		return nil, err
	}

	allDoc := jsjson.NewObj()
	allDoc.Set("manifest", manifest)
	allDoc.Set("tables", tables)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	addStored := func(name string, data []byte) error {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	if err := addStored("manifest.json", jsjson.StringifyIndent(manifest, 2)); err != nil {
		return nil, err
	}
	if err := addStored("all.json", jsjson.StringifyIndent(allDoc, 2)); err != nil {
		return nil, err
	}
	for _, t := range backupTables {
		var rows []*jsjson.Obj
		if arr, ok := tables.Get(t.Name).([]any); ok {
			for _, item := range arr {
				rows = append(rows, item.(*jsjson.Obj))
			}
		}
		if err := addStored("exports/"+t.Name+".csv", []byte(rowsToCSV(t.Columns, rows))); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var checksumRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var datetimeRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)

// ImportBundle replaces the current DB contents with the rows from a bundle.
func (s *Service) ImportBundle(data []byte, confirmOverwrite bool) (*ImportResult, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("Not a ZIP archive: end-of-central-directory not found")
	}
	var allJSON []byte
	for _, f := range zr.File {
		if f.Name == "all.json" {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			allJSON, err = io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return nil, err
			}
		}
	}
	if allJSON == nil {
		return nil, errors.New("Invalid bundle: all.json is missing")
	}

	parsed, err := jsjson.Parse(allJSON)
	if err != nil {
		return nil, errors.New("Invalid all.json: missing manifest or tables")
	}
	doc, ok := parsed.(*jsjson.Obj)
	if !ok {
		return nil, errors.New("Invalid all.json: missing manifest or tables")
	}
	manifest, mok := doc.Get("manifest").(*jsjson.Obj)
	tables, tok := doc.Get("tables").(*jsjson.Obj)
	if !mok || !tok {
		return nil, errors.New("Invalid all.json: missing manifest or tables")
	}
	if err := validateManifest(manifest); err != nil {
		return nil, err
	}

	bundleSchema := manifest.Get("schema_version").(float64)
	current, err := s.schemaVersion()
	if err != nil {
		return nil, err
	}
	if bundleSchema > current {
		return nil, fmt.Errorf(
			"Bundle schema_version %s is newer than this app (%s); upgrade the app to restore it.",
			jsjson.NumberString(bundleSchema), jsjson.NumberString(current))
	}

	expected := manifest.Get("checksums").(*jsjson.Obj).Get("tables").(string)
	if checksumTables(tables) != expected {
		return nil, errors.New("Bundle integrity check failed: tables checksum mismatch")
	}

	if !confirmOverwrite {
		rows, err := s.St.Query(`SELECT COUNT(*) AS n FROM trackers`)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			if n, ok := rows[0].Get("n").(int64); ok && n > 0 {
				return nil, errors.New("Refusing to overwrite a non-empty database; pass confirmOverwrite.")
			}
		}
	}

	importedRows := jsjson.NewObj()
	err = s.St.Transaction(func(tx storage.Storage) error {
		// Delete children before parents.
		for i := len(backupTables) - 1; i >= 0; i-- {
			if err := tx.Exec(`DELETE FROM ` + backupTables[i].Name); err != nil {
				return err
			}
		}
		// Insert parents before children. Only bind columns the bundle
		// actually carries — older bundles predate later ALTER TABLEs, and
		// omitting those columns lets their SQL defaults apply instead of
		// binding NULL into a NOT NULL column.
		for _, t := range backupTables {
			var rows []*jsjson.Obj
			if arr, ok := tables.Get(t.Name).([]any); ok {
				for _, item := range arr {
					if obj, ok := item.(*jsjson.Obj); ok {
						rows = append(rows, obj)
					}
				}
			}
			if len(rows) > 0 {
				var present []string
				for _, c := range t.Columns {
					if rows[0].Has(c) {
						present = append(present, c)
					}
				}
				placeholders := strings.Repeat("?, ", len(present))
				sql := "INSERT INTO " + t.Name + " (" + strings.Join(present, ", ") +
					") VALUES (" + strings.TrimSuffix(placeholders, ", ") + ")"
				for _, row := range rows {
					params := make([]any, len(present))
					for i, c := range present {
						params[i] = normalizeParam(row.Get(c))
					}
					if err := tx.Exec(sql, params...); err != nil {
						return err
					}
				}
			}
			importedRows.Set(t.Name, float64(len(rows)))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &ImportResult{ImportedRows: importedRows, SchemaVersion: bundleSchema}, nil
}

// validateManifest ports manifestSchema (backup/manifest.ts); failures map
// to HTTP 400 exactly like a ZodError would.
func validateManifest(m *jsjson.Obj) error {
	fail := func(path, msg string) error {
		return &core.ValidationError{Issues: []core.Issue{{Code: "invalid_type", Path: []any{path}, Message: msg}}}
	}
	if fv, ok := m.Get("format_version").(float64); !ok || fv != formatVersion {
		return fail("format_version", "Invalid literal value, expected 1")
	}
	if _, ok := m.Get("app_version").(string); !ok {
		return fail("app_version", "Expected string")
	}
	if sv, ok := m.Get("schema_version").(float64); !ok || sv != math.Trunc(sv) || sv <= 0 {
		return fail("schema_version", "Expected positive integer")
	}
	if ea, ok := m.Get("exported_at").(string); !ok || !datetimeRe.MatchString(ea) {
		return fail("exported_at", "Invalid datetime")
	}
	rc, ok := m.Get("row_counts").(*jsjson.Obj)
	if !ok {
		return fail("row_counts", "Expected object")
	}
	for _, k := range rc.Keys() {
		if n, ok := rc.Get(k).(float64); !ok || n != math.Trunc(n) || n < 0 {
			return fail("row_counts", "Expected nonnegative integer")
		}
	}
	cs, ok := m.Get("checksums").(*jsjson.Obj)
	if !ok {
		return fail("checksums", "Expected object")
	}
	if t, ok := cs.Get("tables").(string); !ok || !checksumRe.MatchString(t) {
		return fail("checksums", "Invalid checksum")
	}
	return nil
}

// normalizeParam coerces a parsed JSON value into a SQL-bindable param,
// mirroring the TS importer: null→NULL, bool→1/0, number/string as-is.
func normalizeParam(v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case bool:
		if t {
			return int64(1)
		}
		return int64(0)
	case float64, string:
		return v
	}
	return fmt.Sprint(v)
}

// checksumTables computes "sha256:<hex>" over the canonical (JS-compatible)
// compact serialization of the tables payload, tables emitted in
// backupTables order so the hash is stable — byte-identical to the TS
// implementation's crypto.subtle digest.
func checksumTables(tables *jsjson.Obj) string {
	ordered := jsjson.NewObj()
	for _, t := range backupTables {
		if v := tables.Get(t.Name); v != nil {
			ordered.Set(t.Name, v)
		} else {
			ordered.Set(t.Name, []any{})
		}
	}
	sum := sha256.Sum256(jsjson.Stringify(ordered))
	return "sha256:" + hex.EncodeToString(sum[:])
}
