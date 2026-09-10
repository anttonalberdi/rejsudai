'use strict';
// Non-secret settings, stored as JSON in the app's userData dir.
// Secrets never live here — see credentials.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

// bot.js has its own defaults baked in, but they point at the Linux VM this
// automation used to run in. The app always passes explicit values, so these
// are what a fresh install starts from.
const DEFAULTS = {
  receiptsInbox: path.join(os.homedir(), 'claude_vm', 'receipts-inbox'),
  claimsOutput: path.join(os.homedir(), 'claude_vm', 'claims-output'),
  expenseAlias: '1240351001',
  expenseAliasOption: '1240351001 - InsituMicroSeq/Villum/ salary and run',
  expenseType: '1 -Settlement',
  expensePurpose: '2 - Outside Denmark',
  corporateCard:
    'SEB Eurocard (a Mastercard) — and the SEB Rejsekonto corporate travel account, which travel-agency invoices (e.g. CWT) are charged to (card references like "DC 3614...")',
  headless: false,
};

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  // Only keys we know about; ignore anything the renderer invents.
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) clean[k] = next[k];
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(clean, null, 2));
  return clean;
}

module.exports = { read, write, DEFAULTS };
