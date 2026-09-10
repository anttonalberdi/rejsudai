'use strict';
/* Renderer. No Node access — everything goes through window.rejsud (preload). */

const $ = sel => document.querySelector(sel);
// Electron wraps rejected IPC handlers as "Error invoking remote method 'x': Error: real message".
const clean = err => String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// id -> { ...settlement, status, error, manifestPath, outputFolder, manifest, selected }
const items = new Map();
let running = false;

/* ---------------------------------------------------------------- views -- */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t === tab));
    $('#view-run').hidden = tab.dataset.view !== 'run';
    $('#view-settings').hidden = tab.dataset.view !== 'settings';
    if (tab.dataset.view === 'settings') refreshBrowserStatus();
  });
});

/* ------------------------------------------------------------------ log -- */
const logEl = $('#log');
function appendLog(text, stream) {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  const span = el('span', stream === 'stderr' ? 'l-err' : stream === 'app' ? 'l-app' : null, text);
  logEl.appendChild(span);
  // Keep the pane from growing without bound over a long batch.
  while (logEl.childNodes.length > 4000) logEl.removeChild(logEl.firstChild);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
$('#btn-clear-log').addEventListener('click', () => (logEl.textContent = ''));

/* ------------------------------------------------------------ list view -- */
function statusLabel(s) {
  return { queued: 'Queued', running: 'Running', done: 'Done', error: 'Failed', cancelled: 'Cancelled' }[s] || 'Ready';
}

function render() {
  const list = $('#settlement-list');
  list.textContent = '';
  const all = [...items.values()];
  $('#empty-state').hidden = all.length > 0;

  for (const item of all) {
    const li = el('li', 'settlement');
    if (item.status) li.classList.add(`is-${item.status}`);

    const box = el('input');
    box.type = 'checkbox';
    box.checked = !!item.selected;
    box.disabled = running;
    box.addEventListener('change', () => {
      item.selected = box.checked;
      syncSelection();
    });
    li.appendChild(box);

    const main = el('div', 'settlement-main');
    main.appendChild(el('div', 'settlement-name', item.settlementName || item.folder));
    const bits = [];
    if (item.alias) bits.push(`alias ${item.alias}`);
    bits.push(`${item.fileCount} file${item.fileCount === 1 ? '' : 's'}`);
    bits.push(item.folder);
    main.appendChild(el('div', 'settlement-meta', bits.join(' · ')));

    if (item.error) main.appendChild(el('div', 'settlement-error', item.error));

    if (item.manifest || item.outputFolder) {
      const actions = el('div', 'settlement-actions');
      if (item.manifest) {
        const b = el('button', 'btn btn-quiet', 'Details');
        b.addEventListener('click', () => showResult(item));
        actions.appendChild(b);
      }
      if (item.outputFolder) {
        const b = el('button', 'btn btn-quiet', 'Open output folder');
        b.addEventListener('click', () => window.rejsud.shell.openPath(item.outputFolder));
        actions.appendChild(b);
      }
      if (item.manifestPath) {
        const b = el('button', 'btn btn-quiet', 'manifest.json');
        b.addEventListener('click', () => window.rejsud.shell.openPath(item.manifestPath));
        actions.appendChild(b);
      }
      main.appendChild(actions);
    }
    li.appendChild(main);

    const status = el('span', 'status', statusLabel(item.status));
    if (item.status) status.dataset.status = item.status;
    li.appendChild(status);
    list.appendChild(li);
  }
  syncSelection();
}

function selected() {
  return [...items.values()].filter(i => i.selected);
}

function syncSelection() {
  const sel = selected();
  const all = [...items.values()];
  $('#selection-summary').textContent = sel.length
    ? `${sel.length} of ${all.length} selected`
    : all.length
      ? 'Nothing selected'
      : 'Nothing to process';
  $('#select-all').checked = all.length > 0 && sel.length === all.length;
  $('#select-all').disabled = running || all.length === 0;
  $('#btn-process').disabled = running || sel.length === 0;
  $('#btn-process').textContent = sel.length > 1 ? `Process ${sel.length} settlements` : 'Process';
}

$('#select-all').addEventListener('change', e => {
  for (const item of items.values()) item.selected = e.target.checked;
  render();
});

async function scanInbox() {
  const res = await window.rejsud.inbox.scan();
  $('#inbox-path').textContent = res.inbox;
  $('#inbox-error').hidden = res.exists;
  if (!res.exists) {
    $('#inbox-error').textContent = `Inbox folder not found: ${res.inbox} — set it in Settings.`;
  }
  const previous = new Map(items);
  items.clear();
  for (const s of res.settlements) {
    const before = previous.get(s.id);
    // A folder that is still on disk after a failed run keeps its result, but
    // its file count is refreshed — processed files have already been moved out.
    items.set(s.id, before && (before.status === 'done' || before.status === 'error')
      ? { ...before, ...s, manual: before.manual, selected: false, status: before.status }
      : { ...s, manual: before ? before.manual : false, selected: true, status: 'queued' });
  }
  // Folders the user added by hand, and finished settlements whose folder bot.js
  // has already deleted, stay listed so their results remain reachable.
  for (const [id, item] of previous) {
    if (items.has(id)) continue;
    if (item.manual || item.status === 'done' || item.status === 'error') items.set(id, { ...item, selected: false });
  }
  render();
}

$('#btn-rescan').addEventListener('click', scanInbox);

$('#btn-add-folder').addEventListener('click', async () => {
  const dir = await window.rejsud.dialog.pickDirectory({ title: 'Choose a settlement folder' });
  if (!dir) return;
  const info = await window.rejsud.inbox.describe(dir);
  items.set(info.id, { ...info, manual: true, selected: true, status: 'queued' });
  render();
});

/* -------------------------------------------------------------- running -- */
$('#btn-process').addEventListener('click', async () => {
  const targets = selected();
  if (!targets.length) return;
  for (const t of targets) {
    t.status = 'queued';
    t.error = null;
    t.manifest = null;
    t.manifestPath = null;
    t.outputFolder = null;
  }
  render();
  try {
    await window.rejsud.run.start(targets.map(t => ({ id: t.id, path: t.path, folder: t.folder })));
  } catch (err) {
    appendLog(`\n${clean(err)}\n`, 'stderr');
    alertMsg(clean(err));
  }
});

$('#btn-cancel').addEventListener('click', () => {
  window.rejsud.run.cancel();
  appendLog('\nStopping. The current settlement is being cut short — its indfak2 draft may be left half-filled; review it, or remove it with "Delete a draft" in Settings.\n', 'app');
});

let wasRunning = false;
function setRunning(state) {
  running = state.busy;
  // A finished batch changes the inbox: processed folders are gone, partly
  // processed ones have fewer files left.
  if (wasRunning && !running) scanInbox();
  wasRunning = running;
  $('#btn-cancel').hidden = !running;
  $('#btn-rescan').disabled = running;
  $('#btn-add-folder').disabled = running;
  if (!running) $('#phase-label').textContent = '';
  render();
}

window.rejsud.onLog(({ text, stream }) => appendLog(text, stream));
window.rejsud.onRunState(setRunning);

window.rejsud.onProgress(p => {
  if (p.event === 'phase') {
    $('#phase-label').textContent =
      { parsing: `Reading documents…`, planning: 'Planning settlement…', filing: 'Filing into indfak2…' }[p.phase] || '';
  }
  if (p.event === 'progress') {
    const what = p.phase === 'parsing' ? 'Reading' : 'Filing';
    $('#phase-label').textContent = `${what} ${p.index}/${p.total} · ${p.file}`;
  }
});

window.rejsud.onSettlement(async p => {
  const item = items.get(p.id);
  if (!item) return;
  item.status = p.status;
  item.error = p.error || null;
  if (p.manifestPath) item.manifestPath = p.manifestPath;
  if (p.outputFolder) item.outputFolder = p.outputFolder;
  if (p.manifest) item.manifest = p.manifest;
  if (p.status !== 'running') item.selected = false;
  render();
});

/* ------------------------------------------------------------ TOTP modal -- */
window.rejsud.onTotpRequest(() => {
  $('#totp-modal').hidden = false;
  $('#totp-input').value = '';
  $('#totp-input').focus();
});
$('#totp-ok').addEventListener('click', () => {
  const code = $('#totp-input').value.trim();
  if (!code) return;
  window.rejsud.run.submitTotp(code);
  $('#totp-modal').hidden = true;
});
$('#totp-cancel').addEventListener('click', () => {
  window.rejsud.run.submitTotp('');
  $('#totp-modal').hidden = true;
});
$('#totp-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#totp-ok').click();
});

/* ---------------------------------------------------------- result modal -- */
function showResult(item) {
  const m = item.manifest;
  $('#result-title').textContent = item.settlementName || item.folder;
  const body = $('#result-body');
  body.textContent = '';

  if (!m || !m.settlement) {
    body.appendChild(el('p', 'subtle', 'No manifest was written for this run.'));
  } else {
    const s = m.settlement;
    const tallies = el('div', 'tallies');
    const tally = (n, label) => {
      const wrap = el('div');
      wrap.appendChild(el('span', 'tally-n', String(n)));
      wrap.appendChild(el('span', 'tally-l', label));
      return wrap;
    };
    tallies.appendChild(tally(s.expenses_card ?? 0, 'card lines'));
    tallies.appendChild(tally(s.expenses_normal_cost ?? 0, 'normal cost'));
    tallies.appendChild(tally(s.expenses_unprocessed ?? 0, 'unprocessed'));
    body.appendChild(tallies);

    const meta = el('p', 'subtle');
    meta.textContent = `Draft "${s.draft_name}"${s.settlement_number ? ` · no. ${s.settlement_number}` : ''} · ${s.status}`;
    body.appendChild(meta);

    const table = el('table');
    const head = el('tr');
    for (const h of ['Document', 'Role', 'Filed as', 'Notes']) head.appendChild(el('th', null, h));
    table.appendChild(head);
    for (const inv of m.invoices || []) {
      const tr = el('tr');
      if (inv.errors && inv.errors.length) tr.className = 'result-row-err';
      tr.appendChild(el('td', null, inv.file));
      tr.appendChild(el('td', null, inv.role || '—'));
      tr.appendChild(el('td', null, inv.expense_type || '—'));
      tr.appendChild(el('td', null, (inv.errors && inv.errors.join('; ')) || (inv.moved_to_output ? 'OK' : 'left in inbox')));
      table.appendChild(tr);
    }
    for (const doc of m.supporting_documents || []) {
      const tr = el('tr');
      tr.appendChild(el('td', null, doc.file));
      tr.appendChild(el('td', null, 'supporting'));
      tr.appendChild(el('td', null, doc.attached_to ? `attached to ${doc.attached_to}` : '—'));
      tr.appendChild(el('td', null, doc.moved_to_output ? 'OK' : 'not attached'));
      table.appendChild(tr);
    }
    body.appendChild(table);
  }

  $('#result-open-folder').onclick = () => window.rejsud.shell.openPath(item.outputFolder);
  $('#result-open-folder').disabled = !item.outputFolder;
  $('#result-open-manifest').onclick = () => window.rejsud.shell.openPath(item.manifestPath);
  $('#result-open-manifest').disabled = !item.manifestPath;
  $('#result-modal').hidden = false;
}
$('#result-close').addEventListener('click', () => ($('#result-modal').hidden = true));
$('#btn-totp-help').addEventListener('click', () => ($('#totp-help-modal').hidden = false));
$('#totp-help-close').addEventListener('click', () => ($('#totp-help-modal').hidden = true));

function alertMsg(text) {
  const box = $('#inbox-error');
  box.hidden = false;
  box.textContent = text;
}

/* -------------------------------------------------------------- settings -- */
const SETTING_FIELDS = {
  receiptsInbox: 's-inbox',
  claimsOutput: 's-output',
  expenseAlias: 's-alias',
  expenseAliasOption: 's-alias-option',
  expenseType: 's-type',
  expensePurpose: 's-purpose',
  corporateCard: 's-card',
};

async function loadSettings() {
  const s = await window.rejsud.settings.get();
  for (const [key, id] of Object.entries(SETTING_FIELDS)) $(`#${id}`).value = s[key] ?? '';
  $('#s-headless').checked = !!s.headless;
}

$('#btn-save-settings').addEventListener('click', async () => {
  const patch = { headless: $('#s-headless').checked };
  for (const [key, id] of Object.entries(SETTING_FIELDS)) patch[key] = $(`#${id}`).value.trim();
  await window.rejsud.settings.save(patch);
  flash('#settings-msg', 'Saved.', 'ok');
  scanInbox();
});

document.querySelectorAll('[data-pick]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const input = $(`#${btn.dataset.pick}`);
    const dir = await window.rejsud.dialog.pickDirectory({ title: btn.dataset.pickTitle, defaultPath: input.value });
    if (dir) input.value = dir;
  });
});

function flash(sel, text, cls) {
  const node = $(sel);
  node.textContent = text;
  node.className = `msg ${cls || ''}`;
  clearTimeout(node._t);
  node._t = setTimeout(() => (node.textContent = ''), 4000);
}

/* ----------------------------------------------------------- credentials -- */
const CRED_FIELDS = {
  INDFAK_USERNAME: 'c-user',
  INDFAK_PASSWORD: 'c-pass',
  TOTP_SECRET: 'c-totp',
  ANTHROPIC_API_KEY: 'c-key',
};

async function loadCredStatus() {
  const st = await window.rejsud.credentials.status();
  for (const key of Object.keys(CRED_FIELDS)) {
    const node = document.querySelector(`[data-state-for="${key}"]`);
    const where = st[key];
    node.textContent = where === 'keychain' ? 'Keychain' : where === 'dotenv' ? 'from .env' : 'not set';
    node.className = `state ${where === 'missing' ? 'missing' : 'set'}`;
  }
  const notice = $('#creds-source');
  const fromEnv = Object.keys(CRED_FIELDS).some(k => st[k] === 'dotenv');
  $('#btn-import-env').hidden = !fromEnv;
  notice.hidden = !fromEnv && st.encryptionAvailable;
  if (!st.encryptionAvailable) {
    notice.textContent = 'The macOS Keychain is unavailable, so credentials cannot be saved securely on this machine.';
  } else if (fromEnv) {
    notice.textContent =
      'Some credentials are currently coming from the development .env file next to bot.js. Import them into the Keychain so the packaged app no longer depends on that file.';
  }
}

$('#btn-save-creds').addEventListener('click', async () => {
  const patch = {};
  for (const [key, id] of Object.entries(CRED_FIELDS)) {
    const value = $(`#${id}`).value;
    if (value.trim()) patch[key] = value.trim();
  }
  if (!Object.keys(patch).length) return flash('#creds-msg', 'Nothing to save.', '');
  try {
    await window.rejsud.credentials.save(patch);
    for (const id of Object.values(CRED_FIELDS)) $(`#${id}`).value = '';
    await loadCredStatus();
    flash('#creds-msg', 'Saved to Keychain.', 'ok');
  } catch (err) {
    flash('#creds-msg', clean(err), 'err');
  }
});

$('#btn-import-env').addEventListener('click', async () => {
  try {
    await window.rejsud.credentials.importEnv();
    await loadCredStatus();
    flash('#creds-msg', 'Imported into the Keychain.', 'ok');
  } catch (err) {
    flash('#creds-msg', clean(err), 'err');
  }
});

/* --------------------------------------------------------------- browser -- */
async function refreshBrowserStatus() {
  const st = await window.rejsud.browser.status();
  const node = $('#browser-status');
  const badge = $('#browser-badge');
  if (st.installed) {
    node.textContent =
      st.source === 'shared'
        ? `Using the Chromium already in Playwright's shared cache — no download needed.\n${st.browsersPath}`
        : `Chromium is installed in the app's own folder.\n${st.browsersPath}`;
    node.style.whiteSpace = 'pre-wrap';
    $('#btn-install-browser').textContent = 'Re-download Chromium…';
    badge.hidden = true;
  } else {
    node.textContent = 'Chromium is not installed yet. The automation needs it to drive indfak2 — download it once (about 150 MB).';
    $('#btn-install-browser').textContent = 'Download Chromium…';
    badge.hidden = false;
    badge.textContent = 'Chromium not installed';
  }
  return st;
}

$('#btn-install-browser').addEventListener('click', async () => {
  const btn = $('#btn-install-browser');
  btn.disabled = true;
  flash('#browser-msg', 'Downloading…', '');
  try {
    await window.rejsud.browser.install();
    await refreshBrowserStatus();
    flash('#browser-msg', 'Chromium ready.', 'ok');
  } catch (err) {
    flash('#browser-msg', clean(err), 'err');
  } finally {
    btn.disabled = false;
  }
});

window.rejsud.onBrowserProgress(({ line }) => {
  $('#browser-msg').textContent = line.slice(0, 90);
  appendLog(line + '\n', 'app');
});

/* ---------------------------------------------------------------- drafts -- */
$('#btn-delete-draft').addEventListener('click', async () => {
  const name = $('#d-name').value.trim();
  if (!name) return flash('#draft-msg', 'Enter part of a draft name.', 'err');
  const btn = $('#btn-delete-draft');
  btn.disabled = true;
  flash('#draft-msg', 'Opening indfak2…', '');
  try {
    await window.rejsud.drafts.delete(name);
    flash('#draft-msg', 'Done — see the log for what was deleted.', 'ok');
  } catch (err) {
    flash('#draft-msg', clean(err), 'err');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ init -- */
(async function init() {
  await loadSettings();
  await loadCredStatus();
  await scanInbox();
  const st = await refreshBrowserStatus();
  if (!st.installed) {
    appendLog('Chromium is not installed yet — open Settings and download it before the first run.\n', 'app');
  }
  const info = await window.rejsud.appInfo();
  $('#app-info').textContent = `Rejsud ${info.version} · data in ${info.userData}`;
  setRunning(await window.rejsud.run.state());
})();
