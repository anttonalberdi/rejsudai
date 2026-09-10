'use strict';
// Playwright Chromium management.
//
// Chromium (~150 MB) is not bundled in the .dmg. Resolution order:
//   1. the app's own copy in userData/playwright-browsers
//   2. Playwright's standard shared cache (~/Library/Caches/ms-playwright) —
//      reused as-is if a matching build is already there, so users who have
//      ever run `playwright install` never download it twice
//   3. otherwise: nothing installed yet; the app offers to download into (1)
// Whichever path wins is passed to every child process as
// PLAYWRIGHT_BROWSERS_PATH, so bot.js always finds the same browser.

const os = require('os');
const path = require('path');
const { app } = require('electron');
const { spawnNode } = require('./node-child');

const appBrowsersPath = () => path.join(app.getPath('userData'), 'playwright-browsers');
const sharedBrowsersPath = () => path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');

function probe(browsersPath) {
  return new Promise(resolve => {
    const child = spawnNode('app/lib/browser-probe.js', [], { PLAYWRIGHT_BROWSERS_PATH: browsersPath });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('error', () => resolve({ exists: false }));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ exists: false });
      }
    });
  });
}

// { installed, browsersPath, executable, source }
async function status() {
  for (const [source, dir] of [['app', appBrowsersPath()], ['shared', sharedBrowsersPath()]]) {
    const res = await probe(dir);
    if (res.exists) return { installed: true, browsersPath: dir, executable: res.executable, source };
  }
  return { installed: false, browsersPath: appBrowsersPath(), executable: null, source: 'app' };
}

// Resolves to the directory child processes should use. Never throws — if
// nothing is installed, bot.js will fail with Playwright's own clear message.
async function resolvePath() {
  return (await status()).browsersPath;
}

// Downloads Chromium into the app's own browsers dir. `onLine` receives
// progress output for the UI.
function install(onLine) {
  return new Promise((resolve, reject) => {
    const dir = appBrowsersPath();
    const child = spawnNode('node_modules/playwright/cli.js', ['install', 'chromium'], {
      PLAYWRIGHT_BROWSERS_PATH: dir,
    });
    const pipe = stream => {
      let buf = '';
      stream.on('data', d => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) if (l.trim()) onLine(l);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(dir);
      else reject(new Error(`Chromium download failed (exit code ${code}).`));
    });
  });
}

module.exports = { status, resolvePath, install, appBrowsersPath, sharedBrowsersPath };
