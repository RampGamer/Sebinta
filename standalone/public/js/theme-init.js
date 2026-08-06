'use strict';

// Applies the "notebook" theme before the rest of the page paints, so
// there's no flash of the sober theme after a reload. Has to be an
// external file (not inline) — the server's CSP is script-src 'self',
// which blocks inline scripts with no exceptions.
try {
  if (localStorage.getItem('sebinta-theme') === 'notebook') {
    document.body.classList.add('theme-notebook');
  }
} catch (e) { /* localStorage unavailable (private mode, etc.) — ignore */ }
