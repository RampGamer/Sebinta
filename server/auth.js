'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');

const SITE_COOKIE = 'fp_site';
const CSRF_COOKIE = 'fp_csrf';
const UNLOCKED_COOKIE = 'fp_unlocked';

const cookieBaseOpts = {
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'lax',
  path: '/',
};

/** Constant-time comparison to avoid timing attacks on the site password. */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still does a fixed-size compare so the length isn't leaked via timing.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function siteAuthEnabled() {
  return Boolean(config.sitePassword);
}

function isSiteAuthed(req) {
  if (!siteAuthEnabled()) return true;
  return req.signedCookies && req.signedCookies[SITE_COOKIE] === 'ok';
}

function setSiteAuthCookie(res) {
  res.cookie(SITE_COOKIE, 'ok', { ...cookieBaseOpts, signed: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
}

function clearSiteAuthCookie(res) {
  res.clearCookie(SITE_COOKIE, cookieBaseOpts);
}

/** Middleware: blocks HTML pages if the site-wide password hasn't been validated. */
function siteAuthPageGate(req, res, next) {
  if (isSiteAuthed(req)) return next();
  const next_ = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${next_}`);
}

/** Middleware: blocks API calls (JSON response) if the site-wide password hasn't been validated. */
function siteAuthApiGate(req, res, next) {
  if (isSiteAuthed(req)) return next();
  res.status(401).json({ error: 'site_auth_required' });
}

// --- CSRF (double-submit cookie pattern) ---
// The fp_csrf cookie is deliberately NOT HttpOnly: the frontend JS reads
// its value and sends it back in the X-CSRF-Token header on every write
// request. An attacking site can't read this cookie (same-origin policy)
// or guess its value, so it can't forge the header.
function ensureCsrfCookie(req, res, next) {
  if (!req.cookies || !req.cookies[CSRF_COOKIE]) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, { ...cookieBaseOpts, httpOnly: false, maxAge: 30 * 24 * 60 * 60 * 1000 });
    req.csrfToken = token;
  } else {
    req.csrfToken = req.cookies[CSRF_COOKIE];
  }
  next();
}

function csrfProtection(req, res, next) {
  const cookieToken = req.cookies && req.cookies[CSRF_COOKIE];
  const headerToken = req.get('X-CSRF-Token');
  if (!cookieToken || !headerToken || !safeCompare(cookieToken, headerToken)) {
    return res.status(403).json({ error: 'csrf_invalid' });
  }
  next();
}

// --- Per-pad password ---
function hashPadPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPadPassword(password, hash) {
  try {
    return bcrypt.compareSync(password, hash);
  } catch (_) {
    return false;
  }
}

function padHash(padId) {
  return crypto.createHash('sha256').update(padId).digest('hex').slice(0, 16);
}

function getUnlockedSet(req) {
  const raw = req.signedCookies && req.signedCookies[UNLOCKED_COOKIE];
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch (_) { /* corrupted or tampered cookie: ignore */ }
  return new Set();
}

function isPadUnlocked(req, padId, pad) {
  if (!pad || !pad.password_hash) return true;
  return getUnlockedSet(req).has(padHash(padId));
}

function markPadUnlocked(req, res, padId) {
  const set = getUnlockedSet(req);
  set.add(padHash(padId));
  // Defensive cap so the cookie doesn't grow unbounded.
  const arr = Array.from(set).slice(-200);
  res.cookie(UNLOCKED_COOKIE, JSON.stringify(arr), { ...cookieBaseOpts, signed: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
}

module.exports = {
  SITE_COOKIE,
  CSRF_COOKIE,
  safeCompare,
  siteAuthEnabled,
  isSiteAuthed,
  setSiteAuthCookie,
  clearSiteAuthCookie,
  siteAuthPageGate,
  siteAuthApiGate,
  ensureCsrfCookie,
  csrfProtection,
  hashPadPassword,
  verifyPadPassword,
  isPadUnlocked,
  markPadUnlocked,
};
