'use strict';
// Inbox scanning — a pending settlement is a directory directly inside
// RECEIPTS_INBOX holding either receipts or the metadata file the app writes
// with them. The folder is named after the settlement; its alias and the name
// as it was typed live in that metadata file, which is also what bot.js reads.

const fs = require('fs');
const path = require('path');

const DOC_RE = /\.(pdf|png|jpe?g|heic)$/i;

// Mirrors SETTLEMENT_META / readSettlementMeta() in bot.js, so the list shows
// the name and alias the draft will actually get.
const META_FILE = '.rejsudai.json';

function nameFromFolder(folderName) {
  return folderName
    .replace(/_/g, ' ')
    .split(' ')
    .map(w => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function readMeta(folderPath) {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(folderPath, META_FILE), 'utf8'));
  } catch {
    meta = {};   // hand-made folder, or unreadable — the folder name stands in
  }
  const name = String((meta && meta.name) || '').trim();
  const alias = String((meta && meta.alias) || '').trim();
  return {
    alias: alias || null,
    settlementName: name || nameFromFolder(path.basename(folderPath)),
  };
}

function writeMeta(folderPath, { alias, name }) {
  fs.writeFileSync(
    path.join(folderPath, META_FILE),
    JSON.stringify({ name, alias }, null, 2)
  );
}

function describeFolder(folderPath) {
  const folder = path.basename(folderPath);
  const { alias, settlementName } = readMeta(folderPath);
  let files = [];
  try {
    files = fs.readdirSync(folderPath).filter(f => DOC_RE.test(f));
  } catch {}
  return {
    id: folderPath,
    folder,
    path: folderPath,
    alias,
    settlementName,
    fileCount: files.length,
    files: files.sort(),
  };
}

// A directory only counts as a settlement if the app filed it (it has the
// metadata file) or it holds documents — an unrelated folder someone left in
// the inbox is not listed as something to process.
function isSettlementFolder(folderPath) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath);
  } catch {
    return false;
  }
  return entries.includes(META_FILE) || entries.some(f => DOC_RE.test(f));
}

function scan(inboxPath) {
  let entries;
  try {
    entries = fs.readdirSync(inboxPath, { withFileTypes: true });
  } catch (err) {
    return { inbox: inboxPath, exists: false, error: err.message, settlements: [] };
  }
  const settlements = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => path.join(inboxPath, e.name))
    .filter(isSettlementFolder)
    .map(describeFolder)
    .sort((a, b) => a.folder.localeCompare(b.folder));
  return { inbox: inboxPath, exists: true, settlements };
}

// --- composing a new settlement ---------------------------------------------
// The app's "New settlement" page collects a name, an alias and a set of
// receipts; filing them means creating the folder bot.js expects, copying the
// documents in and writing the metadata beside them. slugify() only has to
// produce a usable directory name — the settlement name and the alias are
// carried by the metadata, not by the name of the folder.

// Only a guard against nonsense in an alias code — settings.js validates the
// alias library against the same rule.
const ALIAS_CODE_RE = /^[A-Za-z0-9._-]+$/;

function slugify(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip accents rather than dropping the letter
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function validate(alias, name) {
  const slug = slugify(name);
  if (!String(name || '').trim()) return { error: 'Give the settlement a name.' };
  if (!slug) return { error: 'The name needs at least one letter or digit.' };
  if (!String(alias || '').trim()) return { error: 'Enter the project alias.' };
  // Same rule settings.js validates the alias library against.
  if (!ALIAS_CODE_RE.test(alias.trim())) {
    return { error: 'The alias can only contain letters, digits, dots, dashes and underscores.' };
  }
  return { slug, alias: alias.trim(), name: String(name).trim() };
}

// What the folder would be called, and the name the draft would get — so the
// page can show both before anything is created.
function propose(inboxPath, { alias, name } = {}) {
  const checked = validate(alias, name);
  if (checked.error) return { ok: false, error: checked.error };
  const folder = checked.slug;
  const folderPath = path.join(inboxPath, folder);
  return {
    ok: true,
    folder,
    path: folderPath,
    alias: checked.alias,
    settlementName: checked.name,
    exists: fs.existsSync(folderPath),
  };
}

// Resolves dropped/picked paths to the documents inside them: files are kept if
// they are a readable document, directories contribute their documents (one
// level, the same depth runFolder() reads).
function expand(paths) {
  const files = [];
  const skipped = [];
  const seen = new Set();
  for (const target of paths || []) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      skipped.push({ name: path.basename(target), reason: 'not readable' });
      continue;
    }
    const candidates = stat.isDirectory()
      ? fs.readdirSync(target).sort().map(f => path.join(target, f)).filter(f => {
          try { return fs.statSync(f).isFile(); } catch { return false; }
        })
      : [target];
    for (const file of candidates) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!DOC_RE.test(file)) {
        // A folder full of other things shouldn't produce a wall of complaints.
        if (!stat.isDirectory()) skipped.push({ name: path.basename(file), reason: 'not a PDF, PNG, JPEG or HEIC' });
        continue;
      }
      files.push({ path: file, name: path.basename(file) });
    }
    if (stat.isDirectory() && !candidates.some(f => DOC_RE.test(f))) {
      skipped.push({ name: path.basename(target), reason: 'no documents inside' });
    }
  }
  return { files, skipped };
}

// fs.copyFileSync fails with ENOTSUP on SMB/virtiofs mounts — same reason
// bot.js copies by hand.
function copyInto(dir, src) {
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let dest = path.join(dir, base);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${stem}-${n}${ext}`);
  fs.writeFileSync(dest, fs.readFileSync(src));
  return dest;
}

// Creates the settlement folder and copies the documents in. Originals are left
// where they are: bot.js moves processed files to CLAIMS_OUTPUT and deletes the
// inbox folder, which should never consume the user's own copy.
function create(inboxPath, { alias, name, files } = {}) {
  const plan = propose(inboxPath, { alias, name });
  if (!plan.ok) throw new Error(plan.error);
  if (plan.exists) {
    throw new Error(`A settlement folder named "${plan.folder}" already exists in the inbox. Use a different name, or process the pending one.`);
  }

  // Never trust the renderer's list: re-resolve it against the disk.
  const resolved = expand(files || []).files;
  if (!resolved.length) throw new Error('Add at least one receipt (PDF, PNG, JPEG or HEIC).');

  fs.mkdirSync(plan.path, { recursive: true });
  try {
    // The metadata goes in first: a folder that exists without it would be read
    // back as a hand-made one, on the default alias.
    writeMeta(plan.path, { alias: plan.alias, name: plan.settlementName });
    for (const file of resolved) copyInto(plan.path, file.path);
  } catch (err) {
    // A half-copied folder would file as a partial settlement — undo it.
    fs.rmSync(plan.path, { recursive: true, force: true });
    throw new Error(`Could not copy the receipts: ${err.message}`);
  }
  return describeFolder(plan.path);
}

// --- removing a saved settlement --------------------------------------------
// A settlement that was saved but not filed (or one left behind by a run) is
// just its inbox folder, so removing it means deleting that folder and the
// receipts copied into it. The renderer names the target, so the path is
// re-checked here rather than trusted: only a directory sitting *directly*
// inside the inbox qualifies. Symlinks are resolved first, so a link inside the
// inbox pointing elsewhere fails the check instead of taking the real folder
// with it.
function remove(inboxPath, folderPath) {
  if (!folderPath) throw new Error('No settlement folder given.');
  // realpath, so a "/var/..." path and its "/private/var/..." twin compare
  // equal — and on the *parent*, which still exists when the folder itself is
  // already gone.
  const real = target => {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  };
  const target = path.resolve(folderPath);
  const parent = real(path.dirname(target));
  if (parent !== real(inboxPath) || path.dirname(target) === target) {
    throw new Error('Only a settlement folder inside the receipts inbox can be removed.');
  }
  const full = path.join(parent, path.basename(target));

  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    // Already gone — the caller wanted it gone, so that is a success.
    return { removed: false, missing: true, path: folderPath };
  }
  // A symlink is not a settlement folder, and deleting through one would reach
  // outside the inbox.
  if (stat.isSymbolicLink()) throw new Error('That is a link, not a settlement folder.');
  if (!stat.isDirectory()) throw new Error('That is a file, not a settlement folder.');

  const described = describeFolder(full);
  fs.rmSync(full, { recursive: true, force: true });
  return { removed: true, missing: false, ...described };
}

module.exports = { scan, describeFolder, readMeta, propose, expand, create, remove, slugify, META_FILE };
