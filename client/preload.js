'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  flash: () => ipcRenderer.send('flash'),
  focusApp: () => ipcRenderer.send('focus-app'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.invoke('set-autostart', on),
  getVersion: () => ipcRenderer.invoke('get-version'),
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  refocus: () => ipcRenderer.send('refocus'),
  showInFolder: (p) => ipcRenderer.send('show-in-folder', p),
  openFile: (p) => ipcRenderer.send('open-file', p),
  setBadge: (count, dataUrl, trayUrl) => ipcRenderer.send('set-badge', count, dataUrl, trayUrl),
  getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
  chooseDownloadDir: () => ipcRenderer.invoke('choose-download-dir'),
  resetDownloadDir: () => ipcRenderer.invoke('reset-download-dir'),
  openDownloadDir: () => ipcRenderer.send('open-download-dir'),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d))
});
