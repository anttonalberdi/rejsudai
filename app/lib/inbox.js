'use strict';
// Inbox scanning — the same rule run-pending.sh uses: any directory directly
// inside RECEIPTS_INBOX whose name contains a "-" is a pending settlement,
// named <alias>-<name_with_underscores>.

const fs = require('fs');
const path = require('path');

const DOC_RE = /\.(pdf|png|jpe?g|heic)$/i;

// Mirrors parseFolderName() in bot.js so the list shows the same name the
// draft will get.
function parseFolderName(folderName) {
  const dashIdx = folderName.indexOf('-');
  if (dashIdx < 0) return { alias: null, settlementName: folderName.replace(/_/g, ' ') };
  const alias = folderName.slice(0, dashIdx);
  const raw = folderName.slice(dashIdx + 1).replace(/_/g, ' ');
  const settlementName = raw
    .split(' ')
    .map(w => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
  return { alias, settlementName };
}

function describeFolder(folderPath) {
  const folder = path.basename(folderPath);
  const { alias, settlementName } = parseFolderName(folder);
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

function scan(inboxPath) {
  let entries;
  try {
    entries = fs.readdirSync(inboxPath, { withFileTypes: true });
  } catch (err) {
    return { inbox: inboxPath, exists: false, error: err.message, settlements: [] };
  }
  const settlements = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name.includes('-'))
    .map(e => describeFolder(path.join(inboxPath, e.name)))
    .sort((a, b) => a.folder.localeCompare(b.folder));
  return { inbox: inboxPath, exists: true, settlements };
}

module.exports = { scan, describeFolder, parseFolderName };
