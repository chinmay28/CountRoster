package migrate

import (
	"strconv"

	"github.com/chinmay28/countroster/server/internal/storage"
)

const schemaVersionKey = "schema_version"

// CurrentVersion reads schema_version from app_meta, or 0 on a fresh DB.
func CurrentVersion(st storage.Storage) (int, error) {
	tables, err := st.Query(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'`)
	if err != nil {
		return 0, err
	}
	if len(tables) == 0 {
		return 0, nil
	}
	rows, err := st.Query(`SELECT value FROM app_meta WHERE key = ?`, schemaVersionKey)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	s, _ := rows[0].Get("value").(string)
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0, nil
	}
	return v, nil
}

// Run applies any pending migrations in one transaction and returns the
// schema version afterwards. Idempotent.
func Run(st storage.Storage) (int, error) {
	current, err := CurrentVersion(st)
	if err != nil {
		return 0, err
	}
	var pending []Migration
	for _, m := range Migrations {
		if m.Version > current {
			pending = append(pending, m)
		}
	}
	if len(pending) == 0 {
		return current, nil
	}

	newVersion := pending[len(pending)-1].Version
	err = st.Transaction(func(tx storage.Storage) error {
		for _, m := range pending {
			if err := tx.Exec(m.Up); err != nil {
				return err
			}
		}
		return tx.Exec(
			`INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			schemaVersionKey, strconv.Itoa(newVersion))
	})
	if err != nil {
		return 0, err
	}
	return newVersion, nil
}
