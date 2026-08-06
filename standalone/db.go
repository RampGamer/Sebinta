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
	return db
}
