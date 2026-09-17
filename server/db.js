'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.quarantineDir, { recursive: true });
fs.mkdirSync(config.finalDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
    kind TEXT NOT NULL, -- 'image' | 'video' | 'other'
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_files_pad_id ON files(pad_id);
  CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
`);

// No migration framework here (see comment style above) — this is a plain
// guarded ALTER, run on every boot, for pads created before content_format
// existed. 'text' is the safe default: the client HTML-escapes it instead
// of trusting it as markup (see public/js/app.js refresh()).
const hasContentFormat = db.prepare("SELECT 1 FROM pragma_table_info('pads') WHERE name = 'content_format'").get();
if (!hasContentFormat) {
  db.exec("ALTER TABLE pads ADD COLUMN content_format TEXT NOT NULL DEFAULT 'text'");
}

module.exports = db;
