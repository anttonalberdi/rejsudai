'use strict';
// The entire surface the renderer can reach. contextIsolation is on and
// nodeIntegration is off — the renderer has no fs, no child_process, and no
// way to read a credential value (only whether one is set).

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, fn) => {
  const listener = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('rejsud', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: patch => ipcRenderer.invoke('settings:save', patch),
  },
  credentials: {
    status: () => ipcRenderer.invoke('creds:status'),
    save: patch => ipcRenderer.invoke('creds:save', patch),
    importEnv: () => ipcRenderer.invoke('creds:importEnv'),
  },
  inbox: {
    scan: () => ipcRenderer.invoke('inbox:scan'),
    describe: folderPath => ipcRenderer.invoke('inbox:describe', folderPath),
  },
  dialog: {
    pickDirectory: opts => ipcRenderer.invoke('dialog:pickDirectory', opts),
  },
  run: {
    start: settlements => ipcRenderer.invoke('run:start', settlements),
    cancel: () => ipcRenderer.invoke('run:cancel'),
    state: () => ipcRenderer.invoke('run:state'),
    submitTotp: code => ipcRenderer.invoke('run:totp', code),
  },
  browser: {
    status: () => ipcRenderer.invoke('browser:status'),
    install: () => ipcRenderer.invoke('browser:install'),
  },
  manifest: {
    read: manifestPath => ipcRenderer.invoke('manifest:read', manifestPath),
  },
  shell: {
    openPath: target => ipcRenderer.invoke('shell:openPath', target),
    revealPath: target => ipcRenderer.invoke('shell:revealPath', target),
  },
  drafts: {
    delete: namePattern => ipcRenderer.invoke('draft:delete', namePattern),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),

  onLog: fn => on('run:log', fn),
  onProgress: fn => on('run:progress', fn),
  onSettlement: fn => on('run:settlement', fn),
  onRunState: fn => on('run:state', fn),
  onTotpRequest: fn => on('run:totp-request', fn),
  onBrowserProgress: fn => on('browser:progress', fn),
});
