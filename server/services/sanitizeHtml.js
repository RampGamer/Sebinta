'use strict';

const sanitizeHtml = require('sanitize-html');

/*
 * Canonical pad-content allowlist. Mirrored in exactly two other places —
 * keep all three in sync when changing this list:
 *   - standalone/sanitize.go      (bluemonday policy, Go server)
 *   - public/js/upload.js         (DOMPurify config, client-side paste)
 *   - standalone/public/js/upload.js (same, standalone tree copy)
 *
 * This is the actual security boundary: pad content is broadcast to every
 * live viewer via a WS "changed" -> GET /api/pad refetch (see server/ws.js),
 * so an unsanitized PUT here would XSS everyone who has the pad open.
 */
const ALLOWED_TAGS = [
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'p', 'br', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's',
  'ul', 'ol', 'li', 'a', 'blockquote', 'code', 'pre',
];

// Whitelist-by-construction: each regex only matches a narrow safe form, so
// url(), expression(), javascript: etc. can never match and are dropped.
const ALLOWED_STYLES = {
  '*': {
    'text-align': [/^(?:left|right|center|justify)$/],
    'vertical-align': [/^(?:top|middle|bottom|baseline)$/],
    'background-color': [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\([\d\s,.%]+\)$/, /^[a-zA-Z]{3,20}$/],
    width: [/^\d{1,4}(?:px|%)$/],
  },
};

const options = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    td: ['colspan', 'rowspan', 'style'],
    th: ['colspan', 'rowspan', 'style'],
    a: ['href', 'style'],
    '*': ['style'],
  },
  allowedStyles: ALLOWED_STYLES,
  allowedSchemes: ['http', 'https'],
  allowedSchemesByTag: { a: ['http', 'https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }, true),
  },
  // No img/video/script/style(tag)/iframe/object/embed/form/svg/etc. — not
  // in allowedTags, so sanitize-html drops them (and their contents, for
  // script/style) by default.
};

function sanitizePadHtml(html) {
  return sanitizeHtml(typeof html === 'string' ? html : '', options);
}

module.exports = { sanitizePadHtml };
