// Package storage is the contract between the domain layer and SQLite. It is
// intentionally tiny — Exec, Query, Transaction, Close — and the domain
// services write raw parameterized SQL against it: SQL *is* the contract,
// exactly as in the TypeScript core this package replaces.
package storage

import (
	"database/sql"
	"fmt"
	"net/url"

	_ "modernc.org/sqlite"
)

// Row is one result row with the statement's column order preserved. Callers
// that don't care about order use Get; the backup canonicalizer depends on
// the order matching the engine's SELECT * column order.
type Row struct {
	Columns []string
	Values  []any
}

// Get returns the value of the named column (nil if absent either way).
func (r *Row) Get(name string) any {
	for i, c := range r.Columns {
		if c == name {
			return r.Values[i]
		}
	}
	return nil
}

// Storage mirrors the TS core's 4-method adapter interface.
type Storage interface {
	Exec(sql string, params ...any) error
	Query(sql string, params ...any) ([]Row, error)
	// Transaction runs fn atomically; a returned error rolls back. Nested
	// calls simply run in the outer transaction.
	Transaction(fn func(tx Storage) error) error
	Close() error
}

type queryer interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
}

// DB is the file- (or memory-) backed SQLite Storage.
type DB struct {
	db *sql.DB
	// Path is the on-disk path (":memory:" for the transient case).
	Path string
}

// Open opens the SQLite database at path (":memory:" is honored as the
// SQLite sentinel) in WAL mode with foreign keys enforced. A single pooled
// connection keeps transaction state coherent, matching the single-handle
// node:sqlite adapter this replaces.
func Open(path string) (*DB, error) {
	dsn := "file:" + url.PathEscape(path) +
		"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	if path == ":memory:" {
		dsn = "file::memory:?_pragma=foreign_keys(1)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open sqlite %q: %w", path, err)
	}
	return &DB{db: db, Path: path}, nil
}

func (d *DB) Exec(query string, params ...any) error {
	_, err := d.db.Exec(query, params...)
	return err
}

func (d *DB) Query(query string, params ...any) ([]Row, error) {
	return queryRows(d.db, query, params...)
}

func (d *DB) Transaction(fn func(tx Storage) error) error {
	sqlTx, err := d.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(&txStorage{tx: sqlTx}); err != nil {
		sqlTx.Rollback()
		return err
	}
	return sqlTx.Commit()
}

func (d *DB) Close() error { return d.db.Close() }

// Checkpoint flushes pending WAL frames into the main database file, so a
// raw-file download doesn't silently omit recent commits.
func (d *DB) Checkpoint() error {
	return d.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
}

type txStorage struct{ tx *sql.Tx }

func (t *txStorage) Exec(query string, params ...any) error {
	_, err := t.tx.Exec(query, params...)
	return err
}

func (t *txStorage) Query(query string, params ...any) ([]Row, error) {
	return queryRows(t.tx, query, params...)
}

func (t *txStorage) Transaction(fn func(tx Storage) error) error { return fn(t) }

func (t *txStorage) Close() error { return nil }

func queryRows(q queryer, query string, params ...any) ([]Row, error) {
	rows, err := q.Query(query, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var out []Row
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		for i, v := range values {
			// Normalize BLOB-scanned []byte for TEXT columns read through
			// expressions; the driver yields string for TEXT already, but be
			// defensive so callers can always type-switch on string.
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}
		out = append(out, Row{Columns: cols, Values: values})
	}
	return out, rows.Err()
}
