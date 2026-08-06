'use strict';

const rateLimit = require('express-rate-limit');

// Site password: few attempts per IP, to make brute-forcing harder.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

// Pad password: same logic, shorter window.
const padPasswordLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

// Uploads: limits number of requests per IP (the size limit is handled separately).
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_uploads' },
});

// Writing text to the pad: generous (autosave), but still capped.
const padWriteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

module.exports = { loginLimiter, padPasswordLimiter, uploadLimiter, padWriteLimiter };
