'use strict';

/*
 * Deteta o tipo real de um ficheiro a partir dos "magic bytes" (assinatura
 * binária), em vez de confiar na extensão ou no Content-Type enviado pelo
 * browser. Isto é usado para decidir o Content-Type real a servir e se um
 * ficheiro pode ter pré-visualização inline (só imagem raster e vídeo).
 *
 * Um ficheiro cuja extensão diz ".png" mas cujos bytes não correspondem a
 * PNG nunca é tratado como imagem — evita o clássico truque de disfarçar
 * HTML/SVG com script embutido como se fosse uma imagem inofensiva.
 */

const path = require('path');

// SVG é sempre excluído de preview inline (pode conter <script>), mesmo
// sendo XML válido — ver requisito de segurança #17.
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
 * @param {Buffer} buf primeiros bytes do ficheiro (>= 4096 recomendado)
 * @param {string} originalName nome original enviado pelo cliente (só para desempate/label)
 * @returns {{ mime: string, kind: 'image'|'video'|'audio'|'pdf'|'ooxml'|'legacy-office'|'zip'|'other', ext: string, family: string }}
 */
function sniff(buf, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();

  // Imagens raster
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

  // SVG (texto, nunca renderizado inline mesmo sendo imagem)
  const head = buf.slice(0, 512).toString('utf8').trim().toLowerCase();
  if (ext === '.svg' && (head.startsWith('<?xml') || head.startsWith('<svg'))) {
    return { mime: 'image/svg+xml', kind: 'other', ext: '.svg', family: 'svg' };
  }

  // PDF
  if (asciiAt(buf, 0, 5) === '%PDF-') {
    return { mime: 'application/pdf', kind: 'pdf', ext: '.pdf', family: 'pdf' };
  }

  // Vídeo: contentor MP4/MOV (ftyp box)
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

  // Áudio
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

  // ZIP / OOXML (docx, xlsx, pptx, odt...) / zip genérico
  if (matches(buf, 0, [0x50, 0x4b, 0x03, 0x04]) || matches(buf, 0, [0x50, 0x4b, 0x05, 0x06])) {
    if (OOXML_EXT.has(ext)) {
      return { mime: EXT_MIME_FALLBACK.get(ext), kind: 'ooxml', ext, family: 'zip' };
    }
    return { mime: 'application/zip', kind: 'zip', ext: ext === '.zip' ? '.zip' : '.zip', family: 'zip' };
  }

  // Office legado (OLE2 Compound File): .doc, .xls, .ppt
  if (matches(buf, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { mime: EXT_MIME_FALLBACK.get(ext) || 'application/x-ole-storage', kind: 'legacy-office', ext: ext || '.doc', family: 'ole' };
  }

  // Fallback: texto simples ou binário genérico — mantém-se, servido como
  // 'other' (download forçado), nunca com preview inline.
  const fallbackMime = EXT_MIME_FALLBACK.get(ext) || 'application/octet-stream';
  return { mime: fallbackMime, kind: 'other', ext: ext || '', family: 'other' };
}

module.exports = { sniff };
