'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');

const settingsStore = require('./lib/settings');
const credentials = require('./lib/credentials');
const inbox = require('./lib/inbox');
const browsers = require('./lib/browsers');
const runner = require('./lib/runner');

let win = null;
let quitting = false;

// --- appearance --------------------------------------------------------------
// The renderer paints itself from its own CSS tokens; this is what the parts of
// the window Chromium draws for us follow — the traffic lights, the native
// dialogs, and the backdrop behind the page before the first paint.
const WINDOW_BG = { light: '#f4f4f7', dark: '#1a1b1e' };

function paintWindowBackground() {
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light);
  }
}

function applyTheme(theme) {
  const source = theme === 'light' || theme === 'dark' ? theme : 'system';
  // Every settings write comes through here, and dragging a splitter is a
  // settings write — re-assigning the same source would re-emit 'updated' each
  // time.
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  paintWindowBackground();
}

// On 'system' the OS can flip underneath us, and the backdrop has to follow.
nativeTheme.on('updated', paintWindowBackground);

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'Rejsudai',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (win = null));

  // Closing the window ends the run (there would be nothing left to watch it),
  // so make that an explicit choice rather than a silent kill mid-draft.
  win.on('close', event => {
    if (!runner.busy || quitting) return;
    event.preventDefault();
    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Keep running', 'Stop and close'],
        defaultId: 0,
        cancelId: 0,
        message: 'A settlement is still being filed.',
        detail: 'Closing now cuts the automation short, which can leave a half-filled draft in indfak2.',
      })
      .then(({ response }) => {
        if (response !== 1) return;
        runner.cancel();
        quitting = true;
        win.close();
      });
  });

  // The automation opens indfak2 links; keep those in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- runner events → renderer ------------------------------------------------
runner.on('log', p => send('run:log', p));
runner.on('progress', p => send('run:progress', p));
runner.on('settlement', p => send('run:settlement', p));
runner.on('state', p => send('run:state', p));
runner.on('totp-request', p => send('run:totp-request', p));
// Live browser frames: base64 JPEG, several per second while a run is on.
runner.on('frame', p => send('run:frame', p));
runner.on('frame-end', p => send('run:frame-end', p));

// --- IPC ---------------------------------------------------------------------
ipcMain.handle('settings:get', () => settingsStore.read());
ipcMain.handle('settings:save', (_e, patch) => {
  const saved = settingsStore.write(patch || {});
  applyTheme(saved.theme);
  return saved;
});
// Adding one alias to the library from the New settlement page.
ipcMain.handle('settings:addAlias', (_e, alias) => settingsStore.addAlias(alias || {}));

ipcMain.handle('creds:status', () => credentials.status());
ipcMain.handle('creds:save', (_e, patch) => credentials.save(patch || {}));
ipcMain.handle('creds:importEnv', () => credentials.importFromDevEnv());

ipcMain.handle('inbox:scan', () => inbox.scan(settingsStore.read().receiptsInbox));

ipcMain.handle('dialog:pickDirectory', async (_e, { title, defaultPath } = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

// A settlement folder picked from anywhere on disk, not just the inbox.
ipcMain.handle('inbox:describe', (_e, folderPath) => inbox.describeFolder(folderPath));

// --- New settlement page -----------------------------------------------------
// propose() previews the folder name and draft name, expand() resolves dropped
// paths to documents, create() writes the folder the automation then reads.
ipcMain.handle('inbox:propose', (_e, payload) => inbox.propose(settingsStore.read().receiptsInbox, payload || {}));
ipcMain.handle('inbox:expand', (_e, paths) => inbox.expand(paths || []));
ipcMain.handle('inbox:create', (_e, payload) => inbox.create(settingsStore.read().receiptsInbox, payload || {}));

// Removing a saved settlement deletes real files, so the confirmation is a
// native dialog here rather than something the renderer could skip.
ipcMain.handle('inbox:remove', async (_e, folderPath) => {
  if (runner.busy) throw new Error('A settlement run is in progress — wait for it to finish.');
  const info = inbox.describeFolder(folderPath);
  const files = `${info.fileCount} receipt${info.fileCount === 1 ? '' : 's'}`;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Delete settlement'],
    defaultId: 0,
    cancelId: 0,
    message: `Delete the saved settlement “${info.settlementName || info.folder}”?`,
    detail:
      `Its inbox folder and the ${files} copied into it are deleted. The originals you dropped in are ` +
      'untouched, and so is any draft already created in indfak2 — delete that in indfak2 itself.',
  });
  if (response !== 1) return { removed: false, cancelled: true };
  return inbox.remove(settingsStore.read().receiptsInbox, folderPath);
});

ipcMain.handle('dialog:pickFiles', async (_e, { title, defaultPath } = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Choose receipts',
    defaultPath: defaultPath || undefined,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Receipts', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'heic'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

// A submitting run ends with the settlement in the approver's queue, which the
// app cannot take back — so the first one asks, with the usual "don't ask
// again" for people who always submit.
async function confirmSubmit(count) {
  const settings = settingsStore.read();
  if (settings.submitConfirmSuppressed) return true;
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Cancel', 'File and submit'],
    defaultId: 1,
    cancelId: 0,
    message: count === 1 ? 'Submit this settlement for approval?' : `Submit ${count} settlements for approval?`,
    detail:
      'Each settlement that files cleanly is sent on to your approver as soon as it is complete — ' +
      'not left as a draft to review. One that is missing a document stays a draft.',
    checkboxLabel: "Don't ask again",
    checkboxChecked: false,
  });
  if (response !== 1) return false;
  if (checkboxChecked) settingsStore.write({ submitConfirmSuppressed: true });
  return true;
}

ipcMain.handle('run:start', async (_e, payload) => {
  // Older shape (a bare array) still works; the app sends { settlements, options }.
  const settlements = Array.isArray(payload) ? payload : (payload && payload.settlements) || [];
  const options = (!Array.isArray(payload) && payload && payload.options) || {};
  if (options.submit && !(await confirmSubmit(settlements.length))) {
    return { ...runner.state(), cancelled: true };
  }
  await runner.start(settlements, options);
  return runner.state();
});
ipcMain.handle('run:cancel', () => {
  runner.cancel();
  return runner.state();
});
ipcMain.handle('run:state', () => runner.state());
ipcMain.handle('run:totp', (_e, code) => runner.submitTotp(code));

ipcMain.handle('browser:status', () => browsers.status());
ipcMain.handle('browser:install', async () => {
  await browsers.install(line => send('browser:progress', { line }));
  return browsers.status();
});

ipcMain.handle('manifest:read', (_e, manifestPath) => {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('shell:openPath', async (_e, target) => {
  if (!target) return 'No path';
  return shell.openPath(target);
});
ipcMain.handle('shell:revealPath', (_e, target) => {
  if (target) shell.showItemInFolder(target);
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  userData: app.getPath('userData'),
  appPath: app.getAppPath(),
}));

// --- lifecycle ---------------------------------------------------------------
app.whenReady().then(() => {
  // Before the window exists, so it opens already in the right appearance.
  applyTheme(settingsStore.read().theme);
  // Packaged builds get the icon from the bundle's .icns (electron-builder makes
  // it from build/icon.png); `npm run dev` would otherwise show Electron's own.
  if (!app.isPackaged && app.dock) {
    const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
    if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      { role: 'windowMenu' },
    ])
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  runner.cancel();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  runner.cancel();
});
