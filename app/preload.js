'use strict';
// The entire surface the renderer can reach. contextIsolation is on and
// nodeIntegration is off — the renderer has no fs, no child_process, and no
// way to read a credential value (only whether one is set).

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, fn) => {
  const listener = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('rejsudai', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: patch => ipcRenderer.invoke('settings:save', patch),
    addAlias: alias => ipcRenderer.invoke('settings:addAlias', alias),
  },
  credentials: {
    status: () => ipcRenderer.invoke('creds:status'),
    save: patch => ipcRenderer.invoke('creds:save', patch),
    importEnv: () => ipcRenderer.invoke('creds:importEnv'),
  },
  inbox: {
    scan: () => ipcRenderer.invoke('inbox:scan'),
    describe: folderPath => ipcRenderer.invoke('inbox:describe', folderPath),
    propose: payload => ipcRenderer.invoke('inbox:propose', payload),
    expand: paths => ipcRenderer.invoke('inbox:expand', paths),
    create: payload => ipcRenderer.invoke('inbox:create', payload),
    remove: folderPath => ipcRenderer.invoke('inbox:remove', folderPath),
  },
  dialog: {
    pickDirectory: opts => ipcRenderer.invoke('dialog:pickDirectory', opts),
    pickFiles: opts => ipcRenderer.invoke('dialog:pickFiles', opts),
  },
  // Dropped File objects carry no path since Electron 32; this is the supported
  // way to get one, and it is the only thing the renderer learns about a drop.
  pathForFile: file => webUtils.getPathForFile(file),
  run: {
    start: (settlements, options) => ipcRenderer.invoke('run:start', { settlements, options: options || {} }),
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
  appInfo: () => ipcRenderer.invoke('app:info'),

  onLog: fn => on('run:log', fn),
  onProgress: fn => on('run:progress', fn),
  onSettlement: fn => on('run:settlement', fn),
  onRunState: fn => on('run:state', fn),
  onTotpRequest: fn => on('run:totp-request', fn),
  onBrowserProgress: fn => on('browser:progress', fn),
  onFrame: fn => on('run:frame', fn),
  onFrameEnd: fn => on('run:frame-end', fn),
});
