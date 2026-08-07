'use strict';

const express = require('express');
const config = require('../config');
const auth = require('../auth');
const store = require('../services/padStore');
const {
  padWriteLimiter,
  padPasswordLimiter,
  padUnlockRetryAfterSeconds,
  recordPadUnlockFailure,
  recordPadUnlockSuccess,
} = require('../middleware/rateLimit');
const ws = require('../ws');

const router = express.Router();

function fileToJson(f) {
  return {
    id: f.id,
    name: f.original_name,
    size: f.size,
    mimeType: f.mime_type,
    kind: f.kind,
    createdAt: f.created_at,
  };
}

/** Extracts and validates the pad id from ?id=... on every route in this router. */
function requirePadId(req, res, next) {
  const raw = typeof req.query.id === 'string' ? req.query.id : '';
  const padId = store.normalizePadId(raw);
  if (!padId) return res.status(400).json({ error: 'invalid_pad_id' });
  req.padId = padId;
  next();
}
router.use(requirePadId);

// GET /api/pad?id=... -> current pad state (or just "locked" if it has a password)
router.get('/', (req, res) => {
  const pad = store.getOrCreatePad(req.padId);
  const hasPassword = Boolean(pad.password_hash);
  const unlocked = auth.isPadUnlocked(req, req.padId, pad);
  if (hasPassword && !unlocked) {
    return res.json({ id: req.padId, hasPassword: true, locked: true });
  }
  const files = store.listFiles(req.padId).map(fileToJson);
  res.json({
    id: req.padId,
    hasPassword,
    locked: false,
    content: pad.content,
    version: pad.version,
    updatedAt: pad.updated_at,
    files,
  });
});

// GET /api/pad/poll?id=...&version=N -> simple long-ish poll (fallback without WebSocket)
router.get('/poll', (req, res) => {
  const pad = store.getPad(req.padId);
  const version = pad ? pad.version : 0;
  res.json({ version });
});

router.use(express.json({ limit: '4mb' }));

// PUT /api/pad?id=... { content } -> saves the text (client-side debounced autosave)
router.put('/', padWriteLimiter, auth.csrfProtection, (req, res) => {
  const pad = store.getOrCreatePad(req.padId);
  if (pad.password_hash && !auth.isPadUnlocked(req, req.padId, pad)) {
    return res.status(423).json({ error: 'pad_locked' });
  }
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  if (content.length > config.maxPadContentChars) {
    return res.status(413).json({ error: 'content_too_large' });
  }
  const updated = store.updateContent(req.padId, content);
  ws.broadcastPadChanged(req.padId, { version: updated.version });
  res.json({ ok: true, version: updated.version });
});

// DELETE /api/pad?id=... -> deletes the text content and all associated files
router.delete('/', auth.csrfProtection, (req, res) => {
  const pad = store.getOrCreatePad(req.padId);
  if (pad.password_hash && !auth.isPadUnlocked(req, req.padId, pad)) {
    return res.status(423).json({ error: 'pad_locked' });
  }
  const removedFiles = store.clearPad(req.padId);
  const { deleteStoredFile } = require('../services/storage');
  for (const f of removedFiles) deleteStoredFile(f.stored_name);
  ws.broadcastPadChanged(req.padId);
  res.json({ ok: true });
});

// POST /api/pad/password?id=... { password } -> sets/removes this pad's password
router.post('/password', padPasswordLimiter, auth.csrfProtection, (req, res) => {
  const pad = store.getOrCreatePad(req.padId);
  if (pad.password_hash && !auth.isPadUnlocked(req, req.padId, pad)) {
    return res.status(423).json({ error: 'pad_locked' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) {
    store.setPadPassword(req.padId, null);
    res.json({ ok: true, hasPassword: false });
    ws.broadcastPadChanged(req.padId);
    return;
  }
  if (password.length < 4 || password.length > 200) {
    return res.status(400).json({ error: 'invalid_password_length' });
  }
  const hash = auth.hashPadPassword(password);
  store.setPadPassword(req.padId, hash);
  auth.markPadUnlocked(req, res, req.padId);
  res.json({ ok: true, hasPassword: true });
  // Broadcast only after the response (which already carries the unlock
  // cookie) has been sent — never before: whoever set the password already
  // has a WebSocket connection open on this pad, and if "changed" arrived
  // first, the refresh() it triggers would use the still-old cookie and
  // see itself as locked, right after setting the password.
  ws.broadcastPadChanged(req.padId);
});

// POST /api/pad/unlock?id=... { password } -> tries to unlock a protected pad
router.post('/unlock', padPasswordLimiter, auth.csrfProtection, (req, res) => {
  const pad = store.getOrCreatePad(req.padId);
  if (!pad.password_hash) return res.json({ ok: true });
  const retryAfterSeconds = padUnlockRetryAfterSeconds(req);
  if (retryAfterSeconds > 0) {
    return res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!auth.verifyPadPassword(password, pad.password_hash)) {
    recordPadUnlockFailure(req);
    // 403, not 401: the client treats any 401 as "site auth required" and
    // redirects to /login (see api() in app.js) — a wrong pad password has
    // nothing to do with that.
    return res.status(403).json({ error: 'invalid_password' });
  }
  recordPadUnlockSuccess(req);
  auth.markPadUnlocked(req, res, req.padId);
  res.json({ ok: true });
});

module.exports = router;
