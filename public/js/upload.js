'use strict';

/*
 * Upload UX: button, drag&drop, paste (Ctrl+V), progress bar, and sending
 * the file exactly as-is — this project doesn't clean metadata (see the
 * desktop app in desktop/ and the CLI in cli/ for that).
 *
 * `Sebinta.setPreUploadHook(fn)` is an optional extension point, unused
 * here: the Electron desktop app injects it to intercept the file before
 * upload (cleaning it locally) without duplicating this UI.
 */
(function () {
  if (!window.Sebinta) return; // app.js didn't load (shouldn't happen)

  const fileInput = document.getElementById('file-input');
  const chooseBtn = document.getElementById('btn-choose-file');
  const progressList = document.getElementById('upload-progress-list');
  const dropzoneOverlay = document.getElementById('dropzone-overlay');

  let preUploadHook = null;
  window.Sebinta.setPreUploadHook = (fn) => { preUploadHook = fn; };

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
    statusEl.textContent = 'preparing…';
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
        statusEl.textContent = 'failed';
      },
      remove: () => item.remove(),
    };
  }

  // Cloudflare's tunnel proxy (used by the standalone server's built-in
  // quick/named tunnel — see standalone/tunnel.go) caps request bodies at
  // 100MB on the plans this project targets. Files bigger than CHUNK_SIZE
  // are split into pieces comfortably under that and sent as separate
  // requests sharing an uploadId, sequentially — the server appends each
  // one to an accumulating file and only assembles the real file record once
  // the last chunk lands. Entirely invisible from here up: same button,
  // same drag&drop, same progress bar: Sebinta.refresh() only ever sees the
  // finished file, exactly as with a small, single-request upload.
  const CHUNK_SIZE = 8 * 1024 * 1024;

  // crypto.randomUUID needs a secure context (HTTPS, or localhost) — true
  // for how this app is actually reached (Cloudflare tunnel or local dev),
  // but this fallback keeps chunked uploads working even if not. Doesn't
  // need to be unpredictable, just unique enough to key one upload's chunks.
  function randomUploadId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    let id = '';
    for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
    return id;
  }

  function uploadErrorMessage(xhr) {
    let message = 'Upload failed.';
    try {
      const data = JSON.parse(xhr.responseText);
      if (data.error === 'metadata_cleanup_failed') {
        message = data.message || 'Server-side metadata cleanup failed.';
      } else if (data.error === 'file_too_large') {
        message = `File too large (max ${data.maxMb} MB).`;
      } else if (data.error === 'pad_locked') {
        message = 'This pad is protected — unlock it first.';
      } else if (data.error === 'too_many_uploads' || data.error === 'too_many_attempts') {
        message = 'Too many uploads in a short time. Wait a bit.';
      } else if (data.error) {
        message = data.error;
      }
    } catch (e) { /* non-JSON response, keep the generic message */ }
    return message;
  }

  // Sends one request — either the whole file (chunkMeta omitted) or one
  // chunk of it. onLoaded reports bytes sent so far *within this request*,
  // for the caller to fold into overall progress.
  function sendOne(blob, fileName, chunkMeta, onLoaded) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let url = Sebinta.apiUrl('/api/files');
      if (chunkMeta) {
        url += `&uploadId=${encodeURIComponent(chunkMeta.uploadId)}` +
          `&chunkIndex=${chunkMeta.chunkIndex}&totalChunks=${chunkMeta.totalChunks}`;
      }
      xhr.open('POST', url);
      xhr.setRequestHeader('X-CSRF-Token', Sebinta.csrfToken());
      // Without this, a chunk whose connection stalls (a dropped packet the
      // OS/proxy never resets, a flaky tunnel reconnect, ...) never fires
      // load/error/abort — this promise would hang forever, freezing the
      // whole upload on that one chunk's percentage with no error shown.
      xhr.timeout = 60000;
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) onLoaded(ev.loaded);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onLoaded(blob.size);
          try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(null); }
        } else {
          reject(new Error(uploadErrorMessage(xhr)));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload.')));
      xhr.addEventListener('abort', () => reject(new Error('Upload canceled.')));
      xhr.addEventListener('timeout', () => reject(new Error('Upload timed out.')));

      const formData = new FormData();
      formData.append('file', blob, fileName);
      xhr.send(formData);
    });
  }

  async function sendOneWithRetry(blob, fileName, chunkMeta, onLoaded) {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
      try {
        return await sendOne(blob, fileName, chunkMeta, onLoaded);
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || /^(File too large|This pad is protected|Too many uploads)/.test(err.message)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  async function uploadWithProgress(file, progress) {
    const setPct = (loaded) => {
      const pct = Math.round((loaded / file.size) * 100);
      progress.setProgress(pct);
      progress.setStatus('uploading… ' + pct + '%');
    };

    let result;
    if (file.size <= CHUNK_SIZE) {
      result = await sendOneWithRetry(file, file.name, null, setPct);
    } else {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const uploadId = randomUploadId();
      let sentBytes = 0;
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
        const base = sentBytes;
        result = await sendOneWithRetry(chunk, file.name, { uploadId, chunkIndex, totalChunks }, (loaded) => setPct(base + loaded));
        sentBytes += chunk.size;
      }
    }
    progress.setProgress(100);
    progress.setStatus('done');
    return result;
  }

  async function handleOneFile(file) {
    const progress = createProgressItem(file.name);
    try {
      const toUpload = preUploadHook ? await preUploadHook(file, progress.setStatus) : file;
      progress.setStatus('uploading…');
      await uploadWithProgress(toUpload, progress);
      Sebinta.refresh();
      setTimeout(() => progress.remove(), 1200);
    } catch (err) {
      progress.setError(err.message || 'Unknown failure.');
      Sebinta.toast(`${file.name}: ${err.message || 'upload failed'}`, 'error');
      setTimeout(() => progress.remove(), 8000);
    }
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      handleOneFile(file);
    }
  }

  // --- button ---
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

  // --- paste (Ctrl+V) ---
  window.addEventListener('paste', (ev) => {
    const editor = document.getElementById('editor');
    if (document.activeElement === editor && (!ev.clipboardData || !ev.clipboardData.files.length)) {
      return; // normal text paste into the editor
    }
    if (ev.clipboardData && ev.clipboardData.files && ev.clipboardData.files.length) {
      ev.preventDefault();
      handleFiles(ev.clipboardData.files);
    }
  });
})();
