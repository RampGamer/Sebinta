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

module.exports = db;
