'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  flash: () => ipcRenderer.send('flash'),
  focusApp: () => ipcRenderer.send('focus-app'),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.invoke('set-autostart', on),
  getVersion: () => ipcRenderer.invoke('get-version'),
  downloadUpdate: (url, version) => ipcRenderer.invoke('download-update', url, version),
  getUpdateReady: () => ipcRenderer.invoke('get-update-ready'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (e, d) => cb(d)),
  onUpdateFailed: (cb) => ipcRenderer.on('update-failed', (e, d) => cb(d)),
  refocus: () => ipcRenderer.send('refocus'),
  showInFolder: (p) => ipcRenderer.send('show-in-folder', p),
  contextMenu: (opt) => ipcRenderer.invoke('context-menu', opt),
  openFile: (p) => ipcRenderer.send('open-file', p),
  saveAttachment: (url) => ipcRenderer.invoke('save-attachment', url),
  fileExists: (p) => ipcRenderer.invoke('file-exists', p),
  setBadge: (count, dataUrl, trayUrl) => ipcRenderer.send('set-badge', count, dataUrl, trayUrl),
  getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
  chooseDownloadDir: () => ipcRenderer.invoke('choose-download-dir'),
  resetDownloadDir: () => ipcRenderer.invoke('reset-download-dir'),
  openDownloadDir: () => ipcRenderer.send('open-download-dir'),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d))
});
