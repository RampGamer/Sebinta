'use strict';

/*
 * Preload de cada separador (<webview>), forçado por main.js em
 * 'will-attach-webview' — corre em contexto isolado, com acesso ao DOM da
 * página real do Sebinta mas não aos objetos JS que ela define. Expõe
 * window.sebintaDesktop.cleanFile(name, buffer) via contextBridge, e liga
 * essa API a window.Sebinta.setPreUploadHook (definido em
 * public/js/upload.js) para limpar Office/PDF localmente antes do upload.
 * A limpeza está sempre ativa (só fica fora do âmbito para tipos não
 * suportados); tags DLP forçam-na de qualquer forma, ver main.js.
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
          if (onStatus) onStatus(result.forced ? 'tags DLP detetadas — a limpar…' : 'a limpar metadados…');
          return new File([result.buffer], file.name, { type: file.type });
        } catch (err) {
          console.error('[sebinta-desktop] limpeza falhou, a enviar ficheiro original:', err);
          return file;
        }
      });
    })();
  `;
  document.head.appendChild(script);
  script.remove();
}

// Avisa a shell (janela principal) qual o tema ativo nesta página — para o
// separador/⚙ na cromada da janela seguirem o mesmo estilo (ver
// btn-brand-logo/theme-notebook em style.css e o listener 'ipc-message' em
// shell.js). MutationObserver em vez de um evento custom: não precisa de
// nenhuma alteração em app.js, reage a qualquer forma de a classe mudar.
function reportTheme() {
  const isNotebook = document.body.classList.contains('theme-notebook');
  ipcRenderer.sendToHost('sebinta:theme', isNotebook ? 'notebook' : 'sober');
}

window.addEventListener('DOMContentLoaded', () => {
  injectUploadHook();
  reportTheme();
  new MutationObserver(reportTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
});
