'use strict';

const helmet = require('helmet');

/*
 * CSP restritiva: nada de CDNs externos (todas as libs, incluindo pdf-lib e
 * fflate, são servidas localmente a partir de /js/vendor). Sem inline
 * scripts/estilos com exceção do necessário, sem frames de terceiros.
 */
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // estilos inline mínimos no HTML estático
      imgSrc: ["'self'", 'blob:', 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
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
