'use strict';

/*
 * UX de upload: botão, drag&drop, colar (Ctrl+V), barra de progresso, e
 * envio do ficheiro tal como está — este projeto não limpa metadados (ver
 * a app desktop em desktop/ e o CLI em cli/ para isso).
 *
 * `Filepad.setPreUploadHook(fn)` é um ponto de extensão opcional, sem uso
 * nenhum aqui: a app desktop Electron injeta-o para poder interceptar o
 * ficheiro antes do envio (limpá-lo localmente) sem duplicar esta UI.
 */
(function () {
  if (!window.Filepad) return; // app.js não carregou (não deveria acontecer)

  const fileInput = document.getElementById('file-input');
  const chooseBtn = document.getElementById('btn-choose-file');
  const progressList = document.getElementById('upload-progress-list');
  const dropzoneOverlay = document.getElementById('dropzone-overlay');

  let preUploadHook = null;
  window.Filepad.setPreUploadHook = (fn) => { preUploadHook = fn; };

  function createProgressItem(name) {
    const item = document.createElement('div');
    item.className = 'upload-progress-item';
    const label = document.createElement('div');
    label.className = 'label';
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = name;
    const statusEl = document.createElement('span');
    statusEl.className = 'status';
    statusEl.textContent = 'a preparar…';
    label.appendChild(nameEl);
    label.appendChild(statusEl);
    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    track.appendChild(fill);
    const errorMsg = document.createElement('div');
    errorMsg.className = 'error-msg';
    item.appendChild(label);
    item.appendChild(track);
    item.appendChild(errorMsg);
    progressList.appendChild(item);
    return {
      setStatus: (text) => { statusEl.textContent = text; },
      setProgress: (pct) => { fill.style.width = pct + '%'; },
      setError: (msg) => {
        item.classList.add('error');
        errorMsg.textContent = msg;
        statusEl.textContent = 'falhou';
      },
      remove: () => item.remove(),
    };
  }

  function uploadWithProgress(file, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', Filepad.apiUrl('/api/files'));
      xhr.setRequestHeader('X-CSRF-Token', Filepad.csrfToken());
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) {
          progress.setProgress(Math.round((ev.loaded / ev.total) * 100));
          progress.setStatus('a enviar… ' + Math.round((ev.loaded / ev.total) * 100) + '%');
        }
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          progress.setProgress(100);
          progress.setStatus('concluído');
          resolve();
        } else {
          let message = 'Falha no envio.';
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.error === 'metadata_cleanup_failed') {
              message = data.message || 'A limpeza de metadados no servidor falhou.';
            } else if (data.error === 'file_too_large') {
              message = `Ficheiro demasiado grande (máximo ${data.maxMb} MB).`;
            } else if (data.error === 'pad_locked') {
              message = 'Este pad está protegido — desbloqueia-o primeiro.';
            } else if (data.error === 'too_many_uploads') {
              message = 'Demasiados uploads em pouco tempo. Aguarda um pouco.';
            } else if (data.error) {
              message = data.error;
            }
          } catch (e) { /* resposta não-JSON, mantém mensagem genérica */ }
          reject(new Error(message));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Erro de rede durante o envio.')));
      xhr.addEventListener('abort', () => reject(new Error('Envio cancelado.')));

      const formData = new FormData();
      formData.append('file', file, file.name);
      xhr.send(formData);
    });
  }

  async function handleOneFile(file) {
    const progress = createProgressItem(file.name);
    try {
      const toUpload = preUploadHook ? await preUploadHook(file, progress.setStatus) : file;
      progress.setStatus('a enviar…');
      await uploadWithProgress(toUpload, progress);
      Filepad.refresh();
      setTimeout(() => progress.remove(), 1200);
    } catch (err) {
      progress.setError(err.message || 'Falha desconhecida.');
      Filepad.toast(`${file.name}: ${err.message || 'falha no envio'}`, 'error');
      setTimeout(() => progress.remove(), 8000);
    }
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      handleOneFile(file);
    }
  }

  // --- botão ---
  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  // --- drag & drop ---
  let dragCounter = 0;
  window.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer || !ev.dataTransfer.types.includes('Files')) return;
    dragCounter++;
    dropzoneOverlay.classList.add('active');
  });
  window.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dropzoneOverlay.classList.remove('active');
  });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragCounter = 0;
    dropzoneOverlay.classList.remove('active');
    if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
      handleFiles(ev.dataTransfer.files);
    }
  });

  // --- colar (Ctrl+V) ---
  window.addEventListener('paste', (ev) => {
    const editor = document.getElementById('editor');
    if (document.activeElement === editor && (!ev.clipboardData || !ev.clipboardData.files.length)) {
      return; // colar texto normal no editor
    }
    if (ev.clipboardData && ev.clipboardData.files && ev.clipboardData.files.length) {
      ev.preventDefault();
      handleFiles(ev.clipboardData.files);
    }
  });
})();
