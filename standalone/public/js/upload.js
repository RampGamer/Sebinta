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
    const speedEl = document.createElement('span');
    speedEl.className = 'speed';
    const statusEl = document.createElement('span');
    statusEl.className = 'status';
    statusEl.textContent = 'preparing…';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'upload-cancel-btn';
    cancelBtn.title = 'Cancel upload';
    cancelBtn.textContent = '✕';
    label.appendChild(nameEl);
    label.appendChild(speedEl);
    label.appendChild(statusEl);
    label.appendChild(cancelBtn);
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

    let cancelHandler = null;
    cancelBtn.addEventListener('click', () => { if (cancelHandler) cancelHandler(); });

    return {
      setStatus: (text) => { statusEl.textContent = text; },
      setProgress: (pct) => { fill.style.width = pct + '%'; },
      setSpeed: (text) => { speedEl.textContent = text; },
      onCancel: (fn) => { cancelHandler = fn; },
      hideCancel: () => { cancelBtn.style.display = 'none'; },
      setError: (msg) => {
        item.classList.add('error');
        errorMsg.textContent = msg;
        statusEl.textContent = 'failed';
        speedEl.textContent = '';
      },
      remove: () => item.remove(),
    };
  }

  // Smoothed transfer rate from periodic (time, bytesLoaded) samples — raw
  // deltas between individual XHR progress events are too jumpy (fired in
  // irregular bursts) to show directly as a speed/ETA.
  function createSpeedTracker() {
    let lastTime = performance.now();
    let lastBytes = 0;
    let rate = 0; // bytes/sec, exponentially smoothed
    return function sample(bytesLoaded) {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      if (dt < 0.2) return rate; // too soon since the last sample — reuse it
      const instant = Math.max(0, (bytesLoaded - lastBytes) / dt);
      rate = rate === 0 ? instant : rate * 0.7 + instant * 0.3;
      lastTime = now;
      lastBytes = bytesLoaded;
      return rate;
    };
  }

  function formatSpeedEta(bytesPerSec, bytesRemaining) {
    if (!(bytesPerSec > 0)) return '';
    const speed = bytesPerSec >= 1024 * 1024
      ? (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s'
      : Math.max(1, Math.round(bytesPerSec / 1024)) + ' KB/s';
    const etaSeconds = bytesRemaining / bytesPerSec;
    const eta = etaSeconds < 60
      ? Math.ceil(etaSeconds) + 's left'
      : Math.floor(etaSeconds / 60) + 'm ' + Math.round(etaSeconds % 60) + 's left';
    return `${speed} · ${eta}`;
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
  // for the caller to fold into overall progress. cancelToken.xhr is set to
  // this request's XHR so a click on the cancel button (which only has the
  // token, not this closure) can abort whichever request is currently
  // in-flight.
  function sendOne(blob, fileName, chunkMeta, onLoaded, cancelToken) {
    return new Promise((resolve, reject) => {
      if (cancelToken && cancelToken.cancelled) {
        reject(new Error('Upload canceled.'));
        return;
      }
      const xhr = new XMLHttpRequest();
      if (cancelToken) cancelToken.xhr = xhr;
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

  async function sendOneWithRetry(blob, fileName, chunkMeta, onLoaded, cancelToken) {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
      try {
        return await sendOne(blob, fileName, chunkMeta, onLoaded, cancelToken);
      } catch (err) {
        if (
          (cancelToken && cancelToken.cancelled) ||
          attempt >= MAX_ATTEMPTS ||
          /^(File too large|This pad is protected|Too many uploads)/.test(err.message)
        ) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  async function uploadWithProgress(file, progress, cancelToken) {
    const speedSample = createSpeedTracker();
    const setPct = (loaded) => {
      const pct = Math.round((loaded / file.size) * 100);
      progress.setProgress(pct);
      progress.setStatus('uploading… ' + pct + '%');
      progress.setSpeed(formatSpeedEta(speedSample(loaded), file.size - loaded));
    };

    let result;
    if (file.size <= CHUNK_SIZE) {
      result = await sendOneWithRetry(file, file.name, null, setPct, cancelToken);
    } else {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const uploadId = randomUploadId();
      let sentBytes = 0;
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
        const base = sentBytes;
        result = await sendOneWithRetry(
          chunk, file.name, { uploadId, chunkIndex, totalChunks },
          (loaded) => setPct(base + loaded), cancelToken,
        );
        sentBytes += chunk.size;
        if (cancelToken && cancelToken.cancelled) throw new Error('Upload canceled.');
      }
    }
    progress.setProgress(100);
    progress.setStatus('done');
    progress.setSpeed('');
    return result;
  }

  async function handleOneFile(file) {
    const progress = createProgressItem(file.name);
    const cancelToken = { cancelled: false, xhr: null };
    progress.onCancel(() => {
      cancelToken.cancelled = true;
      if (cancelToken.xhr) cancelToken.xhr.abort();
    });
    try {
      const toUpload = preUploadHook ? await preUploadHook(file, progress.setStatus) : file;
      progress.setStatus('uploading…');
      await uploadWithProgress(toUpload, progress, cancelToken);
      progress.hideCancel();
      Sebinta.refresh();
      setTimeout(() => progress.remove(), 1200);
    } catch (err) {
      progress.hideCancel();
      progress.setError(err.message || 'Unknown failure.');
      if (err.message !== 'Upload canceled.') {
        Sebinta.toast(`${file.name}: ${err.message || 'upload failed'}`, 'error');
      }
      setTimeout(() => progress.remove(), 8000);
    }
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      handleOneFile(file);
    }
  }

  // --- dropped folders: zipped client-side, then uploaded like any file ---
  // A dropped folder has no bytes of its own to send — this reads its full
  // tree (via the drag & drop Entries API) and zips it (fflate, vendored
  // locally — no CDN, same as DOMPurify) before handing it to the normal
  // upload pipeline. Bounded defensively since a folder's size is entirely
  // up to whoever dropped it: MAX_ZIP_FILES/MAX_ZIP_TOTAL_BYTES stop a huge
  // tree from exhausting this tab's memory while walking/zipping it, and
  // MAX_ZIP_DEPTH guards against pathological nesting — independent of,
  // and in addition to, the server's own MAX_FILE_SIZE_MB check on the
  // finished zip once it's actually uploaded.
  const MAX_ZIP_FILES = 5000;
  const MAX_ZIP_TOTAL_BYTES = 300 * 1024 * 1024;
  const MAX_ZIP_DEPTH = 30;

  function readDirEntries(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  // Defense in depth: entry names come from the browser's own Entries API
  // (not attacker-controlled the way a server upload would be), but strip
  // empty/"."/".." segments before they become paths inside the zip anyway
  // — cheap, and means this zip can never contain a traversal path
  // regardless of what produced the entry tree.
  function normalizeZipPath(path) {
    const clean = path.split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
    return clean || '_'; // every segment was stripped — keep the entry, not lose it silently
  }

  async function walkDirectoryEntry(rootEntry, basePath, depth, cancelToken, state) {
    if (depth > MAX_ZIP_DEPTH) throw new Error('Folder is nested too deeply.');
    const reader = rootEntry.createReader();
    const out = [];
    let batch;
    do {
      if (cancelToken.cancelled) throw new Error('Upload canceled.');
      // readEntries() only returns up to ~100 entries per call — looping
      // until it returns an empty array is required to see everything.
      batch = await readDirEntries(reader);
      for (const entry of batch) {
        const path = basePath + entry.name;
        if (entry.isDirectory) {
          const nested = await walkDirectoryEntry(entry, path + '/', depth + 1, cancelToken, state);
          out.push(...nested);
        } else {
          const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
          state.count++;
          if (state.count > MAX_ZIP_FILES) throw new Error(`Too many files in this folder (max ${MAX_ZIP_FILES}).`);
          state.bytes += file.size;
          if (state.bytes > MAX_ZIP_TOTAL_BYTES) {
            throw new Error(`This folder is too large to zip in the browser (max ${MAX_ZIP_TOTAL_BYTES / (1024 * 1024)}MB).`);
          }
          out.push({ path: normalizeZipPath(path), file });
        }
      }
    } while (batch.length > 0);
    return out;
  }

  function buildZip(entries, cancelToken, onProgress) {
    return (async () => {
      const fileMap = {};
      for (let i = 0; i < entries.length; i++) {
        if (cancelToken.cancelled) throw new Error('Upload canceled.');
        const { path, file } = entries[i];
        const buf = await file.arrayBuffer();
        fileMap[path] = new Uint8Array(buf);
        onProgress(i + 1, entries.length);
      }
      return new Promise((resolve, reject) => {
        window.fflate.zip(fileMap, { level: 6 }, (err, data) => {
          if (err) reject(err);
          else resolve(new Blob([data], { type: 'application/zip' }));
        });
      });
    })();
  }

  async function handleDroppedDirectory(dirEntry) {
    const zipName = dirEntry.name + '.zip';
    const progress = createProgressItem(zipName);
    const cancelToken = { cancelled: false, xhr: null };
    progress.onCancel(() => {
      cancelToken.cancelled = true;
      if (cancelToken.xhr) cancelToken.xhr.abort();
    });
    try {
      progress.setStatus('zipping folder…');
      const entries = await walkDirectoryEntry(dirEntry, '', 0, cancelToken, { count: 0, bytes: 0 });
      if (!entries.length) throw new Error('Folder is empty.');
      const zipBlob = await buildZip(entries, cancelToken, (done, total) => {
        progress.setStatus(`zipping folder… ${done}/${total}`);
      });
      if (cancelToken.cancelled) throw new Error('Upload canceled.');
      const zipFile = new File([zipBlob], zipName, { type: 'application/zip' });
      progress.setStatus('uploading…');
      await uploadWithProgress(zipFile, progress, cancelToken);
      progress.hideCancel();
      Sebinta.refresh();
      setTimeout(() => progress.remove(), 1200);
    } catch (err) {
      progress.hideCancel();
      progress.setError(err.message || 'Could not zip this folder.');
      if (err.message !== 'Upload canceled.') {
        Sebinta.toast(`${dirEntry.name}: ${err.message || 'could not zip this folder'}`, 'error');
      }
      setTimeout(() => progress.remove(), 8000);
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

  // dataTransfer.files alone can't tell a dropped folder apart from a
  // genuine empty file, but each item's entry (the drag & drop Entries
  // API) can, via .isDirectory — separated out here so folders go through
  // handleDroppedDirectory (zip client-side, then upload) instead of
  // handleFiles (which has no bytes to send for a folder).
  function splitDroppedItems(dataTransfer) {
    const files = [];
    const directoryEntries = [];
    if (dataTransfer.items && dataTransfer.items.length) {
      for (const item of dataTransfer.items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) {
          directoryEntries.push(entry);
          continue;
        }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    } else if (dataTransfer.files) {
      // No Entries API support (old browser) — nothing to detect a folder
      // with, fall back to the plain FileList as before.
      files.push(...Array.from(dataTransfer.files));
    }
    return { files, directoryEntries };
  }

  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragCounter = 0;
    dropzoneOverlay.classList.remove('active');
    if (!ev.dataTransfer) return;
    const { files, directoryEntries } = splitDroppedItems(ev.dataTransfer);
    if (files.length) handleFiles(files);
    for (const entry of directoryEntries) handleDroppedDirectory(entry);
  });

  // --- paste (Ctrl+V) ---
  // Three-way branch: an HTML table/rich content pasted into the focused
  // editor (sanitized, then inserted as real DOM — see insertHtmlAtCaret)
  // > files (screenshots etc, handled anywhere on the page, not just the
  // editor — matches the existing "paste" hint next to the upload button)
  // > plain text, left to the browser's native contenteditable paste (no
  // interception needed).
  //
  // HTML is checked before files deliberately: Excel (and Word, Sheets,
  // ...) commonly put BOTH a text/html table AND a bitmap image of the
  // same selection on the clipboard. Checking files first would silently
  // upload that image and never look at the table — exactly what a user
  // pasting a spreadsheet range into the editor doesn't want.
  window.addEventListener('paste', (ev) => {
    const editor = document.getElementById('editor');
    const editorFocused = document.activeElement === editor;
    const hasHtml = editorFocused && ev.clipboardData && ev.clipboardData.types
      && Array.prototype.includes.call(ev.clipboardData.types, 'text/html');

    if (hasHtml) {
      const raw = ev.clipboardData.getData('text/html');
      const clean = window.Sebinta && window.Sebinta.sanitizePadHtml ? window.Sebinta.sanitizePadHtml(raw) : '';
      if (clean) {
        ev.preventDefault();
        insertHtmlAtCaret(editor, clean);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      // Nothing safe survived sanitization (e.g. the clipboard's HTML was
      // just an <img> wrapper, no table/text) — fall through below, so an
      // accompanying image file (or plain text) still gets handled.
    }

    const hasFiles = ev.clipboardData && ev.clipboardData.files && ev.clipboardData.files.length;
    if (hasFiles) {
      ev.preventDefault();
      handleFiles(ev.clipboardData.files);
      return;
    }
    // else: plain-text-only clipboard with the editor focused — let the
    // browser's native contenteditable paste happen, same as before.
  });

  // Inserts a sanitized HTML fragment at the current caret/selection
  // inside `editor`, then moves the caret to just after it. Deliberately
  // not document.execCommand('insertHTML', ...): it's deprecated and
  // inconsistent across browsers, and this needs precise control over the
  // resulting DOM (no browser-injected wrapper spans) so that a later
  // native copy of the pasted table stays clean HTML another Confluence/
  // Notion page can read back in.
  function insertHtmlAtCaret(editor, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const fragment = template.content;
    const lastNode = fragment.lastChild;
    if (!lastNode) return;

    const selection = window.getSelection();
    let range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(fragment);

    const after = document.createRange();
    after.setStartAfter(lastNode);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
  }
})();
