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
  receiptsInbox: path.join(os.homedir(), 'Rejsudai', 'receipts-inbox'),
  claimsOutput: path.join(os.homedir(), 'Rejsudai', 'claims-output'),
  // The alias library: [{ name, code }]. expenseAlias names the entry the
  // New settlement page starts on. Seeded on first read — see read().
  aliases: [],
  // Set the first time settings are written, so the seeding below happens once
  // and an emptied library stays empty.
  aliasesSeeded: false,
  // Each installation starts without an alias. Add one on the Aliases tab;
  // a project code must never be distributed as an application default.
  expenseAlias: '',
  expenseAliasOption: '',
  expenseType: '1 -Settlement',
  expensePurpose: '2 - Outside Denmark',
  corporateCard:
    'SEB Eurocard (a Mastercard) — and the SEB Rejsekonto corporate travel account, which travel-agency invoices (e.g. CWT) are charged to (card references like "DC 3614...")',
  headless: false,
  // 'auto' follows the system appearance; 'light'/'dark' pin it. Applied to
  // nativeTheme in main.js (window chrome, native dialogs) and to the
  // documentElement in the renderer (the CSS tokens).
  theme: 'auto',
  // Whether a run sends its settlements on for approval instead of leaving them
  // as drafts. Remembered between runs, but always visible (and changeable) on
  // the run toolbar before pressing Process.
  submitAfterFiling: false,
  // Ticked "Don't ask again" in the confirmation that precedes a submitting run.
  submitConfirmSuppressed: false,
  // Where the run view's two draggable splitters sit, as a percentage of the
  // window: the settlement list's width, and the browser pane's share of the
  // right-hand column.
  layout: { listPct: 52, browserPct: 50 },
};

const THEMES = ['auto', 'light', 'dark'];

// A splitter is only ever dragged within these bounds, but the file is editable
// by hand — a nonsense value would otherwise leave a panel invisible.
const LAYOUT_MIN = 15;
const LAYOUT_MAX = 85;

function normalizeLayout(layout) {
  const clamp = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(LAYOUT_MAX, Math.max(LAYOUT_MIN, Math.round(n * 10) / 10));
  };
  return {
    listPct: clamp(layout && layout.listPct, DEFAULTS.layout.listPct),
    browserPct: clamp(layout && layout.browserPct, DEFAULTS.layout.browserPct),
  };
}

// A guard against nonsense in an alias code, nothing more — the same rule
// inbox.js validates a typed alias against.
const ALIAS_CODE_RE = /^[A-Za-z0-9._-]+$/;

// Lenient when reading a settings file (a bad entry is dropped rather than
// breaking the app), strict when writing one (the renderer gets told why).
function normalizeAliases(list, { strict = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const name = String((entry && entry.name) || '').trim();
    const code = String((entry && entry.code) || '').trim();
    if (!code) {
      if (strict) throw new Error(`Give the alias "${name}" its code, or remove the row.`);
      continue;
    }
    if (!ALIAS_CODE_RE.test(code)) {
      if (strict) {
        throw new Error(`"${code}" is not a valid alias code — letters, digits, dots, dashes and underscores only.`);
      }
      continue;
    }
    if (seen.has(code)) {
      if (strict) throw new Error(`The alias code ${code} is in the list twice.`);
      continue;
    }
    seen.add(code);
    out.push({ name: name || code, code });
  }
  return out;
}

// "project-code - Project/funder description" → the part after the code,
// which is the closest thing an install from before the library has to a name.
function nameFromOption(option) {
  const m = /^\s*[A-Za-z0-9._]+\s*-\s*(.+)$/.exec(String(option || ''));
  return m ? m[1].trim() : '';
}

function read() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    raw = {};
  }
  const merged = { ...DEFAULTS, ...raw };
  merged.aliases = normalizeAliases(merged.aliases);
  merged.layout = normalizeLayout(merged.layout);
  if (!THEMES.includes(merged.theme)) merged.theme = DEFAULTS.theme;
  // Installs from before the alias library kept their one alias in
  // expenseAlias/expenseAliasOption; carry it in so a first run has something
  // in the dropdown. Only until the first write, or emptying the library
  // deliberately would keep undoing itself.
  if (!merged.aliasesSeeded && !merged.aliases.length && merged.expenseAlias) {
    merged.aliases = normalizeAliases([
      { name: nameFromOption(merged.expenseAliasOption), code: merged.expenseAlias },
    ]);
  }
  return merged;
}

function write(patch) {
  const next = { ...read(), ...(patch || {}) };
  next.aliases = normalizeAliases(next.aliases, { strict: !!(patch && 'aliases' in patch) });
  next.layout = normalizeLayout(next.layout);
  if (!THEMES.includes(next.theme)) next.theme = DEFAULTS.theme;
  next.aliasesSeeded = true;
  // expenseAlias points into the library, so it has to name an entry that is
  // actually there (it stays as typed only while the library is empty).
  if (next.aliases.length && !next.aliases.some(a => a.code === next.expenseAlias)) {
    next.expenseAlias = next.aliases[0].code;
  }
  // Only keys we know about; ignore anything the renderer invents.
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) clean[k] = next[k];
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(clean, null, 2));
  return clean;
}

// Adding one alias from the New settlement page, where the rest of the library
// is not on screen — a read-modify-write there could clobber a Settings edit.
// A code already in the library is returned as-is rather than being an error:
// the caller wants that alias selected either way.
function addAlias(entry) {
  const [alias] = normalizeAliases([entry], { strict: true });
  const current = read();
  const existing = current.aliases.find(a => a.code === alias.code);
  if (existing) return { settings: current, alias: existing, added: false };
  return { settings: write({ aliases: [...current.aliases, alias] }), alias, added: true };
}

module.exports = { read, write, addAlias, DEFAULTS, ALIAS_CODE_RE, THEMES };
