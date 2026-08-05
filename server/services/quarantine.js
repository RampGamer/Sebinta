'use strict';

/*
 * Camada 2 de limpeza de metadados (obrigatória, no servidor, para TODOS os
 * ficheiros — mesmo os já limpos no browser). Um ficheiro só é considerado
 * "seguro" depois de passar por aqui com sucesso. Nunca deve existir um
 * caminho de código que mova um ficheiro para armazenamento definitivo sem
 * passar primeiro por cleanInQuarantine().
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXIFTOOL_BIN = process.env.EXIFTOOL_BIN || 'exiftool';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 min: generoso para videos grandes

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout ? stdout.toString() : '', stderr: stderr ? stderr.toString() : '' });
    });
  });
}

// Familias para as quais o requisito 11 exige explicitamente exiftool -all=
// (imagens, PDFs e documentos). Uma falha aqui rejeita o upload.
const EXIFTOOL_STRICT_FAMILIES = new Set(['image', 'pdf', 'zip', 'ole', 'svg']);
const AV_FAMILIES = new Set(['video', 'audio']);

/**
 * Limpa metadados de um ficheiro que está na pasta de quarentena, em função
 * da família detetada pelos magic bytes (server/services/fileType.js).
 * O ficheiro é limpo *in place* dentro da própria quarentena.
 *
 * @param {string} filePath caminho do ficheiro dentro da quarentena
 * @param {{family:string}} sniffed resultado de fileType.sniff()
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function cleanInQuarantine(filePath, sniffed) {
  if (AV_FAMILIES.has(sniffed.family)) {
    return cleanAudioVideo(filePath);
  }

  if (EXIFTOOL_STRICT_FAMILIES.has(sniffed.family)) {
    const { error, stderr } = await run(EXIFTOOL_BIN, ['-all=', '-overwrite_original', '-q', '-q', filePath]);
    if (error) {
      return { ok: false, reason: `exiftool_failed: ${(stderr || '').slice(0, 300)}` };
    }
    return { ok: true };
  }

  // Ficheiros genéricos ('other', zip sem formato Office reconhecido): não
  // existe um formato de metadados conhecido e padronizado para limpar com
  // segurança. Corre-se exiftool em modo best-effort (remove o que
  // conseguir reconhecer), mas uma falha não bloqueia o upload — o ficheiro
  // já passou pela quarentena, que é o que o requisito de segurança exige.
  await run(EXIFTOOL_BIN, ['-all=', '-overwrite_original', '-q', '-q', filePath]);
  return { ok: true };
}

async function cleanAudioVideo(filePath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath) || '.bin';
  const tmpOut = path.join(dir, `clean-${crypto.randomUUID()}${ext}`);

  // -map_metadata -1 remove metadados globais e por-stream; -map_chapters -1
  // remove capítulos (podem conter texto livre). -c copy remuxa sem
  // reencode: rápido e sem perda de qualidade.
  let { error } = await run(FFMPEG_BIN, [
    '-y', '-i', filePath,
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-c', 'copy',
    tmpOut,
  ]);

  if (error) {
    // Alguns contentores recusam 'copy' direto (streams incompatíveis com o
    // contentor de saída). Fallback: reencode completo, ainda sem metadados.
    await safeUnlink(tmpOut);
    ({ error } = await run(FFMPEG_BIN, [
      '-y', '-i', filePath,
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      tmpOut,
    ]));
  }

  if (error) {
    await safeUnlink(tmpOut);
    return { ok: false, reason: 'ffmpeg_failed' };
  }

  try {
    fs.renameSync(tmpOut, filePath);
  } catch (e) {
    await safeUnlink(tmpOut);
    return { ok: false, reason: 'ffmpeg_replace_failed' };
  }
  return { ok: true };
}

async function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) { /* ignore: melhor esforço */ }
}

module.exports = { cleanInQuarantine };
