'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const http = require('http');

const config = require('./config');
require('./db'); // makes sure the database and folders exist before anything else
const auth = require('./auth');
const { securityHeaders } = require('./middleware/security');
const authRoutes = require('./routes/auth');
const padRoutes = require('./routes/pad');
const fileRoutes = require('./routes/files');
const wsModule = require('./ws');
const cleanup = require('./services/cleanup');

const PUBLIC_DIR = path.join(config.rootDir, 'public');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(cookieParser(config.cookieSecret));
app.use(auth.ensureCsrfCookie);

// Minimal log: method + path only. Never the body, password query strings,
// or cookies — see security requirement #23 (logs with no sensitive content).
app.use((req, res, next) => {
  if (!req.path.startsWith('/css') && !req.path.startsWith('/js') && !req.path.startsWith('/fonts')) {
    console.log(`${req.method} ${req.path}`);
  }
  next();
});

// Docker healthcheck — no password gate, no sensitive information.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Static assets (CSS/JS/vendor) — always reachable, needed even to render
// the password screen.
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { index: false, maxAge: '1h' }));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { index: false, maxAge: '1h' }));
app.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts'), { index: false, maxAge: '1h' }));

// Site password screen — always reachable (it's the gate itself).
app.get('/login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'favicon.ico'));
});

// --- API ---
app.use('/api/auth', authRoutes);
app.use('/api/pad', auth.siteAuthApiGate, padRoutes);
app.use('/api/files', auth.siteAuthApiGate, fileRoutes);

// Dedicated 404 for the API (avoids falling through to the HTML catch-all below).
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Any other path is a pad: creates/opens the pad page as an SPA. Validating
// the pad name itself happens client-side when it calls the API
// (GET /api/pad?id=...), which uses the same normalizePadId().
app.get('*', auth.siteAuthPageGate, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pad.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = http.createServer(app);
wsModule.attach(server);
cleanup.start();

server.listen(config.port, () => {
  console.log(`Sebinta running on port ${config.port} (env=${config.nodeEnv})`);
  console.log(`Site password: ${auth.siteAuthEnabled() ? 'enabled' : 'disabled'}`);
});

module.exports = server;
