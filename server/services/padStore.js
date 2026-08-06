'use strict';

const db = require('../db');
const config = require('../config');

// Segmentos reservados: nunca podem ser o pad (colidem com rotas da app).
const RESERVED_TOP_SEGMENTS = new Set([
  'api', 'ws', 'login', 'logout', 'health', 'css', 'js', 'fonts', 'vendor',
  'favicon.ico', 'robots.txt', 'uploads',
]);

const PAD_ID_RE = /^[a-zA-Z0-9._~-]+(\/[a-zA-Z0-9._~-]+)*$/;

/**
 * Normaliza e valida um caminho de URL como identificador de pad.
 * Previne path traversal (".."), segmentos vazios e caracteres perigosos.
 * @returns {string|null} o id normalizado, ou null se inválido
 */
function normalizePadId(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let p = rawPath.trim();
  // remove barra inicial/final
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return null;
  if (p.length > 200) return null;
  if (p.includes('..')) return null;
  if (!PAD_ID_RE.test(p)) return null;
  const firstSegment = p.split('/')[0].toLowerCase();
  if (RESERVED_TOP_SEGMENTS.has(firstSegment)) return null;
  return p;
}

function getPad(padId) {
  return db.prepare('SELECT * FROM pads WHERE id = ?').get(padId);
}

function getOrCreatePad(padId) {
  const existing = getPad(padId);
  if (existing) return existing;
  const now = Date.now();
  db.prepare('INSERT INTO pads (id, content, version, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
    .run(padId, '', now, now);
  return getPad(padId);
}

function updateContent(padId, content) {
  const now = Date.now();
  db.prepare('UPDATE pads SET content = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(content, now, padId);
  return getPad(padId);
}

function clearPad(padId) {
  const now = Date.now();
  db.prepare('UPDATE pads SET content = \'\', version = version + 1, updated_at = ? WHERE id = ?')
    .run(now, padId);
  const files = db.prepare('SELECT * FROM files WHERE pad_id = ?').all(padId);
  db.prepare('DELETE FROM files WHERE pad_id = ?').run(padId);
  return files;
}

function setPadPassword(padId, hashOrNull) {
  db.prepare('UPDATE pads SET password_hash = ? WHERE id = ?').run(hashOrNull, padId);
}

function listFiles(padId) {
  return db.prepare('SELECT * FROM files WHERE pad_id = ? ORDER BY created_at ASC').all(padId);
}

function getFile(padId, fileId) {
  return db.prepare('SELECT * FROM files WHERE pad_id = ? AND id = ?').get(padId, fileId);
}

function insertFile(file) {
  db.prepare(`INSERT INTO files (id, pad_id, original_name, stored_name, mime_type, size, kind, created_at)
    VALUES (@id, @pad_id, @original_name, @stored_name, @mime_type, @size, @kind, @created_at)`).run(file);
  db.prepare('UPDATE pads SET version = version + 1, updated_at = ? WHERE id = ?').run(Date.now(), file.pad_id);
}

function deleteFile(padId, fileId) {
  const file = getFile(padId, fileId);
  if (!file) return null;
  db.prepare('DELETE FROM files WHERE pad_id = ? AND id = ?').run(padId, fileId);
  db.prepare('UPDATE pads SET version = version + 1, updated_at = ? WHERE id = ?').run(Date.now(), padId);
  return file;
}

function findExpiredFiles(ttlDays) {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  return db.prepare('SELECT * FROM files WHERE created_at < ?').all(cutoff);
}

module.exports = {
  normalizePadId,
  getPad,
  getOrCreatePad,
  updateContent,
  clearPad,
  setPadPassword,
  listFiles,
  getFile,
  insertFile,
  deleteFile,
  findExpiredFiles,
};
