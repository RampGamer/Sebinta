'use strict';

/*
 * Electron main process. The main window loads its own "shell"
 * (renderer/shell.html) with a browser-style tab strip — each tab is a
 * <webview> pointing at a pad on the same Sebinta server (same
 * session/cookies/WebSocket as the web version, just several open at once
 * in a single window). The ⚙ button, on the left of the strip, opens the
 * settings window to switch servers — it's a window-level setting, not a
 * pad-level one, so it doesn't live inside any tab.
 *
 * The only thing this process adds on top of the web interface is the
 * 'sebinta:clean' IPC handler, called by each tab's preload
 * (webview-preload.js) when the user sends a file, to clean Office/PDF
 * locally before the upload continues to the server (see clean/office.js,
 * clean/pdf.js, clean/detectDlp.js).
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { cleanOoxml } = require('./clean/office');
const { cleanPdf } = require('./clean/pdf');
const { hasDlpTags } = require('./clean/detectDlp');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const CLEANABLE_EXT = { '.docx': 'ooxml', '.xlsx': 'ooxml', '.pptx': 'ooxml', '.pdf': 'pdf' };
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
const WEBVIEW_PRELOAD = path.join(__dirname, 'webview-preload.js');

let mainWindow = null;
let settingsWindow = null;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// No native menu (File/Edit/View) — didn't make sense for an app that's
// just a pad window; "Change server" is the ⚙ button in the shell.
Menu.setApplicationMenu(null);

function createMainWindow() {
  if (mainWindow) mainWindow.close();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    icon: APP_ICON,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'shell-preload.js'),
      contextIsolation: true,
      webviewTag: true,
    },
  });

  // Each <webview> requests its own preload/webPreferences on attach — we
  // never trust what the shell (or worse, a compromised tab) declared: we
  // always force the same isolated, Node-free preload.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences) => {
    delete webPreferences.preloadURL;
    webPreferences.preload = WEBVIEW_PRELOAD;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.sandbox = false;
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'shell.html'));
}

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 280,
    resizable: false,
    icon: APP_ICON,
    autoHideMenuBar: true,
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'settings-preload.js'),
      contextIsolation: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

ipcMain.handle('sebinta:get-current-server-url', () => loadConfig().serverUrl || '');

ipcMain.handle('sebinta:save-server-url', (event, url) => {
  saveConfig({ ...loadConfig(), serverUrl: url });
  if (settingsWindow) settingsWindow.close();
  if (mainWindow) mainWindow.webContents.reload();
  else createMainWindow();
});

ipcMain.on('sebinta:open-settings', () => openSettingsWindow());

// Tab state (open paths + which one is active), saved by the shell on
// every change so it reopens exactly as it was left.
ipcMain.handle('sebinta:get-tabs', () => {
  const cfg = loadConfig();
  return { tabs: cfg.tabs || [], activeIndex: cfg.activeTabIndex || 0 };
});

ipcMain.handle('sebinta:save-tabs', (event, { tabs, activeIndex }) => {
  saveConfig({ ...loadConfig(), tabs, activeTabIndex: activeIndex });
});

// Called by each tab's preload when a file is about to be uploaded. Never
// touches the network — only reads the bytes received over IPC.
ipcMain.handle('sebinta:clean', async (event, { name, buffer, cleanEnabled }) => {
  const ext = path.extname(String(name || '')).toLowerCase();
  const kind = CLEANABLE_EXT[ext];
  if (!kind) {
    return { cleaned: false, forced: false, reason: 'unsupported_type' };
  }

  const inputBuffer = Buffer.from(buffer);
  let forced = false;
  if (kind === 'ooxml') {
    forced = hasDlpTags(inputBuffer);
  }
  if (!cleanEnabled && !forced) {
    return { cleaned: false, forced: false, reason: 'skipped_by_user' };
  }

  try {
    if (kind === 'ooxml') {
      const { buffer: cleaned, removed } = cleanOoxml(inputBuffer);
      return { cleaned: true, forced, buffer: new Uint8Array(cleaned), removed };
    }
    const cleaned = await cleanPdf(inputBuffer);
    return { cleaned: true, forced, buffer: new Uint8Array(cleaned), removed: ['PDF metadata (Info + XMP)'] };
  } catch (err) {
    return { cleaned: false, forced, error: err.message };
  }
});

app.whenReady().then(() => {
  const { serverUrl } = loadConfig();
  if (serverUrl) createMainWindow();
  else openSettingsWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const cfg = loadConfig();
      if (cfg.serverUrl) createMainWindow();
      else openSettingsWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
