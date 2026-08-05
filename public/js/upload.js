'use strict';

/*
 * UX de upload: botão, drag&drop, colar (Ctrl+V), barra de progresso, e
 * despacho para o Web Worker de limpeza de metadados (worker.js) antes de
 * enviar imagens, PDFs e ficheiros Office OOXML. Os restantes tipos seguem
 * diretamente para o upload — são limpos apenas no servidor (quarentena).
 */
(function () {
  if (!window.Filepad) return; // app.js não carregou (não deveria acontecer)

  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const PDF_EXTS = new Set(['.pdf']);
  const OOXML_EXTS = new Set(['.docx', '.xlsx', '.pptx']);

  const fileInput = document.getElementById('file-input');
  const chooseBtn = document.getElementById('btn-choose-file');
  const progressList = document.getElementById('upload-progress-list');
  const dropzoneOverlay = document.getElementById('dropzone-overlay');

  let worker = null;
  let msgCounter = 0;
  const pending = new Map();

  function getWorker() {
    if (!worker) {
      worker = new Worker('/js/metadata/worker.js');
      worker.addEventListener('message', (ev) => {
        const { id, ok, buffer, mimeType, error } = ev.data;
        const resolver = pending.get(id);
        if (!resolver) return;
        pending.delete(id);
        if (ok) resolver.resolve({ buffer, mimeType });
        else resolver.reject(new Error(error));
      });
      worker.addEventListener('error', (ev) => {
        // Erro genérico no worker (ex.: falha a carregar um script vendor).
        for (const [id, resolver] of pending) {
          resolver.reject(new Error('Falha interna na limpeza de metadados.'));
          pending.delete(id);
        }
      });
    }
    return worker;
  }

  function extOf(name) {
    const idx = name.lastIndexOf('.');
    return idx === -1 ? '' : name.slice(idx).toLowerCase();
  }

  function detectClientCleanKind(file) {
    const ext = extOf(file.name);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (PDF_EXTS.has(ext)) return 'pdf';
    if (OOXML_EXTS.has(ext)) return 'ooxml';
    return null;
  }

  /**
   * Limpa um ficheiro no browser antes do upload, se o tipo o exigir.
   * @returns {Promise<File>} o ficheiro (limpo, ou o original se não aplicável)
   * @throws {Error} se a limpeza era obrigatória para este tipo e falhou —
   *   nesse caso o upload NUNCA deve prosseguir com o ficheiro original.
   */
  async function cleanClientSide(file, onStatus) {
    const kind = detectClientCleanKind(file);
    if (!kind) return file; // tipo sem limpeza viável no browser (vídeo/áudio, .doc/.xls/.ppt legado, outros)

    onStatus('a limpar metadados…');
    const buffer = await file.arrayBuffer();
    const id = ++msgCounter;
    const w = getWorker();

    const resultPromise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    w.postMessage({ id, kind, buffer, mimeType: file.type || '' }, [buffer]);

    const { buffer: cleanedBuffer, mimeType } = await resultPromise;
    return new File([cleanedBuffer], file.name, { type: mimeType || file.type });
  }

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
      const cleaned = await cleanClientSide(file, progress.setStatus);
      progress.setStatus('a enviar…');
      await uploadWithProgress(cleaned, progress);
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
