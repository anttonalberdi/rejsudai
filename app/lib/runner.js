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

const EVENT_PREFIX = '@@REJSUD ';

class Runner extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.queue = [];
    this.current = null;
    this.cancelled = false;
    this.redactions = [];
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

  log(settlementId, stream, text) {
    this.emit('log', { settlementId, stream, text: this.redact(text) });
  }

  async start(settlements) {
    if (this.busy) throw new Error('A run is already in progress.');

    const settings = settingsStore.read();
    const creds = credentials.resolve();
    const missing = credentials.KEYS.filter(k => !creds[k]);
    if (missing.length) {
      throw new Error(`Missing credentials: ${missing.join(', ')}. Add them in Settings.`);
    }

    this.redactions = credentials.secretValues();
    this.cancelled = false;
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
      EXPENSE_TYPE: settings.expenseType,
      EXPENSE_PURPOSE: settings.expensePurpose,
      CORPORATE_CARD: settings.corporateCard,
      // Added by the wrapper: structured events, GUI 2FA, headless toggle.
      REJSUD_GUI: '1',
      REJSUD_HEADLESS: settings.headless ? '1' : '0',
      PLAYWRIGHT_BROWSERS_PATH: browsersPath,
    };

    this.emit('state', this.state());
    this.next();
  }

  state() {
    return {
      busy: this.busy,
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
    this.lastError = null;
    this.emit('settlement', { id: settlement.id, status: 'running' });
    this.emit('state', this.state());
    this.log(settlement.id, 'app', `\n=== Processing: ${settlement.folder} ===\n`);

    // bot.js resolves a bare name against RECEIPTS_INBOX and takes absolute
    // paths as-is, so an absolute path works for folders anywhere.
    const child = spawnNode('bot.js', [settlement.path], this.env);
    this.child = child;

    this.pipe(child.stdout, 'stdout', settlement);
    this.pipe(child.stderr, 'stderr', settlement);

    child.on('error', err => {
      this.lastError = err.message;
      this.log(settlement.id, 'stderr', `Failed to start automation: ${err.message}\n`);
    });

    child.on('close', code => {
      this.child = null;
      const cancelled = this.cancelled;
      const manifest = this.readManifest(this.manifestPath);
      this.emit('settlement', {
        id: settlement.id,
        status: cancelled ? 'cancelled' : code === 0 ? 'done' : 'error',
        exitCode: code,
        error: code === 0 ? null : this.lastError || `Automation exited with code ${code}.`,
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
      if (payload.event === 'totp_request') this.emit('totp-request', { settlementId: settlement.id });
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

  // Feeds a 2FA code back to the waiting automation (only reached when no
  // TOTP_SECRET is configured).
  submitTotp(code) {
    if (!this.child) return false;
    this.child.stdin.write(`${code || 'CANCEL'}\n`);
    return true;
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
    if (this.child) this.child.kill('SIGTERM');
  }
}

module.exports = new Runner();
