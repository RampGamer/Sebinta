'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sebintaShell', {
  getServerUrl: () => ipcRenderer.invoke('sebinta:get-current-server-url'),
  getTabs: () => ipcRenderer.invoke('sebinta:get-tabs'),
  saveTabs: (state) => ipcRenderer.invoke('sebinta:save-tabs', state),
  openSettings: () => ipcRenderer.send('sebinta:open-settings'),
});
