'use strict';
/* Renderer. No Node access — everything goes through window.rejsudai (preload). */

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
// "new" is a page under the Settlements tab rather than a tab of its own, so
// that tab stays lit while the settlement is being composed.
const VIEWS = ['run', 'new', 'aliases', 'settings'];
function showView(name) {
  for (const view of VIEWS) $(`#view-${view}`).hidden = name !== view;
  const lit = name === 'new' ? 'run' : name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === lit));
  if (name === 'settings') refreshBrowserStatus();
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
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

/* -------------------------------------------------------- live browser -- */
// Base64 JPEG frames pushed from the automation's own Chromium (see
// app/lib/screencast.js) — a mirror, not a browser: clicks here go nowhere.
// The last frame stays up after a run, so a failure is still on screen.
const frameEl = $('#browser-frame');
const liveBadge = $('#browser-live');

window.rejsudai.onFrame(({ data }) => {
  if (!data) return;
  frameEl.src = `data:image/jpeg;base64,${data}`;
  frameEl.hidden = false;
  $('#browser-idle').hidden = true;
  liveBadge.hidden = false;
});
window.rejsudai.onFrameEnd(() => (liveBadge.hidden = true));

/* ------------------------------------------------------------- appearance -- */
// "auto" leaves the CSS pairs on `color-scheme: light dark` and lets macOS
// decide; the other two stamp data-theme, which pins the scheme. Main gets the
// same value on save and points nativeTheme at it, so the traffic lights and
// the native dialogs turn with the window.
const THEMES = ['auto', 'light', 'dark'];

function applyTheme(theme) {
  const chosen = THEMES.includes(theme) ? theme : 'auto';
  if (chosen === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = chosen;
  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.checked = radio.value === chosen;
  }
  return chosen;
}

// A theme picker that waited for a Save button would be a strange thing to use,
// so this one paints and persists on the spot.
document.querySelectorAll('input[name="theme"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    const chosen = applyTheme(radio.value);
    window.rejsudai.settings.save({ theme: chosen }).catch(err => flash('#settings-msg', clean(err), 'err'));
  });
});

/* --------------------------------------------------------- panel sizes -- */
// Two splitters: the settlement list's width, and the browser pane's share of
// the right column. Both are percentages of the run view, kept in settings so
// the window opens the way it was left.
const LAYOUT_DEFAULT = { listPct: 52, browserPct: 50 };
const layout = { ...LAYOUT_DEFAULT };
const runView = $('#view-run');
// Matches the clamp in settings.js — a splitter can never hide a panel.
const clampPct = n => Math.min(85, Math.max(15, Math.round(n * 10) / 10));

function applyLayout() {
  runView.style.setProperty('--list-w', `${layout.listPct}%`);
  runView.style.setProperty('--browser-h', `${layout.browserPct}%`);
}

function adoptLayout(saved) {
  layout.listPct = clampPct(Number(saved && saved.listPct) || LAYOUT_DEFAULT.listPct);
  layout.browserPct = clampPct(Number(saved && saved.browserPct) || LAYOUT_DEFAULT.browserPct);
  applyLayout();
}

// Dragging moves the splitter on every pointer event; one write once the hand
// comes to rest is plenty.
let layoutSaveTimer = null;
function setLayout(key, pct) {
  const next = clampPct(pct);
  if (next === layout[key]) return;
  layout[key] = next;
  applyLayout();
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => window.rejsudai.settings.save({ layout: { ...layout } }).catch(() => {}), 400);
}

// Drag it, arrow-key it, or double-click to put it back where it started.
function wireResizer(handle, { axis, box, key }) {
  const pctFrom = event => {
    const rect = box().getBoundingClientRect();
    return axis === 'x'
      ? ((event.clientX - rect.left) / rect.width) * 100
      : ((event.clientY - rect.top) / rect.height) * 100;
  };
  const stop = event => {
    if (!handle.classList.contains('is-dragging')) return;
    handle.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing', `is-resizing-${axis}`);
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // Capture already released with the pointer (cancel, window blur).
    }
  };

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    // Capture keeps the drag on the handle even as the pointer crosses the
    // panes — including the browser frame, which would otherwise swallow it.
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    document.body.classList.add('is-resizing', `is-resizing-${axis}`);
  });
  handle.addEventListener('pointermove', event => {
    if (handle.hasPointerCapture(event.pointerId)) setLayout(key, pctFrom(event));
  });
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('dblclick', () => setLayout(key, LAYOUT_DEFAULT[key]));
  handle.addEventListener('keydown', event => {
    const step = { ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setLayout(key, layout[key] + step);
  });
}

wireResizer($('#resize-list'), { axis: 'x', box: () => runView, key: 'listPct' });
wireResizer($('#resize-browser'), { axis: 'y', box: () => $('.panel-right'), key: 'browserPct' });

/* ------------------------------------------------------- browser/details -- */
// One pane, two things worth looking at: what the browser is doing right now,
// and what became of a settlement. A run puts the browser up, because that is
// the thing that is moving; clicking a settlement puts its details up, because
// that is the thing that was asked about.
let activePane = 'browser';
// The settlement the Details tab is showing, so a re-render (a run finishing,
// the inbox being re-scanned) keeps it on the same one.
let detailsFor = null;

function showPane(name) {
  activePane = name;
  for (const tab of document.querySelectorAll('.pane-tab')) {
    const on = tab.dataset.pane === name;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  $('#pane-browser').hidden = name !== 'browser';
  $('#pane-details').hidden = name !== 'details';
}

document.querySelectorAll('.pane-tab').forEach(tab => {
  tab.addEventListener('click', () => showPane(tab.dataset.pane));
});

// Clicking a settlement is the ordinary way in: it selects the card, fills the
// pane and brings it to the front.
function openDetails(item) {
  detailsFor = item.id;
  showPane('details');
  render();
}

$('#btn-browser-expand').addEventListener('click', event => {
  const expanded = $('#view-run').classList.toggle('is-browser-expanded');
  event.currentTarget.textContent = expanded ? 'Collapse' : 'Expand';
  event.currentTarget.setAttribute('aria-pressed', String(expanded));
});

/* --------------------------------------------------------- alias library -- */
// The projects costs are booked on: a short name of the user's own plus the
// alias code indfak2 knows it by. Kept in settings; mirrored here so the
// settlement list and the New settlement page can render it without an IPC
// round-trip per keystroke. defaultCode is the entry a new settlement starts on.
const aliasLib = { list: [], defaultCode: '' };
// Sentinel for the dropdown's "New alias…" row. No real code can collide with
// it: codes are letters, digits, dots, dashes and underscores.
const NEW_ALIAS = '\u0000new';

function adoptAliases(settings) {
  const list = Array.isArray(settings.aliases) ? settings.aliases : [];
  const defaultCode = settings.expenseAlias || '';
  const moved = defaultCode !== aliasLib.defaultCode || JSON.stringify(list) !== JSON.stringify(aliasLib.list);
  aliasLib.list = list;
  aliasLib.defaultCode = defaultCode;
  // Re-rendering the Settings editor discards half-typed rows, so only do it
  // when the stored library really moved — not on every read of it.
  if (moved) renderAliasRows();
}

// A settlement records only the code, so the name comes from the library.
function aliasLabel(code) {
  const hit = aliasLib.list.find(a => a.code === code);
  return hit && hit.name !== code ? `${hit.name} (${code})` : code;
}

/* ------------------------------------------------------------ list view -- */
// "Done" said nothing about the thing a person actually wants to know at the
// end of a run: whether indfak2 has the settlement, or whether it is still
// sitting there waiting to be sent. A filed settlement is **Ready** — the draft
// is complete and the approval is yours to press — and one that went out on its
// own is **Submitted**.
function statusLabel(s) {
  return { queued: 'Queued', running: 'Running', done: 'Ready', submitted: 'Submitted',
           error: 'Failed', cancelled: 'Cancelled' }[s] || 'Not filed';
}

// The chip is two words at most, so the distinction it is drawing is spelled
// out where there is room for it.
const STATUS_HINT = {
  done: 'Filed as a draft in indfak2 — ready for you to send for approval',
  submitted: 'Sent to indfak2 for approval',
  error: 'This settlement did not file — see the Details tab',
  cancelled: 'The run was stopped before this settlement finished',
  running: 'Being filed into indfak2 now',
  queued: 'Waiting to be filed',
};

// A trash can, drawn rather than shipped as an asset: lid, handle, body and two
// score lines. createElementNS because SVG is not HTML — document.createElement
// would make an unrendered HTMLUnknownElement.
function trashIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [
    'M2.5 4h11',                        // lid
    'M6.5 4V2.6h3V4',                   // handle
    'M4 4l.6 8.5a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4',  // body
    'M6.7 6.6v4.4',                     // score lines
    'M9.3 6.6v4.4',
  ]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

// What went wrong, in the order a person needs it: the cause, the step it
// happened in, the evidence, and the fix. bot.js supplies all four; a run that
// died before it could explain itself falls back to its last error line.
function failureBlock(item) {
  const f = item.failure || {};
  const box = el('div', 'failure');
  box.appendChild(el('div', 'failure-title', f.title || item.error));
  if (f.while) box.appendChild(el('div', 'failure-step', `While ${f.while}.`));
  if (f.detail && f.detail !== f.title) box.appendChild(el('div', 'failure-detail', f.detail));
  if (f.hint) box.appendChild(el('div', 'failure-hint', f.hint));

  const acts = el('div', 'failure-actions');
  if (f.screenshot) {
    const b = el('button', 'btn btn-quiet', 'Screenshot');
    b.title = 'The page as it looked when the run stopped';
    b.addEventListener('click', () => window.rejsudai.shell.openPath(f.screenshot));
    acts.appendChild(b);
  }
  if (f.raw && f.raw !== f.title) {
    const b = el('button', 'btn btn-quiet', 'Technical details');
    b.addEventListener('click', () => {
      const open = box.classList.toggle('is-open');
      b.textContent = open ? 'Hide details' : 'Technical details';
    });
    acts.appendChild(b);
    const raw = el('pre', 'failure-raw', f.raw);
    box.appendChild(raw);
  }
  if (acts.childNodes.length) box.appendChild(acts);
  return box;
}

function render() {
  const list = $('#settlement-list');
  list.textContent = '';
  const all = [...items.values()];
  $('#empty-state').hidden = all.length > 0;

  for (const item of all) {
    const li = el('li', 'settlement');
    if (item.status) li.classList.add(`is-${item.status}`);
    if (item.id === detailsFor) li.classList.add('is-active');

    // Clicking the card is what opens its details, so it says so.
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.addEventListener('click', event => {
      // The checkbox, the bin and the action buttons are their own thing.
      if (event.target.closest('button, input, a')) return;
      openDetails(item);
    });
    li.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target !== li) return;
      event.preventDefault();
      openDetails(item);
    });

    // A settlement saved but not yet filed is only its inbox folder, so
    // removing it deletes that folder. One whose folder the automation already
    // consumed is just a row left for its result — that only leaves the list.
    const onDisk = item.onDisk !== false;
    const rm = el('button', 'settlement-del');
    rm.appendChild(trashIcon());
    rm.title = item.removing ? 'Removing…'
      : onDisk
        ? 'Delete this settlement and the receipts copied into its inbox folder'
        : 'Take this finished settlement off the list';
    rm.setAttribute('aria-label', rm.title);
    rm.disabled = running || !!item.removing;
    if (item.removing) rm.classList.add('is-busy');
    rm.addEventListener('click', () => removeSettlement(item));
    li.appendChild(rm);

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
    if (item.alias) bits.push(`alias ${aliasLabel(item.alias)}`);
    bits.push(`${item.fileCount} file${item.fileCount === 1 ? '' : 's'}`);
    bits.push(item.folder);
    main.appendChild(el('div', 'settlement-meta', bits.join(' · ')));

    const actions = el('div', 'settlement-actions');
    if (item.outputFolder) {
      const b = el('button', 'btn btn-quiet', 'Open output folder');
      b.addEventListener('click', () => window.rejsudai.shell.openPath(item.outputFolder));
      actions.appendChild(b);
    }
    if (item.manifestPath) {
      const b = el('button', 'btn btn-quiet', 'manifest.json');
      b.addEventListener('click', () => window.rejsudai.shell.openPath(item.manifestPath));
      actions.appendChild(b);
    }
    if (actions.childNodes.length) main.appendChild(actions);
    li.appendChild(main);

    const status = el('span', 'status', statusLabel(item.status));
    if (item.status) status.dataset.status = item.status;
    if (STATUS_HINT[item.status]) status.title = STATUS_HINT[item.status];
    li.appendChild(status);
    list.appendChild(li);
  }
  syncSelection();
  renderDetails();
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
  $('#opt-submit').disabled = running;
  $('#opt-submit-new').disabled = running;
  $('#btn-process').disabled = running || sel.length === 0;
  $('#btn-process').textContent = sel.length > 1 ? `Process ${sel.length} settlements` : 'Process settlements';
}

$('#select-all').addEventListener('change', e => {
  for (const item of items.values()) item.selected = e.target.checked;
  render();
});

async function scanInbox() {
  const res = await window.rejsudai.inbox.scan();
  // scan() creates the inbox when it is merely missing, so getting here means
  // the path itself is unusable — say what went wrong rather than pointing at a
  // Settings field, which no longer holds the inbox path.
  $('#inbox-error').hidden = res.exists;
  if (!res.exists) {
    $('#inbox-error').textContent =
      `Could not open the receipts inbox at ${res.inbox}${res.error ? ` — ${res.error}` : ''}`;
  }
  const previous = new Map(items);
  items.clear();
  for (const s of res.settlements) {
    const before = previous.get(s.id);
    // A folder that is still on disk after a failed run keeps its result, but
    // its file count is refreshed — processed files have already been moved out.
    items.set(s.id, before && (before.status === 'done' || before.status === 'error')
      ? { ...before, ...s, selected: false, status: before.status, onDisk: true }
      : { ...s, selected: true, status: 'queued', onDisk: true });
  }
  // Finished settlements whose folder bot.js has already deleted stay listed so
  // their results remain reachable. onDisk: false marks them as rows only —
  // removing one takes it off the list instead of deleting anything.
  for (const [id, item] of previous) {
    if (items.has(id)) continue;
    if (item.status === 'done' || item.status === 'error') items.set(id, { ...item, selected: false, onDisk: false });
  }
  render();
}

// Removing a saved settlement: the confirmation is a native dialog raised by the
// main process, which is also what deletes the folder — the renderer only asks.
async function removeSettlement(item) {
  if (running || item.removing) return;
  if (item.onDisk === false) {
    items.delete(item.id);
    if (detailsFor === item.id) detailsFor = null;
    render();
    return;
  }
  // The confirmation is a sheet on the window, so a second click while it is
  // open would queue a second one behind it.
  item.removing = true;
  render();
  try {
    const res = await window.rejsudai.inbox.remove(item.path);
    if (res && res.cancelled) return;
    items.delete(item.id);
    if (detailsFor === item.id) detailsFor = null;
    appendLog(
      res && res.missing
        ? `The folder for "${item.settlementName || item.folder}" was already gone — taken off the list.\n`
        : `Removed the settlement "${item.settlementName || item.folder}" and its inbox folder.\n`,
      'app'
    );
  } catch (err) {
    alertMsg(clean(err));
  } finally {
    item.removing = false;
    render();
  }
}

/* -------------------------------------------------------------- running -- */
// Submit or leave as a draft. One choice for the next run, shown on both
// screens that can start one, and remembered so the next session opens on it.
let submitAfterFiling = false;

function setSubmitOption(value, { persist = true } = {}) {
  submitAfterFiling = !!value;
  $('#opt-submit').checked = submitAfterFiling;
  $('#opt-submit-new').checked = submitAfterFiling;
  if (persist) window.rejsudai.settings.save({ submitAfterFiling }).catch(() => {});
}

for (const id of ['#opt-submit', '#opt-submit-new']) {
  $(id).addEventListener('change', e => setSubmitOption(e.target.checked));
}

$('#btn-process').addEventListener('click', async () => {
  const targets = selected();
  if (!targets.length) return;
  for (const t of targets) {
    t.status = 'queued';
    t.error = null;
    t.failure = null;
    t.manifest = null;
    t.manifestPath = null;
    t.outputFolder = null;
  }
  render();
  try {
    const state = await window.rejsudai.run.start(
      targets.map(t => ({ id: t.id, path: t.path, folder: t.folder })),
      { submit: submitAfterFiling }
    );
    // Declining the submit confirmation starts nothing — put the rows back.
    if (state && state.cancelled) {
      for (const t of targets) t.status = 'pending';
      render();
    }
  } catch (err) {
    appendLog(`\n${clean(err)}\n`, 'stderr');
    alertMsg(clean(err));
  }
});

$('#btn-cancel').addEventListener('click', () => {
  window.rejsudai.run.cancel();
  appendLog('\nStopping. The current settlement is being cut short — its indfak2 draft may be left half-filled; review it in indfak2 and delete it there if needed.\n', 'app');
});

let wasRunning = false;
function setRunning(state) {
  running = state.busy;
  if (!wasRunning && running) showPane('browser');
  // A finished batch changes the inbox: processed folders are gone, partly
  // processed ones have fewer files left.
  if (wasRunning && !running) {
    scanInbox();
    const failed = [...items.values()].find(i => i.status === 'error');
    if (failed) openDetails(failed);
  }
  wasRunning = running;
  $('#btn-cancel').hidden = !running;
  $('#btn-new').disabled = running;
  syncComposeButtons();
  if (!running) { statusLine.count = ''; statusLine.step = ''; $('#phase-label').textContent = ''; }
  render();
}

window.rejsudai.onLog(({ text, stream }) => appendLog(text, stream));
window.rejsudai.onRunState(setRunning);

// The status line pairs where the run is in the batch ("Filing 2/3 · x.pdf")
// with what it is doing right now ("searching the card transactions"), so a
// stall is legible while it is happening rather than only afterwards.
const statusLine = { count: '', step: '' };
function showStatus() {
  const step = statusLine.step ? statusLine.step[0].toUpperCase() + statusLine.step.slice(1) : '';
  $('#phase-label').textContent = [statusLine.count, step].filter(Boolean).join(' — ');
}
window.rejsudai.onProgress(p => {
  if (p.event === 'phase') {
    statusLine.count = { parsing: 'Reading documents', planning: 'Planning settlement',
                         filing: 'Filing into indfak2', submitting: 'Submitting for approval' }[p.phase] || '';
    statusLine.step = '';
  }
  if (p.event === 'progress') {
    const what = p.phase === 'parsing' ? 'Reading' : 'Filing';
    statusLine.count = `${what} ${p.index}/${p.total} · ${p.file}`;
  }
  // A step names the thing that can hang; it is also what a failure is
  // attributed to, so the two always read the same way.
  if (p.event === 'step') statusLine.step = p.label || '';
  if (p.event === 'error') statusLine.step = '';
  // A question blocks the run until it is answered or times out; without this
  // the status line still reads as the step that failed, and the run looks hung.
  if (p.event === 'ask') statusLine.step = 'waiting for your answer';
  if (p.event === 'ask_close') statusLine.step = '';
  if (['phase', 'progress', 'step', 'error', 'ask', 'ask_close'].includes(p.event)) showStatus();
});

window.rejsudai.onSettlement(async p => {
  const item = items.get(p.id);
  if (!item) return;
  // A settlement that actually left for approval says so, rather than reading
  // like every other finished run.
  const submitted = !!(p.manifest && p.manifest.settlement && p.manifest.settlement.submit
    && p.manifest.settlement.submit.submitted);
  item.status = p.status === 'done' && submitted ? 'submitted' : p.status;
  item.error = p.error || null;
  item.failure = p.failure || null;
  if (p.manifestPath) item.manifestPath = p.manifestPath;
  if (p.outputFolder) item.outputFolder = p.outputFolder;
  if (p.manifest) item.manifest = p.manifest;
  if (p.status !== 'running') item.selected = false;
  render();
});

/* ------------------------------------------------- new settlement page -- */
// A dropped file outside the drop zone would otherwise navigate the window to it.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

// Either a list of dropped/picked files, or one declared folder — never both,
// which is what "use a folder instead" means.
const compose = { files: [], sourceFolder: null, skipped: [] };

function openNewPage() {
  compose.files = [];
  compose.sourceFolder = null;
  compose.skipped = [];
  $('#n-name').value = '';
  $('#n-folder').value = '';
  $('#n-alias-name').value = '';
  $('#n-alias-code').value = '';
  // Re-read rather than trust the mirror: the library may have been edited in
  // Settings since the page was last open.
  window.rejsudai.settings.get().then(s => {
    adoptAliases(s);
    fillAliasSelect(aliasLib.defaultCode);
    refreshCompose();
  });
  flash('#new-msg', '', '');
  showView('new');
  $('#n-name').focus();
}

// --- alias dropdown ---------------------------------------------------------
function fillAliasSelect(preferredCode) {
  const sel = $('#n-alias');
  sel.textContent = '';
  for (const alias of aliasLib.list) {
    const opt = el('option', null, alias.name === alias.code ? alias.code : `${alias.name} — ${alias.code}`);
    opt.value = alias.code;
    sel.appendChild(opt);
  }
  const fresh = el('option', null, aliasLib.list.length ? 'New alias…' : 'New alias — none saved yet');
  fresh.value = NEW_ALIAS;
  sel.appendChild(fresh);
  sel.value = aliasLib.list.some(a => a.code === preferredCode) ? preferredCode
    : aliasLib.list.length ? aliasLib.list[0].code
    : NEW_ALIAS;
  syncAliasMode();
}

// The name/code pair is only on screen while "New alias…" is the selection.
function syncAliasMode() {
  $('#n-alias-new').hidden = $('#n-alias').value !== NEW_ALIAS;
}

function currentAliasCode() {
  const sel = $('#n-alias');
  return sel.value === NEW_ALIAS ? $('#n-alias-code').value.trim() : sel.value;
}

$('#n-alias').addEventListener('change', () => {
  syncAliasMode();
  if ($('#n-alias').value === NEW_ALIAS) $('#n-alias-name').focus();
  refreshCompose();
});

// Puts the typed alias in the library and selects it. The run does this too, so
// this is only for saving one without filing a settlement behind it.
async function saveTypedAlias() {
  const { settings, alias, added } = await window.rejsudai.settings.addAlias({
    name: $('#n-alias-name').value,
    code: $('#n-alias-code').value,
  });
  adoptAliases(settings);
  fillAliasSelect(alias.code);
  return { alias, added };
}

$('#btn-alias-save').addEventListener('click', async () => {
  try {
    const { alias, added } = await saveTypedAlias();
    flash('#new-msg', added ? `Added "${alias.name}" to the library.` : `"${alias.name}" was already in the library.`, 'ok');
  } catch (err) {
    flash('#new-msg', clean(err), 'err');
    return;
  }
  refreshCompose();
});

$('#btn-new').addEventListener('click', openNewPage);
$('#btn-new-back').addEventListener('click', () => showView('run'));
$('#btn-new-cancel').addEventListener('click', () => showView('run'));

// --- receipts ---------------------------------------------------------------
async function addPaths(paths) {
  if (!paths.length) return;
  const { files, skipped } = await window.rejsudai.inbox.expand(paths);
  // A drop replaces a declared folder: the two sources are alternatives.
  if (compose.sourceFolder) {
    compose.sourceFolder = null;
    $('#n-folder').value = '';
    compose.files = [];
  }
  const known = new Set(compose.files.map(f => f.path));
  for (const f of files) if (!known.has(f.path)) compose.files.push(f);
  compose.skipped = skipped;
  refreshCompose();
}

const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    e.stopPropagation();
    if (!compose.sourceFolder) dropzone.classList.add('is-over');
  })
);
['dragleave', 'dragend'].forEach(evt =>
  dropzone.addEventListener(evt, () => dropzone.classList.remove('is-over'))
);
dropzone.addEventListener('drop', async e => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.remove('is-over');
  const paths = [...e.dataTransfer.files].map(f => window.rejsudai.pathForFile(f)).filter(Boolean);
  await addPaths(paths);
});
dropzone.addEventListener('click', e => {
  if (e.target.id !== 'btn-choose-files') $('#btn-choose-files').click();
});

$('#btn-choose-files').addEventListener('click', async () => {
  const paths = await window.rejsudai.dialog.pickFiles({ title: 'Choose receipts' });
  await addPaths(paths || []);
});

$('#btn-pick-source').addEventListener('click', async () => {
  const dir = await window.rejsudai.dialog.pickDirectory({ title: 'Choose a folder of receipts' });
  if (!dir) return;
  const { files, skipped } = await window.rejsudai.inbox.expand([dir]);
  compose.sourceFolder = dir;
  compose.files = files;
  compose.skipped = skipped;
  $('#n-folder').value = dir;
  refreshCompose();
});

$('#btn-clear-source').addEventListener('click', () => {
  compose.sourceFolder = null;
  compose.files = [];
  compose.skipped = [];
  $('#n-folder').value = '';
  refreshCompose();
});

function renderFileList() {
  const list = $('#n-files');
  list.textContent = '';
  for (const file of compose.files) {
    const li = el('li', 'fileitem');
    li.appendChild(el('span', 'fileitem-name', file.name));
    // Files come as a set from a declared folder, so they are removed as a set.
    if (!compose.sourceFolder) {
      const rm = el('button', 'fileitem-x', '×');
      rm.title = `Remove ${file.name}`;
      rm.addEventListener('click', () => {
        compose.files = compose.files.filter(f => f.path !== file.path);
        refreshCompose();
      });
      li.appendChild(rm);
    }
    list.appendChild(li);
  }

  const source = $('#n-source');
  source.hidden = !compose.files.length && !compose.sourceFolder;
  const n = compose.files.length;
  source.textContent = compose.sourceFolder
    ? `${n} document${n === 1 ? '' : 's'} from this folder will be copied into the settlement.`
    : `${n} receipt${n === 1 ? '' : 's'} ready.`;

  const skipped = $('#n-skipped');
  skipped.hidden = !compose.skipped.length;
  skipped.textContent = compose.skipped.length
    ? `Skipped: ${compose.skipped.map(s => `${s.name} (${s.reason})`).join(', ')}`
    : '';

  dropzone.classList.toggle('is-disabled', !!compose.sourceFolder);
  $('#dropzone .dropzone-main').textContent = compose.sourceFolder ? 'Using a folder' : 'Drop receipts here';
  $('#btn-clear-source').hidden = !compose.sourceFolder;
}

// --- name/alias preview -----------------------------------------------------
let proposal = null;
// propose() is an IPC round-trip, so two edits in flight can answer out of
// order; only the newest one is allowed to write the preview.
let composeSeq = 0;

async function refreshCompose() {
  renderFileList();
  const seq = ++composeSeq;
  const name = $('#n-name').value;
  const alias = currentAliasCode();
  // The alias now always has a value, so an untouched page would otherwise open
  // on "Give the settlement a name." — wait for step 1 before previewing.
  const answer = name.trim() ? await window.rejsudai.inbox.propose({ name, alias }) : null;
  if (seq !== composeSeq) return;

  proposal = answer;
  const preview = $('#n-preview');
  if (!answer) {
    preview.textContent = '';
    preview.className = 'hint';
  } else if (!answer.ok) {
    preview.textContent = answer.error;
    preview.className = 'hint hint-warn';
  } else if (answer.exists) {
    preview.textContent = `A settlement folder "${answer.folder}" already exists — choose another name.`;
    preview.className = 'hint hint-warn';
  } else {
    preview.textContent = `Draft "* ${answer.settlementName}" · folder ${answer.folder}`;
    preview.className = 'hint';
  }

  syncComposeButtons();
}

// Composing during a run is fine, and so is saving one — only starting a second
// run is not.
function syncComposeButtons() {
  const ready = !!proposal && proposal.ok && !proposal.exists && compose.files.length > 0;
  $('#btn-run-new').disabled = running || !ready;
  $('#btn-save-new').disabled = !ready;
}

let composeTimer = null;
for (const id of ['#n-name', '#n-alias-name', '#n-alias-code']) {
  $(id).addEventListener('input', () => {
    clearTimeout(composeTimer);
    composeTimer = setTimeout(refreshCompose, 150);
  });
}

// --- save / run -------------------------------------------------------------
// Writes the inbox folder and copies the receipts into it. Both buttons do this;
// only "Run settlement" hands the result to the runner afterwards. Returns null
// when it failed — the message is already on screen.
async function createFromCompose(btn) {
  // A newly typed alias joins the library here, so the next settlement can pick
  // it from the dropdown. A code that is already in there just gets selected.
  try {
    if ($('#n-alias').value === NEW_ALIAS) await saveTypedAlias();
    return await window.rejsudai.inbox.create({
      name: $('#n-name').value,
      alias: currentAliasCode(),
      files: compose.files.map(f => f.path),
    });
  } catch (err) {
    flash('#new-msg', clean(err), 'err');
    btn.disabled = false;
    return null;
  }
}

// Saved, not started: it waits in the settlement list until "Process". Kept
// selected so several saved in a row can be processed as one batch.
$('#btn-save-new').addEventListener('click', async () => {
  const btn = $('#btn-save-new');
  btn.disabled = true;
  flash('#new-msg', 'Saving the folder…', '');

  const created = await createFromCompose(btn);
  if (!created) return;

  items.set(created.id, { ...created, selected: true, status: 'queued', onDisk: true });
  showView('run');
  render();
  flash('#new-msg', '', '');
  btn.disabled = false;
});

$('#btn-run-new').addEventListener('click', async () => {
  const btn = $('#btn-run-new');
  btn.disabled = true;
  flash('#new-msg', 'Preparing the folder…', '');

  const created = await createFromCompose(btn);
  if (!created) return;

  // Show it in the list as the one thing about to run, then hand it to the runner:
  // its status becomes "Running" as soon as bot.js is spawned.
  for (const item of items.values()) item.selected = false;
  items.set(created.id, { ...created, selected: true, status: 'queued', onDisk: true });
  showView('run');
  render();

  try {
    const state = await window.rejsudai.run.start(
      [{ id: created.id, path: created.path, folder: created.folder }],
      { submit: submitAfterFiling }
    );
    // Declining the submit confirmation leaves the folder saved but unrun.
    if (state && state.cancelled) {
      const item = items.get(created.id);
      if (item) item.status = 'pending';
      render();
    }
    flash('#new-msg', '', '');
  } catch (err) {
    appendLog(`\n${clean(err)}\n`, 'stderr');
    alertMsg(clean(err));
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------ TOTP modal -- */
window.rejsudai.onTotpRequest(() => {
  $('#totp-modal').hidden = false;
  $('#totp-input').value = '';
  $('#totp-input').focus();
});
$('#totp-ok').addEventListener('click', () => {
  const code = $('#totp-input').value.trim();
  if (!code) return;
  window.rejsudai.run.submitTotp(code);
  $('#totp-modal').hidden = true;
});
$('#totp-cancel').addEventListener('click', () => {
  window.rejsudai.run.submitTotp('');
  $('#totp-modal').hidden = true;
});
$('#totp-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#totp-ok').click();
});

/* ------------------------------------------------------------- ask modal -- */
// The run has stopped and is waiting on an answer. Ignoring this window is a
// safe thing to do: every question carries the option it takes on its own, and
// the countdown says which one and when.
let askTimer = null;

function hideAsk() {
  if (askTimer) { clearInterval(askTimer); askTimer = null; }
  $('#ask-modal').hidden = true;
}

function showAsk(q) {
  hideAsk();
  $('#ask-question').textContent = q.question || 'The run needs an answer.';
  const detail = $('#ask-detail');
  detail.textContent = q.detail || '';
  detail.hidden = !q.detail;

  // What the run knows about the problem, in the same order the failure block
  // on a settlement card puts it: the step it was on, then the raw message.
  const ctx = q.context || {};
  const raw = $('#ask-raw');
  raw.textContent = [ctx.while ? `While ${ctx.while}.` : '', ctx.raw || ''].filter(Boolean).join('\n');
  raw.hidden = !raw.textContent;

  const shot = $('#ask-shot');
  shot.hidden = !ctx.screenshot;
  shot.onclick = () => window.rejsudai.shell.openPath(ctx.screenshot);

  // Which try this is. On a third attempt at the same document, knowing that
  // the last two did not work is most of what decides the answer.
  const attempt = $('#ask-attempt');
  attempt.textContent = ctx.attempt > 1 ? `Attempt ${ctx.attempt}` : '';
  attempt.hidden = !(ctx.attempt > 1);

  const box = $('#ask-options');
  box.textContent = '';
  for (const [i, option] of (q.options || []).entries()) {
    const b = el('button', `btn ask-option${i === 0 ? ' btn-primary' : ' btn-quiet'}`);
    // Only the first nine can be answered from the keyboard, so only those
    // carry the number that does it.
    if (i < 9) b.appendChild(el('span', 'ask-option-key', String(i + 1)));
    const text = el('span', 'ask-option-text');
    text.appendChild(el('span', 'ask-option-label', option.label));
    if (option.detail) text.appendChild(el('span', 'ask-option-detail', option.detail));
    b.appendChild(text);
    b.addEventListener('click', () => {
      window.rejsudai.run.answer(q.id, option.value);
      hideAsk();
    });
    box.appendChild(b);
  }

  const fallback = (q.options || []).find(o => o.value === q.fallback);
  const countdown = $('#ask-countdown');
  const deadline = q.timeout_ms > 0 ? Date.now() + q.timeout_ms : 0;
  const tick = () => {
    if (!deadline) {
      countdown.textContent = 'The run is paused until you answer.';
      return;
    }
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    countdown.textContent = fallback
      ? `No answer in ${clock} → ${fallback.label.toLowerCase()}`
      : `Closing in ${clock}`;
    // bot.js has moved on by now and its ask_close is on the way; closing here
    // keeps the window from sitting there dead in the meantime.
    if (left <= 0) hideAsk();
  };
  tick();
  if (deadline) askTimer = setInterval(tick, 1000);
  $('#ask-modal').hidden = false;
  // A dialog that blocks the run should be answerable without reaching for the
  // mouse, and focus must not wander off behind it.
  const first = box.querySelector('button');
  if (first) first.focus();
}

// The options are numbered in the order they are shown, so 1/2/3 answer;
// the arrows move between them, and Tab stays inside the dialog. Escape is
// deliberately not bound — every answer here changes what the run does, and
// none of them should be one keystroke away by accident.
$('#ask-modal').addEventListener('keydown', e => {
  const options = [...$('#ask-options').querySelectorAll('button')];
  if (!options.length) return;

  if (/^[1-9]$/.test(e.key)) {
    const chosen = options[Number(e.key) - 1];
    if (chosen) { e.preventDefault(); chosen.click(); }
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const at = options.indexOf(document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    options[(at < 0 ? 0 : at + step + options.length) % options.length].focus();
    return;
  }
  if (e.key === 'Tab') {
    const inside = [...$('#ask-modal').querySelectorAll('button')].filter(b => !b.hidden);
    const edge = e.shiftKey ? inside[0] : inside[inside.length - 1];
    if (document.activeElement === edge) {
      e.preventDefault();
      (e.shiftKey ? inside[inside.length - 1] : inside[0]).focus();
    }
  }
});

window.rejsudai.onAsk(showAsk);
window.rejsudai.onAskClose(hideAsk);

/* --------------------------------------------------------- details pane -- */
// Everything known about one settlement: what went wrong if something did, then
// what was filed, what was asked, and where each document ended up. Reads from
// `items`, not from a captured argument, so it can be re-run whenever the
// settlement changes underneath it.
function renderDetails() {
  const item = detailsFor && items.get(detailsFor);
  const title = $('#details-title');
  const body = $('#details-body');
  body.textContent = '';

  const folderBtn = $('#details-open-folder');
  const manifestBtn = $('#details-open-manifest');
  folderBtn.onclick = () => item && window.rejsudai.shell.openPath(item.outputFolder);
  manifestBtn.onclick = () => item && window.rejsudai.shell.openPath(item.manifestPath);
  folderBtn.disabled = !(item && item.outputFolder);
  manifestBtn.disabled = !(item && item.manifestPath);

  if (!item) {
    detailsFor = null;
    title.textContent = 'Details';
    body.appendChild(el('p', 'details-idle',
      'Click a settlement to see what happened to it — what was filed, what was asked, and anything that went wrong.'));
    return;
  }

  title.textContent = item.settlementName || item.folder;

  // The failure comes first: it is the reason the pane was opened.
  if (item.error) body.appendChild(failureBlock(item));

  const m = item.manifest;
  if (!m || !m.settlement) {
    body.appendChild(el('p', 'subtle', item.error
      ? 'No manifest was written for this run.'
      : item.status === 'running'
        ? 'This settlement is being filed. Its result appears here when the run finishes.'
        : 'This settlement has not been filed yet.'));
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

    // Only worth a line when submitting was asked for: otherwise "draft" is the
    // expected outcome and s.status already says it.
    const sub = s.submit;
    if (sub && sub.requested) {
      const line = el('p', sub.submitted ? 'msg ok' : 'msg err');
      line.textContent = sub.submitted
        ? 'Sent for approval.'
        : `Not submitted — ${sub.skipped_reason || sub.errors.join(' | ') || 'reason unknown'}. It is still a draft in indfak2.`;
      body.appendChild(line);
    }

    // A settlement somebody steered by hand is not the same kind of result as
    // one the automation reached on its own, so the questions it was asked —
    // and what was answered — are part of what happened. 2FA is left out: it is
    // asked of every run and says nothing about this one.
    const asked = (s.questions || []).filter(q => q.kind !== 'totp');
    if (asked.length) {
      body.appendChild(el('p', 'subtle', asked.length === 1
        ? 'One question was asked during this run:'
        : `${asked.length} questions were asked during this run:`));
      const list = el('ul', 'steps');
      for (const q of asked) {
        list.appendChild(el('li', null,
          `${q.question} → ${q.label || q.answer}${q.answered ? '' : ' (nobody answered — the default was taken)'}`));
      }
      body.appendChild(list);
    }

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
      const outcome = (inv.errors && inv.errors.join('; ')) || (inv.moved_to_output ? 'OK' : 'left in inbox');
      // A document that only went in on the third try is worth knowing about,
      // whether or not it eventually worked.
      const note = el('td', null, inv.attempts > 1 ? `${outcome} · ${inv.attempts} attempts` : outcome);
      const d = inv.error_detail;
      if (d) {
        if (d.hint) note.appendChild(el('div', 'failure-hint', d.hint));
        if (d.screenshot) {
          const b = el('button', 'btn btn-quiet', 'Screenshot');
          b.addEventListener('click', () => window.rejsudai.shell.openPath(d.screenshot));
          note.appendChild(b);
        }
      }
      tr.appendChild(note);
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
}
$('#btn-totp-help').addEventListener('click', () => ($('#totp-help-modal').hidden = false));
$('#totp-help-close').addEventListener('click', () => ($('#totp-help-modal').hidden = true));

function alertMsg(text) {
  const box = $('#inbox-error');
  box.hidden = false;
  box.textContent = text;
}

/* -------------------------------------------------------------- settings -- */
const SETTING_FIELDS = {
  claimsOutput: 's-output',
  expenseAliasOption: 's-alias-option',
  expenseType: 's-type',
  expensePurpose: 's-purpose',
  corporateCard: 's-card',
};

async function loadSettings() {
  const s = await window.rejsudai.settings.get();
  for (const [key, id] of Object.entries(SETTING_FIELDS)) $(`#${id}`).value = s[key] ?? '';
  $('#s-headless').checked = !!s.headless;
  $('#s-ask').checked = s.askOnFailure !== false;
  $('#s-ask-timeout').value = s.askTimeoutSeconds ?? 300;
  applyTheme(s.theme);
  $('#s-submit-confirm').checked = !s.submitConfirmSuppressed;
  setSubmitOption(s.submitAfterFiling, { persist: false });
  adoptLayout(s.layout);
  adoptAliases(s);
  renderAliasRows(); // adoptAliases skips it when nothing moved; the first load still needs it
}

// --- alias library editor ---------------------------------------------------
// The rows are the editable copy: they are rendered from the library once and
// then read back on save, so a half-typed code is never normalized away
// under the cursor.
function aliasRow({ name = '', code = '' } = {}) {
  const li = el('li', 'aliasrow');

  const pick = el('input');
  pick.type = 'radio';
  pick.name = 'alias-default';
  pick.className = 'alias-default';
  pick.title = 'Preselect this alias for a new settlement';
  pick.checked = !!code && code === aliasLib.defaultCode;
  li.appendChild(pick);

  for (const [cls, placeholder, value] of [
    ['alias-name', 'Short name', name],
    ['mono alias-code', 'your-alias-code', code],
  ]) {
    const input = el('input', cls);
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = placeholder;
    input.value = value;
    li.appendChild(input);
  }

  const rm = el('button', 'fileitem-x', '×');
  rm.title = 'Remove this alias';
  rm.addEventListener('click', () => {
    li.remove();
    syncAliasRows();
  });
  li.appendChild(rm);
  return li;
}

function renderAliasRows() {
  const list = $('#alias-list');
  if (!list) return;
  list.textContent = '';
  for (const alias of aliasLib.list) list.appendChild(aliasRow(alias));
  syncAliasRows();
}

function syncAliasRows() {
  $('#alias-empty').hidden = $('#alias-list').children.length > 0;
}

function collectAliasRows() {
  return [...$('#alias-list').children]
    .map(row => ({
      name: row.querySelector('.alias-name').value.trim(),
      code: row.querySelector('.alias-code').value.trim(),
      isDefault: row.querySelector('.alias-default').checked,
    }))
    // A row left entirely blank is an abandoned "Add alias", not an error.
    .filter(a => a.name || a.code);
}

$('#btn-add-alias').addEventListener('click', () => {
  const row = aliasRow();
  $('#alias-list').appendChild(row);
  syncAliasRows();
  row.querySelector('.alias-name').focus();
});

// The library lives on its own page, so a settings patch leaves `aliases` out
// entirely — the store keeps whatever is already there.
$('#btn-save-aliases').addEventListener('click', async () => {
  const rows = collectAliasRows();
  const patch = { aliases: rows.map(({ name, code }) => ({ name, code })) };
  // The marked row is what a new settlement starts on; with none marked, the
  // first one is (which is what the store would settle on anyway).
  const chosen = rows.find(a => a.isDefault) || rows[0];
  if (chosen) patch.expenseAlias = chosen.code;

  let saved;
  try {
    // Rejects on a malformed or duplicated alias code, naming the offender.
    saved = await window.rejsudai.settings.save(patch);
  } catch (err) {
    flash('#aliases-msg', clean(err), 'err');
    return;
  }
  adoptAliases(saved);
  flash('#aliases-msg', 'Saved.', 'ok');
  render(); // settlement rows name their alias out of the library
});

$('#btn-save-settings').addEventListener('click', async () => {
  const patch = {
    headless: $('#s-headless').checked,
    askOnFailure: $('#s-ask').checked,
    askTimeoutSeconds: Number($('#s-ask-timeout').value),
    submitConfirmSuppressed: !$('#s-submit-confirm').checked,
  };
  for (const [key, id] of Object.entries(SETTING_FIELDS)) patch[key] = $(`#${id}`).value.trim();

  let saved;
  try {
    saved = await window.rejsudai.settings.save(patch);
  } catch (err) {
    flash('#settings-msg', clean(err), 'err');
    return;
  }
  adoptAliases(saved);
  flash('#settings-msg', 'Saved.', 'ok');
  scanInbox();
});

document.querySelectorAll('[data-pick]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const input = $(`#${btn.dataset.pick}`);
    const dir = await window.rejsudai.dialog.pickDirectory({ title: btn.dataset.pickTitle, defaultPath: input.value });
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

// What a run cannot start without. TOTP_SECRET is deliberately not one of them:
// without it the app simply asks for a code mid-run.
const REQUIRED_CREDS = ['INDFAK_USERNAME', 'INDFAK_PASSWORD', 'ANTHROPIC_API_KEY'];
const CRED_LABELS = {
  INDFAK_USERNAME: 'username',
  INDFAK_PASSWORD: 'password',
  ANTHROPIC_API_KEY: 'Anthropic API key',
};
let credsReady = false;
// True while the app is parked on Settings only because credentials are
// missing — filling them in then hands the user over to the settlement list.
let credsGate = false;

async function loadCredStatus() {
  const st = await window.rejsudai.credentials.status();
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

  const missing = REQUIRED_CREDS.filter(k => st[k] === 'missing');
  credsReady = missing.length === 0;
  const required = $('#creds-required');
  required.hidden = credsReady;
  if (!credsReady) {
    const names = missing.map(k => CRED_LABELS[k]);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    required.textContent =
      `No settlement can run until the ${list} ${names.length > 1 ? 'are' : 'is'} stored. ` +
      'The app opens on this page until then.';
  }
  return st;
}

$('#btn-save-creds').addEventListener('click', async () => {
  const patch = {};
  for (const [key, id] of Object.entries(CRED_FIELDS)) {
    const value = $(`#${id}`).value;
    if (value.trim()) patch[key] = value.trim();
  }
  if (!Object.keys(patch).length) return flash('#creds-msg', 'Nothing to save.', '');
  try {
    await window.rejsudai.credentials.save(patch);
    for (const id of Object.values(CRED_FIELDS)) $(`#${id}`).value = '';
    await loadCredStatus();
    flash('#creds-msg', 'Saved to Keychain.', 'ok');
    if (credsGate && credsReady) {
      credsGate = false;
      showView('run');
    }
  } catch (err) {
    flash('#creds-msg', clean(err), 'err');
  }
});

$('#btn-import-env').addEventListener('click', async () => {
  try {
    await window.rejsudai.credentials.importEnv();
    await loadCredStatus();
    flash('#creds-msg', 'Imported into the Keychain.', 'ok');
  } catch (err) {
    flash('#creds-msg', clean(err), 'err');
  }
});

/* --------------------------------------------------------------- browser -- */
// Probing spawns a node child per candidate path, so concurrent callers (init
// and the Settings tab opening at the same moment) share one round-trip.
let browserProbe = null;
function refreshBrowserStatus() {
  if (!browserProbe) browserProbe = probeBrowser().finally(() => (browserProbe = null));
  return browserProbe;
}

async function probeBrowser() {
  const st = await window.rejsudai.browser.status();
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
    await window.rejsudai.browser.install();
    await refreshBrowserStatus();
    flash('#browser-msg', 'Chromium ready.', 'ok');
  } catch (err) {
    flash('#browser-msg', clean(err), 'err');
  } finally {
    btn.disabled = false;
  }
});

window.rejsudai.onBrowserProgress(({ line }) => {
  $('#browser-msg').textContent = line.slice(0, 90);
  appendLog(line + '\n', 'app');
});

/* ------------------------------------------------------------------ init -- */
(async function init() {
  await loadSettings();
  await loadCredStatus();
  await scanInbox();
  // Nothing can run without credentials, so an install that has none opens on
  // Settings; once they are stored the app opens on the settlement list.
  credsGate = !credsReady;
  showView(credsReady ? 'run' : 'settings');
  const st = await refreshBrowserStatus();
  if (!st.installed) {
    appendLog('Chromium is not installed yet — open Settings and download it before the first run.\n', 'app');
  }
  const info = await window.rejsudai.appInfo();
  $('#app-info').textContent = `Rejsudai ${info.version} · data in ${info.userData}`;
  setRunning(await window.rejsudai.run.state());
})();
