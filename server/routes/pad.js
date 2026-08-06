'use strict';

const express = require('express');
const config = require('../config');
const auth = require('../auth');
const store = require('../services/padStore');
const { padWriteLimiter, padPasswordLimiter } = require('../middleware/rateLimit');
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

/** Extrai e valida o id do pad a partir de ?id=... em todas as rotas deste router. */
function requirePadId(req, res, next) {
  const raw = typeof req.query.id === 'string' ? req.query.id : '';
  const padId = store.normalizePadId(raw);
  if (!padId) return res.status(400).json({ error: 'invalid_pad_id' });
  req.padId = padId;
  next();
}
router.use(requirePadId);

// GET /api/pad?id=... -> estado atual do pad (ou apenas "locked" se tiver password)
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

// GET /api/pad/poll?id=...&version=N -> long-ish poll simples (fallback sem WebSocket)
router.get('/poll', (req, res) => {
  const pad = store.getPad(req.padId);
  const version = pad ? pad.version : 0;
  res.json({ version });
});

router.use(express.json({ limit: '4mb' }));

// PUT /api/pad?id=... { content } -> grava o texto (autosave debounced no cliente)
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

// DELETE /api/pad?id=... -> apaga conteúdo de texto e todos os ficheiros associados
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

// POST /api/pad/password?id=... { password } -> define/remove a password deste pad
router.post('/password', padPasswordLimiter, auth.csrfProtection, (req, res) => {
  const pad = store.getOrCreatePad(req.padId);
  if (pad.password_hash && !auth.isPadUnlocked(req, req.padId, pad)) {
    return res.status(423).json({ error: 'pad_locked' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) {
    store.setPadPassword(req.padId, null);
    ws.broadcastPadChanged(req.padId);
    return res.json({ ok: true, hasPassword: false });
  }
  if (password.length < 4 || password.length > 200) {
    return res.status(400).json({ error: 'invalid_password_length' });
  }
  const hash = auth.hashPadPassword(password);
  store.setPadPassword(req.padId, hash);
  auth.markPadUnlocked(req, res, req.padId);
  // Sem isto, quem já tem o pad aberto só via o badge "Protegido" (ou fica
  // bloqueado, se ainda não tiver a cookie de desbloqueio) depois de um F5.
  ws.broadcastPadChanged(req.padId);
  res.json({ ok: true, hasPassword: true });
});

// POST /api/pad/unlock?id=... { password } -> tenta desbloquear um pad protegido
router.post('/unlock', padPasswordLimiter, auth.csrfProtection, (req, res) => {
  const pad = store.getOrCreatePad(req.padId);
  if (!pad.password_hash) return res.json({ ok: true });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!auth.verifyPadPassword(password, pad.password_hash)) {
    // 403, não 401: o cliente trata qualquer 401 como "falta autenticação do
    // site" e redireciona para /login (ver api() em app.js) — uma password
    // de pad errada não tem nada a ver com isso.
    return res.status(403).json({ error: 'invalid_password' });
  }
  auth.markPadUnlocked(req, res, req.padId);
  res.json({ ok: true });
});

module.exports = router;
