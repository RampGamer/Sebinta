'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sebintaSettings', {
  getCurrentServerUrl: () => ipcRenderer.invoke('sebinta:get-current-server-url'),
  saveServerUrl: (url) => ipcRenderer.invoke('sebinta:save-server-url', url),
});
