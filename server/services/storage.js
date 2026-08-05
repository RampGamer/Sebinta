'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

// Nomes gerados sempre pelo servidor (UUID + extensão curta) — nunca a
// partir do nome original do ficheiro. Isto por si só já prevem path
// traversal nos nomes armazenados, mas valida-se mesmo assim em profundidade.
const SAFE_STORED_NAME_RE = /^[a-fA-F0-9-]{36}(\.[a-zA-Z0-9]{1,10})?$/;

function isSafeStoredName(name) {
  return typeof name === 'string' && SAFE_STORED_NAME_RE.test(name);
}

function finalPath(storedName) {
  if (!isSafeStoredName(storedName)) return null;
  const resolved = path.resolve(config.finalDir, storedName);
  if (!resolved.startsWith(path.resolve(config.finalDir) + path.sep)) return null;
  return resolved;
}

function quarantinePath(storedName) {
  if (!isSafeStoredName(storedName)) return null;
  const resolved = path.resolve(config.quarantineDir, storedName);
  if (!resolved.startsWith(path.resolve(config.quarantineDir) + path.sep)) return null;
  return resolved;
}

function deleteStoredFile(storedName) {
  const p = finalPath(storedName);
  if (!p) return;
  fs.unlink(p, (err) => {
    if (err && err.code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.error('Falha ao apagar ficheiro do armazenamento:', err.code);
    }
  });
}

module.exports = { isSafeStoredName, finalPath, quarantinePath, deleteStoredFile };
