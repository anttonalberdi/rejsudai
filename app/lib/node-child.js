'use strict';
// Spawns a plain Node process using Electron's own bundled Node runtime
// (ELECTRON_RUN_AS_NODE=1), so the app has no dependency on a system Node
// install. This is the single place child processes are created.

const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');

// In dev this is the repo root; in the packaged app, Contents/Resources/app.
// bot.js and its node_modules live there in both cases (the build sets
// asar:false precisely because this child is plain Node, which cannot read
// files inside an asar archive).
const appRoot = () => app.getAppPath();

// `ipc: true` adds Node's IPC channel as a fourth stdio slot, giving the child
// a process.send() for structured payloads that would swamp the log — only the
// live browser frames use it. Left off elsewhere so nothing else changes.
function spawnNode(scriptRelPath, args, extraEnv = {}, { ipc = false } = {}) {
  const script = path.join(appRoot(), scriptRelPath);
  return spawn(process.execPath, [script, ...args], {
    cwd: appRoot(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // Keep Electron's own switches out of the child's argv handling.
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      ...extraEnv,
    },
    stdio: ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
  });
}

module.exports = { spawnNode, appRoot };
