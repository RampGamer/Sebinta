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

// COOKIE_SECRET / CSRF_SECRET are randomly generated if not set, but in
// that case sessions don't survive a container restart. In production,
// set them in .env to keep sessions stable.
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

const config = {
  rootDir: ROOT_DIR,
  port: envInt('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'production',

  dataDir: process.env.DATA_DIR || path.join(ROOT_DIR, 'data'),
  dbPath: process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'), 'sebinta.db'),

  uploadsDir: process.env.UPLOADS_DIR || path.join(ROOT_DIR, 'uploads'),
  quarantineDir: path.join(process.env.UPLOADS_DIR || path.join(ROOT_DIR, 'uploads'), 'quarantine'),
  finalDir: path.join(process.env.UPLOADS_DIR || path.join(ROOT_DIR, 'uploads'), 'final'),

  // Site-wide password (optional). If empty/undefined, the site opens freely.
  sitePassword: process.env.SITE_PASSWORD || '',

  cookieSecret: COOKIE_SECRET,
  cookieSecure: process.env.COOKIE_SECURE !== 'false', // true by default (there's always HTTPS behind the tunnel)

  maxFileSizeMb: envInt('MAX_FILE_SIZE_MB', 500),
  get maxFileSizeBytes() {
    return this.maxFileSizeMb * 1024 * 1024;
  },

  // If set (> 0), files older than N days are deleted automatically.
  fileTtlDays: envInt('FILE_TTL_DAYS', 0),

  maxPadContentChars: envInt('MAX_PAD_CONTENT_CHARS', 2_000_000),

  trustProxy: process.env.TRUST_PROXY !== 'false',
};

module.exports = config;
