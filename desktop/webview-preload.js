'use strict';

/*
 * Preload for each tab (<webview>), forced by main.js on
 * 'will-attach-webview' — runs in an isolated context, with access to the
 * real Sebinta page's DOM but not to the JS objects it defines. Exposes
 * window.sebintaDesktop.cleanFile(name, buffer) via contextBridge, and
 * wires that API to window.Sebinta.setPreUploadHook (defined in
 * public/js/upload.js) to clean Office/PDF locally before upload. Cleaning
 * is always on (it's only out of scope for unsupported types); DLP tags
 * force it regardless, see main.js.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sebintaDesktop', {
  cleanFile: (name, buffer) => ipcRenderer.invoke('sebinta:clean', { name, buffer, cleanEnabled: true }),
});

function injectUploadHook() {
  const script = document.createElement('script');
  script.textContent = `
    (function () {
      if (!window.Sebinta || !window.Sebinta.setPreUploadHook || !window.sebintaDesktop) return;
      window.Sebinta.setPreUploadHook(async function (file, onStatus) {
        try {
          const buffer = await file.arrayBuffer();
          const result = await window.sebintaDesktop.cleanFile(file.name, buffer);
          if (!result || !result.cleaned) return file;
          if (onStatus) onStatus(result.forced ? 'DLP tags detected — cleaning…' : 'cleaning metadata…');
          return new File([result.buffer], file.name, { type: file.type });
        } catch (err) {
          console.error('[sebinta-desktop] cleanup failed, sending the original file:', err);
          return file;
        }
      });
    })();
  `;
  document.head.appendChild(script);
  script.remove();
}

// Tells the shell (main window) which theme is active on this page — so
// the tab/⚙ in the window chrome follow the same style (see
// btn-brand-logo/theme-notebook in style.css and the 'ipc-message' listener
// in shell.js). MutationObserver instead of a custom event: needs no
// changes in app.js, reacts to any way the class might change.
function reportTheme() {
  const isNotebook = document.body.classList.contains('theme-notebook');
  ipcRenderer.sendToHost('sebinta:theme', isNotebook ? 'notebook' : 'sober');
}

window.addEventListener('DOMContentLoaded', () => {
  injectUploadHook();
  reportTheme();
  new MutationObserver(reportTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
});
