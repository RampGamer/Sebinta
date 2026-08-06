'use strict';

// Aplica o tema "caderno" antes do resto da página pintar, para não haver
// flash do tema sóbrio a seguir a um reload. Tem de ser um ficheiro
// externo (não inline) — o CSP do servidor é script-src 'self', que
// bloqueia scripts inline sem exceção.
try {
  if (localStorage.getItem('sebinta-theme') === 'notebook') {
    document.body.classList.add('theme-notebook');
  }
} catch (e) { /* localStorage indisponível (modo privado, etc.) — ignora */ }
