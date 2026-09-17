package main

import (
	"database/sql"
	"log"
	"os"

	_ "modernc.org/sqlite"
)

// Schema IDENTICAL to server/db.js — the same DATA_DIR/UPLOADS_DIR can be
// used interchangeably by the Node server or this one, with no migration.
const schema = `
CREATE TABLE IF NOT EXISTS pads (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  pad_id TEXT NOT NULL REFERENCES pads(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_pad_id ON files(pad_id);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
`

func openDB(cfg *Config) *sql.DB {
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatalf("could not create %s: %v", cfg.DataDir, err)
	}
	if err := os.MkdirAll(cfg.QuarantineDir, 0o755); err != nil {
		log.Fatalf("could not create %s: %v", cfg.QuarantineDir, err)
	}
	if err := os.MkdirAll(cfg.FinalDir, 0o755); err != nil {
		log.Fatalf("could not create %s: %v", cfg.FinalDir, err)
	}

	db, err := sql.Open("sqlite", cfg.DBPath+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)")
	if err != nil {
		log.Fatalf("could not open the database: %v", err)
	}
	// SQLite doesn't handle concurrent writes from multiple connections
	// well; a single connection avoids "database is locked" under
	// concurrent load.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(schema); err != nil {
		log.Fatalf("could not create the schema: %v", err)
	}
	if err := migrateContentFormat(db); err != nil {
		log.Fatalf("could not migrate the schema: %v", err)
	}
	return db
}

// migrateContentFormat mirrors server/db.js: no migration framework, just a
// guarded ALTER run on every boot, for pads created before content_format
// existed. 'text' is the safe default: the client HTML-escapes it instead
// of trusting it as markup (see standalone/public/js/app.js refresh()).
func migrateContentFormat(db *sql.DB) error {
	rows, err := db.Query(`SELECT name FROM pragma_table_info('pads')`)
	if err != nil {
		return err
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		if name == "content_format" {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if found {
		return nil
	}
	_, err = db.Exec(`ALTER TABLE pads ADD COLUMN content_format TEXT NOT NULL DEFAULT 'text'`)
	return err
}
