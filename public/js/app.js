'use strict';

/*
 * Lógica principal da página do pad: carregar/gravar texto, sincronização
 * em tempo real (WebSocket com fallback de polling), listagem de
 * ficheiros e as ações de apagar pad / password do pad. O upload em si
 * (drag&drop, colar, barra de progresso, limpeza de metadados) está em
 * upload.js, que usa o objeto global window.Sebinta definido aqui.
 */

(function () {
  const padId = decodeURIComponent(window.location.pathname.replace(/^\/+/, ''));

  // Raiz "/" sem nome de pad: não há nada válido para carregar (o servidor
  // rejeitaria com invalid_pad_id) — mostra um ecrã a pedir um nome em vez
  // de tentar e falhar.
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
    return;
  }

  const editor = document.getElementById('editor');
  const padNameEl = document.getElementById('pad-name');
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

  // Torna visível se o pad ficou protegido — quem define a password fica
  // desbloqueado neste browser (cookie de 7 dias), por isso o badge é o
  // único sinal visual de que a proteção ficou mesmo ativa.
  function updateProtectedBadge() {
    protectedBadge.hidden = !state.hasPassword;
    btnPassword.textContent = state.hasPassword ? '🔒 Password (ativa)' : '🔒 Password';
    btnPassword.title = state.hasPassword
      ? 'Este pad está protegido — clica para alterar ou remover a password'
      : 'Proteger este pad com password';
  }
  let lastLocalEditAt = 0;
  let saveTimer = null;
  let ws = null;
  let pollTimer = null;
  let wsFailCount = 0;

  padNameEl.textContent = '/' + padId;
  document.title = '/' + padId + ' — Sebinta';

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
      toast('Não foi possível carregar o pad.', 'error');
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
      preview.title = 'Clica para pré-visualizar';
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
    downloadBtn.textContent = '⬇ Transferir';
    downloadBtn.addEventListener('click', () => {
      window.location.href = apiUrl(`/api/files/${encodeURIComponent(file.id)}/download`);
    });
    row.appendChild(downloadBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Apagar ficheiro';
    deleteBtn.addEventListener('click', () => deleteFile(file.id));
    row.appendChild(deleteBtn);

    meta.appendChild(row);
    card.appendChild(meta);
    return card;
  }

  // --- pré-visualização de imagens em ecrã inteiro ---
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
      toast('Ficheiro apagado.', 'success');
      refresh();
    } else {
      toast('Não foi possível apagar o ficheiro.', 'error');
    }
  }

  // --- autosave do texto ---
  editor.addEventListener('input', () => {
    lastLocalEditAt = Date.now();
    setStatus('saving', 'a gravar…');
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
        setStatus('offline', 'erro ao gravar');
        return;
      }
      const data = await res.json();
      state.version = data.version;
      setStatus(ws && ws.readyState === WebSocket.OPEN ? 'online' : 'offline', 'gravado');
    } catch (e) {
      setStatus('offline', 'sem ligação');
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
      toast('Pad limpo.', 'success');
    } else {
      toast('Não foi possível limpar o pad.', 'error');
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
      toast(data.hasPassword ? 'Password definida — este pad já está protegido (repara no ícone 🔒 junto ao nome).' : 'Password removida.', 'success');
    } else {
      const data = await res.json().catch(() => ({}));
      passwordError.textContent = data.error === 'invalid_password_length'
        ? 'A password deve ter entre 4 e 200 caracteres.'
        : 'Não foi possível guardar a password.';
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
      state.version = -1; // força a aplicar o conteúdo recebido a seguir
      refresh();
      connectRealtime();
    } else if (res.status === 429) {
      unlockError.textContent = 'Demasiadas tentativas. Aguarda um pouco.';
    } else {
      unlockError.textContent = 'Password incorreta.';
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
      setStatus('online', 'em direto');
      stopPolling();
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'changed') refresh();
      } catch (e) { /* ignora mensagens inválidas */ }
    });
    ws.addEventListener('close', () => {
      clearTimeout(connectTimeout);
      wsFailCount++;
      setStatus('offline', 'sem ligação em direto');
      startPolling();
      // Tenta religar com backoff, até 30s.
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

  // Expõe o essencial para upload.js.
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
