'use strict';
// Runs settlements by spawning bot.js once per folder — the same thing
// run-pending.sh does, one folder per invocation. bot.js is treated as a black
// box: config and credentials go in as environment variables (the names it
// already reads), and results come back out of stdout and manifest.json.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnNode } = require('./node-child');
const settingsStore = require('./settings');
const credentials = require('./credentials');
const browsers = require('./browsers');

const EVENT_PREFIX = '@@REJSUDAI ';

class Runner extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.queue = [];
    this.current = null;
    this.cancelled = false;
    this.submit = false;
    this.redactions = [];
    // The question bot.js is currently waiting on, if any: { id, kind }. Only
    // one can be outstanding, since the run is blocked until it is answered.
    this.pendingAsk = null;
  }

  get busy() {
    return this.child !== null || this.queue.length > 0;
  }

  // Replaces any credential value that somehow reaches the log with a marker,
  // so nothing secret is ever shown in the UI or copied out of it.
  redact(text) {
    let out = text;
    for (const secret of this.redactions) out = out.split(secret).join('«redacted»');
    return out;
  }

  // A failure report is shown in the UI and copied out of it, so every string
  // in it goes through the same redaction as the log.
  redactFailure(failure) {
    if (!failure) return null;
    const out = {};
    for (const [k, v] of Object.entries(failure)) out[k] = typeof v === 'string' ? this.redact(v) : v;
    return out;
  }

  log(settlementId, stream, text) {
    this.emit('log', { settlementId, stream, text: this.redact(text) });
  }

  // options.submit decides whether bot.js sends each settlement for approval;
  // it comes from the run toolbar, which starts from the saved setting.
  async start(settlements, options = {}) {
    if (this.busy) throw new Error('A run is already in progress.');

    const settings = settingsStore.read();
    const submit = options.submit === undefined ? !!settings.submitAfterFiling : !!options.submit;
    const creds = credentials.resolve();
    const missing = credentials.KEYS.filter(k => !creds[k]);
    if (missing.length) {
      throw new Error(`Missing credentials: ${missing.join(', ')}. Add them in Settings.`);
    }

    this.redactions = credentials.secretValues();
    this.cancelled = false;
    this.submit = submit;
    this.queue = settlements.slice();

    const browsersPath = await browsers.resolvePath();
    this.env = {
      // Credentials — injected per run, never written to disk as a .env.
      ...creds,
      // The config knobs bot.js already reads.
      RECEIPTS_INBOX: settings.receiptsInbox,
      CLAIMS_OUTPUT: settings.claimsOutput,
      EXPENSE_ALIAS: settings.expenseAlias,
      EXPENSE_ALIAS_OPTION: settings.expenseAliasOption,
      // The whole alias library, so that an alias indfak2 rejects can be
      // answered with one of the others instead of ending the run.
      REJSUDAI_ALIASES: JSON.stringify(settings.aliases || []),
      EXPENSE_TYPE: settings.expenseType,
      EXPENSE_PURPOSE: settings.expensePurpose,
      CORPORATE_CARD: settings.corporateCard,
      // Added by the wrapper: structured events, GUI 2FA, headless toggle.
      REJSUDAI_GUI: '1',
      REJSUDAI_HEADLESS: settings.headless ? '1' : '0',
      // Asking is only possible while the app is here to relay the question.
      REJSUDAI_ASK: settings.askOnFailure === false ? '0' : '1',
      REJSUDAI_ASK_TIMEOUT: String(settings.askTimeoutSeconds),
      REJSUDAI_SUBMIT: submit ? '1' : '0',
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    };

    this.emit('state', this.state());
    this.next();
  }

  state() {
    return {
      busy: this.busy,
      submit: !!this.submit,
      currentId: this.current ? this.current.id : null,
      queued: this.queue.map(s => s.id),
    };
  }

  next() {
    if (this.cancelled || this.queue.length === 0) {
      this.current = null;
      this.child = null;
      this.emit('state', this.state());
      this.emit('idle');
      return;
    }
    const settlement = this.queue.shift();
    this.runOne(settlement);
  }

  runOne(settlement) {
    this.current = settlement;
    this.manifestPath = null;
    this.clearAsk();
    this.lastError = null;
    this.lastFailure = null;
    this.emit('settlement', { id: settlement.id, status: 'running' });
    this.emit('state', this.state());
    this.log(settlement.id, 'app', `\n=== Processing: ${settlement.folder} ===\n`);

    // bot.js resolves a bare name against RECEIPTS_INBOX and takes absolute
    // paths as-is, so an absolute path works for folders anywhere.
    const child = spawnNode('bot.js', [settlement.path], this.env, { ipc: true });
    this.child = child;

    this.pipe(child.stdout, 'stdout', settlement);
    this.pipe(child.stderr, 'stderr', settlement);

    // Live browser frames arrive over the IPC channel rather than stdout, so
    // they stay out of the log and out of the redaction pass (a base64 JPEG
    // cannot contain a credential).
    child.on('message', msg => {
      if (msg && msg.channel === 'frame') {
        this.emit('frame', { settlementId: settlement.id, data: msg.data, width: msg.width, height: msg.height });
      }
    });

    child.on('error', err => {
      this.lastError = err.message;
      this.log(settlement.id, 'stderr', `Failed to start automation: ${err.message}\n`);
    });

    child.on('close', code => {
      this.child = null;
      // A child that died mid-question leaves a modal on screen with nothing
      // behind it.
      this.clearAsk();
      this.emit('frame-end', { settlementId: settlement.id });
      const cancelled = this.cancelled;
      const manifest = this.readManifest(this.manifestPath);
      // bot.js explains its own failures (what step, what cause, what to do);
      // `lastError` is only the fallback for a crash that never got that far.
      const failure = code === 0 ? null : this.redactFailure(this.lastFailure);
      this.emit('settlement', {
        id: settlement.id,
        status: cancelled ? 'cancelled' : code === 0 ? 'done' : 'error',
        exitCode: code,
        error: code === 0 ? null : (failure && failure.title) || this.lastError || `Automation exited with code ${code}.`,
        failure,
        manifestPath: this.manifestPath,
        outputFolder: this.manifestPath ? path.dirname(this.manifestPath) : null,
        manifest,
      });
      // Anything still queued when the user cancels is reported as such.
      if (cancelled) {
        for (const s of this.queue) this.emit('settlement', { id: s.id, status: 'cancelled' });
        this.queue = [];
      }
      this.next();
    });
  }

  pipe(stream, name, settlement) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) this.handleLine(line, name, settlement);
    });
    stream.on('end', () => {
      if (buf.trim()) this.handleLine(buf, name, settlement);
    });
  }

  handleLine(line, stream, settlement) {
    if (line.startsWith(EVENT_PREFIX)) {
      let payload;
      try {
        payload = JSON.parse(line.slice(EVENT_PREFIX.length));
      } catch {
        return;
      }
      if (payload.event === 'manifest') this.manifestPath = payload.manifest;
      if (payload.event === 'error') this.lastFailure = payload;
      if (payload.event === 'ask') this.openAsk(payload, settlement);
      if (payload.event === 'ask_close') this.closeAsk(payload.id);
      this.emit('progress', { settlementId: settlement.id, ...payload });
      return;
    }
    // "Bot failed: <message>" is bot.js's own top-level error line.
    const failed = /^Bot failed:\s*(.+)$/.exec(line.trim());
    if (failed) this.lastError = failed[1];
    this.log(settlement.id, stream, line + '\n');
  }

  readManifest(manifestPath) {
    if (!manifestPath) return null;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return null;
    }
  }

  // bot.js has stopped and asked something. A 2FA request keeps its own event
  // and its own modal — the shape of that question has nothing to do with the
  // rest — and everything else goes to the generic prompt.
  openAsk(payload, settlement) {
    this.pendingAsk = { id: payload.id, kind: payload.kind };
    const question = this.redactFailure(payload);
    if (payload.kind === 'totp') this.emit('totp-request', { settlementId: settlement.id, id: payload.id });
    else this.emit('ask', { settlementId: settlement.id, ...question });
  }

  // The question is over without an answer from here (it timed out inside
  // bot.js, or the run ended): take the prompt off the screen.
  closeAsk(id) {
    if (id && this.pendingAsk && this.pendingAsk.id !== id) return;
    this.clearAsk();
  }

  clearAsk() {
    if (!this.pendingAsk) return;
    const { id } = this.pendingAsk;
    this.pendingAsk = null;
    this.emit('ask-close', { id });
  }

  // Answers whatever bot.js is waiting on. The id travels with the answer so a
  // reply that arrives after its question timed out is discarded rather than
  // landing on the next one. `answer` of null means "no answer" — every
  // question has a default for exactly that.
  answerAsk(id, answer) {
    if (!this.child) return false;
    const target = id || (this.pendingAsk && this.pendingAsk.id);
    if (!target) return false;
    this.child.stdin.write(`${JSON.stringify({ id: target, answer: answer === undefined ? null : answer })}\n`);
    this.clearAsk();
    return true;
  }

  // Feeds a 2FA code back to the waiting automation (only reached when no
  // TOTP_SECRET is configured). An empty code cancels the run, as before.
  submitTotp(code) {
    return this.answerAsk(this.pendingAsk && this.pendingAsk.id, code || null);
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
    this.clearAsk();
    if (this.child) this.child.kill('SIGTERM');
  }
}

module.exports = new Runner();
