'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const config = require('../config');
const auth = require('../auth');
const store = require('../services/padStore');
const storage = require('../services/storage');
const fileType = require('../services/fileType');
const { uploadLimiter } = require('../middleware/rateLimit');
const ws = require('../ws');

const router = express.Router();

// --- Multer: always writes to the QUARANTINE folder first, never to the final destination. ---
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.quarantineDir),
  filename: (req, file, cb) => cb(null, crypto.randomUUID()),
});

const upload = multer({
  storage: multerStorage,
  limits: { fileSize: config.maxFileSizeBytes, files: 1 },
});

function sanitizeOriginalName(name) {
  const base = path.basename(String(name || 'file'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return (cleaned || 'file').slice(0, 255);
}

function contentDispositionHeader(disposition, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Shared middleware: validates ?id=, ensures it exists and isn't locked. */
async function requireUnlockedPad(req, res, next) {
  const padId = store.normalizePadId(typeof req.query.id === 'string' ? req.query.id : '');
  if (!padId) return res.status(400).json({ error: 'invalid_pad_id' });
  const pad = store.getOrCreatePad(padId);
  if (pad.password_hash && !auth.isPadUnlocked(req, padId, pad)) {
    return res.status(423).json({ error: 'pad_locked' });
  }
  req.padId = padId;
  req.pad = pad;
  next();
}

async function readHeadBytes(filePath, length = 4100) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function toUiKind(sniffed) {
  if (sniffed.kind === 'image') return 'image';
  if (sniffed.kind === 'video') return 'video';
  return 'other';
}

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

/*
 * POST /api/files?id=... (multipart/form-data, field "file")
 *
 * No metadata cleaning on the server — anyone who needs that guarantee
 * uses the desktop app (desktop/) or the CLI (cli/) before uploading.
 * multer always writes to uploads/quarantine/ first (folder name kept for
 * compatibility with existing Docker volumes) just to allow detecting the
 * real type via magic bytes before moving to uploads/final/.
 */
router.post('/', uploadLimiter, auth.csrfProtection, requireUnlockedPad, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file_too_large', maxMb: config.maxFileSizeMb });
      }
      return res.status(400).json({ error: 'upload_failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'no_file' });
    }

    const quarantineFile = req.file.path;
    let finalStoredPath = null;

    try {
      const head = await readHeadBytes(quarantineFile);
      const sniffed = fileType.sniff(head, req.file.originalname);

      // The stored name includes the real extension detected via magic
      // bytes (never the extension declared by the client), so the
      // Content-Type served in /download and /preview is always correct.
      const storedName = `${req.file.filename}${sniffed.ext || ''}`;
      const finalDest = storage.finalPath(storedName);
      await fsp.rename(quarantineFile, finalDest);
      finalStoredPath = finalDest;

      const stat = await fsp.stat(finalDest);
      const fileRow = {
        id: req.file.filename,
        pad_id: req.padId,
        original_name: sanitizeOriginalName(req.file.originalname),
        stored_name: storedName,
        mime_type: sniffed.mime,
        size: stat.size,
        kind: toUiKind(sniffed),
        created_at: Date.now(),
      };
      store.insertFile(fileRow);
      ws.broadcastPadChanged(req.padId);
      res.status(201).json(fileToJson(fileRow));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Upload processing failed:', e.message);
      await fsp.unlink(quarantineFile).catch(() => {});
      if (finalStoredPath) await fsp.unlink(finalStoredPath).catch(() => {});
      res.status(500).json({ error: 'upload_processing_failed' });
    }
  });
});

router.get('/:fileId/download', requireUnlockedPad, async (req, res) => {
  const file = store.getFile(req.padId, req.params.fileId);
  if (!file) return res.status(404).json({ error: 'not_found' });
  const filePath = storage.finalPath(file.stored_name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', contentDispositionHeader('attachment', file.original_name));
  fs.createReadStream(filePath).pipe(res);
});

// SVG is never previewed inline (it can contain <script>); only raster
// images and video get a preview — see security requirement #17.
router.get('/:fileId/preview', requireUnlockedPad, async (req, res) => {
  const file = store.getFile(req.padId, req.params.fileId);
  if (!file) return res.status(404).json({ error: 'not_found' });
  if (file.kind !== 'image' && file.kind !== 'video') {
    return res.status(415).json({ error: 'preview_not_supported' });
  }
  const filePath = storage.finalPath(file.stored_name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', contentDispositionHeader('inline', file.original_name));

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
});

router.delete('/:fileId', auth.csrfProtection, requireUnlockedPad, (req, res) => {
  const removed = store.deleteFile(req.padId, req.params.fileId);
  if (!removed) return res.status(404).json({ error: 'not_found' });
  storage.deleteStoredFile(removed.stored_name);
  ws.broadcastPadChanged(req.padId);
  res.json({ ok: true });
});

module.exports = router;
