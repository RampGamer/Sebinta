'use strict';

/*
 * Main pad page logic: loading/saving text, real-time sync (WebSocket with
 * polling fallback), file listing, and the clear-pad / pad-password
 * actions. The upload itself (drag&drop, paste, progress bar, metadata
 * cleaning) is in upload.js, which uses the global window.Sebinta object
 * defined here.
 */

(function () {
  const padId = decodeURIComponent(window.location.pathname.replace(/^\/+/, ''));

  // Landing downloads ("Client"/"Server"): the hrefs in the HTML already
  // point to the releases page (a working fallback without JS); here we
  // just refine them to the exact file of the latest release, read live
  // from the GitHub API — so they never get stuck on one version as new
  // releases ship. Silent failure (offline, rate limit, etc.): the
  // fallback links keep working.
  function initDownloads() {
    const releaseTag = document.getElementById('dl-release-tag');
    const matchers = {
      'client-windows': /^Sebinta-desktop-.*windows.*\.exe$/i,
      'client-linux': /^Sebinta-desktop-.*\.AppImage$/i,
      'client-macos': /^Sebinta-desktop-.*macos-arm64\.zip$/i,
      'client-macos-x64': /^Sebinta-desktop-.*macos-x64\.zip$/i,
      'server-windows': /^sebinta-server-.*windows.*\.exe$/i,
      'server-linux': /^sebinta-server-.*linux-amd64$/i,
      'server-macos': /^sebinta-server-.*macos-arm64$/i,
      'server-macos-x64': /^sebinta-server-.*macos-amd64$/i,
    };
    fetch('https://api.github.com/repos/RampGamer/Sebinta/releases/latest')
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((release) => {
        if (releaseTag && release.tag_name) {
          releaseTag.textContent = ''; // textContent: nunca innerHTML, previne XSS
          releaseTag.append('Latest version: ');
          const b = document.createElement('b');
          b.textContent = release.tag_name;
          releaseTag.append(b);
        }
        const assets = release.assets || [];
        for (const [key, pattern] of Object.entries(matchers)) {
          const asset = assets.find((a) => pattern.test(a.name));
          if (!asset) continue;
          const el = document.querySelector(`[data-key="${key}"]`);
          if (!el) continue;
          el.href = asset.browser_download_url;
          el.title = asset.name;
          el.removeAttribute('target');
          el.removeAttribute('rel');
        }
      })
      .catch(() => {
        if (releaseTag) releaseTag.textContent = 'See all versions on GitHub.';
      });
  }

  // Root "/" with no pad name: there's nothing valid to load (the server
  // would reject it with invalid_pad_id) — shows a screen asking for a
  // name instead of trying and failing.
  if (!padId) {
    document.getElementById('pad-header').hidden = true;
    document.getElementById('pad-main').hidden = true;
    const landing = document.getElementById('landing');
    landing.hidden = false;
    document.getElementById('form-landing').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = document.getElementById('landing-pad-name').value.trim();
      if (!name) return;
      window.location.href = new URL(name, window.location.origin + '/').href;
    });
    initDownloads();
    return;
  }

  const editor = document.getElementById('editor');
  const padPathForm = document.getElementById('form-pad-path');
  const padPathInput = document.getElementById('pad-path-input');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const fileGrid = document.getElementById('file-grid');
  const toastContainer = document.getElementById('toast-container');

  const modalUnlock = document.getElementById('modal-unlock');
  const formUnlock = document.getElementById('form-unlock');
  const unlockError = document.getElementById('unlock-error');

  const modalPassword = document.getElementById('modal-password');
  const formPassword = document.getElementById('form-password');
  const passwordError = document.getElementById('password-error');

  const modalClear = document.getElementById('modal-clear');
  const protectedBadge = document.getElementById('protected-badge');
  const btnPassword = document.getElementById('btn-password');

  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxName = document.getElementById('lightbox-name');
  const lightboxDownload = document.getElementById('lightbox-download');

  let state = { version: 0, hasPassword: false, locked: false };

  // Shows whether the pad became protected — whoever sets the password
  // stays unlocked in this browser (7-day cookie), so the badge is the
  // only visual signal that protection actually took effect.
  function updateProtectedBadge() {
    protectedBadge.hidden = !state.hasPassword;
    btnPassword.textContent = state.hasPassword ? '🔒 Password (active)' : '🔒 Password';
    btnPassword.title = state.hasPassword
      ? 'This pad is protected — click to change or remove the password'
      : 'Protect this pad with a password';
  }
  let lastLocalEditAt = 0;
  let saveTimer = null;
  let ws = null;
  let pollTimer = null;
  let wsFailCount = 0;

  padPathInput.value = padId;
  document.title = '/' + padId + ' — Sebinta';

  padPathForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const raw = padPathInput.value.trim();
    if (!raw || raw === padId) return;
    window.location.href = new URL(raw, window.location.origin + '/').href;
  });

  // Easter egg: switches to a "notebook" theme (same page, just a reskin via
  // CSS — see body.theme-notebook in style.css). Saved per browser.
  const brandLogo = document.getElementById('btn-brand-logo');
  brandLogo.addEventListener('click', () => {
    const next = document.body.classList.toggle('theme-notebook') ? 'notebook' : 'sober';
    try { localStorage.setItem('sebinta-theme', next); } catch (e) { /* ignora (modo privado, etc.) */ }
  });

  // --- utilidades ---
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[2]) : null;
  }

  function csrfToken() {
    return getCookie('fp_csrf') || '';
  }

  function apiUrl(path) {
    return path + (path.includes('?') ? '&' : '?') + 'id=' + encodeURIComponent(padId);
  }

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = message; // textContent: nunca HTML, previne XSS
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function setStatus(kind, text) {
    statusDot.className = 'status-dot ' + kind;
    statusText.textContent = text;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let val = bytes;
    let i = -1;
    do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
    return val.toFixed(val < 10 ? 1 : 0) + ' ' + units[i];
  }

  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', ...options };
    opts.headers = { ...(opts.headers || {}) };
    if (options.method && options.method !== 'GET') {
      opts.headers['X-CSRF-Token'] = csrfToken();
    }
    const res = await fetch(apiUrl(path), opts);
    if (res.status === 401) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      throw new Error('site_auth_required');
    }
    return res;
  }

  // --- carregar / renderizar estado do pad ---
  async function refresh() {
    let res;
    try {
      res = await api('/api/pad');
    } catch (e) {
      return;
    }
    if (!res.ok) {
      toast('Could not load the pad.', 'error');
      return;
    }
    const data = await res.json();
    state.hasPassword = data.hasPassword;
    updateProtectedBadge();

    if (data.locked) {
      state.locked = true;
      modalUnlock.classList.add('active');
      return;
    }
    state.locked = false;
    modalUnlock.classList.remove('active');

    if (data.version !== state.version) {
      const editorFocused = document.activeElement === editor;
      const recentlyEdited = Date.now() - lastLocalEditAt < 4000;
      if (!editorFocused && !recentlyEdited) {
        editor.value = data.content;
      }
      state.version = data.version;
    }
    renderFiles(data.files || []);
  }

  function renderFiles(files) {
    fileGrid.replaceChildren();
    for (const file of files) {
      fileGrid.appendChild(buildFileCard(file));
    }
  }

  function buildFileCard(file) {
    const card = document.createElement('div');
    card.className = 'file-card';

    const preview = document.createElement('div');
    preview.className = 'preview';
    if (file.kind === 'image') {
      const img = document.createElement('img');
      img.src = apiUrl(`/api/files/${encodeURIComponent(file.id)}/preview`);
      img.alt = file.name;
      img.loading = 'lazy';
      preview.appendChild(img);
      preview.title = 'Click to preview';
      preview.addEventListener('click', () => openLightbox(file));
    } else if (file.kind === 'video') {
      const video = document.createElement('video');
      video.src = apiUrl(`/api/files/${encodeURIComponent(file.id)}/preview`);
      video.controls = true;
      video.preload = 'metadata';
      preview.appendChild(video);
    } else {
      const icon = document.createElement('div');
      icon.className = 'icon';
      icon.textContent = '📄';
      preview.appendChild(icon);
    }
    card.appendChild(preview);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = file.name; // textContent: nunca innerHTML, previne XSS
    name.title = file.name;
    meta.appendChild(name);

    const size = document.createElement('div');
    size.className = 'size';
    size.textContent = formatSize(file.size);
    meta.appendChild(size);

    const row = document.createElement('div');
    row.className = 'row';

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = '⬇ Download';
    downloadBtn.addEventListener('click', () => {
      window.location.href = apiUrl(`/api/files/${encodeURIComponent(file.id)}/download`);
    });
    row.appendChild(downloadBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete file';
    deleteBtn.addEventListener('click', () => deleteFile(file.id));
    row.appendChild(deleteBtn);

    meta.appendChild(row);
    card.appendChild(meta);
    return card;
  }

  // --- full-screen image preview ---
  function openLightbox(file) {
    lightboxImg.src = apiUrl(`/api/files/${encodeURIComponent(file.id)}/preview`);
    lightboxImg.alt = file.name;
    lightboxName.textContent = file.name; // textContent: nunca innerHTML, previne XSS
    lightboxDownload.onclick = () => {
      window.location.href = apiUrl(`/api/files/${encodeURIComponent(file.id)}/download`);
    };
    lightbox.hidden = false;
  }
  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.src = '';
  }
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (ev) => { if (ev.target === lightbox) closeLightbox(); });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !lightbox.hidden) closeLightbox(); });

  async function deleteFile(fileId) {
    const res = await api(`/api/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    if (res.ok) {
      toast('File deleted.', 'success');
      refresh();
    } else {
      toast('Could not delete the file.', 'error');
    }
  }

  // --- autosave do texto ---
  editor.addEventListener('input', () => {
    lastLocalEditAt = Date.now();
    setStatus('saving', 'saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveContent, 600);
  });

  async function saveContent() {
    const content = editor.value;
    try {
      const res = await api('/api/pad', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        setStatus('offline', 'save error');
        return;
      }
      const data = await res.json();
      state.version = data.version;
      setStatus(ws && ws.readyState === WebSocket.OPEN ? 'online' : 'offline', 'saved');
    } catch (e) {
      setStatus('offline', 'no connection');
    }
  }

  // --- limpar pad ---
  document.getElementById('btn-clear').addEventListener('click', () => modalClear.classList.add('active'));
  document.getElementById('btn-clear-cancel').addEventListener('click', () => modalClear.classList.remove('active'));
  document.getElementById('btn-clear-confirm').addEventListener('click', async () => {
    const res = await api('/api/pad', { method: 'DELETE' });
    modalClear.classList.remove('active');
    if (res.ok) {
      editor.value = '';
      fileGrid.replaceChildren();
      toast('Pad cleared.', 'success');
    } else {
      toast('Could not clear the pad.', 'error');
    }
  });

  // --- password do pad ---
  document.getElementById('btn-password').addEventListener('click', () => {
    passwordError.textContent = '';
    document.getElementById('new-password').value = '';
    modalPassword.classList.add('active');
  });
  document.getElementById('btn-password-cancel').addEventListener('click', () => modalPassword.classList.remove('active'));
  formPassword.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const password = document.getElementById('new-password').value;
    const res = await api('/api/pad/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const data = await res.json();
      state.hasPassword = data.hasPassword;
      updateProtectedBadge();
      modalPassword.classList.remove('active');
      toast(data.hasPassword ? 'Password set — this pad is now protected (look for the 🔒 icon next to the name).' : 'Password removed.', 'success');
    } else {
      const data = await res.json().catch(() => ({}));
      passwordError.textContent = data.error === 'invalid_password_length'
        ? 'The password must be between 4 and 200 characters.'
        : 'Could not save the password.';
    }
  });

  formUnlock.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    unlockError.textContent = '';
    const password = document.getElementById('unlock-password').value;
    const res = await api('/api/pad/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      document.getElementById('unlock-password').value = '';
      modalUnlock.classList.remove('active');
      state.version = -1; // forces the content received next to be applied
      refresh();
      connectRealtime();
    } else if (res.status === 429) {
      unlockError.textContent = 'Too many attempts. Wait a bit.';
    } else {
      unlockError.textContent = 'Incorrect password.';
    }
  });

  // --- tempo real: WebSocket com fallback de polling curto ---
  function connectRealtime() {
    if (state.locked) return;
    stopPolling();
    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws?pad=${encodeURIComponent(padId)}`);
    } catch (e) {
      startPolling();
      return;
    }
    const connectTimeout = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        ws.close();
      }
    }, 4000);

    ws.addEventListener('open', () => {
      clearTimeout(connectTimeout);
      wsFailCount = 0;
      setStatus('online', 'live');
      stopPolling();
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'changed') refresh();
      } catch (e) { /* ignores invalid messages */ }
    });
    ws.addEventListener('close', () => {
      clearTimeout(connectTimeout);
      wsFailCount++;
      setStatus('offline', 'live connection lost');
      startPolling();
      // Tries to reconnect with backoff, up to 30s.
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(wsFailCount, 5)));
      setTimeout(connectRealtime, delay);
    });
    ws.addEventListener('error', () => {
      if (ws) ws.close();
    });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(refresh, 4000);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Exposes the essentials for upload.js.
  window.Sebinta = {
    padId,
    csrfToken,
    apiUrl,
    toast,
    refresh,
    api,
  };

  refresh().then(() => {
    if (!state.locked) connectRealtime();
  });
})();
