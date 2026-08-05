'use strict';

/*
 * Tarefa agendada opcional (FILE_TTL_DAYS): apaga ficheiros mais antigos que
 * N dias, tanto do disco como da base de dados. Corre dentro do próprio
 * processo Node (setInterval), sem dependências externas — mantém-se o
 * princípio de "sem filas, sem microserviços".
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('./padStore');
const storage = require('./storage');
const ws = require('../ws');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // verifica a cada hora

/*
 * Nada deve ficar na quarentena de forma permanente: se o processo morrer a
 * meio de um upload (entre o multer gravar e o ficheiro ser movido para
 * uploads/final/), o resto fica lá. No arranque, varre-se a quarentena e
 * apaga-se tudo o que já lá está há mais de 1 hora (nunca associado a
 * nenhum pad, é sempre seguro apagar).
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
    } catch (_) { /* ignora entradas já removidas por outro processo */ }
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
  console.log(`[cleanup] ${expired.length} ficheiro(s) expirado(s) removido(s) (TTL=${config.fileTtlDays}d).`);
}

function start() {
  sweepQuarantine();
  setInterval(sweepQuarantine, CHECK_INTERVAL_MS);

  if (!config.fileTtlDays || config.fileTtlDays <= 0) {
    // eslint-disable-next-line no-console
    console.log('[cleanup] FILE_TTL_DAYS não definido — limpeza automática de ficheiros antigos desativada.');
    return;
  }
  runOnce();
  setInterval(runOnce, CHECK_INTERVAL_MS);
  // eslint-disable-next-line no-console
  console.log(`[cleanup] limpeza automática ativa: ficheiros com mais de ${config.fileTtlDays} dia(s) serão removidos.`);
}

module.exports = { start, runOnce, sweepQuarantine };
