'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');

const settingsStore = require('./lib/settings');
const credentials = require('./lib/credentials');
const inbox = require('./lib/inbox');
const browsers = require('./lib/browsers');
const runner = require('./lib/runner');
const { spawnNode } = require('./lib/node-child');

let win = null;
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'Rejsud',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f6f6f8',
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

// --- IPC ---------------------------------------------------------------------
ipcMain.handle('settings:get', () => settingsStore.read());
ipcMain.handle('settings:save', (_e, patch) => settingsStore.write(patch || {}));

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

ipcMain.handle('run:start', async (_e, settlements) => {
  await runner.start(settlements || []);
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

// Optional cleanup helper for drafts left behind by a crashed run.
ipcMain.handle('draft:delete', async (_e, namePattern) => {
  if (runner.busy) throw new Error('A settlement run is in progress — wait for it to finish.');
  if (!namePattern || !namePattern.trim()) throw new Error('Enter part of the draft name.');

  const creds = credentials.resolve();
  const missing = credentials.KEYS.filter(k => k !== 'ANTHROPIC_API_KEY' && !creds[k]);
  if (missing.length) throw new Error(`Missing credentials: ${missing.join(', ')}`);

  const settings = settingsStore.read();
  const browsersPath = await browsers.resolvePath();
  const secrets = credentials.secretValues();
  const redact = t => secrets.reduce((acc, s) => acc.split(s).join('«redacted»'), t);

  return new Promise((resolve, reject) => {
    const child = spawnNode('delete-draft.js', [namePattern.trim()], {
      ...creds,
      REJSUD_GUI: '1',
      REJSUD_HEADLESS: settings.headless ? '1' : '0',
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    });
    let out = '';
    const collect = d => {
      const text = redact(d.toString());
      out += text;
      send('run:log', { settlementId: null, stream: 'stdout', text });
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', code =>
      code === 0 ? resolve(out) : reject(new Error(out.trim().split('\n').pop() || `Exited with code ${code}`))
    );
  });
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  userData: app.getPath('userData'),
  appPath: app.getAppPath(),
}));

// --- lifecycle ---------------------------------------------------------------
app.whenReady().then(() => {
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
