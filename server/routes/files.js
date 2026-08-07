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

// Chunked uploads (see public/js/upload.js): Cloudflare's tunnel proxy caps
// request bodies at 100MB on the plans this project targets, so the browser
// splits any file into chunks well under that and sends them as separate
// requests sharing an uploadId, passed as query params (?uploadId=...&
// chunkIndex=N&totalChunks=N) — available before the multipart body is
// touched at all, unlike a form field. Older/other clients (the
// sebinta-clean CLI's `send` command, curl, ...) that never send them keep
// working exactly as before — this custom storage engine treats that as a
// single chunk (0 of 1).
const uploadIdRe = /^[a-fA-F0-9-]{1,64}$/;

// --- Multer: always writes to the QUARANTINE folder first, never to the final destination. ---
// A custom storage engine (rather than multer.diskStorage) so a chunk
// continuation can be *appended* to the same accumulating file instead of
// each chunk landing in its own file that would need reassembling.
const chunkedStorage = {
  _handleFile(req, file, cb) {
    const uploadId = typeof req.query.uploadId === 'string' ? req.query.uploadId : '';
    const totalChunks = Number(req.query.totalChunks) || 0;
    const chunkIndex = Number(req.query.chunkIndex) || 0;
    const chunked = Boolean(uploadId) && totalChunks > 1;

    if (chunked && !uploadIdRe.test(uploadId)) {
      return cb(Object.assign(new Error('invalid_upload_id'), { code: 'INVALID_UPLOAD_ID' }));
    }
    if (chunked && (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks)) {
      return cb(Object.assign(new Error('invalid_chunk_index'), { code: 'INVALID_CHUNK_INDEX' }));
    }

    const destPath = chunked
      ? path.join(config.quarantineDir, `chunk-${uploadId}`)
      : path.join(config.quarantineDir, crypto.randomUUID());
    const appending = chunked && chunkIndex > 0;

    let priorSize = 0;
    if (appending) {
      try {
        priorSize = fs.statSync(destPath).size;
      } catch (e) { /* first chunk this server has seen for this id — starts at 0 */ }
    }

    let total = priorSize;
    let tooLarge = false;
    const out = fs.createWriteStream(destPath, { flags: appending ? 'a' : 'w' });
    file.stream.on('data', (data) => {
      total += data.length;
      if (total > config.maxFileSizeBytes) tooLarge = true;
    });
    out.on('error', (err) => cb(err));
    file.stream.pipe(out);
    out.on('finish', () => {
      if (tooLarge) {
        return cb(Object.assign(new Error('file_too_large'), { code: 'LIMIT_FILE_SIZE' }));
      }
      cb(null, { path: destPath, filename: path.basename(destPath), size: total });
    });
  },
  _removeFile(req, file, cb) {
    fs.unlink(file.path, () => cb(null));
  },
};

const upload = multer({ storage: chunkedStorage });

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
 * POST /api/files?id=...[&uploadId=...&chunkIndex=N&totalChunks=N] (multipart/form-data, field "file")
 *
 * No metadata cleaning on the server — anyone who needs that guarantee
 * uses the desktop app (desktop/) or the CLI (cli/) before uploading.
 * multer always writes to uploads/quarantine/ first (folder name kept for
 * compatibility with existing Docker volumes) just to allow detecting the
 * real type via magic bytes before moving to uploads/final/.
 */
router.post('/', auth.csrfProtection, requireUnlockedPad, (req, res, next) => {
  // Only the first request of an upload (the whole file, or chunk 0) counts
  // against uploadLimiter — otherwise a single large file, split into dozens
  // of chunk requests, would exhaust the abuse limit on its own and block
  // the rest of its own chunks.
  const chunkIndex = Number(req.query.chunkIndex) || 0;
  if (chunkIndex === 0) return uploadLimiter(req, res, next);
  next();
}, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file_too_large', maxMb: config.maxFileSizeMb });
      }
      if (err.code === 'INVALID_UPLOAD_ID') {
        return res.status(400).json({ error: 'invalid_upload_id' });
      }
      if (err.code === 'INVALID_CHUNK_INDEX') {
        return res.status(400).json({ error: 'invalid_chunk_index' });
      }
      return res.status(400).json({ error: 'upload_failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'no_file' });
    }

    const uploadId = typeof req.query.uploadId === 'string' ? req.query.uploadId : '';
    const totalChunks = Number(req.query.totalChunks) || 0;
    const chunkIndex = Number(req.query.chunkIndex) || 0;
    const chunked = Boolean(uploadId) && totalChunks > 1;

    if (chunked && chunkIndex < totalChunks - 1) {
      return res.status(200).json({ ok: true, chunkIndex });
    }

    const quarantineFile = req.file.path;
    let finalStoredPath = null;

    try {
      const head = await readHeadBytes(quarantineFile);
      const sniffed = fileType.sniff(head, req.file.originalname);

      // The stored name includes the real extension detected via magic
      // bytes (never the extension declared by the client), so the
      // Content-Type served in /download and /preview is always correct.
      // A fresh ID here — never req.file.filename, which for a chunked
      // upload is the shared "chunk-<uploadId>" accumulator name, not a
      // per-file ID.
      const fileId = crypto.randomUUID();
      const storedName = `${fileId}${sniffed.ext || ''}`;
      const finalDest = storage.finalPath(storedName);
      await fsp.rename(quarantineFile, finalDest);
      finalStoredPath = finalDest;

      const stat = await fsp.stat(finalDest);
      const fileRow = {
        id: fileId,
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
