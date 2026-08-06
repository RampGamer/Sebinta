'use strict';

const helmet = require('helmet');

/*
 * Restrictive CSP: no external CDNs (all libs, including pdf-lib and
 * fflate, are served locally from /js/vendor). No inline scripts/styles
 * beyond what's needed, no third-party frames.
 */
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // minimal inline styles in the static HTML
      imgSrc: ["'self'", 'blob:', 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://api.github.com'], // landing downloads: reads releases/latest
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      workerSrc: ["'self'", 'blob:'],
      upgradeInsecureRequests: [],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  frameguard: { action: 'deny' },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
});

module.exports = { securityHeaders };
