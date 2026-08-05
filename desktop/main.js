'use strict';

/*
 * Processo principal do Electron. A janela principal carrega uma "shell"
 * própria (renderer/shell.html) com uma faixa de separadores estilo
 * browser — cada separador é um <webview> a apontar para um pad do mesmo
 * servidor Sebinta (mesma sessão/cookies/WebSocket que a versão web, mas
 * várias abertas ao mesmo tempo numa só janela). O botão ⚙, no canto
 * esquerdo da faixa, abre a janela de definições para trocar de servidor —
 * é uma definição da janela, não de um pad, por isso não vive dentro de
 * nenhum separador.
 *
 * A única coisa que este processo acrescenta à interface web é o handler
 * IPC 'sebinta:clean', chamado pelo preload de cada separador
 * (webview-preload.js) quando o utilizador envia um ficheiro, para limpar
 * Office/PDF localmente antes do upload seguir para o servidor (ver
 * clean/office.js, clean/pdf.js, clean/detectDlp.js).
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

// Sem menu nativo (File/Edit/View) — não fazia sentido numa app que é só
// uma janela do pad; "Mudar servidor" é o botão ⚙ na shell.
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

  // Cada <webview> pede o seu próprio preload/webPreferences ao anexar —
  // nunca confiamos no que a shell (ou, pior, um separador comprometido)
  // declarou: forçamos sempre o mesmo preload isolado e sem Node.
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

// Estado dos separadores (caminhos abertos + qual está ativo), gravado pela
// shell a cada alteração para reabrir tal como ficou.
ipcMain.handle('sebinta:get-tabs', () => {
  const cfg = loadConfig();
  return { tabs: cfg.tabs || [], activeIndex: cfg.activeTabIndex || 0 };
});

ipcMain.handle('sebinta:save-tabs', (event, { tabs, activeIndex }) => {
  saveConfig({ ...loadConfig(), tabs, activeTabIndex: activeIndex });
});

// Chamado pelo preload de cada separador quando um ficheiro está prestes a
// ser enviado. Nunca contacta a rede — só lê os bytes recebidos por IPC.
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
    return { cleaned: true, forced, buffer: new Uint8Array(cleaned), removed: ['Metadados do PDF (Info + XMP)'] };
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
