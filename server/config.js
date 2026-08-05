'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// COOKIE_SECRET / CSRF_SECRET sao gerados aleatoriamente se nao definidos,
// mas nesse caso as sessoes nao sobrevivem a um restart do container.
// Em producao define-os no .env para manter as sessoes de forma estavel.
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

const config = {
  rootDir: ROOT_DIR,
  port: envInt('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'production',

  dataDir: process.env.DATA_DIR || path.join(ROOT_DIR, 'data'),
  dbPath: process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'), 'filepad.db'),

  uploadsDir: process.env.UPLOADS_DIR || path.join(ROOT_DIR, 'uploads'),
  quarantineDir: path.join(process.env.UPLOADS_DIR || path.join(ROOT_DIR, 'uploads'), 'quarantine'),
  finalDir: path.join(process.env.UPLOADS_DIR || path.join(ROOT_DIR, 'uploads'), 'final'),

  // Password global do site (opcional). Se vazia/indefinida, o site abre livremente.
  sitePassword: process.env.SITE_PASSWORD || '',

  cookieSecret: COOKIE_SECRET,
  cookieSecure: process.env.COOKIE_SECURE !== 'false', // true por omissao (atras do tunnel ha sempre HTTPS)

  maxFileSizeMb: envInt('MAX_FILE_SIZE_MB', 500),
  get maxFileSizeBytes() {
    return this.maxFileSizeMb * 1024 * 1024;
  },

  // Se definido (> 0), ficheiros mais antigos que N dias sao apagados automaticamente.
  fileTtlDays: envInt('FILE_TTL_DAYS', 0),

  maxPadContentChars: envInt('MAX_PAD_CONTENT_CHARS', 2_000_000),

  trustProxy: process.env.TRUST_PROXY !== 'false',
};

module.exports = config;
