'use strict';

/*
 * Processo principal do Electron. Carrega a interface web real de um
 * servidor Filepad (mesma UI, mesma sessão/cookies/WebSocket) numa janela
 * normal — não há UI própria a reimplementar. A única coisa que este
 * processo acrescenta é o handler IPC 'filepad:clean', chamado pelo
 * preload.js quando o utilizador envia um ficheiro, para limpar Office/PDF
 * localmente antes do upload seguir para o servidor (ver clean/office.js,
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

function buildMenu(serverUrl) {
  const template = [
    {
      label: 'Filepad',
      submenu: [
        {
          label: 'Mudar servidor…',
          click: () => openSettingsWindow(),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Sair' },
      ],
    },
    { role: 'editMenu', label: 'Editar' },
    { role: 'viewMenu', label: 'Ver' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(serverUrl) {
  if (mainWindow) mainWindow.close();
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  mainWindow.loadURL(serverUrl);
  buildMenu(serverUrl);
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
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'settings-preload.js'),
      contextIsolation: true,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

ipcMain.handle('filepad:get-current-server-url', () => loadConfig().serverUrl || '');

ipcMain.handle('filepad:save-server-url', (event, url) => {
  saveConfig({ ...loadConfig(), serverUrl: url });
  if (settingsWindow) settingsWindow.close();
  createMainWindow(url);
});

// Chamado pelo preload.js da janela principal quando um ficheiro está prestes
// a ser enviado. Nunca contacta a rede — só lê os bytes recebidos por IPC.
ipcMain.handle('filepad:clean', async (event, { name, buffer, cleanEnabled }) => {
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
    return { cleaned: true, forced, buffer: new Uint8Array(cleaned), removed: ['Metadados do PDF (Info + XMP)'] };
  } catch (err) {
    return { cleaned: false, forced, error: err.message };
  }
});

app.whenReady().then(() => {
  const { serverUrl } = loadConfig();
  if (serverUrl) createMainWindow(serverUrl);
  else openSettingsWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const cfg = loadConfig();
      if (cfg.serverUrl) createMainWindow(cfg.serverUrl);
      else openSettingsWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
