'use strict';

const rateLimit = require('express-rate-limit');

// Password do site: poucas tentativas por IP, para dificultar brute force.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

// Password de pad: mesma lógica, janela mais curta.
const padPasswordLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

// Uploads: limita número de pedidos por IP (o limite de tamanho é tratado à parte).
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_uploads' },
});

// Escrita de texto no pad: generoso (autosave), mas ainda com um teto.
const padWriteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

module.exports = { loginLimiter, padPasswordLimiter, uploadLimiter, padWriteLimiter };
