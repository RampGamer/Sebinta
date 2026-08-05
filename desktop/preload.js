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
 *    janela com o toggle "limpar metadados" e uma caixa "ir para pad" (a
 *    janela principal só carrega um URL fixo — sem isto não havia forma de
 *    mudar de pad sem passar pelo menu "Mudar servidor…").
 */

const { contextBridge, ipcRenderer } = require('electron');

let cleanEnabled = true;

contextBridge.exposeInMainWorld('filepadDesktop', {
  cleanFile: (name, buffer) => ipcRenderer.invoke('filepad:clean', { name, buffer, cleanEnabled }),
});

// Mesma paleta de public/css/style.css, para a barra parecer parte da app
// e não um addon do browser.
const BAR_CSS = `
  position:fixed;top:0;left:0;right:0;z-index:99999;
  background:#161922;color:#e7e9ee;border-bottom:1px solid #2a2f3d;
  font:12.5px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  padding:7px 12px;display:flex;gap:10px;align-items:center;
`;

function injectStatusBar() {
  const bar = document.createElement('div');
  bar.id = 'filepad-desktop-bar';
  bar.style.cssText = BAR_CSS;
  bar.innerHTML = `
    <label style="display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none;">
      <input type="checkbox" id="filepad-desktop-toggle" checked>
      Limpar metadados antes de enviar
    </label>
    <span style="width:1px;height:16px;background:#2a2f3d;"></span>
    <input type="text" id="filepad-desktop-pad-input" placeholder="nome do pad" style="
      background:#1d2130;border:1px solid #2a2f3d;color:#e7e9ee;border-radius:6px;
      padding:4px 9px;font:inherit;width:220px;">
    <button id="filepad-desktop-pad-go" style="
      background:#5b8cff;border:none;color:#0f1115;border-radius:6px;padding:5px 12px;
      font:inherit;font-weight:600;cursor:pointer;">Ir</button>
    <span id="filepad-desktop-status" style="opacity:.7;flex:1;"></span>
    <button id="filepad-desktop-settings" title="Mudar servidor" style="
      background:transparent;border:1px solid #2a2f3d;color:#9aa0b0;border-radius:6px;
      width:26px;height:26px;font:14px inherit;cursor:pointer;">⚙</button>
  `;
  document.documentElement.prepend(bar);
  document.body.style.marginTop = `${bar.offsetHeight}px`;

  const toggle = bar.querySelector('#filepad-desktop-toggle');
  toggle.addEventListener('change', () => { cleanEnabled = toggle.checked; });

  const padInput = bar.querySelector('#filepad-desktop-pad-input');
  const padGo = bar.querySelector('#filepad-desktop-pad-go');
  padInput.value = decodeURIComponent(location.pathname.replace(/^\/+/, ''));
  function goToPad() {
    const raw = padInput.value.trim();
    if (!raw) return;
    location.href = new URL(raw, `${location.origin}/`).href;
  }
  padGo.addEventListener('click', goToPad);
  padInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') goToPad(); });

  bar.querySelector('#filepad-desktop-settings').addEventListener('click', () => {
    ipcRenderer.send('filepad:open-settings');
  });

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
