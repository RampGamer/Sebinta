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
          releaseTag.textContent = ''; // textContent: never innerHTML, prevents XSS
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

  const viewerBadge = document.getElementById('viewer-badge');

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

  // --- pad HTML rendering/sanitization ---
  // Client-side defense-in-depth only — the real security boundary is
  // server-side (standalone/sanitize.go sanitizes every PUT before
  // storing/rebroadcasting to every other live viewer). Canonical
  // allowlist mirrored in exactly that file, server/services/sanitizeHtml.js,
  // and here (shared with upload.js via window.Sebinta.sanitizePadHtml).
  const PAD_HTML_ALLOWED_TAGS = [
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'p', 'br', 'div', 'span',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's',
    'ul', 'ol', 'li', 'a', 'blockquote', 'code', 'pre',
  ];
  const PAD_HTML_ALLOWED_ATTR = ['colspan', 'rowspan', 'href', 'style'];
  // Whitelist-by-construction: url(), expression(), javascript: etc. can
  // never match these, so they're dropped along with everything else.
  const PAD_STYLE_ALLOWLIST = {
    'text-align': /^(?:left|right|center|justify)$/,
    'vertical-align': /^(?:top|middle|bottom|baseline)$/,
    'background-color': /^(?:#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\)|[a-zA-Z]{3,20})$/,
    width: /^\d{1,4}(?:px|%)$/,
  };

  if (window.DOMPurify) {
    // DOMPurify has no built-in per-declaration style filtering — this
    // hook rebuilds the style attribute keeping only the 4 allowed
    // declarations, each value-checked against PAD_STYLE_ALLOWLIST.
    DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
      if (data.attrName !== 'style') return;
      const kept = [];
      for (const decl of data.attrValue.split(';')) {
        const idx = decl.indexOf(':');
        if (idx === -1) continue;
        const prop = decl.slice(0, idx).trim();
        const val = decl.slice(idx + 1).trim();
        const re = PAD_STYLE_ALLOWLIST[prop];
        if (re && re.test(val)) kept.push(`${prop}: ${val}`);
      }
      data.attrValue = kept.join('; ');
    });
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('rel', 'noopener noreferrer');
        node.setAttribute('target', '_blank');
      }
    });
  }

  function sanitizePadHtml(html) {
    // Fail closed: if the vendored library somehow didn't load, don't
    // trust unsanitized HTML into the DOM.
    if (!window.DOMPurify) return '';
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: PAD_HTML_ALLOWED_TAGS,
      ALLOWED_ATTR: PAD_HTML_ALLOWED_ATTR,
      ALLOWED_URI_REGEXP: /^(?:https?:|(?!.*:))/i,
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Pads created before content_format existed (or never edited in the
  // rich editor yet) have plain-text content — escape it and turn
  // newlines into <br> instead of trusting it as markup, so old notes
  // with literal <, >, & display correctly instead of being misparsed.
  function renderPadContent(content, format) {
    if (format === 'html') return sanitizePadHtml(content || '');
    return escapeHtml(content || '').replace(/\n/g, '<br>');
  }

  let state = { version: 0, hasPassword: false, locked: false };

  // Bumped every time this tab locally confirms it holds the right
  // password (sets one, or unlocks). A refresh() started before that
  // point can still resolve after it (it was already in flight, sent
  // with the pre-unlock cookie) and report locked:true — comparing
  // against the token lets refresh() tell that stale verdict apart from
  // a real, current lock and ignore it, instead of flashing the unlock
  // modal right after the password was just set.
  let unlockToken = 0;

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
    try { localStorage.setItem('sebinta-theme', next); } catch (e) { /* ignore (private mode, etc.) */ }
  });

  // Light/dark toggle — swaps only the color variables (see body.theme-light
  // in style.css), independent of the notebook easter egg above. Saved per
  // browser; theme-init.js applies it before first paint to avoid a flash.
  const btnColorMode = document.getElementById('btn-color-mode');
  function updateColorModeButton() {
    const isLight = document.body.classList.contains('theme-light');
    btnColorMode.textContent = isLight ? '☀️ Light' : '🌙 Dark';
    btnColorMode.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  }
  updateColorModeButton();
  btnColorMode.addEventListener('click', () => {
    const next = document.body.classList.toggle('theme-light') ? 'light' : 'dark';
    try { localStorage.setItem('sebinta-color-mode', next); } catch (e) { /* ignore (private mode, etc.) */ }
    updateColorModeButton();
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
    el.textContent = message; // textContent: never HTML, prevents XSS
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function setStatus(kind, text) {
    statusDot.className = 'status-dot ' + kind;
    statusText.textContent = text;
  }

  // count includes this tab itself, so the badge only shows for count > 1.
  function updateViewerBadge(count) {
    viewerBadge.hidden = !(typeof count === 'number' && count > 1);
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

  // --- load / render pad state ---
  async function refresh() {
    const tokenAtStart = unlockToken;
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
      if (tokenAtStart !== unlockToken) return; // superseded: this tab already unlocked since this request was sent
      state.locked = true;
      modalUnlock.classList.add('active');
      return;
    }
    state.locked = false;
    modalUnlock.classList.remove('active');

    if (data.version !== state.version) {
      // Only protection is "don't clobber content the user is actively
      // typing right now" — having the cursor in the field otherwise
      // doesn't block a live update, so remote edits show up immediately
      // instead of waiting for blur.
      const recentlyEdited = Date.now() - lastLocalEditAt < 4000;
      if (!recentlyEdited) {
        editor.innerHTML = renderPadContent(data.content, data.contentFormat);
        state.version = data.version;
      }
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
    name.textContent = file.name; // textContent: never innerHTML, prevents XSS
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
    lightboxName.textContent = file.name; // textContent: never innerHTML, prevents XSS
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

  // --- text autosave ---
  editor.addEventListener('input', () => {
    lastLocalEditAt = Date.now();
    setStatus('saving', 'saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveContent, 600);
  });

  // Catches up immediately on any remote edit that arrived while this tab
  // had the editor focused (and was therefore skipped in refresh()), rather
  // than waiting for the next remote change to trigger a retry.
  editor.addEventListener('blur', () => refresh());

  async function saveContent() {
    const content = editor.innerHTML;
    try {
      const res = await api('/api/pad', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, content_format: 'html' }),
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
      editor.innerHTML = '';
      fileGrid.replaceChildren();
      toast('Pad cleared.', 'success');
    } else {
      toast('Could not clear the pad.', 'error');
    }
  });

  // Shows a live countdown in an error <p> for a 429 response — el.error
  // is expected to already hold the parsed JSON body ({ error,
  // retryAfterSeconds }). Ticks down every second so the message stays
  // accurate instead of a static "wait a bit" that's wrong a moment later.
  function showRetryCountdown(el, retryAfterSeconds) {
    if (el._countdownTimer) {
      clearInterval(el._countdownTimer);
      el._countdownTimer = null;
    }
    let remaining = Math.max(1, Math.round(retryAfterSeconds) || 0);
    if (!remaining) {
      el.textContent = 'Too many attempts. Wait a bit.';
      return;
    }
    const render = () => { el.textContent = `Too many attempts. Try again in ${remaining}s.`; };
    render();
    el._countdownTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(el._countdownTimer);
        el._countdownTimer = null;
        el.textContent = '';
      } else {
        render();
      }
    }, 1000);
  }

  // --- pad password ---
  const btnPasswordRemove = document.getElementById('btn-password-remove');
  document.getElementById('btn-password').addEventListener('click', () => {
    passwordError.textContent = '';
    document.getElementById('new-password').value = '';
    btnPasswordRemove.hidden = !state.hasPassword;
    modalPassword.classList.add('active');
  });
  document.getElementById('btn-password-cancel').addEventListener('click', () => modalPassword.classList.remove('active'));

  async function savePassword(password) {
    const res = await api('/api/pad/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const data = await res.json();
      state.hasPassword = data.hasPassword;
      state.locked = false;
      unlockToken++;
      updateProtectedBadge();
      modalPassword.classList.remove('active');
      modalUnlock.classList.remove('active');
      toast(data.hasPassword ? 'Password set — this pad is now protected (look for the 🔒 icon next to the name).' : 'Password removed.', 'success');
    } else {
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        showRetryCountdown(passwordError, data.retryAfterSeconds);
      } else if (data.error === 'invalid_password_length') {
        passwordError.textContent = 'The password must be between 4 and 200 characters.';
      } else if (data.error === 'pad_locked') {
        passwordError.textContent = 'This pad is protected — unlock it first.';
      } else {
        passwordError.textContent = 'Could not save the password.';
      }
    }
  }

  formPassword.addEventListener('submit', (ev) => {
    ev.preventDefault();
    savePassword(document.getElementById('new-password').value);
  });
  btnPasswordRemove.addEventListener('click', () => savePassword(''));

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
      state.locked = false;
      unlockToken++;
      modalUnlock.classList.remove('active');
      state.version = -1; // forces the content received next to be applied
      refresh();
      connectRealtime();
    } else if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      showRetryCountdown(unlockError, data.retryAfterSeconds);
    } else {
      unlockError.textContent = 'Incorrect password.';
    }
  });

  // --- real-time: WebSocket with short-polling fallback ---
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
        else if (msg.type === 'presence') updateViewerBadge(msg.count);
      } catch (e) { /* ignores invalid messages */ }
    });
    ws.addEventListener('close', () => {
      clearTimeout(connectTimeout);
      wsFailCount++;
      setStatus('offline', 'live connection lost');
      // Presence is a WebSocket-only feature (no polling equivalent) — once
      // disconnected we no longer know who else is here, so hide it rather
      // than show a stale count.
      updateViewerBadge(0);
      startPolling();
      // Tries to reconnect with backoff, up to 30s.
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(wsFailCount, 5)));
      setTimeout(connectRealtime, delay);
    });
    ws.addEventListener('error', () => {
      if (ws) ws.close();
    });
  }

  // Navigating to a different pad (the "Go" form) replaces the whole page,
  // but the browser doesn't always tear down an in-flight WebSocket
  // promptly as part of that — closing it explicitly here means the server
  // sees the close frame right away instead of only noticing once the
  // connection times out (up to ~20s later), so the 👁 viewer badge on
  // other tabs updates immediately instead of lagging behind.
  window.addEventListener('pagehide', () => {
    if (ws) ws.close();
  });

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
    sanitizePadHtml,
  };

  refresh().then(() => {
    if (!state.locked) connectRealtime();
  });
})();
