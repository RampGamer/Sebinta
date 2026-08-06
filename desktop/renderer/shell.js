'use strict';

/*
 * Chrome da janela principal: botão ⚙ (mudar servidor) + faixa de
 * separadores estilo browser, um <webview> por separador (cada um com a sua
 * própria ligação WebSocket — trocar de separador não recarrega nada). O
 * estado dos separadores (caminhos abertos + qual está ativo) é persistido
 * via IPC em config.json, para reabrir tal como ficou.
 */

(function () {
  const tabStrip = document.getElementById('tab-strip');
  const tabNewBtn = document.getElementById('tab-new');
  const tabViews = document.getElementById('tab-views');
  const hostBtn = document.getElementById('host-btn');

  let serverOrigin = '';
  let tabs = [];
  let activeId = null;
  let nextId = 1;
  let saveTimer = null;

  function tabUrl(padPath) {
    const clean = String(padPath || '').replace(/^\/+/, '');
    if (!clean) return serverOrigin + '/';
    return serverOrigin + '/' + clean.split('/').map(encodeURIComponent).join('/');
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistTabs, 400);
  }

  function persistTabs() {
    window.sebintaShell.saveTabs({
      tabs: tabs.map((t) => t.padPath),
      activeIndex: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
    });
  }

  function renderStrip() {
    tabStrip.querySelectorAll('.tab').forEach((el) => el.remove());
    tabs.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === activeId ? ' active' : '');
      const label = t.padPath || 'novo separador';
      el.title = label;
      el.innerHTML = `<span class="dot${t.connected ? '' : ' loading'}"></span><span class="name"></span><span class="close" title="Fechar">✕</span>`;
      el.querySelector('.name').textContent = label;
      el.addEventListener('click', () => switchTab(t.id));
      el.querySelector('.close').addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(t.id);
      });
      tabStrip.insertBefore(el, tabNewBtn);
    });
  }

  function switchTab(id) {
    activeId = id;
    tabs.forEach((t) => { t.viewEl.style.display = t.id === id ? 'flex' : 'none'; });
    renderStrip();
    applyChromeTheme();
    scheduleSave();
  }

  // A cromada da janela (⚙ + separadores) segue o tema da página do
  // separador ativo — cada webview avisa o seu tema via ipc-message (ver
  // webview-preload.js), a chamada aqui só reflete o que já sabemos.
  function applyChromeTheme() {
    const active = tabs.find((t) => t.id === activeId);
    document.body.classList.toggle('theme-notebook', !!active && active.theme === 'notebook');
  }

  function updatePadPathFromUrl(tab) {
    try {
      const u = new URL(tab.webview.getURL());
      tab.padPath = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    } catch (e) {
      /* navegação ainda não resolvida (about:blank, etc.) — ignora */
    }
    renderStrip();
    scheduleSave();
  }

  function openTab(padPath, { activate = true } = {}) {
    const id = nextId++;
    const viewEl = document.createElement('div');
    viewEl.className = 'tab-view';
    viewEl.style.display = 'none';

    const webview = document.createElement('webview');
    webview.setAttribute('partition', 'persist:sebinta');
    webview.setAttribute('src', tabUrl(padPath));
    viewEl.appendChild(webview);
    tabViews.appendChild(viewEl);

    const tab = { id, padPath: padPath || '', webview, viewEl, connected: false, theme: 'sober' };
    webview.addEventListener('did-navigate', () => updatePadPathFromUrl(tab));
    webview.addEventListener('did-navigate-in-page', () => updatePadPathFromUrl(tab));
    webview.addEventListener('did-start-loading', () => { tab.connected = false; renderStrip(); });
    webview.addEventListener('dom-ready', () => { tab.connected = true; renderStrip(); });
    webview.addEventListener('ipc-message', (event) => {
      if (event.channel !== 'sebinta:theme') return;
      tab.theme = event.args[0] === 'notebook' ? 'notebook' : 'sober';
      if (tab.id === activeId) applyChromeTheme();
    });

    tabs.push(tab);
    if (activate) switchTab(id); else renderStrip();
    scheduleSave();
    return tab;
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    if (tabs.length === 1) {
      // Nunca deixa a janela sem separadores — este volta à raiz (landing).
      const tab = tabs[0];
      tab.padPath = '';
      tab.webview.loadURL(tabUrl(''));
      renderStrip();
      scheduleSave();
      return;
    }

    const [tab] = tabs.splice(idx, 1);
    tab.viewEl.remove();
    if (activeId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      switchTab(next.id);
    } else {
      renderStrip();
    }
    scheduleSave();
  }

  hostBtn.addEventListener('click', () => window.sebintaShell.openSettings());
  tabNewBtn.addEventListener('click', () => openTab(''));

  window.sebintaShell.getServerUrl()
    .then((url) => {
      serverOrigin = url || '';
      return window.sebintaShell.getTabs();
    })
    .then(({ tabs: savedPaths, activeIndex }) => {
      const paths = savedPaths && savedPaths.length ? savedPaths : [''];
      paths.forEach((p) => openTab(p, { activate: false }));
      const target = tabs[Math.min(activeIndex || 0, tabs.length - 1)];
      switchTab(target.id);
    });
})();
