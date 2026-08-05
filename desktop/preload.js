'use strict';

/*
 * Preload da janela principal — corre em contexto isolado (contextIsolation:
 * true), com acesso ao DOM da página real do Filepad mas não aos objetos JS
 * que ela define. Duas coisas:
 *
 * 1. Expõe window.filepadDesktop.cleanFile(name, buffer) para o mundo
 *    principal via contextBridge — a única API que a página pode chamar.
 * 2. Depois de app.js/upload.js correrem (DOMContentLoaded), injeta um
 *    pequeno <script> que liga window.Filepad.setPreUploadHook (definido em
 *    public/js/upload.js) a essa API, e uma barra de estado no topo da
 *    janela com o toggle "limpar metadados".
 */

const { contextBridge, ipcRenderer } = require('electron');

let cleanEnabled = true;

contextBridge.exposeInMainWorld('filepadDesktop', {
  cleanFile: (name, buffer) => ipcRenderer.invoke('filepad:clean', { name, buffer, cleanEnabled }),
});

function injectStatusBar() {
  const bar = document.createElement('div');
  bar.id = 'filepad-desktop-bar';
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;background:#14181f;color:#e6e6e6;' +
    'font:12px -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 12px;display:flex;' +
    'gap:10px;align-items:center;border-bottom:1px solid #2a2f3a;';
  bar.innerHTML =
    '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none;">' +
    '<input type="checkbox" id="filepad-desktop-toggle" checked>' +
    'Limpar metadados (Office/PDF) antes de enviar</label>' +
    '<span id="filepad-desktop-status" style="opacity:.75;"></span>';
  document.documentElement.prepend(bar);
  document.body.style.marginTop = `${bar.offsetHeight}px`;

  const toggle = bar.querySelector('#filepad-desktop-toggle');
  toggle.addEventListener('change', () => { cleanEnabled = toggle.checked; });

  return bar.querySelector('#filepad-desktop-status');
}

function injectUploadHook() {
  const script = document.createElement('script');
  script.textContent = `
    (function () {
      if (!window.Filepad || !window.Filepad.setPreUploadHook || !window.filepadDesktop) return;
      window.Filepad.setPreUploadHook(async function (file, onStatus) {
        try {
          const buffer = await file.arrayBuffer();
          const result = await window.filepadDesktop.cleanFile(file.name, buffer);
          if (!result || !result.cleaned) return file;
          if (onStatus) onStatus(result.forced ? 'tags DLP detetadas — a limpar…' : 'a limpar metadados…');
          window.dispatchEvent(new CustomEvent('filepad-desktop:cleaned', {
            detail: { name: file.name, forced: !!result.forced, removed: result.removed || [] },
          }));
          return new File([result.buffer], file.name, { type: file.type });
        } catch (err) {
          console.error('[filepad-desktop] limpeza falhou, a enviar ficheiro original:', err);
          return file;
        }
      });
    })();
  `;
  document.head.appendChild(script);
  script.remove();
}

window.addEventListener('DOMContentLoaded', () => {
  const statusEl = injectStatusBar();
  injectUploadHook();
  window.addEventListener('filepad-desktop:cleaned', (ev) => {
    const { name, forced, removed } = ev.detail;
    statusEl.textContent = forced
      ? `${name}: limpeza forçada (tags DLP detetadas) — ${removed.length} item(ns) removido(s)`
      : `${name}: limpo — ${removed.length} item(ns) removido(s)`;
  });
});
