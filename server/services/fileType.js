'use strict';

/*
 * Detects a file's real type from its "magic bytes" (binary signature),
 * instead of trusting the extension or the Content-Type the browser sent.
 * This is used to decide the real Content-Type to serve and whether a file
 * can have an inline preview (raster images and video only).
 *
 * A file whose extension says ".png" but whose bytes don't match PNG is
 * never treated as an image — avoids the classic trick of disguising
 * HTML/SVG with an embedded script as a harmless-looking image.
 */

const path = require('path');

// SVG is always excluded from inline preview (it can contain <script>),
// even though it's valid XML — see security requirement #17.
const EXT_MIME_FALLBACK = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.xml', 'application/xml'],
  ['.svg', 'image/svg+xml'],
  ['.doc', 'application/msword'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.odt', 'application/vnd.oasis.opendocument.text'],
  ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['.odp', 'application/vnd.oasis.opendocument.presentation'],
]);

const OOXML_EXT = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);

function matches(buf, offset, bytes) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function asciiAt(buf, offset, len) {
  if (buf.length < offset + len) return '';
  return buf.toString('ascii', offset, offset + len);
}

/**
 * @param {Buffer} buf file's first bytes (>= 4096 recommended)
 * @param {string} originalName original name sent by the client (tie-break/label only)
 * @returns {{ mime: string, kind: 'image'|'video'|'audio'|'pdf'|'ooxml'|'legacy-office'|'zip'|'other', ext: string, family: string }}
 */
function sniff(buf, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();

  // Raster images
  if (matches(buf, 0, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', kind: 'image', ext: '.jpg', family: 'image' };
  }
  if (matches(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', kind: 'image', ext: '.png', family: 'image' };
  }
  if (matches(buf, 0, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return { mime: 'image/gif', kind: 'image', ext: '.gif', family: 'image' };
  }
  if (asciiAt(buf, 0, 4) === 'RIFF' && asciiAt(buf, 8, 4) === 'WEBP') {
    return { mime: 'image/webp', kind: 'image', ext: '.webp', family: 'image' };
  }
  if (matches(buf, 0, [0x42, 0x4d])) {
    return { mime: 'image/bmp', kind: 'image', ext: '.bmp', family: 'image' };
  }

  // SVG (text, never rendered inline even though it's an image)
  const head = buf.slice(0, 512).toString('utf8').trim().toLowerCase();
  if (ext === '.svg' && (head.startsWith('<?xml') || head.startsWith('<svg'))) {
    return { mime: 'image/svg+xml', kind: 'other', ext: '.svg', family: 'svg' };
  }

  // PDF
  if (asciiAt(buf, 0, 5) === '%PDF-') {
    return { mime: 'application/pdf', kind: 'pdf', ext: '.pdf', family: 'pdf' };
  }

  // Video: MP4/MOV container (ftyp box)
  if (asciiAt(buf, 4, 4) === 'ftyp') {
    return { mime: 'video/mp4', kind: 'video', ext: ext === '.mov' ? '.mov' : '.mp4', family: 'video' };
  }
  // WEBM / MKV (EBML)
  if (matches(buf, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mime: ext === '.mkv' ? 'video/x-matroska' : 'video/webm', kind: 'video', ext: ext === '.mkv' ? '.mkv' : '.webm', family: 'video' };
  }
  // AVI
  if (asciiAt(buf, 0, 4) === 'RIFF' && asciiAt(buf, 8, 4) === 'AVI ') {
    return { mime: 'video/x-msvideo', kind: 'video', ext: '.avi', family: 'video' };
  }

  // Audio
  if (asciiAt(buf, 0, 4) === 'RIFF' && asciiAt(buf, 8, 4) === 'WAVE') {
    return { mime: 'audio/wav', kind: 'audio', ext: '.wav', family: 'audio' };
  }
  if (matches(buf, 0, [0x49, 0x44, 0x33]) || matches(buf, 0, [0xff, 0xfb]) || matches(buf, 0, [0xff, 0xf3]) || matches(buf, 0, [0xff, 0xf2])) {
    return { mime: 'audio/mpeg', kind: 'audio', ext: '.mp3', family: 'audio' };
  }
  if (asciiAt(buf, 0, 4) === 'OggS') {
    return { mime: 'audio/ogg', kind: 'audio', ext: '.ogg', family: 'audio' };
  }
  if (asciiAt(buf, 0, 4) === 'fLaC') {
    return { mime: 'audio/flac', kind: 'audio', ext: '.flac', family: 'audio' };
  }

  // ZIP / OOXML (docx, xlsx, pptx, odt...) / generic zip
  if (matches(buf, 0, [0x50, 0x4b, 0x03, 0x04]) || matches(buf, 0, [0x50, 0x4b, 0x05, 0x06])) {
    if (OOXML_EXT.has(ext)) {
      return { mime: EXT_MIME_FALLBACK.get(ext), kind: 'ooxml', ext, family: 'zip' };
    }
    return { mime: 'application/zip', kind: 'zip', ext: ext === '.zip' ? '.zip' : '.zip', family: 'zip' };
  }

  // Legacy Office (OLE2 Compound File): .doc, .xls, .ppt
  if (matches(buf, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { mime: EXT_MIME_FALLBACK.get(ext) || 'application/x-ole-storage', kind: 'legacy-office', ext: ext || '.doc', family: 'ole' };
  }

  // Fallback: plain text or generic binary — kept as-is, served as
  // 'other' (forced download), never with an inline preview.
  const fallbackMime = EXT_MIME_FALLBACK.get(ext) || 'application/octet-stream';
  return { mime: fallbackMime, kind: 'other', ext: ext || '', family: 'other' };
}

module.exports = { sniff };
