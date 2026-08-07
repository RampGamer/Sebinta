'use strict';

const rateLimit = require('express-rate-limit');

// Tells the client exactly when it can retry instead of a generic "wait a
// bit" — express-rate-limit populates req.rateLimit.resetTime on every
// request, blocked ones included.
function rateLimitedHandler(errorCode) {
  return (req, res) => {
    const resetMs = req.rateLimit?.resetTime ? req.rateLimit.resetTime.getTime() - Date.now() : 0;
    const retryAfterSeconds = Math.max(1, Math.round(resetMs / 1000));
    res.status(429).json({ error: errorCode, retryAfterSeconds });
  };
}

// Site password: few attempts per IP, to make brute-forcing harder.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedHandler('too_many_attempts'),
});

// The blanket per-IP guard against abuse — brute-forcing a pad's password
// specifically is padUnlockRetryAfterSeconds/recordPadUnlockFailure's job
// (see below), so this one can afford to be generous rather than tripping
// on normal use (checking/changing a password a few times while setting up
// a pad).
const padPasswordLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedHandler('too_many_attempts'),
});

// Uploads: limits number of requests per IP (the size limit is handled separately).
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedHandler('too_many_uploads'),
});

// Writing text to the pad: generous (autosave), but still capped.
const padWriteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitedHandler('too_many_requests'),
});

// Tighter, pad-scoped guard against password guessing: 5 wrong guesses
// against the same pad locks that (IP, pad) pair out for 30s. A success
// clears the count, so a legitimate retry after a typo doesn't count
// against the limit. Keyed by IP+pad rather than pad alone, so one
// attacker can't lock everyone else out of unlocking a shared pad just by
// failing on purpose.
const FAILED_ATTEMPT_THRESHOLD = 5;
const FAILED_ATTEMPT_LOCKOUT_MS = 30 * 1000;
const failedPadUnlockAttempts = new Map(); // "ip:padId" -> { failures, lockedUntil }

function padUnlockAttemptKey(req) {
  return `${req.ip}:${req.padId}`;
}

// Seconds left in the lockout, or 0 if not (or no longer) blocked — lets the
// caller tell the client exactly when it can retry, instead of a generic
// "wait a bit".
function padUnlockRetryAfterSeconds(req) {
  const s = failedPadUnlockAttempts.get(padUnlockAttemptKey(req));
  if (!s) return 0;
  const remainingMs = s.lockedUntil - Date.now();
  return remainingMs > 0 ? Math.max(1, Math.round(remainingMs / 1000)) : 0;
}

function recordPadUnlockFailure(req) {
  const key = padUnlockAttemptKey(req);
  const s = failedPadUnlockAttempts.get(key) || { failures: 0, lockedUntil: 0 };
  s.failures += 1;
  if (s.failures >= FAILED_ATTEMPT_THRESHOLD) {
    s.lockedUntil = Date.now() + FAILED_ATTEMPT_LOCKOUT_MS;
    s.failures = 0;
  }
  failedPadUnlockAttempts.set(key, s);
}

function recordPadUnlockSuccess(req) {
  failedPadUnlockAttempts.delete(padUnlockAttemptKey(req));
}

module.exports = {
  loginLimiter,
  padPasswordLimiter,
  uploadLimiter,
  padWriteLimiter,
  padUnlockRetryAfterSeconds,
  recordPadUnlockFailure,
  recordPadUnlockSuccess,
};
