'use strict';

const express = require('express');
const config = require('../config');
const auth = require('../auth');
const { loginLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    siteAuthEnabled: auth.siteAuthEnabled(),
    siteAuthed: auth.isSiteAuthed(req),
    csrfToken: req.csrfToken,
  });
});

// Note: the password is never written to logs (not even in access logs,
// see server/index.js, which only logs method+path, never the body).
router.post('/login', loginLimiter, auth.csrfProtection, express.json({ limit: '2kb' }), (req, res) => {
  if (!auth.siteAuthEnabled()) {
    return res.json({ ok: true });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !auth.safeCompare(password, config.sitePassword)) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  auth.setSiteAuthCookie(res);
  res.json({ ok: true });
});

router.post('/logout', auth.csrfProtection, (req, res) => {
  auth.clearSiteAuthCookie(res);
  res.json({ ok: true });
});

module.exports = router;
