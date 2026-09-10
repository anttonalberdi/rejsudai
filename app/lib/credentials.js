'use strict';
// Credential storage.
//
// Secrets are encrypted with Electron's safeStorage, which on macOS wraps a key
// held in the login Keychain, and written to userData/credentials.enc. No .env
// is written or shipped. A .env sitting next to bot.js is still READ as a
// development fallback (and can be imported into the Keychain from Settings),
// so the plain CLI stays easy to run.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const KEYS = ['INDFAK_USERNAME', 'INDFAK_PASSWORD', 'TOTP_SECRET', 'ANTHROPIC_API_KEY'];
const FILE = () => path.join(app.getPath('userData'), 'credentials.enc');
const ENV_FILE = () => path.join(app.getAppPath(), '.env');

function readStore() {
  try {
    const buf = fs.readFileSync(FILE());
    if (!safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(buf));
  } catch {
    return {};
  }
}

function writeStore(obj) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('macOS Keychain is unavailable, so credentials cannot be stored securely.');
  }
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), safeStorage.encryptString(JSON.stringify(obj)), { mode: 0o600 });
}

// Minimal .env parser — enough for KEY=value lines with optional quotes.
function readDevEnv() {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(ENV_FILE(), 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) out[m[1]] = v;
  }
  return out;
}

// Keychain wins; .env fills the gaps. Returns the actual secret values —
// only ever used to build a child process env, never sent to the renderer.
function resolve() {
  const store = readStore();
  const dev = readDevEnv();
  const out = {};
  for (const k of KEYS) out[k] = store[k] || dev[k] || '';
  return out;
}

// What the renderer is allowed to know: whether each secret is set, and where
// it came from. Never the values themselves.
function status() {
  const store = readStore();
  const dev = readDevEnv();
  const out = {};
  for (const k of KEYS) {
    out[k] = store[k] ? 'keychain' : dev[k] ? 'dotenv' : 'missing';
  }
  out.envFileExists = fs.existsSync(ENV_FILE());
  out.encryptionAvailable = safeStorage.isEncryptionAvailable();
  return out;
}

// Saves only the keys present in `patch`. An empty string clears that key
// (falling back to .env, if any); undefined leaves it untouched.
function save(patch) {
  const store = readStore();
  for (const k of KEYS) {
    if (!(k in patch)) continue;
    const v = String(patch[k] ?? '').trim();
    if (v) store[k] = v;
    else delete store[k];
  }
  writeStore(store);
  return status();
}

function importFromDevEnv() {
  const dev = readDevEnv();
  const patch = {};
  for (const k of KEYS) if (dev[k]) patch[k] = dev[k];
  if (!Object.keys(patch).length) throw new Error('No credentials found in .env');
  return save(patch);
}

// Every secret value currently known, for redacting log output.
function secretValues() {
  return Object.values(resolve()).filter(v => v && v.length >= 6);
}

module.exports = { KEYS, resolve, status, save, importFromDevEnv, secretValues };
