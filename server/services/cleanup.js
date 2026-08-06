'use strict';

/*
 * Optional scheduled task (FILE_TTL_DAYS): deletes files older than N days,
 * both from disk and the database. Runs inside the Node process itself
 * (setInterval), no external dependencies — keeps the "no queues, no
 * microservices" principle.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('./padStore');
const storage = require('./storage');
const ws = require('../ws');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // checks every hour

/*
 * Nothing should stay in quarantine permanently: if the process dies mid-
 * upload (between multer saving and the file being moved to
 * uploads/final/), the rest stays there. On startup, quarantine is swept
 * and anything older than 1 hour is deleted (never associated with any
 * pad, always safe to delete).
 */
function sweepQuarantine() {
  let entries;
  try {
    entries = fs.readdirSync(config.quarantineDir);
  } catch (_) {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of entries) {
    if (name === '.gitkeep') continue;
    const p = path.join(config.quarantineDir, name);
    try {
      const stat = fs.statSync(p);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(p);
    } catch (_) { /* ignores entries already removed by another process */ }
  }
}

function runOnce() {
  if (!config.fileTtlDays || config.fileTtlDays <= 0) return;
  const expired = store.findExpiredFiles(config.fileTtlDays);
  if (expired.length === 0) return;

  const affectedPads = new Set();
  for (const file of expired) {
    const removed = store.deleteFile(file.pad_id, file.id);
    if (removed) {
      storage.deleteStoredFile(removed.stored_name);
      affectedPads.add(removed.pad_id);
    }
  }
  for (const padId of affectedPads) ws.broadcastPadChanged(padId);
  // eslint-disable-next-line no-console
  console.log(`[cleanup] ${expired.length} expired file(s) removed (TTL=${config.fileTtlDays}d).`);
}

function start() {
  sweepQuarantine();
  setInterval(sweepQuarantine, CHECK_INTERVAL_MS);

  if (!config.fileTtlDays || config.fileTtlDays <= 0) {
    // eslint-disable-next-line no-console
    console.log('[cleanup] FILE_TTL_DAYS not set — automatic cleanup of old files disabled.');
    return;
  }
  runOnce();
  setInterval(runOnce, CHECK_INTERVAL_MS);
  // eslint-disable-next-line no-console
  console.log(`[cleanup] automatic cleanup enabled: files older than ${config.fileTtlDays} day(s) will be removed.`);
}

module.exports = { start, runOnce, sweepQuarantine };
