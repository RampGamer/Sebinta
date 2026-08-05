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

/** Comparação em tempo constante para evitar timing attacks na password do site. */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Ainda assim faz um compare de tamanho fixo para não vazar o comprimento por timing.
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

/** Middleware: bloqueia páginas HTML se a password global do site não foi validada. */
function siteAuthPageGate(req, res, next) {
  if (isSiteAuthed(req)) return next();
  const next_ = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${next_}`);
}

/** Middleware: bloqueia chamadas de API (resposta JSON) se a password global não foi validada. */
function siteAuthApiGate(req, res, next) {
  if (isSiteAuthed(req)) return next();
  res.status(401).json({ error: 'site_auth_required' });
}

// --- CSRF (padrão double-submit cookie) ---
// O cookie fp_csrf NÃO é HttpOnly de propósito: o JS do frontend lê o seu
// valor e reenvia-o no header X-CSRF-Token em cada pedido de escrita. Um
// site atacante não consegue ler este cookie (same-origin policy) nem
// adivinhar o valor, por isso não consegue forjar o header.
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

// --- Password por pad ---
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
  } catch (_) { /* cookie corrompido ou adulterado: ignora */ }
  return new Set();
}

function isPadUnlocked(req, padId, pad) {
  if (!pad || !pad.password_hash) return true;
  return getUnlockedSet(req).has(padHash(padId));
}

function markPadUnlocked(req, res, padId) {
  const set = getUnlockedSet(req);
  set.add(padHash(padId));
  // Limite defensivo para o cookie não crescer sem controlo.
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
