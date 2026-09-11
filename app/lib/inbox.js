'use strict';
// Settlement folders. Each settlement is one directory directly inside
// RECEIPTS_INBOX, kept for as long as the settlement exists:
//
//   .rejsudai.json   its name as typed and its alias (written here)
//   input/           receipts waiting to be filed
//   processed/       receipts already in the indfak2 draft (moved there by bot.js)
//   manifest.json    bot.js's record of what is filed where
//
// Adding receipts to a settlement puts them in input/; running it again files
// them into the same draft. A folder made by hand, with its receipts loose
// inside, is read the same way bot.js reads it: loose documents are input.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOC_RE = /\.(pdf|png|jpe?g|heic)$/i;

// Mirror SETTLEMENT_META / INPUT_DIR / PROCESSED_DIR / RECORD_FILE in bot.js.
const META_FILE = '.rejsudai.json';
const INPUT_DIR = 'input';
const PROCESSED_DIR = 'processed';
const RECORD_FILE = 'manifest.json';

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

// Document names directly inside `dir`, the way bot.js lists them: dot-files
// are skipped, since macOS leaves "._x.pdf" shadow files on network volumes.
function listDocs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.') && DOC_RE.test(e.name))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

// What the list needs from bot.js's record — enough to show where the
// settlement stands. The full record is read only when its Details are opened.
function readRecord(folderPath) {
  const file = path.join(folderPath, RECORD_FILE);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { path: file, unreadable: true, error: err.message };
  }
  const s = (record && record.settlement) || {};
  const filed = [...(record.invoices || []), ...(record.supporting_documents || [])]
    .filter(e => e && e.moved_to_output)
    .map(e => e.file);
  return {
    path: file,
    draftName: s.draft_name || null,
    settlementNumber: s.settlement_number || null,
    submitted: !!(s.submit && s.submit.submitted),
    status: s.status || null,
    filed,
    updatedAt: record.updated_at || record.run_at || null,
  };
}

function describeFolder(folderPath) {
  const folder = path.basename(folderPath);
  const { alias, settlementName } = readMeta(folderPath);
  // Waiting to be filed: input/, plus anything loose in a hand-made folder.
  const files = [...listDocs(path.join(folderPath, INPUT_DIR)), ...listDocs(folderPath)];
  const processed = listDocs(path.join(folderPath, PROCESSED_DIR));
  const record = readRecord(folderPath);
  return {
    id: folderPath,
    folder,
    path: folderPath,
    alias,
    settlementName,
    fileCount: files.length,
    files,
    processedCount: processed.length,
    processed,
    record,
    manifestPath: record ? record.path : null,
  };
}

// A directory only counts as a settlement if the app filed it (it has the
// metadata file), bot.js has worked on it, or it holds documents — an
// unrelated folder someone left in the inbox is not listed.
function isSettlementFolder(folderPath) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath);
  } catch {
    return false;
  }
  return entries.includes(META_FILE)
    || entries.includes(RECORD_FILE)
    || entries.includes(INPUT_DIR)
    || entries.includes(PROCESSED_DIR)
    || entries.some(f => DOC_RE.test(f) && !f.startsWith('.'));
}

// The inbox is the app's own working folder, not a path the user points at —
// Settings has no field for it, because settlements are composed in the app and
// written here. So a missing one is just a fresh install (or a folder someone
// tidied away): create it and carry on. Only a path that cannot be created or
// read — a removed volume, a permission problem — is reported as a failure.
function scan(inboxPath) {
  let entries;
  try {
    entries = fs.readdirSync(inboxPath, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return { inbox: inboxPath, exists: false, error: err.message, settlements: [] };
    }
    try {
      fs.mkdirSync(inboxPath, { recursive: true });
      entries = fs.readdirSync(inboxPath, { withFileTypes: true });
    } catch (createErr) {
      return { inbox: inboxPath, exists: false, error: createErr.message, settlements: [] };
    }
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
// documents into its input/ and writing the metadata beside them. slugify()
// only has to produce a usable directory name — the settlement name and the
// alias are carried by the metadata, not by the name of the folder.

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
      if (!DOC_RE.test(file) || path.basename(file).startsWith('.')) {
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

// Every name a new document must not take in this settlement: whatever is in
// input/, processed/ or loose in the folder, and everything the record says is
// filed. A document's name is its identity in the record, so two receipts with
// one name would share an entry.
function takenNames(folderPath, record) {
  return new Set([
    ...listDocs(path.join(folderPath, INPUT_DIR)),
    ...listDocs(path.join(folderPath, PROCESSED_DIR)),
    ...listDocs(folderPath),
    ...((record && record.filed) || []),
  ]);
}

// fs.copyFileSync fails with ENOTSUP on SMB/virtiofs mounts — same reason
// bot.js copies by hand.
function copyInto(dir, src, taken) {
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`;
  taken.add(name);
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, fs.readFileSync(src));
  return dest;
}

// Creates the settlement folder and copies the documents into its input/.
// Originals are left where they are: bot.js moves what it files from input/ to
// processed/, and that must never consume the user's own copy.
function create(inboxPath, { alias, name, files } = {}) {
  const plan = propose(inboxPath, { alias, name });
  if (!plan.ok) throw new Error(plan.error);
  if (plan.exists) {
    throw new Error(`A settlement folder named "${plan.folder}" already exists. Use a different name, or add the receipts to that settlement from the list.`);
  }

  // Never trust the renderer's list: re-resolve it against the disk.
  const resolved = expand(files || []).files;
  if (!resolved.length) throw new Error('Add at least one receipt (PDF, PNG, JPEG or HEIC).');

  fs.mkdirSync(plan.path, { recursive: true });
  try {
    // The metadata goes in first: a folder that exists without it would be read
    // back as a hand-made one, on the default alias.
    writeMeta(plan.path, { alias: plan.alias, name: plan.settlementName });
    const input = path.join(plan.path, INPUT_DIR);
    fs.mkdirSync(input);
    const taken = new Set();
    for (const file of resolved) copyInto(input, file.path, taken);
  } catch (err) {
    // A half-copied folder would file as a partial settlement — undo it.
    fs.rmSync(plan.path, { recursive: true, force: true });
    throw new Error(`Could not copy the receipts: ${err.message}`);
  }
  return describeFolder(plan.path);
}

// The renderer names the settlement, so its path is re-checked rather than
// trusted: only a directory sitting *directly* inside the inbox qualifies.
// Symlinks are resolved first, so a link inside the inbox pointing elsewhere
// fails the check instead of reaching through it. Returns the real path, or
// null when the folder is already gone.
function settlementDir(inboxPath, folderPath) {
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
    throw new Error('Only a settlement folder inside the receipts inbox can be changed from here.');
  }
  const full = path.join(parent, path.basename(target));

  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return null;
  }
  // A symlink is not a settlement folder, and following one would reach
  // outside the inbox.
  if (stat.isSymbolicLink()) throw new Error('That is a link, not a settlement folder.');
  if (!stat.isDirectory()) throw new Error('That is a file, not a settlement folder.');
  return full;
}

const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// --- adding receipts to a settlement ----------------------------------------
// The way a settlement is continued: new receipts go into its input/, and the
// next run files them into the same draft. A receipt identical to one already
// in the settlement — filed or waiting — is turned away here, where saying so
// is easy, rather than left for the run to recognise as a duplicate.
function addFiles(inboxPath, folderPath, files) {
  const dir = settlementDir(inboxPath, folderPath);
  if (!dir) throw new Error('That settlement folder is gone.');
  const record = readRecord(dir);
  if (record && record.unreadable) {
    throw new Error(`This settlement's record (${RECORD_FILE}) cannot be read, so nothing can be added to it: ${record.error}`);
  }
  if (record && record.submitted) {
    throw new Error('This settlement has already been sent for approval. File the new receipts as a settlement of their own.');
  }

  const { files: found, skipped } = expand(files || []);
  const input = path.join(dir, INPUT_DIR);
  const known = new Map();
  for (const [sub, names] of [
    [INPUT_DIR, listDocs(input)],
    [PROCESSED_DIR, listDocs(path.join(dir, PROCESSED_DIR))],
    ['', listDocs(dir)],
  ]) {
    for (const name of names) {
      try {
        known.set(fileHash(path.join(dir, sub, name)), name);
      } catch {}
    }
  }

  const taken = takenNames(dir, record);
  const added = [];
  fs.mkdirSync(input, { recursive: true });
  for (const file of found) {
    let hash;
    try {
      hash = fileHash(file.path);
    } catch {
      skipped.push({ name: file.name, reason: 'not readable' });
      continue;
    }
    if (known.has(hash)) {
      skipped.push({ name: file.name, reason: `already in this settlement as ${known.get(hash)}` });
      continue;
    }
    const dest = copyInto(input, file.path, taken);
    known.set(hash, path.basename(dest));
    added.push(path.basename(dest));
  }
  return { settlement: describeFolder(dir), added, skipped };
}

// --- removing a settlement ---------------------------------------------------
// A settlement is its folder, so removing it means deleting that folder: the
// receipts copied into it, filed or not, and the record of what was filed.
// Nothing in indfak2 is touched.
function remove(inboxPath, folderPath) {
  const full = settlementDir(inboxPath, folderPath);
  // Already gone — the caller wanted it gone, so that is a success.
  if (!full) return { removed: false, missing: true, path: folderPath };
  const described = describeFolder(full);
  fs.rmSync(full, { recursive: true, force: true });
  return { removed: true, missing: false, ...described };
}

module.exports = {
  scan, describeFolder, readMeta, propose, expand, create, addFiles, remove, slugify,
  META_FILE, INPUT_DIR, PROCESSED_DIR, RECORD_FILE,
};
