'use strict';

/*
 * Sincronização quase em tempo real entre dispositivos que têm o mesmo pad
 * aberto. Um WebSocket por aba, agrupado por pad ("room"). Quando o texto
 * ou a lista de ficheiros de um pad muda, todos os clientes ligados a esse
 * pad recebem uma notificação e voltam a pedir o estado atual (evita
 * problemas de ordering — o servidor é sempre a fonte da verdade).
 *
 * O frontend faz fallback automático para polling curto se o WebSocket não
 * conseguir ligar (ex.: proxy que bloqueia upgrade).
 */

const { WebSocketServer } = require('ws');
const cookie = require('cookie');
const cookieSignature = require('cookie-signature');
const config = require('./config');
const { normalizePadId, getPad } = require('./services/padStore');
const { isPadUnlocked, isSiteAuthed: _unused } = require('./auth');

const rooms = new Map(); // padId -> Set<WebSocket>

function unsignCookie(raw) {
  if (!raw || !raw.startsWith('s:')) return null;
  const val = cookieSignature.unsign(raw.slice(2), config.cookieSecret);
  return val === false ? null : val;
}

function parseSignedCookies(cookieHeader) {
  const parsed = cookie.parse(cookieHeader || '');
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    const decoded = decodeURIComponent(v);
    const unsigned = unsignCookie(decoded);
    if (unsigned !== null) out[k] = unsigned;
  }
  return out;
}

function isRequestAuthorized(req, padId) {
  const signed = parseSignedCookies(req.headers.cookie);
  if (config.sitePassword && signed.fp_site !== 'ok') return false;
  const pad = getPad(padId);
  if (pad && pad.password_hash) {
    let unlockedSet = new Set();
    try {
      const arr = JSON.parse(signed.fp_unlocked || '[]');
      if (Array.isArray(arr)) unlockedSet = new Set(arr);
    } catch (_) { /* cookie ausente/corrompido */ }
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(padId).digest('hex').slice(0, 16);
    if (!unlockedSet.has(hash)) return false;
  }
  return true;
}

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://internal');
    } catch (_) {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const padId = normalizePadId(url.searchParams.get('pad') || '');
    if (!padId) {
      socket.destroy();
      return;
    }
    if (!isRequestAuthorized(req, padId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.padId = padId;
      ws.isAlive = true;
      if (!rooms.has(padId)) rooms.set(padId, new Set());
      rooms.get(padId).add(ws);

      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => {
        const room = rooms.get(padId);
        if (room) {
          room.delete(ws);
          if (room.size === 0) rooms.delete(padId);
        }
      });
      ws.on('error', () => ws.terminate());
    });
  });

  // Heartbeat: fecha ligações mortas (ex.: cliente que dormiu/perdeu rede).
  const interval = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30000);
  server.on('close', () => clearInterval(interval));

  return wss;
}

/** Notifica todos os clientes ligados a um pad de que o estado mudou. */
function broadcastPadChanged(padId, extra = {}) {
  const room = rooms.get(padId);
  if (!room || room.size === 0) return;
  const payload = JSON.stringify({ type: 'changed', ...extra });
  for (const ws of room) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

module.exports = { attach, broadcastPadChanged };
