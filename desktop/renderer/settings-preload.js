'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('filepadSettings', {
  getCurrentServerUrl: () => ipcRenderer.invoke('filepad:get-current-server-url'),
  saveServerUrl: (url) => ipcRenderer.invoke('filepad:save-server-url', url),
});
