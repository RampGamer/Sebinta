'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const http = require('http');

const config = require('./config');
require('./db'); // garante que a base de dados e as pastas existem antes de tudo o resto
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

// Log minimo: método + caminho apenas. Nunca corpo, query de password, ou
// cookies — ver requisito de segurança #23 (logs sem conteúdo sensível).
app.use((req, res, next) => {
  if (!req.path.startsWith('/css') && !req.path.startsWith('/js')) {
    console.log(`${req.method} ${req.path}`);
  }
  next();
});

// Healthcheck do Docker — sem gate de password, sem informação sensível.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Recursos estáticos (CSS/JS/vendor) — sempre acessíveis, necessários mesmo
// para desenhar o ecrã de password.
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { index: false, maxAge: '1h' }));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { index: false, maxAge: '1h' }));

// Ecrã de password do site — sempre acessível (é o próprio gate).
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

// 404 dedicado para a API (evita cair no catch-all de páginas HTML abaixo).
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Qualquer outro caminho é um pad: cria/abre a página do pad em SPA. A
// validação do próprio nome do pad acontece do lado do cliente ao chamar a
// API (GET /api/pad?id=...), que usa a mesma normalizePadId().
app.get('*', auth.siteAuthPageGate, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pad.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = http.createServer(app);
wsModule.attach(server);
cleanup.start();

server.listen(config.port, () => {
  console.log(`Sebinta a correr na porta ${config.port} (env=${config.nodeEnv})`);
  console.log(`Password do site: ${auth.siteAuthEnabled() ? 'ativa' : 'desativada'}`);
});

module.exports = server;
