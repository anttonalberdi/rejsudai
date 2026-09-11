require('dotenv').config();
const { chromium } = require('playwright');
const { TOTP } = require('otpauth');
const Anthropic = require('@anthropic-ai/sdk');
const heicConvert = require('heic-convert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- CONFIG (overridable via env vars) ---
const DEFAULT_DATA_DIR     = path.join(os.homedir(), 'Rejsudai');
const RECEIPTS_INBOX       = process.env.RECEIPTS_INBOX       || path.join(DEFAULT_DATA_DIR, 'receipts-inbox');
const CLAIMS_OUTPUT        = process.env.CLAIMS_OUTPUT        || path.join(DEFAULT_DATA_DIR, 'claims-output');
// A project alias is specific to each user's indfak2 account. It is deliberately
// unset by default: configure EXPENSE_ALIAS for CLI runs, or add an alias in the
// desktop app before creating a settlement.
const PROJECT_ALIAS        = process.env.EXPENSE_ALIAS        || '';
const PROJECT_ALIAS_OPTION = process.env.EXPENSE_ALIAS_OPTION || '';
// Every alias the desktop app has in its library, as JSON [{ name, code }].
// An alias that indfak2 rejects is a configuration mistake whose fix is another
// alias, so the question asked about it offers these. A CLI run has none, and
// the question then offers only trying again and stopping.
const KNOWN_ALIASES = (() => {
  try {
    const list = JSON.parse(process.env.REJSUDAI_ALIASES || '[]');
    if (!Array.isArray(list)) return [];
    return list
      .map(a => ({ code: String((a && a.code) || '').trim(), name: String((a && a.name) || '').trim() }))
      .filter(a => a.code);
  } catch {
    return [];
  }
})();
const EXPENSE_TYPE         = process.env.EXPENSE_TYPE         || '1 -Settlement';
const EXPENSE_PURPOSE      = process.env.EXPENSE_PURPOSE      || '2 - Outside Denmark';
// Describes the corporate card so Claude can tell card-paid receipts (which appear
// as card transactions in indfak2) from out-of-pocket ones (which don't).
const CORPORATE_CARD       = process.env.CORPORATE_CARD       || 'SEB Eurocard (a Mastercard) — and the SEB Rejsekonto corporate travel account, which travel-agency invoices (e.g. CWT) are charged to (card references like "DC 3614...")';
// Sending a settlement on for approval is not something the bot can take back,
// so it is opt-in: REJSUDAI_SUBMIT=1 (the desktop app's toggle) or --submit on the
// command line. --no-submit wins over both, for a one-off draft-only run.
const SUBMIT_SETTLEMENT = process.argv.includes('--no-submit')
  ? false
  : (process.argv.includes('--submit') || process.env.REJSUDAI_SUBMIT === '1');

// ---------------------------------------------------------------------------
// SETTLEMENT FOLDER METADATA
// A folder is named after the settlement and nothing else. What the name cannot
// carry — the project alias, and the name exactly as it was typed — lives in a
// small JSON file written beside the receipts (the desktop app writes it when
// it files the folder). A folder made by hand has no such file: its own name
// becomes the settlement name and the alias falls back to EXPENSE_ALIAS.
// ---------------------------------------------------------------------------
const SETTLEMENT_META = '.rejsudai.json';

// "ai_subscription_fees" → "AI Subscription Fees". Title-case each word;
// uppercase words of ≤2 chars (handles acronyms like AI, UK).
function settlementNameFromFolder(folderName) {
  return folderName
    .replace(/_/g, ' ')
    .split(' ')
    .map(w => w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function readSettlementMeta(folderPath) {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(folderPath, SETTLEMENT_META), 'utf8'));
  } catch {
    meta = {};   // no metadata, or unreadable — fall back to the folder name
  }
  const name  = String(meta && meta.name  || '').trim();
  const alias = String(meta && meta.alias || '').trim();
  return {
    alias: alias || null,
    settlementName: name || settlementNameFromFolder(path.basename(folderPath)),
  };
}

// ---------------------------------------------------------------------------
// SETTLEMENT FOLDER LAYOUT
// A settlement is one folder, kept for as long as the settlement exists:
//   .rejsudai.json   name + alias (see above)
//   input/           documents waiting to be filed
//   processed/       documents already in the indfak2 draft
//   manifest.json    the settlement's record — every document filed so far,
//                    rewritten after each one
// Adding receipts later means putting them in input/ and running again: the
// run reconnects to the draft the record names and carries on. A folder made
// by hand, with its receipts loose inside, works too — loose documents count
// as input and move to processed/ once filed.
// ---------------------------------------------------------------------------
const INPUT_DIR     = 'input';
const PROCESSED_DIR = 'processed';
const RECORD_FILE   = 'manifest.json';
const DOC_RE        = /\.(pdf|png|jpe?g|heic)$/i;

// Documents directly inside `dir`. Dot-files are skipped: macOS leaves "._x.pdf"
// shadow files on network volumes, and they are not receipts.
function listDocuments(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.') && DOC_RE.test(e.name))
      .map(e => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

// What a run has to file: input/, plus anything loose in the folder itself.
function pendingDocuments(folderPath) {
  return [...listDocuments(path.join(folderPath, INPUT_DIR)), ...listDocuments(folderPath)];
}

// The settlement's record from earlier runs, or null before the first one. A
// record that exists but cannot be read stops the run: without it the run
// cannot know which draft is this settlement's or what is already in it, and
// guessing risks filing the same receipt twice.
function readRecord(folderPath) {
  const file = path.join(folderPath, RECORD_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw failure(`The settlement's record (${RECORD_FILE}) could not be read.`, {
      detail: `${file}: ${err.message}`,
      hint: 'It says which draft is this settlement\'s and what is already filed in it. Restore it from a backup, or delete it only if the draft in indfak2 is empty.',
    });
  }
}

// Written to a temporary file and renamed into place, so a run that dies
// mid-write leaves the previous record rather than half of a new one.
function writeRecord(folderPath, record) {
  const file = path.join(folderPath, RECORD_FILE);
  const text = JSON.stringify(record, null, 2);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, text);
  }
  return file;
}

// The documents a record says are in the draft. `moved_to_output` is true once
// a file has gone to processed/ (the name is from before the folder layout).
function filedEntries(record) {
  if (!record) return [];
  return [...(record.invoices || []), ...(record.supporting_documents || [])].filter(e => e && e.moved_to_output);
}

// "receipt.pdf" → "receipt-2.pdf", "receipt-3.pdf", … — the first not in `taken`,
// which it is then added to.
function uniqueName(name, taken) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
  taken.add(candidate);
  return candidate;
}

// A document's file name is its identity in the record, so a new document that
// shares a name with one already filed is renamed before anything reads it —
// otherwise its result would overwrite the filed one's entry. Returns the
// documents left to file.
function claimFileNames(folderPath, files, record) {
  const processedDir = path.join(folderPath, PROCESSED_DIR);
  const processed = new Set(listDocuments(processedDir).map(f => path.basename(f)));
  const filed = new Set(filedEntries(record).map(e => e.file));
  const taken = new Set([...processed, ...filed]);
  const out = [];
  for (const file of files) {
    const base = path.basename(file);
    if (filed.has(base) && !processed.has(base)) {
      // The record says this one is in the draft, yet it never reached
      // processed/: the run that filed it died before moving it. It is not a
      // new receipt, and filing it again would claim it twice.
      fs.mkdirSync(processedDir, { recursive: true });
      moveFile(file, path.join(processedDir, base));
      processed.add(base);
      console.log(`  ${base} is already filed (the run that filed it stopped before moving it) — moved to ${PROCESSED_DIR}/.`);
      continue;
    }
    if (!taken.has(base)) {
      taken.add(base);
      out.push(file);
      continue;
    }
    const fresh = uniqueName(base, taken);
    const dest = path.join(path.dirname(file), fresh);
    fs.renameSync(file, dest);
    console.log(`  ${base} has the same name as a document already in this settlement — renamed to ${fresh}.`);
    out.push(dest);
  }
  return out;
}

// rename(2) within the settlement folder; copying by hand when that is refused
// (another volume, or a mount that will not). fs.copyFileSync is no fallback: it
// fails with ENOTSUP on SMB/virtiofs mounts.
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.writeFileSync(dest, fs.readFileSync(src));
    fs.unlinkSync(src);
  }
}

// ---------------------------------------------------------------------------
// CLAUDE CALLS
// Every request to Claude goes through callClaude(), which keeps what was sent,
// what came back, the tokens Claude reported and what they cost. Each call is
// printed to the log as it happens, and the whole list goes into the manifest
// (`claude`) with the settlement's total — so a settlement says what its
// paperwork cost, and a surprising answer can be traced to the prompt behind it.
// ---------------------------------------------------------------------------
const CLAUDE_MODEL = 'claude-opus-4-8';

// USD per million tokens — Anthropic's list prices, checked 2026-09-11 against
// https://platform.claude.com/docs/en/about-claude/pricing. Writing to the cache
// costs 1.25× the input rate (the default 5-minute cache; 2× for the 1-hour
// one) and reading from it 0.1×. A model that is not listed here is logged
// without a cost rather than with a wrong one.
const CLAUDE_PRICES = {
  'claude-opus-4-8':  { input: 5, output: 25 },
  'claude-opus-5':    { input: 5, output: 25 },
  'claude-sonnet-5':  { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ     = 0.1;

const CLAUDE_LOG = [];
// Long prompt text already printed in full, and the call it was printed with.
// The parsing instruction is the same for every document: the log prints it
// once and points back to it after that. The manifest always has it in full.
const CLAUDE_TEXT_SHOWN = new Map();

const roundUsd = usd => Math.round(usd * 1e6) / 1e6;
const fmtTokens = n => n.toLocaleString('en-US');
const fmtUsd = usd => (usd === null ? 'no price on file' : `$${usd.toFixed(4)}`);

function claudeCost(model, usage) {
  const price = CLAUDE_PRICES[model];
  if (!price) return null;
  const written   = usage.cache_creation_input_tokens || 0;
  const written1h = Math.min(written, (usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens) || 0);
  return roundUsd((
    (usage.input_tokens || 0) * price.input
    + (written - written1h) * price.input * CACHE_WRITE_5M
    + written1h * price.input * CACHE_WRITE_1H
    + (usage.cache_read_input_tokens || 0) * price.input * CACHE_READ
    + (usage.output_tokens || 0) * price.output
  ) / 1e6);
}

// A prompt block as a person would read it. Documents and images travel as
// base64, which is no use in a log or a manifest, so they are named instead.
function claudeBlockText(block) {
  if (typeof block === 'string') return block;
  if (block.type === 'text') return block.text;
  if (block.source && block.source.type === 'base64') {
    const kb = Math.max(1, Math.round(block.source.data.length * 0.75 / 1024));
    return `[${block.type} attached: ${block.source.media_type}, ${kb} KB]`;
  }
  return `[${block.type}]`;
}

const claudeBlocks = content => (Array.isArray(content) ? content : [content]);
const claudePromptText = content => claudeBlocks(content).map(claudeBlockText).join('\n\n');

function printClaudeCall(call, params) {
  const indent = text => String(text).split('\n').map(line => `        ${line}`).join('\n');
  const shown = block => {
    const text = claudeBlockText(block);
    const isText = typeof block === 'string' || block.type === 'text';
    if (!isText || text.length < 200) return text;
    const first = CLAUDE_TEXT_SHOWN.get(text);
    if (first) return `(the same text as in Claude #${first})`;
    CLAUDE_TEXT_SHOWN.set(text, call.n);
    return text;
  };
  const out = [`\n  Claude #${call.n} · ${call.purpose}${call.subject ? ` · ${call.subject}` : ''} · ${call.model}`];
  if (params.system) out.push('    Sent — system:', indent(claudeBlocks(params.system).map(shown).join('\n\n')));
  for (const m of params.messages) out.push(`    Sent — ${m.role}:`, indent(claudeBlocks(m.content).map(shown).join('\n\n')));
  const secs = `${(call.duration_ms / 1000).toFixed(1)} s`;
  if (call.error) {
    out.push(`    No reply — the call failed after ${secs}: ${call.error}`);
  } else {
    const t = call.tokens;
    out.push(`    Received — ${call.stop_reason}, ${secs}:`, indent(call.reply));
    out.push(`    Tokens: ${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out · cache ${fmtTokens(t.cache_write)} written / ${fmtTokens(t.cache_read)} read — est. ${fmtUsd(call.estimated_cost_usd)}`);
  }
  console.log(out.join('\n'));
}

// messages.create(), on the record. `purpose` says which step asked (the
// function's name) and `subject` what about — the file, the settlement.
async function callClaude({ purpose, subject = null }, params) {
  const call = {
    n: CLAUDE_LOG.length + 1, at: new Date().toISOString(), purpose, subject, model: params.model,
    system: params.system ? claudePromptText(params.system) : null,
    messages: params.messages.map(m => ({ role: m.role, text: claudePromptText(m.content) })),
    reply: null, stop_reason: null, tokens: null, estimated_cost_usd: null, duration_ms: null, error: null,
  };
  CLAUDE_LOG.push(call);
  const started = Date.now();
  let msg;
  try {
    msg = await anthropic.messages.create(params);
  } catch (err) {
    call.duration_ms = Date.now() - started;
    call.error = String(err && err.message || err).split('\n')[0];
    call.estimated_cost_usd = 0;   // a request that ends in an error is not billed
    printClaudeCall(call, params);
    throw err;
  }
  const usage = msg.usage || {};
  call.duration_ms = Date.now() - started;
  call.reply = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  call.stop_reason = msg.stop_reason;
  call.tokens = {
    input: usage.input_tokens || 0,
    cache_write: usage.cache_creation_input_tokens || 0,
    cache_read: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
  };
  call.estimated_cost_usd = claudeCost(params.model, usage);
  printClaudeCall(call, params);
  return msg;
}

// The manifest's `claude` section: the settlement's total, the rates it was
// worked out with, and every call in full.
function claudeRecord() {
  const total = key => CLAUDE_LOG.reduce((n, c) => n + (c.tokens ? c.tokens[key] : 0), 0);
  const models = [...new Set(CLAUDE_LOG.map(c => c.model))];
  return {
    estimated_cost_usd: roundUsd(CLAUDE_LOG.reduce((n, c) => n + (c.estimated_cost_usd || 0), 0)),
    tokens: { input: total('input'), cache_write: total('cache_write'), cache_read: total('cache_read'), output: total('output') },
    rates_usd_per_mtok: Object.fromEntries(models.map(m => {
      const p = CLAUDE_PRICES[m];
      return [m, p ? { input: p.input, cache_write: p.input * CACHE_WRITE_5M, cache_read: p.input * CACHE_READ, output: p.output } : null];
    })),
    note: 'Token counts are the ones Claude reported. The cost is estimated from Anthropic list prices; the Anthropic invoice is what counts.',
    calls: CLAUDE_LOG,
  };
}

// A settlement filed over several runs keeps one `claude` section: the earlier
// runs' calls and this run's, and the total of all of them.
function mergeClaude(before, now) {
  if (!before || !Array.isArray(before.calls) || !before.calls.length) return now;
  const sum = key => ((before.tokens || {})[key] || 0) + ((now.tokens || {})[key] || 0);
  return {
    estimated_cost_usd: roundUsd((before.estimated_cost_usd || 0) + (now.estimated_cost_usd || 0)),
    tokens: { input: sum('input'), cache_write: sum('cache_write'), cache_read: sum('cache_read'), output: sum('output') },
    rates_usd_per_mtok: { ...(before.rates_usd_per_mtok || {}), ...now.rates_usd_per_mtok },
    note: now.note,
    calls: [...before.calls, ...now.calls],
  };
}

// The same total, for the end of the log — printed whether or not the run got
// as far as writing a manifest, since a failed run was paid for too.
function printClaudeTotals() {
  if (!CLAUDE_LOG.length) return;
  const r = claudeRecord();
  const failed = CLAUDE_LOG.filter(c => c.error).length;
  const calls = CLAUDE_LOG.length === 1 ? '1 call' : `${CLAUDE_LOG.length} calls`;
  console.log(`\nClaude for this settlement: ${calls}${failed ? ` (${failed} failed)` : ''} · `
    + `${fmtTokens(r.tokens.input)} tokens in, ${fmtTokens(r.tokens.output)} out · `
    + `cache ${fmtTokens(r.tokens.cache_write)} written / ${fmtTokens(r.tokens.cache_read)} read — est. ${fmtUsd(r.estimated_cost_usd)}`);
}

// ---------------------------------------------------------------------------
// 1. PARSE INVOICE with Claude vision
// ---------------------------------------------------------------------------

// Claude vision and indfak2 uploads both reject HEIC (iPhone receipt photos).
// Converts to JPEG in tmpDir; the JPEG is used for parsing AND for upload.
async function prepareFile(filePath, tmpDir) {
  if (!/\.heic$/i.test(filePath)) return { parsePath: filePath, uploadPath: filePath, converted: false };
  const dest = path.join(tmpDir, path.basename(filePath).replace(/\.heic$/i, '.jpg'));
  const out  = await heicConvert({ buffer: fs.readFileSync(filePath), format: 'JPEG', quality: 0.8 });
  fs.writeFileSync(dest, Buffer.from(out));
  console.log(`  Converted ${path.basename(filePath)} → ${path.basename(dest)}`);
  return { parsePath: dest, uploadPath: dest, converted: true };
}

async function parseInvoice(filePath) {
  const ext       = path.extname(filePath).toLowerCase();
  const isPdf     = ext === '.pdf';
  const data      = fs.readFileSync(filePath).toString('base64');
  const mediaType = isPdf ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
  const source    = { type: 'base64', media_type: mediaType, data };

  const contentBlock = isPdf
    ? { type: 'document', source }
    : { type: 'image',    source };

  // Instruction placed BEFORE the document so cache_control caches just the
  // instruction text. Subsequent calls with different documents hit this cache,
  // avoiding re-billing the instruction tokens each time.
  const msg = await callClaude({ purpose: 'parse_invoice', subject: path.basename(filePath) }, {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Extract from this expense document and reply ONLY with a JSON object (no markdown):
{"document_kind": "invoice" | "receipt" | "ticket" | "itinerary" | "booking_confirmation" | "event_document" | "other",
 "vendor": "short vendor name",
 "vendor_country": "full country name where the vendor is located, e.g. 'Denmark', 'Finland', 'Germany', or null if not determinable from address/locale on the document",
 "date": "YYYY-MM-DD",
 "amount": 123.45,
 "currency": "USD",
 "payment_method": "what the document shows about how it was paid, e.g. 'Mastercard ****3663', 'Visa Debit ..1662', 'cash', 'charged to credit card DC ...4974', or null if not shown",
 "references": ["booking references, PNRs, invoice numbers visible on the document"],
 "keywords": ["..."]}

Rules:
- "date" is the date the PAYMENT happened (purchase/issue/charge date), NOT a service, travel or check-out date. A trip booked in April but flown in May has date in April on its booking invoice.
- "amount" is the total actually paid in the payment currency.
- "vendor_country": infer from the vendor's printed address (street, postal code, city, country line) or from locale clues (language of receipt, local tax labels like 'Moms', 'MwSt', 'VAT'). Danish postal codes are 4-digit numbers 1000–9990; 'Kbh', 'København', 'Aarhus', 'Odense' etc. mean Denmark. For online/global vendors with no physical address shown, set null.
- "ticket" is a travel ticket or e-ticket (train, flight, bus, ferry); "booking_confirmation" confirms a reservation (hotel, car, package); "itinerary" is a trip overview, e.g. from a travel agency.
- Tickets and booking confirmations: "amount"/"currency" are the total price printed on the document — every ticket, seat reservation and fee on it added together — and "date" is the purchase/issue date printed on it. A ticket bought directly is often the only record of what the journey cost, so its price must not be dropped; whether it duplicates an invoice is decided later, with all the documents in view. Leave amount/currency null only when the document shows no price, or says the price is still to be paid (e.g. "pay at the hotel").
- Itineraries, event programmes and participant lists are not proof of a payment: amount/currency/payment_method null (a fare or fee printed on them is informational).
- For itineraries and tickets also include "travel": {"start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "origin_city": "...", "origin_country": "...", "destination_city": "...", "destination_country": "..."} describing the whole trip (outbound departure to final return); omit for other documents.
- "keywords" must be 2-6 short strings that could appear in the card-statement descriptor for this charge: the vendor brand, parent/legal company name, product or service names, and web domains mentioned on the document. Example: an Anthropic invoice for a Claude.ai subscription -> ["Anthropic", "Claude.ai", "Claude"]. NEVER include generic words that other merchants' descriptors could also contain: no city/country names, no payment-terminal brands (Verifone, Nets), no generic words like "hotel" or "restaurant" on their own.`,
          cache_control: { type: 'ephemeral' },
        },
        contentBlock,
      ]
    }]
  });

  const raw = msg.content[0].text.trim().replace(/^```json|```$/g, '').trim();
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 1b. SETTLEMENT PLAN — one Claude call over all parsed documents decides, per
// file, whether it is a card expense, an out-of-pocket expense ("Normal cost"),
// or a supporting document to attach to one of the expense lines.
//
// `filed` is what earlier runs already put in this settlement's draft (entries
// from its record). The plan sees them so a document added later that covers a
// cost already filed — the e-ticket for a flight whose invoice went in last
// week — is recognised as evidence rather than filed a second time. When there
// are filed documents the draft exists, so its travel window (`draftTravel`)
// is fixed and the plan is told so.
// ---------------------------------------------------------------------------
async function planSettlement(docs, settlementName, { filed = [], draftTravel = null } = {}) {
  const docList = docs.map(d => ({
    file: path.basename(d.filePath),
    document_kind: d.document_kind || null,
    vendor: d.vendor || null,
    date: d.date || null,
    amount: d.amount ?? null,
    currency: d.currency || null,
    payment_method: d.payment_method || null,
    references: d.references || [],
    travel: d.travel || null,
  }));

  const msg = await callClaude({ purpose: 'plan_settlement', subject: settlementName }, {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: [{
      type: 'text',
      text: `You plan how to file expense settlements in a travel-expense system (indfak2).
The employee's corporate card is: ${CORPORATE_CARD}. Costs paid with it (or invoiced to a corporate travel account) appear as card transactions in the system and are filed as "From card transaction". Costs paid personally (cash or a personal card) never appear there and are filed as "Normal cost" (out-of-pocket reimbursement).
Every cost is filed exactly once — never dropped, never twice.
If two documents cover the same cost (e.g. an e-ticket and the agency invoice sharing a booking reference), the invoice is the expense and the other is supporting, attached to it.
A ticket or booking confirmation with a price is the evidence of that cost when no invoice or receipt in the settlement covers the same booking: it is then an expense line, not supporting — usually "unknown_expense", since tickets rarely show how they were paid. A train ticket bought directly from the operator is the typical case.
Documents with no price of their own (itineraries, event programmes, participant lists) are supporting documents: not expense lines, but attached to one of the expense lines as evidence.

Reply ONLY with JSON (no markdown):
{"travel": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "origin_city": "...", "origin_country": "...", "destination_city": "...", "destination_country": "..."} | null,
 "documents": [{"file": "...", "role": "card_expense" | "pocket_expense" | "unknown_expense" | "supporting", "attach_to": "<file of the expense it supports, or null>", "reason": "short"}]}

- "travel": present when the settlement is a TRIP (there are itinerary/hotel/transport documents). Use the TRAVELER'S OWN itinerary: "start" = their outbound departure date, "end" = their return date (NOT the booking date, and NOT the event's last day if the traveler returns earlier); places come from the itinerary. null for non-trip settlements (e.g. subscriptions).
- "card_expense": clearly paid with the corporate card / corporate travel account.
- "pocket_expense": clearly paid personally (cash or a card that is not the corporate card).
- "unknown_expense": a real cost but the payment method cannot be determined.
- "supporting": not an expense line — a document with no price, or one whose cost another document here already files; set attach_to to the most related expense file, or null for any.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: planPrompt(settlementName, docList, filed, draftTravel),
    }]
  });

  const raw = msg.content[0].text.trim().replace(/^```json|```$/g, '').trim();
  const plan = JSON.parse(raw);
  const byFile = Object.fromEntries((plan.documents || []).map(p => [p.file, p]));
  for (const d of docs) {
    const p = byFile[path.basename(d.filePath)];
    d.role      = p ? p.role : (d.amount ? 'unknown_expense' : 'supporting');
    d.attach_to = p ? p.attach_to : null;
    d.plan_reason = p ? p.reason : 'not mentioned in plan — defaulted';
  }

  // Tickets carry their price now, so what keeps a CWT e-ticket from being
  // filed beside the CWT invoice for the same flight is the plan's
  // shared-reference rule. A double claim is too costly to rest on one prompt:
  // a ticket the plan made an expense that shares a booking reference with an
  // invoice or receipt that is also an expense goes back to supporting.
  // The invoices and receipts an earlier run filed count here too: the booking
  // they paid for is in the draft already.
  const refKey = r => String(r).replace(/\s+/g, '').toUpperCase();
  const isPayment = kind => ['invoice', 'receipt'].includes(kind);
  const payments = [
    ...docs.filter(d => d.role !== 'supporting' && isPayment(d.document_kind))
      .map(d => ({ file: path.basename(d.filePath), references: d.references || [], filed: false })),
    ...filed.filter(e => e.expense_type && isPayment((e.parsed_invoice || {}).document_kind))
      .map(e => ({ file: e.file, references: (e.parsed_invoice || {}).references || [], filed: true })),
  ];
  for (const d of docs) {
    if (d.role === 'supporting' || !['ticket', 'booking_confirmation', 'itinerary'].includes(d.document_kind)) continue;
    const mine = new Set((d.references || []).map(refKey).filter(r => r.length >= 5));
    const payment = payments.find(p => p.references.some(r => mine.has(refKey(r))));
    if (!payment) continue;
    const shared = payment.references.find(r => mine.has(refKey(r)));
    d.role = 'supporting';
    d.attach_to = payment.file;
    d.plan_reason = `shares booking reference ${shared} with ${payment.file}, which ${payment.filed ? 'is already filed' : 'files this cost'}`;
  }
  return { travel: plan.travel || null };
}

// The plan's user message. The documents already in the draft go before the
// new ones, as context the reply must not list.
function planPrompt(settlementName, docList, filed, draftTravel) {
  const parts = [`Settlement: "${settlementName}"`];
  if (filed.length) {
    const filedList = filed.map(e => {
      const p = e.parsed_invoice || {};
      return {
        file: e.file,
        filed_as: e.expense_type || `supporting document${e.attached_to ? ` attached to ${e.attached_to}` : ''}`,
        document_kind: p.document_kind || null,
        vendor: p.vendor || null,
        date: p.date || null,
        amount: p.amount ?? null,
        currency: p.currency || null,
        references: p.references || [],
      };
    });
    parts.push('This settlement already has a draft in indfak2, and these documents are filed in it. They are context only: '
      + 'do not list them in "documents". A new document covering a cost already filed here — the same booking reference, '
      + 'or the same vendor, amount and date — is "supporting": the cost must not be filed twice.\n'
      + JSON.stringify(filedList, null, 2));
    parts.push(draftTravel
      ? `The draft's travel window is fixed: ${JSON.stringify(draftTravel)}. Return it as "travel".`
      : 'The draft is not a travel settlement: return "travel": null.');
  }
  parts.push(`${filed.length ? 'New documents to file' : 'Documents'}:\n${JSON.stringify(docList, null, 2)}`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// 1c. PICK OPTION — Claude chooses one entry from a dropdown's option list
// (used for tenant-specific dropdowns like "Cost type" whose options are only
// known at runtime). Falls back to an "other"-like option, then the first.
// ---------------------------------------------------------------------------
async function pickOption(options, context, instruction) {
  try {
    const msg = await callClaude({ purpose: 'pick_option' }, {
      model: CLAUDE_MODEL,
      max_tokens: 16,
      system: [{
        type: 'text',
        text: 'You pick one option from a numbered list for an expense system. Reply with ONLY the number.',
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{
        role: 'user',
        content: `${instruction}\n\n${context}\n\nOptions:\n${options.map((o, i) => `${i}: ${o}`).join('\n')}`,
      }],
    });
    const idx = parseInt(msg.content[0].text.trim());
    if (!isNaN(idx) && options[idx]) return options[idx];
  } catch (e) {
    console.log(`  Claude option pick failed (${e.message}) — using fallback.`);
  }
  return options.find(o => /øvrig|other|andet|misc/i.test(o)) || options[0];
}

// ---------------------------------------------------------------------------
// GUI BRIDGE (added for the Electron wrapper — no effect on plain CLI runs)
// When REJSUDAI_GUI=1 the parent process is the desktop app, which reads stdout
// line by line. Structured events are emitted as a single line prefixed with
// @@REJSUDAI so the app can show progress and find the manifest without having to
// screen-scrape the human-readable log. Everything else is unchanged.
// ---------------------------------------------------------------------------
const REJSUDAI_GUI = process.env.REJSUDAI_GUI === '1';

function rejsudaiEmit(event, data = {}) {
  if (!REJSUDAI_GUI) return;
  try { process.stdout.write(`@@REJSUDAI ${JSON.stringify({ event, ...data })}\n`); } catch {}
}

// Mirrors the live page into the app's Browser pane. Frames go over Node's IPC
// channel (the app spawns this process with one) rather than stdout, so they
// never mix into the log. Returns a stop function, or null when there is
// nothing to stream to — a plain CLI run has no parent to send frames to.
async function rejsudaiStartScreencast(page) {
  if (!REJSUDAI_GUI || typeof process.send !== 'function') return null;
  try {
    const { startScreencast } = require('./app/lib/screencast');
    return await startScreencast(page, frame => process.send({ channel: 'frame', ...frame }));
  } catch (err) {
    console.error(`Live browser view unavailable: ${err.message}`);
    return null;
  }
}

// Chromium's own window, when the run has one to work with. Under the app the
// page is mirrored into the Browser pane, so the window is a fallback for
// putting a page right by hand — not the view, and no reason for it to take the
// screen every time a run starts.
//
// It is parked off the bottom of the desktop rather than minimised, which does
// not work: a minimised window on macOS stops compositing, and everything that
// depends on the compositor goes with it — the screencast stops dead (the
// Browser pane freezes, and does not come back when the window is restored),
// page.screenshot() blocks until it times out, and Playwright's actionability
// waits crawl (a click on an animating element measured 2.0 s against 0.6 s).
// A window merely moved out of sight is still a normal, composited window, and
// measures the same as one on screen. macOS clamps how far it will go, so where
// it lands is checked rather than assumed.
//
// `--no-startup-window` means no window exists until newPage(), so this runs
// about 20 ms after it appears.
const OFF_SCREEN_TOP = 20000;

async function rejsudaiStowWindow(browser, page) {
  // A CLI run has no mirror — moving the only view of the page out of sight
  // would be a downgrade — and a headless run has no window to move.
  if (!REJSUDAI_GUI || process.env.REJSUDAI_HEADLESS === '1') return null;
  try {
    const browserSession = await browser.newBrowserCDPSession();
    const pageSession = await page.context().newCDPSession(page);
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    await pageSession.detach().catch(() => {});
    const { windowId, bounds: home } = await browserSession.send(
      'Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    // Read before the move, so it is the display the window actually started on.
    const screenHeight = await page.evaluate(() => window.screen.height).catch(() => null);

    const moveTo = bounds => browserSession.send('Browser.setWindowBounds', { windowId, bounds });
    const where = async () => (await browserSession.send(
      'Browser.getWindowForTarget', { targetId: targetInfo.targetId })).bounds;

    await moveTo({ left: home.left, top: OFF_SCREEN_TOP, width: home.width, height: home.height });
    const parked = await where();
    // A strip of browser across the bottom of the screen is worse than a window
    // that is simply there, so an unexpected clamp puts it back.
    if (screenHeight && parked.top < screenHeight) {
      await moveTo(home).catch(() => {});
      console.error('Chromium is staying on screen: this display would not let its window move clear.');
      return null;
    }

    return {
      // Bring it back where it started, and to the front — this is called when
      // the run has stopped to ask for hands on the page.
      restore: async () => {
        try {
          await moveTo(home);
          await page.bringToFront();
        } catch {
          // The window is gone, or this Chromium will not have it. Neither is
          // worth failing a settlement over.
        }
      },
    };
  } catch (err) {
    console.error(`Could not move the Chromium window off screen: ${err.message}`);
    return null;
  }
}

// Set at launch, and read by the questions that ask for hands on the page.
let BROWSER_WINDOW = null;

// ---------------------------------------------------------------------------
// ASKING THE USER
// A run that hits something it cannot get past should not die with the browser
// still open on the problem — it should ask. Questions go out as an `ask`
// event and answers come back on stdin: the same round trip the 2FA prompt has
// always used, generalized. Every question carries an id, so a late answer can
// never resolve a later prompt, and every question carries a fallback — the
// answer used when nobody is watching — so an unattended run behaves exactly
// as it did before there was anyone to ask.
// ---------------------------------------------------------------------------

// Waiting for a person is only worth doing when there is one. The app sets
// REJSUDAI_ASK from its “Ask before giving up” setting; a terminal run asks
// when stdin is a TTY, and a piped or scripted run takes the fallback without
// ever stopping.
const ASK_ENABLED = process.env.REJSUDAI_ASK === '1' ? true
  : process.env.REJSUDAI_ASK === '0' ? false
  : !!(REJSUDAI_GUI || process.stdin.isTTY);

// Nothing may block a queue forever: an unanswered question falls back to its
// default after this long. REJSUDAI_ASK_TIMEOUT is in seconds; 0 waits
// indefinitely, for someone sitting in front of the run.
const ASK_TIMEOUT_MS = (() => {
  const raw = Number(process.env.REJSUDAI_ASK_TIMEOUT);
  return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : 300000;
})();

// Half of what makes a question worth asking is that there is a browser window
// to work in. A window parked off screen is still one — askAboutFailure()
// brings it back — but with Chromium headless there is nothing to put right
// by hand at all (the Browser pane is a mirror, not a browser), so the answers
// that depend on it are not offered, and the ones that remain are worded for it.
const CAN_WORK_THE_PAGE = process.env.REJSUDAI_HEADLESS !== '1';

// Every question and its answer, for the manifest. A run that a person steered
// should say so: which document was retried, what was left out, where it was
// stopped. It is also the only place a timed-out question is distinguishable
// from one somebody actually answered.
const ASK_LOG = [];

const PENDING_ASKS = new Map(); // id -> resolve
let ASK_SEQ = 0;
let ANSWER_CHANNEL_OPEN = false;

// One reader for the whole process — two competing stdin listeners would each
// eat half the answers. An answer is a JSON line naming the question it belongs
// to; a bare line (a CLI reply, or an older app build) answers the oldest
// question still outstanding.
function openAnswerChannel() {
  if (ANSWER_CHANNEL_OPEN) return;
  ANSWER_CHANNEL_OPEN = true;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  // A resumed stdin holds the event loop open, which would leave the process
  // running after the last settlement and stall the app's queue. It is kept
  // unreferenced except while a question is actually outstanding (see askUser).
  holdStdin(false);
  process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      deliverAnswer(line);
    }
  });
  // Input closing means nobody can answer any more: release every waiter with
  // its fallback rather than hanging the run on a channel that is gone.
  process.stdin.on('end', () => {
    for (const id of [...PENDING_ASKS.keys()]) settleAsk(id, null);
  });
}

// stdin is only allowed to keep this process alive while someone might still
// answer. Guarded because a redirected stdin is not a socket and has no ref().
function holdStdin(hold) {
  const fn = hold ? process.stdin.ref : process.stdin.unref;
  if (typeof fn === 'function') { try { fn.call(process.stdin); } catch {} }
}

function settleAsk(id, answer) {
  const resolve = PENDING_ASKS.get(id);
  if (!resolve) return;
  PENDING_ASKS.delete(id);
  resolve(answer);
}

function deliverAnswer(line) {
  if (!line) return;
  if (line.startsWith('{')) {
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id && PENDING_ASKS.has(msg.id)) {
        settleAsk(msg.id, msg.answer === undefined ? null : msg.answer);
        return;
      }
      // An envelope for a question that has already timed out is stale —
      // dropping it is what keeps a late answer from landing on the next one.
      if (msg && msg.id) return;
    } catch { /* not an answer envelope — treat it as a bare reply */ }
  }
  const oldest = PENDING_ASKS.keys().next();
  if (!oldest.done) settleAsk(oldest.value, line === 'CANCEL' ? null : line);
}

// The CLI has no modal: the question and its options are printed to stderr, and
// the shared reader above takes the reply (an option number, or the answer).
function printCliQuestion(question, detail, options, fallback) {
  process.stderr.write(`\n? ${question}\n`);
  if (detail) process.stderr.write(`  ${detail}\n`);
  options.forEach((o, i) => {
    process.stderr.write(`  ${i + 1}) ${o.label}${o.value === fallback ? '  (default)' : ''}\n`);
  });
  process.stderr.write(options.length ? '  Choose: ' : '  > ');
}

// Puts a question to whoever is watching and waits for the answer.
//   options   [{ value, label, detail }] — the choices offered
//   fallback  the answer used when nobody is there, the reply is empty, or the
//             question times out. It must be what the run would have done on
//             its own, so that turning asking off changes nothing.
//   required  the run cannot continue without an answer (a 2FA code), so it is
//             asked even where questions are otherwise turned off.
// Returns the chosen value.
async function askUser({ kind = 'choice', question, detail = null, context = null, options = [],
                         fallback = null, required = false, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  if (!ASK_ENABLED && !required) return fallback;
  const id = `ask${++ASK_SEQ}`;
  openAnswerChannel();

  const answered = new Promise(resolve => PENDING_ASKS.set(id, resolve));
  holdStdin(true);
  if (REJSUDAI_GUI) {
    // The app shows the question in a dialog, but the log is what gets read
    // back afterwards and copied into a bug report, so it goes there too.
    console.log(`\n  ? ${question}`);
    rejsudaiEmit('ask', { id, kind, question, detail, context, options, fallback, timeout_ms: timeoutMs });
  } else {
    printCliQuestion(question, detail, options, fallback);
  }

  let timer = null;
  const reply = await (timeoutMs > 0
    ? Promise.race([answered, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })])
    : answered);
  if (timer) clearTimeout(timer);
  if (PENDING_ASKS.size <= 1) holdStdin(false);

  // Still pending here means the timeout won. Drop the waiter (so a late answer
  // is discarded rather than delivered to the next question) and tell the app,
  // whose modal would otherwise outlive the question it belongs to.
  const timedOut = PENDING_ASKS.has(id);
  if (timedOut) {
    PENDING_ASKS.delete(id);
    if (REJSUDAI_GUI) rejsudaiEmit('ask_close', { id });
    console.log(`  No answer within ${Math.round(timeoutMs / 1000)}s.`);
  }

  const chosen = resolveAnswer(reply, options, fallback);
  const label = (options.find(o => o.value === chosen) || {}).label || null;
  // A 2FA code is the one answer that must never reach a log or a manifest —
  // but a cancelled prompt has to read as cancelled, not as a code supplied.
  const recorded = kind === 'totp' ? (chosen ? '(code supplied)' : '(no code given)') : chosen;
  ASK_LOG.push({ at: new Date().toISOString(), kind, question, answer: recorded, label, answered: !timedOut });
  console.log(`  Answer: ${label || recorded}${timedOut ? ' (nobody answered — the default)' : ''}`);
  return chosen;
}

// A reply is the option's own value, the number of an option (how the CLI
// answers), or — when the question took free text, like a 2FA code — the text.
// Anything else is treated as no answer at all.
function resolveAnswer(reply, options, fallback) {
  if (reply === null || reply === undefined || reply === '') return fallback;
  const text = String(reply).trim();
  if (!options.length) return text;
  const byNumber = options[Number(text) - 1];
  if (byNumber) return byNumber.value;
  return options.some(o => o.value === text) ? text : fallback;
}

// Asks for a 2FA code. The desktop app has its own prompt for kind 'totp'; a
// terminal run is asked on stderr. Only reached when no TOTP_SECRET is set.
async function askForOTP() {
  const code = await askUser({
    kind: 'totp',
    question: 'Enter the 6-digit code from your authenticator app.',
    detail: 'No TOTP secret is configured, so signing in is waiting for a code.',
    fallback: null,
    // There is no way past this question: without a code there is no session,
    // so it is asked even in a run that would otherwise never stop to ask —
    // including one whose stdin is a pipe rather than a terminal.
    required: true,
    // Long enough to go and find the phone, whatever the failure questions are
    // set to. Zero still means wait for as long as it takes.
    timeoutMs: ASK_TIMEOUT_MS === 0 ? 0 : Math.max(ASK_TIMEOUT_MS, 120000),
  });
  if (!code) throw failure('2FA code not provided — run cancelled.', {
    hint: 'Set a TOTP secret in Settings so the automation can generate codes itself.',
  });
  return String(code).trim();
}

// ---------------------------------------------------------------------------
// FAILURE REPORTING
// A Playwright timeout reads "locator.waitFor: Timeout 10000ms exceeded" plus a
// call log full of selectors — which says nothing about WHAT the bot was doing
// or what the person should fix. Every abort is therefore reported as three
// things: the step that was running, a plain-language cause, and what to do
// about it. The CLI prints them; the desktop app gets them as a @@REJSUDAI
// `error` event and shows them on the settlement card.
// ---------------------------------------------------------------------------
let CURRENT_STEP = { step: 'start', label: 'starting up' };

// Called at each stage that can fail on its own. The label is written to be
// read mid-sentence ("Timed out while <label>"), and doubles as the app's live
// status line.
function setStep(step, label) {
  CURRENT_STEP = { step, label };
  rejsudaiEmit('step', { step, label });
}

// An error that already knows its own explanation — describeFailure() passes
// these through untouched. Use it wherever the code knows more about the
// failure than the stack trace does.
function failure(title, { detail = null, hint = null } = {}) {
  const err = new Error(title);
  err.rejsudai = { title, detail, hint };
  return err;
}

// "getByRole('link', { name: /^project-code/ })" → 'the "project-code" link'.
// Playwright's call log names the locator it gave up on, which is the only
// clue about which thing on the page never appeared.
function describeTarget(text) {
  if (!text) return 'the element it was waiting for';
  const name = /name: (?:'([^']*)'|\/\^?([^/]*?)\$?\/)/.exec(text);
  const role = /getByRole\('([a-z]+)'/.exec(text);
  const label = /getByLabel\((?:'([^']*)'|\/([^/]*)\/)/.exec(text);
  const css = /locator\('([^']*)'\)/.exec(text);
  const what = name && (name[1] || name[2]);
  if (what && role) return `the "${what}" ${role[1]}`;
  if (what) return `"${what}"`;
  if (label) return `the "${label[1] || label[2]}" field`;
  if (role) return `a ${role[1]}`;
  if (css) return `an element matching ${css[1]}`;
  return 'the element it was waiting for';
}

// Everything a failure report needs: what broke, the evidence, and the fix.
// `raw` is kept so the log/manifest still carries the original message.
function describeFailure(err) {
  const raw = ((err && err.message) || String(err)).trim();
  const first = raw.split('\n')[0].trim();
  const step = CURRENT_STEP;
  const at = { step: step.step, while: step.label, raw };
  if (err && err.rejsudai) return { ...at, ...err.rejsudai };

  const say = (title, hint, detail = first) => ({ ...at, title, detail, hint });

  // Environment-level failures come with recognizable messages and are worth
  // catching before the generic timeout branch — they are not indfak2's fault.
  if (/net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(raw))
    return say('Could not reach indfak2.dk',
      'Check the network connection (and the VPN, if this machine needs one for KU), then run again.');
  if (/Target (page|context|browser) has been closed|Browser has been closed|browserContext\.close/i.test(raw))
    return say('The browser closed before the run finished',
      'If you closed the browser window, start the run again. Otherwise indfak2 ended the session.');
  if (/Executable doesn.?t exist|playwright install/i.test(raw))
    return say('The automation browser is missing',
      'Open Settings and install the browser, then run again.');
  if (/invalid x-api-key|authentication_error|permission_error/i.test(raw))
    return say('Claude rejected the API key',
      'Check ANTHROPIC_API_KEY in Settings — the documents cannot be read without it.');
  if (/rate_limit_error|overloaded_error/i.test(raw))
    return say('Claude is rate-limited or overloaded',
      'Wait a few minutes and run the settlement again — nothing was filed.');
  if (/credit balance|billing/i.test(raw))
    return say('The Claude account cannot be billed',
      'Top up the Anthropic account for this API key, then run again.');
  if (/ENOENT|no such file or directory/i.test(raw))
    return say('A file or folder the run needed is gone',
      'Check that the settlement folder is still in the inbox and readable.');
  if (/ENOSPC|no space left/i.test(raw))
    return say('The disk is full', 'Free some space and run again.');

  // Whatever is left and timed out: name the step and the thing that never
  // showed up. This is the branch the raw Playwright message used to reach.
  if (/Timeout \d+ms exceeded|exceeded while waiting|waiting for/i.test(raw)) {
    const target = /waiting for (.+?)(?: to be| to appear|\n|$)/.exec(raw);
    // "waiting for event 'response'" is indfak2 never answering, not an
    // element that never rendered — worth saying differently.
    const what = /waiting for event/i.test(raw)
      ? 'indfak2 never answered'
      : `${describeTarget(target && target[1])} never appeared`;
    const hints = {
      login: 'Check the username, password and 2FA secret in Settings.',
      expense_module: 'indfak2 was slow or its Expense module did not load. Try again; if it repeats, open indfak2 in a browser and check the account still has expense access.',
      draft: 'The draft form did not behave as expected — the screenshot shows the page when the bot gave up.',
      alias: 'Check the alias code on the settlement and in Settings.',
      transactions: 'The card-transaction list did not load. Try again in a few minutes.',
      line: 'The expense line form did not behave as expected — the screenshot shows the page when the bot gave up.',
      submit: 'The settlement is still a draft in indfak2 and can be sent by hand.',
    };
    return say(`Timed out while ${step.label} — ${what}`,
      hints[step.step] || 'The page may have changed or been unusually slow. The screenshot shows what was on screen.',
      null);
  }

  return say(`Failed while ${step.label}`,
    'The log below and the screenshot show what happened at the moment it stopped.');
}

// Prints the readable version and hands the app a structured event. `page` may
// be null — failures before the browser is up still get reported, just without
// a screenshot.
async function reportFailure(page, err) {
  if (err && err.rejsudaiReported) return;
  const info = describeFailure(err);
  // A shot taken when the failure happened beats one taken now: if a question
  // was on screen, the page has been worked on by hand since, and a picture of
  // the repair explains nothing.
  let screenshot = (err && err.rejsudaiScreenshot) || null;
  if (!screenshot && page) {
    const target = path.join(os.tmpdir(), `rejsudai-failure-${Date.now()}.png`);
    const ok = await page.screenshot({ path: target, fullPage: true }).then(() => true).catch(() => false);
    if (ok) screenshot = target;
  }
  // The call log is the useful part of a Playwright message, but it can run for
  // pages; the app shows this verbatim, so keep it to the top of the trace.
  const raw = info.raw.split('\n').slice(0, 8).join('\n').slice(0, 800);
  rejsudaiEmit('error', { ...info, raw, screenshot });
  console.error(`\n✖ ${info.title}`);
  console.error(`  While: ${info.while}`);
  if (info.detail && info.detail !== info.title) console.error(`  Detail: ${info.detail}`);
  if (info.hint) console.error(`  → ${info.hint}`);
  if (screenshot) console.error(`  Screenshot: ${screenshot}`);
  if (err) err.rejsudaiReported = true;
  return { ...info, screenshot };
}

// The shape every failure question shares: what broke, what the run knows about
// it, and the choices — the first being the one worth trying. `info` is a
// describeFailure() result, so the question reads the same way the failure
// report would have.
async function askAboutFailure(question, info, options, { fallback, attempt = 1 } = {}) {
  // Every one of these questions is about a page, and the answer worth trying
  // first usually wants hands on it. The window is parked off screen, so bring
  // it back and to the front — and leave it there: once a run has needed a
  // person, it has stopped being a background job.
  if (BROWSER_WINDOW) await BROWSER_WINDOW.restore();
  return askUser({
    kind: 'failure',
    question,
    detail: [info.title, info.hint].filter(Boolean).join(' — '),
    context: {
      file: info.file || null,
      while: info.while || null,
      detail: info.detail || null,
      hint: info.hint || null,
      raw: info.raw ? info.raw.split('\n')[0] : null,
      screenshot: info.screenshot || null,
      attempt,
    },
    options,
    fallback,
  });
}

// A document could not be filed, and the browser is still open on the page that
// failed. Before, that was the end of it: the error went into the manifest and
// the run moved on. Now it asks, because the three useful answers are all a
// person's to give — fix the page and retry, leave this one for later, or stop
// before the rest of the folder goes the same way. The fallback is 'skip', so
// an unattended run does exactly what it did before.
async function askAfterExpenseFailure(fileName, info, { attempt = 1 } = {}) {
  const answer = await askAboutFailure(
    `${fileName} could not be filed. What should the run do?`,
    { ...info, file: fileName },
    [
      { value: 'retry', label: 'Try this document again',
        detail: CAN_WORK_THE_PAGE
          ? 'The browser is paused on the problem — put the page right by hand, then retry.'
          : 'Files the same document again. Chromium is hidden, so this is for a page that was slow rather than one that needs a hand.' },
      { value: 'skip',  label: 'Skip it and carry on',
        detail: 'It stays in the inbox for a later run, and the settlement is left as a draft.' },
      { value: 'stop',  label: 'Stop the run here',
        detail: 'Lines already filed stay in the draft; every remaining document keeps for next time.' },
    ],
    { fallback: 'skip', attempt });
  return answer === 'retry' || answer === 'stop' ? answer : 'skip';
}

// The alias on the draft does not exist in indfak2, or this account cannot use
// it. That is a configuration mistake rather than a page that misbehaved, and
// its fix is a different alias — so the question offers the ones the app has in
// its library instead of leaving "try the same thing again" as the only way
// forward. Returns the alias to try next, or null to give up: 'stop' is the
// fallback, so an unattended run ends exactly where it did before.
async function askAboutAlias(alias, err, attempt = 1) {
  const info = describeFailure(err);
  const others = KNOWN_ALIASES.filter(a => a.code !== alias);
  const answer = await askAboutFailure(
    `Alias ${alias} could not be used. Which alias should this settlement have?`,
    info,
    [
      ...others.map(a => ({
        value: `use:${a.code}`,
        label: a.name ? `${a.name} — ${a.code}` : a.code,
        detail: 'Fills the draft with this alias instead, for this run only — Settings is left alone.',
      })),
      { value: 'retry', label: `Look for ${alias} again`,
        detail: 'Worth a second go if indfak2 was slow to answer rather than missing the alias.' },
      { value: 'stop', label: 'Stop the run',
        detail: 'Nothing is filed, and the failure is reported as it always was.' },
    ],
    { fallback: 'stop', attempt });
  if (typeof answer === 'string' && answer.startsWith('use:')) return answer.slice(4);
  if (answer === 'retry') return alias;
  // The user has already been asked about this failure and said stop; the draft
  // stage around it must not put its own, vaguer question about the same thing.
  if (ASK_ENABLED) err.rejsudaiAsked = true;
  return null;
}

// A stage of the run that can be attempted again on its own — nothing it does
// is left half-done in a way that a second attempt would duplicate. These are
// the failures that used to end the run outright, which is a poor answer to a
// rate-limited Claude call or a login that needed one manual nudge. Now the
// stage asks: try it again (having put the page right by hand, if that is what
// it needs), take whatever way past it the caller offers, or stop and let the
// run's own handler report it exactly as before — which is also what an
// unattended run does, since 'stop' is the fallback.
const STAGE_SKIPPED = Symbol('stage skipped');

async function runStage(page, { question, retry, retryDetail, extra = null }, fn) {
  // What went wrong the first time. A second attempt that breaks somewhere else
  // is a consequence, not the cause, and reporting only the last one leaves the
  // user chasing the wrong thing.
  let origin = null;
  let originShot = null;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      // Nothing on a closed page can be put right by hand, and a retry would
      // only produce the same question again.
      if (!page || page.isClosed()) throw err;
      // The stage put its own question about this and was told to stop; asking
      // a second, vaguer question about the same failure helps nobody.
      if (err && err.rejsudaiAsked) throw err;
      const info = describeFailure(err);
      console.error(`\n  ✗ ${info.title}`);
      if (info.hint) console.error(`    → ${info.hint}`);
      const shot = path.join(os.tmpdir(), `rejsudai-fail-${Date.now()}.png`);
      const shotOk = await page.screenshot({ path: shot, fullPage: true }).then(() => true).catch(() => false);
      // Kept on the error so that stopping here reports the page as it was when
      // it broke, not as it looks after someone has been putting it right.
      if (shotOk) err.rejsudaiScreenshot = shot;
      if (!origin) { origin = info; originShot = shotOk ? shot : null; }

      const choice = await askAboutFailure(question, { ...info, screenshot: shotOk ? shot : null }, [
        { value: 'retry', label: retry, detail: retryDetail },
        ...(extra ? [extra] : []),
        { value: 'stop', label: 'Stop the run',
          detail: 'Nothing further is filed, and the failure is reported as it always was.' },
      ], { fallback: 'stop', attempt });

      if (choice === 'retry') {
        console.log(`  Trying again (attempt ${attempt + 1}).`);
        continue;
      }
      if (extra && choice === extra.value) return STAGE_SKIPPED;
      // Report the failure that started this, with the one the retry ran into
      // kept alongside it — the first is what has to be fixed, and the second
      // is usually just the page being somewhere else by then.
      if (origin.title !== info.title) {
        err.rejsudai = {
          title: origin.title,
          detail: [origin.detail, `Trying again stopped elsewhere: ${info.title}`].filter(Boolean).join(' '),
          hint: origin.hint,
          // The step too, or the report reads "Alias … does not exist. While:
          // opening the Expense module" — a title and a step from two different
          // failures.
          step: origin.step,
          while: origin.while,
        };
        if (originShot) err.rejsudaiScreenshot = originShot;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. TOTP
// ---------------------------------------------------------------------------
async function getOTP() {
  if (process.env.TOTP_SECRET) {
    const totp = new TOTP({ secret: process.env.TOTP_SECRET, algorithm: 'SHA1', digits: 6, period: 30 });
    const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (secondsLeft < 5) {
      console.log(`TOTP window almost expired (${secondsLeft}s left), waiting for fresh code...`);
      await new Promise(r => setTimeout(r, (secondsLeft + 1) * 1000));
    }
    return totp.generate();
  }
  // No TOTP_SECRET configured, so a person has to supply the code: the desktop
  // app shows its 2FA prompt, a terminal run is asked on stderr. Both go
  // through askUser so there is only ever one reader on stdin.
  return askForOTP();
}

// ---------------------------------------------------------------------------
// 3. LOGIN
// ---------------------------------------------------------------------------
// Whatever the login page is complaining about on screen, so a rejected
// credential is reported with the site's own wording rather than a timeout.
async function loginPageMessage(page) {
  try {
    const texts = await page.locator('.alert, .error, .message, [role="alert"]').allInnerTexts();
    const msg = texts.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean)[0];
    return msg ? `indfak2 says: "${msg}"` : null;
  } catch {
    return null;
  }
}

async function login(page) {
  await page.goto('https://indfak2.dk/login/#/');
  await page.locator('#select_value_label_0').click();
  await page.getByText('English').click();
  await page.getByRole('textbox', { name: 'User name' }).fill(process.env.INDFAK_USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.INDFAK_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();

  // A wrong username or password never reaches the 2FA step, so waiting for the
  // code field is what separates "bad credentials" from "bad TOTP code".
  const codeBox = page.getByRole('textbox', { name: 'Code *' });
  try {
    await codeBox.waitFor({ timeout: 20000 });
  } catch {
    throw failure('indfak2 did not accept the username or password.', {
      detail: await loginPageMessage(page),
      hint: 'Check the login email and password in Settings (Credentials).',
    });
  }
  await codeBox.fill(await getOTP());
  await page.getByRole('button', { name: 'Ok' }).click();

  try {
    await page.getByRole('button', { name: 'Expense' }).waitFor({ timeout: 10000 });
  } catch {
    throw failure('Two-factor code rejected.', {
      detail: await loginPageMessage(page) || 'indfak2 stayed on the code screen after the code was submitted.',
      hint: process.env.TOTP_SECRET
        ? 'Check the 2FA secret in Settings, and that this Mac’s clock is set automatically — a drifting clock invalidates every code.'
        : 'The code was already expired or mistyped. Run again and enter a fresh code.',
    });
  }
  console.log('Logged in.');
}

// ---------------------------------------------------------------------------
// 4. NAVIGATE TO EXPENSE MODULE
// ---------------------------------------------------------------------------
async function openExpenseModule(page) {
  setStep('expense_module', 'opening the Expense module');
  const outer = page.locator('iframe[title="ibistic"]').contentFrame();
  // The draft stage is retried from the top, so this runs again from wherever
  // the last attempt broke — usually inside the module already, on a half-filled
  // draft form. The portal's own "Expense" button is no use there (gone, or
  // matching three elements once a wizard has run): waiting for it times out
  // and the run is then reported as a slow Expense module, which buries the
  // real failure — a wrong alias, say. #ecm_link is the way back to the drafts
  // list from inside the module, the same door submitSettlement uses.
  const inModule = (await outer.locator('#ecm_link').count().catch(() => 0)) > 0;
  const backViaNav = inModule &&
    await outer.locator('#ecm_link').click({ timeout: 8000 }).then(() => true).catch(() => false);
  if (backViaNav) {
    console.log('  Already inside the Expense module — went back to the drafts list.');
  } else {
    await page.getByRole('button', { name: 'Expense' }).first().click();
    await outer.locator('#ecm_link').waitFor({ timeout: 15000 });
    await outer.locator('#ecm_link').click();
  }

  const inner = outer.locator('iframe').contentFrame();

  for (let attempt = 0; attempt < 3; attempt++) {
    const visible = await inner.locator('#inner-draft-container').isVisible().catch(() => false);
    if (visible) break;
    await new Promise(r => setTimeout(r, 2000));
    if (attempt < 2) {
      console.log(`#inner-draft-container not visible yet (attempt ${attempt + 1}), retrying...`);
      await outer.locator('#ecm_link').click().catch(() => {});
    }
  }

  try {
    await inner.locator('#inner-draft-container').waitFor({ timeout: 10000 });
  } catch {
    throw failure('The Expense module in indfak2 never loaded.', {
      detail: 'The draft list (#inner-draft-container) stayed empty after three attempts.',
      hint: 'Usually indfak2 being slow — run again. If it keeps happening, open indfak2 in a browser and check the account still has access to Expense.',
    });
  }
  return { outer, inner };
}

// The drafts grid's name cell for one draft, and every name the grid shows (for
// a report when it is not there). Names are compared whole — case and runs of
// whitespace aside — because a substring match lets "* Oslo" open
// "* Oslo Workshop", and a run that reconnects to its draft must never file
// into someone else's. The first *visible* match wins: ui-grid can render a
// cell twice.
const sameDraftName = (a, b) => String(a).replace(/\s+/g, ' ').trim().toLowerCase()
  === String(b).replace(/\s+/g, ' ').trim().toLowerCase();

async function findDraftCell(inner, name) {
  const cells = inner.locator('#inner-draft-container .ui-grid-row h4');
  const texts = await cells.allTextContents().catch(() => []);
  const names = [...new Set(texts.map(t => t.trim()).filter(Boolean))];
  for (let i = 0; i < texts.length; i++) {
    if (!sameDraftName(texts[i], name)) continue;
    const cell = cells.nth(i);
    if (await cell.isVisible().catch(() => false)) return { cell, names };
  }
  return { cell: null, names };
}

// ---------------------------------------------------------------------------
// 5. LINE-ITEMS TAB + FAB HELPERS
// ---------------------------------------------------------------------------
async function ensureLineItemsTab(inner, draftName = null) {
  // Wait for any success/error toast to clear — it intercepts pointer events
  await inner.locator('#toast-container').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

  // Recovery: if on draft list (e.g. after a previous Escape), re-enter the draft first.
  if (await inner.locator('#inner-draft-container').isVisible().catch(() => false) && draftName) {
    const { cell } = await findDraftCell(inner, draftName);
    if (cell) {
      console.log(`  Re-entering draft "${draftName}".`);
      await cell.click();
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // Ensure we're on the line-items tab with the FAB visible before trying to open it.
  //
  // Two distinct states after a previous allocation:
  //   A) FAB in DOM but hidden  → already on line-items tab, page still transitioning;
  //      do NOT navigate (a.nth(4) would resolve to the hidden FAB and time out).
  //      Just wait for the FAB to become visible.
  //   B) FAB not in DOM at all  → on a different tab/page; navigate to line-items tab first.
  const mainFab = inner.locator('.mfb-component__button--main').first();
  const fabInDom = (await inner.locator('.mfb-component__button--main').count()) > 0;
  if (!fabInDom) {
    // We may be stranded on the transaction-selection page or a cost form left
    // open by a failure: cancel out first, then use the breadcrumb (the draft
    // name is a link back to the draft's line-items view).
    await closeAllocationDialogIfOpen(inner);
    if ((await inner.locator('.mfb-component__button--main').count()) === 0 && draftName) {
      const crumb = inner.locator('a').filter({ hasText: draftName }).first();
      if (await crumb.isVisible().catch(() => false)) {
        console.log('  Returning to the draft via breadcrumb.');
        await crumb.click().catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    if ((await inner.locator('.mfb-component__button--main').count()) === 0) {
      // Not on the line-items tab — navigate there.
      const lineItemsTab = inner.getByRole('link', { name: /expense line|line item|lines|udlæg/i });
      if (await lineItemsTab.count() > 0) {
        await lineItemsTab.first().click();
      } else {
        // On the draft-form page, the line-items tab is a.nth(4) ONLY when the FAB
        // is not yet in the DOM (i.e., we haven't been to that tab this session).
        await inner.locator('a').nth(4).click().catch(() => {});
      }
    }
  }
  // Wait for the FAB to become visible (handles both navigation and already-on-tab cases)
  await mainFab.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  // The FAB is in the DOM (hidden) even on the transaction-selection/cost
  // sub-pages, so "in DOM" alone proves nothing. If it never became VISIBLE we
  // are stranded on a sub-page: cancel out and use the breadcrumb.
  if (!(await mainFab.isVisible().catch(() => false))) {
    await closeAllocationDialogIfOpen(inner);
    if (!(await mainFab.isVisible().catch(() => false)) && draftName) {
      const crumb = inner.locator('a').filter({ hasText: draftName }).first();
      if (await crumb.isVisible().catch(() => false)) {
        console.log('  Returning to the draft via breadcrumb.');
        await crumb.click().catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    await mainFab.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  }
  await new Promise(r => setTimeout(r, 400));
  return mainFab;
}

// kind: 'card' → "Create from a card transaction" (2nd child)
//       'normal' → "Normal cost" (matched by label, falling back to 1st child)
async function openFabChild(inner, mainFab, kind) {
  // Hover over the main FAB button to reveal child buttons (MFB uses CSS :hover
  // transitions). Non-fatal — the forced-open fallback below works without it.
  await mainFab.hover({ timeout: 5000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 400));

  let childBtn;
  if (kind === 'card') {
    childBtn = inner.locator('li:nth-child(2) > .mfb-component__button--child').first();
  } else {
    const labels = await inner.locator('.mfb-component__button--child')
      .evaluateAll(els => els.map(e => e.getAttribute('data-mfb-label') || e.getAttribute('title') || e.textContent.trim()))
      .catch(() => []);
    console.log(`  FAB children: ${JSON.stringify(labels)}`);
    const idx = labels.findIndex(l => /normal/i.test(l || ''));
    childBtn = idx >= 0
      ? inner.locator('.mfb-component__button--child').nth(idx)
      : inner.locator('li:nth-child(1) > .mfb-component__button--child').first();
  }

  // The synthetic hover doesn't always expand the MFB menu, leaving children at
  // scale(0) (zero bounding box → never "visible" to Playwright). Fall back to
  // forcing the menu open via its data-mfb-state attribute, then force/DOM click.
  try {
    await childBtn.click({ timeout: 5000 });
  } catch {
    console.log('  FAB child not clickable after hover — forcing menu open.');
    await inner.locator('ul[data-mfb-toggle]').first()
      .evaluate(el => el.setAttribute('data-mfb-state', 'open')).catch(() => {});
    await childBtn.locator('..').hover().catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    try {
      await childBtn.click({ force: true, timeout: 3000 });
    } catch {
      // Last resort: dispatch the click at DOM level — fires ng-click regardless
      // of geometry/visibility.
      try {
        await childBtn.evaluate(el => el.click(), undefined, { timeout: 5000 });
      } catch {
        throw new Error(`FAB child ("${kind}") not present — not on the line-items tab?`);
      }
    }
  }
}

// The "allocation dialog" is really a sub-PAGE (breadcrumb Drafts > draft >
// New cost): the transaction-selection step shows an " Allocate" button, the
// cost form shows Save/Cancel. NOTE: do not detect it via `.stretch` — that
// class is also on page containers like #inner-draft-container.
async function allocationPageOpen(inner) {
  // The " Allocate" button only becomes visible once a row is selected, so also
  // check the page title/breadcrumb of the transaction-selection step.
  if (await inner.getByRole('button', { name: ' Allocate' }).isVisible().catch(() => false)) return true;
  return inner.getByText(/create from a card transaction/i).first().isVisible().catch(() => false);
}

// Close a left-open allocation/cost form (from a previous no-match or failed
// save) via its Cancel button — never Escape, which navigates the outer
// Angular frame and destroys the inner iframe.
async function closeAllocationDialogIfOpen(inner) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const allocateVisible = await allocationPageOpen(inner);
    const cancelBtn = inner.getByRole('button', { name: /^\s*(cancel|annuller)\s*$/i }).first();
    const cancelVisible = await cancelBtn.isVisible().catch(() => false);
    if (!allocateVisible && !cancelVisible) return;
    console.log('  Closing open allocation/cost form.');
    if (cancelVisible) await cancelBtn.click().catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    // a "discard changes?" confirmation may follow
    const confirm = inner.getByRole('button', { name: /^(yes|ok|ja|discard)\s*$/i }).first();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click().catch(() => {});
      await new Promise(r => setTimeout(r, 800));
    }
  }
  if (await allocationPageOpen(inner)) console.warn('  ⚠ Allocation form still open after close attempts.');
}

// ---------------------------------------------------------------------------
// 5b. CHECK FOR MATCHING CARD TRANSACTION
//    Opens the allocation dialog, scans for vendor + closest amount match.
//    Returns row info if found & selected, null if not found.
// ---------------------------------------------------------------------------
async function findMatchingTransaction(page, outer, inner, invoice, draftName = null) {
  setStep('transactions', `searching the card transactions for ${invoice.vendor || 'this document'}`);
  // If the transaction-selection page is already open from a previous no-match,
  // reuse it — searching the same grid avoids navigation issues entirely.
  // (Detected via the " Allocate" button, NOT `.stretch` — see allocationPageOpen.)
  const dialogAlreadyOpen = await allocationPageOpen(inner);

  if (!dialogAlreadyOpen) {
    const mainFab = await ensureLineItemsTab(inner, draftName);
    await openFabChild(inner, mainFab, 'card');

    const stretch = inner.locator('.ng-scope.ng-isolate-scope.stretch');
    if (await stretch.isVisible()) await stretch.click();
  } else {
    console.log('  Reusing open allocation dialog for next invoice search.');
  }

  // The grid may still be reloading after a previous allocation. If no checkbox
  // ever appears the grid is EMPTY (all transactions already allocated) — that
  // is a normal no-match, not an error.
  try {
    await inner.locator('.file-selector').first().waitFor({ state: 'visible', timeout: dialogAlreadyOpen ? 30000 : 15000 });
  } catch {
    console.log('  Transaction grid shows no selectable rows (all transactions allocated?) — no match.');
    return null;
  }

  // A row is a candidate when it mentions the vendor OR any keyword Claude
  // extracted from the invoice (brand, legal name, product, domain) — card
  // statement descriptors often use the product name (e.g. "Claude.ai
  // subscription" for an Anthropic invoice).
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keywords = [...new Set([invoice.vendor, ...(invoice.keywords || [])].filter(Boolean))];
  const keywordRegex = new RegExp(keywords.map(escapeRe).join('|'), 'i');
  const rowSelectors = ['.ui-grid-row', 'tr[role="row"]', '[role="row"]', '.grid-group-item'];

  let vendorRows = [];
  for (const sel of rowSelectors) {
    const candidates = inner.locator(sel).filter({ hasText: keywordRegex });
    const count = await candidates.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) vendorRows.push(candidates.nth(i));
      break;
    }
  }

  if (vendorRows.length === 0) {
    const allRows = await inner.locator('.ui-grid-row, [role="row"]').allTextContents().catch(() => []);
    const summary = [...new Set(allRows.map(r => r.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 10);
    console.log(`No card transaction mentions any of: ${keywords.join(', ')}.`);
    console.log('Available rows:', summary);
    return null; // leave dialog open — next call will reuse it
  }

  // Strict selection among keyword candidates:
  //   • transaction date within ±3 days of the invoice date
  //   • EXACT amount in the invoice currency — except when the row shows no
  //     amount in that currency at all (the grid sometimes displays DKK only
  //     for foreign-currency charges), where the amount check is skipped.
  // Normalize both "1,340.89" (US) and "1.340,89" (DA) — the last separator
  // present is the decimal point.
  const parseRowAmounts = text => {
    const out = [];
    const re = /(\d[\d,.]*)\s*(EUR|DKK|USD|GBP|SEK|NOK)/gi;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[1];
      const normalized = raw.includes(',') && raw.includes('.')
        ? (raw.lastIndexOf(',') > raw.lastIndexOf('.')
            ? raw.replace(/\./g, '').replace(',', '.')
            : raw.replace(/,/g, ''))
        : raw.replace(',', '.');
      out.push({ amount: parseFloat(normalized), currency: m[2].toUpperCase() });
    }
    return out;
  };

  const invoiceDate = invoice.date ? new Date(invoice.date) : null;
  const DAY = 24 * 60 * 60 * 1000;
  const rejected = [];
  const dateOkRows = [];

  for (const row of vendorRows) {
    const text = ((await row.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();

    // Rows show dates like "Tue, May 5, 2026"
    let dateOk = !invoiceDate; // no parsed invoice date → can't constrain
    const dm = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]+ \d{1,2}, \d{4})/);
    if (invoiceDate && dm) {
      const rowDate = new Date(dm[1]);
      dateOk = !isNaN(rowDate) && Math.abs(rowDate - invoiceDate) <= 3 * DAY;
    }
    if (!dateOk) { rejected.push({ row: text, reason: 'date outside ±3 days' }); continue; }

    const sameCurrency = parseRowAmounts(text).filter(a => a.currency === (invoice.currency || '').toUpperCase());
    dateOkRows.push({ row, text, amount: sameCurrency.length ? sameCurrency[0].amount : null });
  }

  // 1) Single row with the exact invoice amount.
  let matchingRows = null, matchReason = null;
  const exact = dateOkRows.find(r => r.amount !== null && Math.abs(r.amount - invoice.amount) < 0.005);
  if (exact) {
    matchingRows = [exact];
    matchReason = `keyword + date within ±3 days + exact amount ${invoice.amount} ${invoice.currency}`;
  }

  // 2) Several rows that SUM to the invoice amount — travel-account invoices
  // (e.g. CWT) are charged as one transaction per ticket/fee, so a 2130 DKK
  // invoice can be 1324 + 781 + 25 on the card statement.
  if (!matchingRows) {
    const amountRows = dateOkRows.filter(r => r.amount !== null);
    if (amountRows.length >= 2 && amountRows.length <= 12) {
      for (let mask = 3; mask < (1 << amountRows.length); mask++) {
        if ((mask & (mask - 1)) === 0) continue; // skip single-row subsets (handled above)
        const subset = amountRows.filter((_, i) => mask & (1 << i));
        const sum = subset.reduce((s, r) => s + r.amount, 0);
        if (Math.abs(sum - invoice.amount) < 0.01) {
          matchingRows = subset;
          matchReason = `keyword + date within ±3 days + ${subset.length} transactions summing to ${invoice.amount} ${invoice.currency} (${subset.map(r => r.amount).join(' + ')})`;
          break;
        }
      }
    }
  }

  // 2b) Resume after a partial allocation: earlier lines of a multi-transaction
  // invoice were already allocated, so the REMAINING same-vendor rows sum to
  // less than the invoice total. Allocate them all; the match_reason makes the
  // partial nature visible in the manifest for review.
  if (!matchingRows) {
    const amountRows = dateOkRows.filter(r => r.amount !== null);
    const sum = amountRows.reduce((s, r) => s + r.amount, 0);
    if (amountRows.length >= 1 && sum > 0 && sum < invoice.amount - 0.005) {
      matchingRows = amountRows;
      matchReason = `partial/resume: ${amountRows.length} remaining transaction(s) summing to ${sum.toFixed(2)} of invoice total ${invoice.amount} ${invoice.currency}`;
    }
  }

  // 3) Single row showing no amount in the invoice currency at all (the grid
  // sometimes displays DKK only for foreign-currency charges) — amount check
  // has to be skipped, so this is the weakest match and tried last.
  if (!matchingRows) {
    const noAmount = dateOkRows.find(r => r.amount === null);
    if (noAmount) {
      matchingRows = [noAmount];
      matchReason = `keyword + date within ±3 days (row shows no ${invoice.currency} amount; amount check skipped)`;
    }
  }

  if (!matchingRows) {
    for (const r of dateOkRows) rejected.push({ row: r.text, reason: `amount not exactly ${invoice.amount} ${invoice.currency} and no subset sums to it` });
    console.log(`No transaction passed strict matching for "${invoice.vendor}" (need date within ±3 days of ${invoice.date} and exact/summed ${invoice.amount} ${invoice.currency}).`);
    for (const r of rejected) console.log(`  Rejected [${r.reason}]: ${r.row}`);
    return null; // leave dialog open — next call will reuse it
  }

  // Do NOT select anything here — selecting several rows and clicking Allocate
  // only allocates ONE of them. The caller allocates one line per row via
  // allocateOneTransaction (re-finding each row by its text).
  console.log(`Found matching transaction row(s) for "${invoice.vendor}" (${matchReason}):`);
  for (const r of matchingRows) console.log(`  → ${r.text}`);
  return {
    rows: matchingRows.map(r => ({ text: r.text })),
    transaction_row: matchingRows.map(r => r.text).join(' || '),
    match_reason: matchReason,
  };
}

// ---------------------------------------------------------------------------
// 5c. ALLOCATE ONE TRANSACTION → one expense line with the invoice attached.
// Multi-transaction invoices call this once per transaction; the grid loses the
// allocated row each time, so the target row is re-found by its full text.
// ---------------------------------------------------------------------------
async function allocateOneTransaction(page, inner, rowText, uploadPath, opts = {}) {
  setStep('line', 'creating the expense line from the card transaction');
  // opts.openSelectionPage: the caller tracks page state — the first allocation
  // reuses the selection page left open by findMatchingTransaction; subsequent
  // ones start from the line-items tab after the previous line's save.
  if (opts.openSelectionPage) {
    const mainFab = await ensureLineItemsTab(inner, opts.draftName);
    await openFabChild(inner, mainFab, 'card');
  }
  try {
    await inner.locator('.file-selector').first().waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    return { errors: [`transaction grid empty when allocating "${rowText.slice(0, 60)}"`], fields: null };
  }
  await new Promise(r => setTimeout(r, 500));

  const target = rowText.replace(/\s+/g, ' ').trim();
  let row = null;
  for (const sel of ['.ui-grid-row', 'tr[role="row"]', '[role="row"]', '.grid-group-item']) {
    const all = inner.locator(sel);
    const n = await all.count();
    for (let i = 0; i < n; i++) {
      const t = ((await all.nth(i).textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (t === target) { row = all.nth(i); break; }
    }
    if (row) break;
  }
  if (!row) return { errors: [`transaction row not found on grid: "${target.slice(0, 60)}"`], fields: null };

  const selBox = row.locator('.file-selector').first();
  let selected = false;
  for (let attempt = 0; attempt < 3 && !selected; attempt++) {
    await selBox.click().catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    selected = await selBox.evaluate(el => el.classList.contains('selected')).catch(() => false);
  }
  if (!selected) return { errors: [`could not select transaction row: "${target.slice(0, 60)}"`], fields: null };

  return allocateAndUpload(page, inner, uploadPath, opts);
}

// ---------------------------------------------------------------------------
// 6. PICK OR CREATE DRAFT  (single-file mode only)
// ---------------------------------------------------------------------------
async function pickOrCreateDraft(inner, invoice) {
  await inner.locator('#inner-draft-container').waitFor({ timeout: 15000 });

  // The draft list is a ui-grid: names are h4 cells inside .ui-grid-row, NOT
  // links — the only link is the "+" new-draft button. Rows render after the
  // container appears; a timeout here just means there are no drafts yet.
  await inner.locator('#inner-draft-container .ui-grid-row').first().waitFor({ timeout: 5000 }).catch(() => {});

  const newDraftLink = inner.locator('#inner-draft-container a').first();
  const nameCells    = inner.locator('#inner-draft-container .ui-grid-row h4');
  const names        = (await nameCells.allTextContents().catch(() => [])).map(t => t.trim());
  const existingDrafts = names
    .map((text, index) => ({ text, index }))
    .filter(d => d.text.length > 2);

  if (existingDrafts.length === 0) {
    console.log('No existing drafts. Creating new draft.');
    return { action: 'new', link: newDraftLink };
  }

  console.log(`Found ${existingDrafts.length} existing draft(s):`, existingDrafts.map(d => d.text));

  const promptText = `You are helping allocate an expense invoice to an expense report draft.

Invoice details:
- Vendor: ${invoice.vendor}
- Date: ${invoice.date}
- Amount: ${invoice.amount} ${invoice.currency}

Existing draft expense reports:
${existingDrafts.map((d, i) => `${i}: "${d.text}"`).join('\n')}

Which draft (by index) should this invoice be added to? Reply with just the index number, or "new" if none is suitable. A draft is suitable if it clearly covers the same type of expense or period.`;

  // Static system prompt cached so repeated calls in the same session are cheaper
  const msg = await callClaude({ purpose: 'pick_draft', subject: invoice.vendor }, {
    model: CLAUDE_MODEL,
    max_tokens: 16,
    system: [{
      type: 'text',
      text: 'You are helping allocate expense invoices to expense report drafts. Reply with only a number or "new".',
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: promptText }]
  });

  const answer = msg.content[0].text.trim().toLowerCase();
  if (answer === 'new' || isNaN(parseInt(answer))) {
    console.log(`Claude chose to create a new draft (answer: "${answer}").`);
    return { action: 'new', link: newDraftLink };
  }

  const chosen = existingDrafts[parseInt(answer)];
  console.log(`Claude chose existing draft: "${chosen.text}"`);
  return { action: 'existing', link: nameCells.nth(chosen.index) };
}

// ---------------------------------------------------------------------------
// 7. FILL NEW DRAFT FORM
//    opts.draftName  — overrides the auto-generated name
//    opts.alias      — overrides PROJECT_ALIAS; uses link-based option search
// ---------------------------------------------------------------------------
async function selectByPartialLabel(locator, partialLabel) {
  await locator.evaluate((el, label) => new Promise((resolve, reject) => {
    const check = () => {
      const opt = Array.from(el.options).find(o => o.text.trim().includes(label));
      if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change')); resolve(); }
      else if (el.options.length > 1) reject(new Error(`Option containing "${label}" not found. Available: ${Array.from(el.options).map(o => o.text.trim()).join(', ')}`));
      else setTimeout(check, 200);
    };
    check();
  }), partialLabel);
}

// Alias codes indfak2 actually offered for the search term — the useful half of
// a "no such alias" report.
async function aliasSearchResults(inner) {
  try {
    const texts = await inner.getByRole('link').allInnerTexts();
    return [...new Set(texts.map(t => t.replace(/\s+/g, ' ').trim()).filter(t => /^\d{6,}/.test(t)))].slice(0, 8);
  } catch {
    return [];
  }
}

async function readFormFields(inner) {
  const fields = {};
  const inputs = await inner.locator('input[type="text"], input:not([type]), textarea, select').all();
  for (const el of inputs) {
    const label = await el.evaluate(node => {
      const id = node.id;
      const name = node.getAttribute('name') || node.getAttribute('placeholder') || '';
      const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
      return (labelEl ? labelEl.textContent.trim() : name).replace(/\s*\*\s*$/, '').trim();
    }).catch(() => '');
    const value = await el.inputValue().catch(() => '');
    if (label && value) fields[label] = value;
  }
  return fields;
}

async function checkErrors(inner) {
  const errorEls = await inner.locator('.alert-danger, [role="alert"]').all();
  const msgs = [];
  for (const el of errorEls) {
    if (!await el.isVisible().catch(() => false)) continue;
    const txt = (await el.textContent().catch(() => '')).trim();
    if (txt) msgs.push(txt);
  }
  return msgs;
}

async function saveAndCheck(inner, buttonLocator) {
  await buttonLocator.click();
  await new Promise(r => setTimeout(r, 1500));
  const errors = await checkErrors(inner);
  if (errors.length) console.warn('⚠ Page errors after save:', errors);
  return errors;
}

// Type a date into an Angular masked date input with REAL keystrokes — fill()
// sets the value without key events and leaves the directive's model invalid.
// Mirrors whatever format the field's current value uses (observed default
// M/DD/YYYY), disambiguating day/month position against today's date.
async function typeDateInto(box, isoDate) {
  if (!(await box.count())) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dd = String(d).padStart(2, '0');
  const current = (await box.inputValue().catch(() => '')) || '';
  const today = new Date();
  const sepMatch = current.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/);
  let formatted;
  if (sepMatch) {
    const sep = sepMatch[2];
    const a = Number(sepMatch[1]), b = Number(sepMatch[3]);
    // The current value may be prefilled with a date other than today (e.g. the
    // trip departure), so "doesn't read as today" must not imply day-first.
    // Day-first only when proven: first component can't be a month, or the
    // value reads as today in D/M order but not in M/D order. Otherwise the
    // tenant's observed M/DD/YYYY default wins.
    let monthFirst;
    if (a > 12) monthFirst = false;
    else if (b > 12) monthFirst = true;
    else monthFirst = !(a === today.getDate() && b === today.getMonth() + 1
      && !(a === today.getMonth() + 1 && b === today.getDate()));
    formatted = monthFirst ? `${m}${sep}${dd}${sep}${y}` : `${dd}${sep}${m}${sep}${y}`;
  } else {
    formatted = `${m}/${dd}/${y}`;
  }
  await box.click().catch(() => {});
  await box.press('ControlOrMeta+a').catch(() => {});
  await box.pressSequentially(formatted, { delay: 60 }).catch(() => {});
  await box.press('Tab').catch(() => {});
  await new Promise(r => setTimeout(r, 400));
  return box.inputValue().catch(() => '?');
}

// Save a line-item cost form and VERIFY it actually closed. Validation
// failures show an "Errors count: N" banner (NOT an .alert-danger, so
// checkErrors misses it) and keep the form open; a save click can also be
// silently swallowed while the form is still settling — retry in that case.
async function saveLineAndVerify(inner, label = 'line save') {
  for (let attempt = 0; attempt < 3; attempt++) {
    const saveBtn = inner.getByRole('button', { name: ' Save' }).first();
    if (!(await saveBtn.isVisible().catch(() => false))) return []; // form already closed
    await saveBtn.click().catch(() => {});
    await new Promise(r => setTimeout(r, 2500));

    const banner = inner.getByText(/Errors count: \d+/).first();
    if (await banner.isVisible().catch(() => false)) {
      const count = ((await banner.textContent().catch(() => '')) || '').trim();
      const hints = (await inner.locator('.has-error:visible, .text-danger:visible, [class*="error-message"]:visible').allTextContents().catch(() => []))
        .map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 120).slice(0, 6);
      return [`${label} failed (${count})${hints.length ? ': ' + hints.join(' | ') : ''}`];
    }

    const formOpen = await inner.getByRole('button', { name: /^\s*(cancel|annuller)\s*$/i }).first().isVisible().catch(() => false);
    if (!formOpen) {
      await inner.locator('#toast-container').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
      return [];
    }
    console.log(`  Save did not close the form (attempt ${attempt + 1}/3) — retrying.`);
  }
  return [`${label}: form still open after 3 save attempts (no error banner shown)`];
}

// Derives the Purpose dropdown label from available signals.
// Priority: travel destination country > vendor_country on any expense doc >
// DKK currency on any expense doc > EXPENSE_PURPOSE env fallback.
function derivePurpose(travel, docs) {
  if (travel) {
    return (travel.destination_country && !/denmark/i.test(travel.destination_country))
      ? '2 - Outside Denmark' : '1 - Denmark';
  }
  const expenses = (docs || []).filter(d => d.role !== 'supporting');
  for (const d of expenses) {
    if (d.vendor_country) {
      return /denmark/i.test(d.vendor_country) ? '1 - Denmark' : '2 - Outside Denmark';
    }
  }
  // Currency fallback: DKK is only used in Denmark
  if (expenses.some(d => d.currency && d.currency.toUpperCase() === 'DKK')) {
    return '1 - Denmark';
  }
  return EXPENSE_PURPOSE;
}

// Puts one alias code into the draft's Alias field. Split out of fillNewDraft
// because a code indfak2 does not know can be answered with another one and
// tried again, which is not worth re-filling the whole form for. `byPinnedOption`
// is the configured-label path, and applies only to the alias the run started
// with — anything chosen afterwards is searched for by code.
async function selectAlias(page, inner, alias, { byPinnedOption = false } = {}) {
  setStep('alias', `selecting the project alias ${alias}`);
  const aliasField = inner.getByRole('textbox', { name: 'Alias *' });
  await aliasField.click();

  await page.waitForResponse(r => r.url().includes('pinned_and_most_used'), { timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));

  const searchByCode = async () => {
    const searchResponse = page.waitForResponse(r => r.url().includes('dimension_usages'), { timeout: 15000 });
    await aliasField.fill(alias);
    await aliasField.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true })));
    await searchResponse;
    await new Promise(r => setTimeout(r, 500));
  };

  let aliasOption;
  if (!byPinnedOption) {
    // Search by code: the normal path for a new CLI installation, and the only
    // path once an alias has been chosen in answer to a question.
    await searchByCode();
    aliasOption = inner.getByRole('link', { name: new RegExp('^' + alias) }).first();
  } else {
    // Config mode: check pinned list first, fall back to search
    aliasOption = inner.getByText(PROJECT_ALIAS_OPTION, { exact: false });
    if (!await aliasOption.isVisible().catch(() => false)) await searchByCode();
  }

  // A wrong alias code fails here, and as a bare locator timeout it is
  // unreadable — so say which alias was searched for and what indfak2 offered
  // instead.
  try {
    await aliasOption.waitFor({ timeout: 10000 });
  } catch {
    const offered = await aliasSearchResults(inner);
    throw failure(`Alias "${alias}" does not exist in indfak2, or this account cannot use it.`, {
      detail: offered.length
        ? `Searching for "${alias}" returned: ${offered.join(' · ')}`
        : `Searching for "${alias}" returned no projects.`,
      hint: 'Fix the alias on the settlement, or set the right default alias in Settings.',
    });
  }
  await aliasOption.click();
  await new Promise(r => setTimeout(r, 800));
}

async function fillNewDraft(page, inner, invoice, opts = {}) {
  const alias       = opts.alias     || PROJECT_ALIAS;
  const expenseName = opts.draftName || `* ${invoice.vendor} - ${invoice.date.slice(0, 7)}`;
  const travel      = opts.travel    || null;

  if (!alias) {
    throw failure('No project alias is configured.', {
      hint: 'Add an alias in the app, or set EXPENSE_ALIAS before running the CLI.',
    });
  }

  setStep('draft', `creating the draft "${expenseName}"`);
  await inner.getByRole('textbox', { name: 'Name *' }).fill(expenseName);
  // Trips use Type 2 ("Travel settlements (days,expenses,transp.)"), which
  // unlocks the Travel details section; everything else uses EXPENSE_TYPE.
  await selectByPartialLabel(inner.getByLabel('Type'), travel ? 'Travel settlements' : EXPENSE_TYPE);
  await new Promise(r => setTimeout(r, 1000)); // form re-renders on type change

  // A wrong alias is the commonest configuration mistake there is, and unlike a
  // page that misbehaved it has an answer the run can act on: another alias. So
  // it is asked about right here, with the draft form still open on the field,
  // instead of costing the whole draft stage a restart.
  let aliasUsed = alias;
  let byPinnedOption = !opts.alias && !!PROJECT_ALIAS_OPTION;
  for (let attempt = 1; ; attempt++) {
    try {
      await selectAlias(page, inner, aliasUsed, { byPinnedOption });
      break;
    } catch (err) {
      if (page.isClosed()) throw err;
      const next = await askAboutAlias(aliasUsed, err, attempt);
      if (next === null) throw err;
      // An alias picked from the library is looked up by its code — the pinned
      // label belongs to the alias the run was configured with, not to this one.
      if (next !== aliasUsed) byPinnedOption = false;
      aliasUsed = next;
      console.log(`  Trying alias ${aliasUsed}.`);
    }
  }
  setStep('draft', 'filling in the draft form');

  // Travel details (Type 2 only): Travel Dates + Departure/Destination places.
  // Line-item dates must fall inside the travel window, so this matters beyond
  // bookkeeping: without it, normal-cost lines dated during the trip are
  // rejected with "Invalid date".
  if (travel) {
    if (travel.start) {
      const v = await typeDateInto(inner.getByLabel(/^departure/i).first(), travel.start);
      console.log(`  Travel departure date: "${v}" (${travel.start})`);
    }
    if (travel.end) {
      const v = await typeDateInto(inner.getByLabel(/^arrival/i).first(), travel.end);
      console.log(`  Travel arrival date: "${v}" (${travel.end})`);
    }
    // Two "Country" selects + two "City or Town" inputs: [0] = departure place,
    // [1] = destination place.
    const countries = inner.getByLabel(/^country/i);
    if (travel.origin_country && await countries.count() >= 1) {
      await selectByPartialLabel(countries.nth(0), travel.origin_country)
        .catch(e => console.log(`  Origin country select failed: ${e.message}`));
    }
    if (travel.destination_country && await countries.count() >= 2) {
      await selectByPartialLabel(countries.nth(1), travel.destination_country)
        .catch(e => console.log(`  Destination country select failed: ${e.message}`));
    }
    const cities = inner.getByLabel(/city or town/i);
    if (travel.origin_city && await cities.count() >= 1) await cities.nth(0).fill(travel.origin_city).catch(() => {});
    if (travel.destination_city && await cities.count() >= 2) await cities.nth(1).fill(travel.destination_city).catch(() => {});
    console.log(`  Travel: ${travel.origin_city || '?'} (${travel.origin_country || '?'}) → ${travel.destination_city || '?'} (${travel.destination_country || '?'}), ${travel.start} → ${travel.end}`);
  }

  const purposeLabel = derivePurpose(travel, opts.docs);

  // Try to fill Purpose before saving; fall back to post-save if options aren't ready yet
  let purposeFilledEarly = false;
  try {
    await Promise.race([
      selectByPartialLabel(inner.getByLabel('Purpose'), purposeLabel),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Purpose options not ready')), 5000)),
    ]);
    purposeFilledEarly = true;
    console.log('Purpose filled before first save.');
  } catch (e) {
    console.log(`Purpose not available yet (${e.message}), will fill after first save.`);
  }

  const formFields = await readFormFields(inner);
  const saveErrors1 = await saveAndCheck(inner, inner.getByRole('button', { name: 'Save', exact: true }));

  if (!purposeFilledEarly) {
    await selectByPartialLabel(inner.getByLabel('Purpose'), purposeLabel);
    const saveErrors2 = await saveAndCheck(inner, inner.getByRole('button', { name: 'Save', exact: true }));
    console.log(`New draft created: "${expenseName}"`);
    return { name: expenseName, alias: aliasUsed, formFields, saveErrors: [...saveErrors1, ...saveErrors2] };
  }

  console.log(`New draft created: "${expenseName}"`);
  return { name: expenseName, alias: aliasUsed, formFields, saveErrors: saveErrors1 };
}

// ---------------------------------------------------------------------------
// 8. ALLOCATE TRANSACTION + UPLOAD INVOICE
// ---------------------------------------------------------------------------

// Upload one attachment into the open line-item dialog:
// "Upload attachment" → #attachmentButton (file chooser) → Description → Save.
async function uploadAttachment(page, inner, filePath, description) {
  await inner.getByRole('button', { name: 'Upload attachment' }).click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    inner.locator('#attachmentButton').click(),
  ]);
  await fileChooser.setFiles(filePath);
  await inner.getByRole('textbox', { name: 'Description *' }).fill(description);
  return saveAndCheck(inner, inner.getByRole('button', { name: 'Save', exact: true }));
}

// Most card transactions auto-fill the cost form (description, cost type,
// purpose from the merchant category), but some — e.g. agency fees like CWT's
// "DIFTOL" — leave required fields empty and the save fails. Fill the gaps.
async function completeRequiredLineFields(inner, invoice) {
  // The cost form renders slowly after Allocate — wait for it, or every check
  // below silently no-ops on an empty page.
  const desc = inner.getByRole('textbox', { name: 'Description *' }).first();
  await desc.waitFor({ timeout: 15000 }).catch(() => {});
  if (await desc.count() && !((await desc.inputValue().catch(() => '')) || '').trim()) {
    const text = invoice ? `${invoice.vendor}${invoice.date ? ' ' + invoice.date : ''}` : 'Expense';
    await desc.fill(text).catch(() => {});
    console.log(`  Description filled: "${text}"`);
  }
  const ct = inner.getByLabel(/cost type/i).first();
  if (await ct.count()) {
    const val = (await ct.evaluate(el => el.value).catch(() => '')) || '';
    if (!val || /null/.test(val)) {
      const options = await ct.evaluate(el =>
        Array.from(el.options || []).map(o => o.text.trim()).filter(t => t && !/^\?/.test(t))
      ).catch(() => []);
      if (options.length) {
        const choice = await pickOption(options,
          invoice ? `Expense: ${invoice.vendor}, ${invoice.amount} ${invoice.currency}, ${invoice.date} (${invoice.document_kind || 'invoice'})` : 'Travel agency booking fee',
          'Pick the most appropriate cost type for this expense.');
        await selectByPartialLabel(ct, choice).catch(() => {});
        console.log(`  Cost type filled: "${choice}"`);
      }
    }
  }
  const purpose = inner.getByLabel(/^purpose/i).first();
  if (await purpose.count()) {
    const val = (await purpose.evaluate(el => el.value).catch(() => '')) || '';
    if (!val || /null/.test(val)) {
      await selectByPartialLabel(purpose, EXPENSE_PURPOSE).catch(() => {});
      console.log(`  Purpose filled: "${EXPENSE_PURPOSE}"`);
    }
  }
}

// opts.extraAttachments: [{ path, description }] — e.g. supporting documents
// (event programme, itinerary) attached to the same line item as the invoice.
// opts.invoice — parsed invoice metadata for filling missing required fields.
async function allocateAndUpload(page, inner, invoicePath, opts = {}) {
  const cardCell = inner.locator('[role="gridcell"]').filter({ hasText: /SEB Eurocard/i });
  if (await cardCell.isVisible().catch(() => false)) await cardCell.click();

  await inner.getByRole('button', { name: ' Allocate' }).click();
  await new Promise(r => setTimeout(r, 1000));

  const attachErrors = await uploadAttachment(page, inner, invoicePath, 'Invoice');
  await completeRequiredLineFields(inner, opts.invoice);
  const fields = await readFormFields(inner);
  fields['Attachment'] = path.basename(invoicePath);

  const extraNames = [];
  for (const extra of opts.extraAttachments || []) {
    console.log(`  Attaching supporting document: ${path.basename(extra.path)}`);
    const errs = await uploadAttachment(page, inner, extra.path, extra.description);
    attachErrors.push(...errs);
    extraNames.push(path.basename(extra.path));
  }
  if (extraNames.length) fields['Extra attachments'] = extraNames.join(', ');

  const lineErrors = await saveLineAndVerify(inner, `line save (${path.basename(invoicePath)})`);
  if (lineErrors.length) {
    console.warn(`  ⚠ ${lineErrors.join(' | ')}`);
    await page.screenshot({ path: `/tmp/rejsudai-save-fail-${Date.now()}.png`, fullPage: true }).catch(() => {});
    // Discard the unsaved form so the next expense starts from the line-items tab
    await closeAllocationDialogIfOpen(inner);
  } else {
    console.log(`  Allocated and attached: ${path.basename(invoicePath)}`);
  }
  await new Promise(r => setTimeout(r, 600));
  return { errors: [...attachErrors, ...lineErrors], fields };
}

// ---------------------------------------------------------------------------
// 8b. NORMAL COST LINE — out-of-pocket expenses that have no card transaction.
// Opens the "Normal cost" FAB child, fills description/date/amount/currency
// manually, uploads the receipt, saves.
// ---------------------------------------------------------------------------
async function createNormalCostLine(page, inner, invoice, uploadPath, opts = {}) {
  setStep('line', 'creating the normal-cost expense line');
  await closeAllocationDialogIfOpen(inner);
  const mainFab = await ensureLineItemsTab(inner, opts.draftName);
  await openFabChild(inner, mainFab, 'normal');
  await new Promise(r => setTimeout(r, 1000));

  // The normal-cost form is the same line-item dialog but with editable
  // date/amount/currency instead of a transaction grid. Fill the manual fields
  // first — the attachment upload ends with a dialog Save, which must not hit
  // an incomplete form.
  const description = inner.getByRole('textbox', { name: 'Description *' });
  await description.waitFor({ timeout: 10000 });
  const descText = `${invoice.vendor}${invoice.date ? ' ' + invoice.date : ''}`;
  await description.fill(descText).catch(e => console.log(`  Description fill failed: ${e.message}`));
  console.log(`  Description filled: "${descText}"`);

  // Date — must lie within the settlement's Departure/Arrival window (set from
  // the plan's trip dates in fillNewDraft), otherwise the save is rejected with
  // a misleading "Invalid date. Format: M/DD/YYYY" error. A cost paid outside
  // it — a train ticket bought weeks ahead — is dated at the nearer end of the
  // trip; the description above keeps the date it was actually paid.
  const travel = opts.travel || {};
  let lineDate = invoice.date;
  if (lineDate && travel.start && lineDate < travel.start) lineDate = travel.start;
  if (lineDate && travel.end && lineDate > travel.end) lineDate = travel.end;
  const dateBox = inner.getByRole('textbox', { name: /date/i }).first();
  if (await dateBox.count() && lineDate) {
    if (lineDate !== invoice.date) {
      console.log(`  Paid ${invoice.date}, outside the travel window (${travel.start} → ${travel.end}) — dating the line ${lineDate}.`);
    }
    const v = await typeDateInto(dateBox, lineDate);
    console.log(`  Date set to "${v}" (invoice date ${invoice.date}).`);
  }

  const amountBox = inner.getByRole('textbox', { name: /amount/i }).first();
  if (await amountBox.count()) {
    await amountBox.fill(String(invoice.amount)).catch(e => console.log(`  Amount fill failed: ${e.message}`));
    await amountBox.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true }))).catch(() => {});
  }

  // Currency is an autocomplete textbox (like Alias), not a <select>: type the
  // code, then click the matching option link.
  const curBox = inner.getByRole('textbox', { name: /currency/i }).first();
  if (await curBox.count() && invoice.currency) {
    const cur = invoice.currency.toUpperCase();
    await curBox.click().catch(() => {});
    await curBox.fill(cur).catch(e => console.log(`  Currency fill failed: ${e.message}`));
    await curBox.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true }))).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    const curOpt = inner.getByRole('link', { name: new RegExp('^' + cur, 'i') }).first();
    if (await curOpt.isVisible().catch(() => false)) await curOpt.click();
    else await curBox.press('Enter').catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    console.log(`  Currency set to "${await curBox.inputValue().catch(() => '?')}" (wanted ${cur}).`);
  }

  // Cost type — required dropdown with tenant-specific options; let Claude pick
  // the best fit for this expense (regex fallback to an "other"-like option).
  const costTypeSel = inner.getByLabel(/cost type/i).first();
  if (await costTypeSel.count()) {
    const options = await costTypeSel.evaluate(el =>
      Array.from(el.options || []).map(o => o.text.trim()).filter(t => t && !/^\?/.test(t))
    ).catch(() => []);
    if (options.length) {
      const choice = await pickOption(options,
        `Out-of-pocket travel expense: vendor "${invoice.vendor}", ${invoice.amount} ${invoice.currency}, ${invoice.date}, document kind: ${invoice.document_kind || 'receipt'}.`,
        'Pick the most appropriate cost type for this expense.');
      await selectByPartialLabel(costTypeSel, choice).catch(e => console.log(`  Cost type select failed: ${e.message}`));
      console.log(`  Cost type: "${choice}"`);
    }
  }

  // Means of payment — make sure a private/own-payment option is selected,
  // since this cost was paid out of pocket.
  const mopSel = inner.getByLabel(/means of payment/i).first();
  if (await mopSel.count()) {
    const mopOptions = await mopSel.evaluate(el =>
      Array.from(el.options || []).map(o => o.text.trim()).filter(Boolean)
    ).catch(() => []);
    const privateOpt = mopOptions.find(o => /privat|private|own|egen|cash|udlæg/i.test(o));
    if (privateOpt) {
      await selectByPartialLabel(mopSel, privateOpt).catch(e => console.log(`  Means of payment select failed: ${e.message}`));
      console.log(`  Means of payment: "${privateOpt}"`);
    } else if (mopOptions.length) {
      console.log(`  Means of payment options ${JSON.stringify(mopOptions)} — none looks private, left at default.`);
    }
  }

  const attachErrors = await uploadAttachment(page, inner, uploadPath,
    `${invoice.vendor} (out of pocket)`);

  const extraNames = [];
  for (const extra of opts.extraAttachments || []) {
    console.log(`  Attaching supporting document: ${path.basename(extra.path)}`);
    const errs = await uploadAttachment(page, inner, extra.path, extra.description);
    attachErrors.push(...errs);
    extraNames.push(path.basename(extra.path));
  }

  const fields = await readFormFields(inner);
  fields['Attachment'] = path.basename(uploadPath);
  if (extraNames.length) fields['Extra attachments'] = extraNames.join(', ');
  if (lineDate !== invoice.date) fields['Date note'] = `Paid ${invoice.date}; dated ${lineDate} to fall inside the travel window`;
  console.log(`  Normal-cost form snapshot: ${JSON.stringify(fields)}`);

  const lineErrors = await saveLineAndVerify(inner, `normal-cost save (${invoice.vendor})`);
  if (lineErrors.length) {
    await page.screenshot({ path: `/tmp/rejsudai-save-fail-${Date.now()}.png`, fullPage: true }).catch(() => {});
    await closeAllocationDialogIfOpen(inner).catch(() => {});
  }
  await new Promise(r => setTimeout(r, 600));

  const errors = [...attachErrors, ...lineErrors];
  if (errors.length) console.warn(`  ⚠ Normal-cost line NOT confirmed saved: ${errors.join(' | ')}`);
  else console.log(`  Normal-cost line created: ${invoice.vendor} ${invoice.amount} ${invoice.currency}`);
  return { errors, fields };
}

// ---------------------------------------------------------------------------
// SINGLE-FILE RUN
// ---------------------------------------------------------------------------
async function runSingle(page, invoicePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejsudai-'));
  const { prep, invoice } = await runStage(page, {
    question: `${path.basename(invoicePath)} could not be read. What should the run do?`,
    retry: 'Try reading it again',
    retryDetail: 'Sends the document to Claude again — worth a try when the cause was a rate limit or a network blip.',
  }, async () => {
    setStep('parsing', `reading ${path.basename(invoicePath)}`);
    const prep = await prepareFile(invoicePath, tmpDir);
    return { prep, invoice: await parseInvoice(prep.parsePath) };
  });
  console.log('Invoice details:', invoice);

  const { outer, inner, action, draftName, formFields, saveErrors } = await runStage(page, {
    question: 'Setting up the draft in indfak2 failed. What should the run do?',
    retry: 'Try the draft again',
    retryDetail: 'Goes back to the drafts list and starts over.',
  }, async () => {
    const { outer, inner } = await openExpenseModule(page);
    const { action, link } = await pickOrCreateDraft(inner, invoice);

    let draftName, formFields = {}, saveErrors = [];
    if (action === 'new') {
      await link.click();
      ({ name: draftName, formFields, saveErrors } = await fillNewDraft(page, inner, invoice));
    } else {
      await link.click();
      draftName = (await link.textContent()).trim();
      console.log(`Opened existing draft: "${draftName}"`);
    }
    return { outer, inner, action, draftName, formFields, saveErrors };
  });

  const matched = await findMatchingTransaction(page, outer, inner, invoice, draftName);

  const manifest = {
    run_at: new Date().toISOString(), mode: 'single',
    invoice_file: path.basename(invoicePath),
    vendor: invoice.vendor, date: invoice.date, amount: invoice.amount, currency: invoice.currency,
    keywords: invoice.keywords || [],
    draft_name: draftName, draft_action: action,
    form_fields_entered: formFields,
    transaction_matched: !!matched,
    transaction_row: matched ? matched.transaction_row : null,
    match_reason: matched ? matched.match_reason : null,
    status: matched ? 'draft_with_allocation' : 'draft_no_match',
    errors_detected: saveErrors,
    questions: ASK_LOG,
  };

  if (!matched) {
    manifest.note = 'No matching card transaction found — draft left empty.';
    console.log(`\n⚠ No match for "${invoice.vendor}" (${invoice.amount} ${invoice.currency}). Draft left empty.`);
  } else {
    let allocErrors = [], lineFields = null;
    for (let i = 0; i < matched.rows.length; i++) {
      if (matched.rows.length > 1) console.log(`  Allocating transaction ${i + 1}/${matched.rows.length}.`);
      const res = await allocateOneTransaction(page, inner, matched.rows[i].text, prep.uploadPath, { draftName, openSelectionPage: i > 0, invoice });
      allocErrors = [...allocErrors, ...res.errors];
      if (!lineFields) lineFields = res.fields;
      if (res.errors.length) break;
    }
    manifest.line_fields_entered = lineFields;
    manifest.errors_detected = [...saveErrors, ...allocErrors];
    manifest.note = allocErrors.length
      ? 'Allocation had errors — review the draft manually.'
      : 'Transaction allocated and invoice attached. Please review and submit manually.';
    console.log(`\n✓ Done. Draft "${draftName}" ready for review.`);

    // Same rule as folder mode: only a clean run may be sent on. A draft picked
    // rather than created may hold other people's lines, so it is never sent.
    if (SUBMIT_SETTLEMENT) {
      const submitState = { requested: true, submitted: false, skipped_reason: null, button: null, errors: [] };
      if (allocErrors.length || saveErrors.length) {
        submitState.skipped_reason = 'the draft has errors';
        console.log(`  Not submitting — ${submitState.skipped_reason}.`);
      } else if (action !== 'new') {
        submitState.skipped_reason = 'the invoice went into an existing draft, which may still be incomplete';
        console.log(`  Not submitting — ${submitState.skipped_reason}.`);
      } else {
        const res = await submitSettlement(page, outer, inner, draftName).catch(err => ({
          submitted: false, errors: [err.message.split('\n')[0]],
        }));
        submitState.submitted = res.submitted;
        submitState.button    = res.button || null;
        submitState.errors    = res.errors;
        if (!res.submitted) console.log(`  ⚠ Not submitted: ${res.errors.join(' | ')}`);
      }
      rejsudaiEmit('submit', submitState);
      manifest.submit = submitState;
      if (submitState.submitted) {
        manifest.status = 'submitted';
        manifest.note = 'Transaction allocated, invoice attached, settlement sent for approval.';
      }
    }
  }

  // Last, so it holds every call the run made and the bulky prompts sit at the
  // end of the file.
  manifest.claude = claudeRecord();

  const manifestPath = path.join(CLAIMS_OUTPUT, `${invoice.date}_${invoice.vendor.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  rejsudaiEmit('manifest', { output_folder: CLAIMS_OUTPUT, manifest: manifestPath });
  console.log(`  Manifest: ${manifestPath}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// READ SETTLEMENT NUMBER from the draft form (best-effort — read-only numeric field)
// ---------------------------------------------------------------------------
async function readSettlementNumber(inner) {
  // Try readonly/disabled inputs first
  const inputs = await inner.locator('input[readonly], input[disabled]').all();
  for (const input of inputs) {
    const val = (await input.inputValue().catch(() => '')).trim();
    if (/^\d{5,}$/.test(val)) return val;
  }
  // Fallback: any visible text node matching a long numeric ID (Angular ng-model fields
  // may not carry the HTML readonly attribute even when read-only in the UI)
  const allInputs = await inner.locator('input').all();
  for (const input of allInputs) {
    const val = (await input.inputValue().catch(() => '')).trim();
    if (/^\d{7,}$/.test(val)) return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SUBMIT THE SETTLEMENT (opt-in)
// Sending a settlement puts it in the approver's queue, which the bot cannot
// undo — so it only runs when the caller asked for it AND every document in the
// folder actually made it into the draft (see the gate in runFolderInner).
// ---------------------------------------------------------------------------

// Every visible button label, for the "couldn't find it" error — a failed run
// then says exactly what this tenant calls its buttons.
async function visibleButtonLabels(inner) {
  const labels = await inner.locator('button, a.btn, input[type="submit"]')
    .evaluateAll(els => els
      .filter(e => e.offsetParent !== null || e.getClientRects().length)
      .map(e => (e.textContent || e.value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean))
    .catch(() => []);
  return [...new Set(labels)];
}

// Picks the button that sends the settlement on. Labels differ per tenant and
// language ("Send", "Submit", "Send til godkendelse"), and they carry an icon
// glyph, so match on scored text rather than one exact name.
async function findSubmitControl(inner, { wizard = false } = {}) {
  const candidates = inner.locator('button, a.btn');
  const count = await candidates.count().catch(() => 0);
  const scored = [];
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const text  = ((await el.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const title = (await el.getAttribute('title').catch(() => '')) || '';
    const label = text || title.trim();
    if (!label) continue;
    // Never mistake the destructive or the everyday buttons for the send one.
    if (/^\s*(cancel|annuller|delete|slet|save|gem|back|tilbage|close|luk|allocate)\s*$/i.test(label)) continue;
    let score = 0;
    if (/^(send|submit)$/i.test(label)) score = 4;
    else if (/(send|submit)[^a-z]{0,3}(for |to |til )?(approval|godkend)/i.test(label)) score = 4;
    else if (/^(send|submit|forward|videresend|afsend)\b/i.test(label)) score = 3;
    else if (/(send|submit|godkend)/i.test(label)) score = 1;
    // Later wizard steps are labelled as steps, not as the action.
    else if (wizard && /^(next|continue|finish|complete|done|videre|fortsæt|afslut)\b/i.test(label)) score = 2;
    if (score) scored.push({ el, label, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

async function submitSettlement(page, outer, inner, draftName) {
  setStep('submit', 'sending the settlement for approval');
  rejsudaiEmit('phase', { phase: 'submitting' });
  console.log(`\nSubmitting "${draftName}" for approval...`);

  // A cost form left open would swallow the click, and a toast would intercept it.
  await closeAllocationDialogIfOpen(inner).catch(() => {});
  await inner.locator('#toast-container').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

  let control = await findSubmitControl(inner);
  if (!control && draftName) {
    // The send button may live on the draft's own view rather than whichever
    // sub-page the last expense left us on — walk back via the breadcrumb.
    const crumb = inner.locator('a').filter({ hasText: draftName }).first();
    if (await crumb.isVisible().catch(() => false)) {
      await crumb.click().catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
      control = await findSubmitControl(inner);
    }
  }
  if (!control) {
    const seen = await visibleButtonLabels(inner);
    return { submitted: false, errors: [`Submit button not found on the draft — visible buttons: ${seen.join(' | ') || '(none)'}`] };
  }

  // Sending is a wizard, not a button: this tenant's first step reads
  // "Send (1 of 2)". Walk it — click, look at what came back, click again —
  // and stop as soon as a click changes nothing, so a page that keeps offering
  // the same button can never loop.
  const pressed = [];
  const fingerprint = async () => (await visibleButtonLabels(inner)).join(' | ');

  for (let step = 0; step < 4 && control; step++) {
    const before = await fingerprint();
    console.log(`  Clicking "${control.label}".`);
    pressed.push(control.label);
    try {
      await control.el.click({ timeout: 10000 });
    } catch {
      await control.el.click({ force: true, timeout: 5000 }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 3000));
    await inner.locator('#toast-container').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});

    // A confirmation dialog may follow any step. Only answer a real modal — a
    // global search would find the send button again and press it twice.
    const modal = inner.locator('.modal, [role="dialog"], .sweet-alert').filter({ has: inner.locator('button') }).first();
    if (await modal.isVisible().catch(() => false)) {
      const confirm = modal.getByRole('button', { name: /^\s*(yes|ja|ok|send|submit|confirm|bekræft|continue|fortsæt)\s*$/i }).first();
      if (await confirm.isVisible().catch(() => false)) {
        const label = ((await confirm.textContent().catch(() => '')) || '').trim();
        console.log(`  Confirming: "${label}".`);
        pressed.push(label);
        await confirm.click().catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Validation refusals surface the same two ways line saves do.
    const errors = await checkErrors(inner);
    const banner = inner.getByText(/Errors count: \d+/).first();
    if (await banner.isVisible().catch(() => false)) {
      errors.push(((await banner.textContent().catch(() => '')) || '').trim());
    }
    if (errors.length) {
      return { submitted: false, button: pressed.join(' → '), errors: [`Submit refused after "${pressed.join(' → ')}": ${errors.join(' | ')}`] };
    }

    // Back on the drafts list means the wizard is done.
    if (await inner.locator('#inner-draft-container').isVisible().catch(() => false)) break;
    // Nothing on the page moved: the click did not take, and clicking the same
    // thing again would not help either.
    if ((await fingerprint()) === before) break;

    control = await findSubmitControl(inner, { wizard: true });
  }

  // Proof, not optimism: a sent settlement is gone from the drafts list. Go back
  // to the module's front page through the outer frame's own nav link — clicking
  // the top-level "Expense" button again matches several elements once the send
  // wizard has run.
  let listed = null;
  try {
    if (!(await inner.locator('#inner-draft-container').isVisible().catch(() => false))) {
      await outer.locator('#ecm_link').click({ timeout: 10000 });
      await inner.locator('#inner-draft-container').waitFor({ timeout: 20000 });
    }
    await new Promise(r => setTimeout(r, 2500));
    const names = (await inner.locator('#inner-draft-container .ui-grid-row h4').allTextContents().catch(() => []))
      .map(t => t.trim()).filter(Boolean);
    listed = names.some(n => n === draftName || n.includes(draftName));
  } catch (err) {
    return {
      submitted: false, button: pressed.join(' → '),
      errors: [`Pressed ${pressed.map(p => `"${p}"`).join(' → ')} but could not verify the result: ${err.message.split('\n')[0]}`],
    };
  }
  if (listed) {
    return {
      submitted: false, button: pressed.join(' → '),
      errors: [`Pressed ${pressed.map(p => `"${p}"`).join(' → ')} but the settlement is still in the drafts list.`],
    };
  }
  console.log('  ✓ Submitted — the settlement has left the drafts list.');
  return { submitted: true, errors: [], button: pressed.join(' → ') };
}

// ---------------------------------------------------------------------------
// FOLDER RUN
// Files whatever is waiting in the settlement's input/ into its one draft (see
// SETTLEMENT FOLDER LAYOUT). The first run creates the draft; every later one
// — receipts added since, or ones that failed last time — reconnects to the
// draft its record names and carries on. A Claude planning step decides per
// document whether it is a card expense (matched to a card transaction), an
// out-of-pocket expense (entered as a "Normal cost" line), or a supporting
// document (attached to the first successful expense line), with what is
// already filed in view so that nothing is claimed twice.
// ---------------------------------------------------------------------------

// What a folder run needs before a browser is worth starting: something to
// file, and a settlement that can still take it. run() calls it before
// Chromium launches, and runFolder() again for the record and the file list.
function checkFolder(folderPath) {
  const { settlementName } = readSettlementMeta(folderPath);
  const record = readRecord(folderPath);
  const s = (record && record.settlement) || {};
  if (s.submit && s.submit.submitted) {
    throw failure(`"${s.draft_name || settlementName}" has already been sent for approval.`, {
      detail: 'A settlement cannot take more receipts once it has left the drafts list.',
      hint: 'File the new receipts as a settlement of their own.',
    });
  }
  const files = pendingDocuments(folderPath);
  if (!files.length) {
    throw failure(`Nothing to file in "${settlementName}".`, {
      detail: `No PDF, PNG, JPEG or HEIC documents are waiting in ${path.join(path.basename(folderPath), INPUT_DIR)}.`,
      hint: record
        ? 'Everything in this settlement is already filed. Add receipts to it to file more.'
        : 'Add the receipts to the settlement, then run it again.',
    });
  }
  return { record, files };
}

// The fields the record keeps from each parse. `references` and `travel` are
// what a later run's plan needs to recognise a cost this settlement has
// already filed.
function parsedFields(d) {
  return {
    vendor: d.vendor ?? null,
    vendor_country: d.vendor_country || null,
    amount: d.amount ?? null,
    currency: d.currency || null,
    date: d.date || null,
    document_kind: d.document_kind || null,
    payment_method: d.payment_method || null,
    references: d.references || [],
    keywords: d.keywords || [],
    travel: d.travel || null,
  };
}

// The settlement's record: the one earlier runs left (`prev`, null before the
// first) with this run laid over it. Only filed entries carry over — an
// earlier failure is either being tried again in this run, because its file is
// still in input/, or its file is gone and so is the point of listing it. A
// document tried again replaces its old entry.
//
// `run` is everything this run knows: its results, its supporting documents,
// the files it has moved to processed/ (`filed`), what is still waiting in
// input/, its submit outcome, questions and Claude calls. `final` is false for
// the saves made along the way, whose status is written for the case where the
// run dies before the next one.
function composeRecord(prev, run) {
  prev = prev || {};
  const ps = prev.settlement || {};
  const now = new Set([...run.results.map(r => r.file), ...run.supporting.map(s => s.file)]);
  const kept = list => (list || []).filter(e => e && e.moved_to_output && !now.has(e.file));
  const invoices = [...kept(prev.invoices), ...run.results];
  const supporting = [...kept(prev.supporting_documents), ...run.supporting];
  const filedLines = invoices.filter(i => i.moved_to_output);
  const { waiting, submit } = run;
  const status = submit.submitted ? 'SUBMITTED — sent for approval'
    : !run.final ? `DRAFT — filing was interrupted; ${waiting.length} document(s) still waiting in ${INPUT_DIR}/`
    : waiting.length ? `DRAFT — ${waiting.length} document(s) not filed yet, waiting in ${INPUT_DIR}/`
    : submit.requested ? `DRAFT — submit was requested but did not happen (${submit.skipped_reason || submit.errors.join(' | ')})`
    : 'DRAFT — every document is filed; review it and submit it in indfak2';
  return {
    manifest_version: 2,
    mode: 'folder',
    run_at: run.runAt,
    updated_at: new Date().toISOString(),
    settlement: {
      draft_name: run.draftName,
      settlement_number: run.settlementNumber || ps.settlement_number || null,
      original_folder: run.folderName,
      alias: run.alias,
      type: run.header.type,
      purpose: run.header.purpose,
      travel: run.travel,
      created_at: run.header.created_at,
      form_fields_entered: run.header.form_fields_entered,
      save_errors: run.header.save_errors,
      expenses_total: invoices.length,
      expenses_card: filedLines.filter(r => r.expense_type === 'From Card Transaction').length,
      expenses_normal_cost: filedLines.filter(r => r.expense_type === 'Normal Cost').length,
      expenses_unprocessed: invoices.length - filedLines.length,
      documents_waiting: waiting,
      submit,
      // What a person was asked while filing this settlement, and what they
      // answered — so a settlement someone steered by hand says so.
      questions: [...(ps.questions || []), ...run.questions],
      status,
    },
    invoices,
    supporting_documents: supporting,
    // One entry per run that has filed into this settlement.
    runs: [...(prev.runs || []), {
      run_at: run.runAt,
      finished: !!run.final,
      documents: run.documents,
      filed: run.filed,
      submit: run.final ? submit : null,
      claude_estimated_cost_usd: run.claude.estimated_cost_usd,
    }],
    // Every Claude call the settlement has taken, across all its runs, and the
    // total. Last, because the prompts are long.
    claude: mergeClaude(prev.claude, run.claude),
  };
}

async function runFolder(page, folderPath) {
  const folderName = path.basename(folderPath);
  const { alias, settlementName } = readSettlementMeta(folderPath);
  const { record, files: found } = checkFolder(folderPath);
  const files = claimFileNames(folderPath, found, record);
  if (files.length === 0) {
    throw failure(`Nothing to file in "${settlementName}".`, {
      detail: `Everything in ${path.join(folderName, INPUT_DIR)} turned out to be filed already.`,
      hint: 'Add receipts to the settlement to file more.',
    });
  }

  console.log(`\nFolder: ${folderName}`);
  console.log(`  Alias:           ${alias || '(from config)'}`);
  console.log(`  Settlement name: ${settlementName}`);
  console.log(`  Documents to file: ${files.length}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejsudai-'));
  try {
    await runFolderInner(page, folderPath, folderName, alias, settlementName, files, tmpDir, record);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runFolderInner(page, folderPath, folderName, alias, settlementName, files, tmpDir, record) {
  const runAt = new Date().toISOString();
  const processedDir = path.join(folderPath, PROCESSED_DIR);
  // The record as this run found it. Every save lays this run over this
  // snapshot — never over the previous save — so nothing is counted twice.
  const prev = record || {};
  const prevSettlement = prev.settlement || {};
  const filedBefore = filedEntries(record);
  // The record names a draft: an earlier run made it, and this one belongs in it.
  const continuing = !!prevSettlement.draft_name;
  if (continuing) {
    console.log(`  Continuing draft "${prevSettlement.draft_name}"`
      + `${prevSettlement.settlement_number ? ` (no. ${prevSettlement.settlement_number})` : ''}`
      + ` — ${filedBefore.length} document(s) already filed in it.`);
  }

  // Parse all documents up-front (before opening the browser flow)
  const docs = [];
  // Documents left out by hand at this stage. They go back into the manifest at
  // the end: a file that was skipped belongs on the record rather than being
  // silently absent from it.
  const unread = [];
  rejsudaiEmit('phase', { phase: 'parsing', total: files.length });
  for (const f of files) {
    rejsudaiEmit('progress', { phase: 'parsing', index: docs.length + 1, total: files.length, file: path.basename(f) });
    console.log(`  Parsing ${path.basename(f)}...`);
    const parsed = await runStage(page, {
      question: `${path.basename(f)} could not be read. What should the run do?`,
      retry: 'Try reading it again',
      retryDetail: 'Sends the document to Claude again — worth a try when the cause was a rate limit or a network blip.',
      extra: { value: 'leave_out', label: 'Leave this document out',
               detail: `The rest is filed. This file stays in ${INPUT_DIR}/ and is listed as unread in the manifest.` },
    }, async () => {
      setStep('parsing', `reading ${path.basename(f)}`);
      const prep = await prepareFile(f, tmpDir);
      const inv  = await parseInvoice(prep.parsePath);
      return { ...inv, filePath: f, uploadPath: prep.uploadPath, converted: prep.converted };
    });
    if (parsed === STAGE_SKIPPED) {
      console.log('    → left out of the settlement.');
      unread.push(path.basename(f));
      continue;
    }
    console.log(`    → [${parsed.document_kind}] ${parsed.vendor}  ${parsed.amount} ${parsed.currency}  ${parsed.date}  pay: ${parsed.payment_method || '?'}`);
    docs.push(parsed);
  }
  if (docs.length === 0) throw failure('None of the documents to file could be read.', {
    hint: `The files stay in ${INPUT_DIR}/. Check they are readable invoices or receipts, then run the settlement again.`,
  });

  // Plan the settlement: card expense / out-of-pocket expense / supporting doc
  rejsudaiEmit('phase', { phase: 'planning' });
  const { travel: plannedTravel } = await runStage(page, {
    question: 'Working out what each document is failed. What should the run do?',
    retry: 'Try planning again',
    retryDetail: 'Asks Claude again with the same documents — worth a try when the cause was a rate limit or a network blip.',
  }, async () => {
    setStep('planning', 'working out what each document is');
    return planSettlement(docs, settlementName, { filed: filedBefore, draftTravel: prevSettlement.travel || null });
  });
  console.log('\nSettlement plan:');
  if (plannedTravel) console.log(`  Travel: ${plannedTravel.origin_city} (${plannedTravel.origin_country}) → ${plannedTravel.destination_city} (${plannedTravel.destination_country}), ${plannedTravel.start} → ${plannedTravel.end}`);
  for (const d of docs) console.log(`  ${d.role.padEnd(15)} ${path.basename(d.filePath)} — ${d.plan_reason}`);

  // Card-matched (and unknown) expenses first, out-of-pocket last: an unmatched
  // card search leaves the allocation dialog open for reuse by the NEXT card
  // search, so normal-cost lines (which need that dialog closed) go at the end.
  const expenses = [
    ...docs.filter(d => d.role === 'card_expense' || d.role === 'unknown_expense'),
    ...docs.filter(d => d.role === 'pocket_expense'),
  ];
  const supporting = docs.filter(d => d.role === 'supporting');
  // Supporting documents ride on an expense line filed in the same run, and a
  // line already in the draft cannot be given one — so a batch of nothing but
  // evidence has nowhere to go.
  if (expenses.length === 0) {
    throw failure('None of the documents is a cost of its own, so there is no line to attach them to.', {
      detail: `Every document was read as supporting evidence: ${supporting.map(d => `${path.basename(d.filePath)} (${d.plan_reason})`).join('; ')}.`,
      hint: continuing
        ? `Supporting documents are attached to an expense line filed in the same run, and cannot be added to a line already in the draft. Attach them in indfak2 by hand and delete them from ${INPUT_DIR}/, or add them together with the cost they belong to.`
        : 'Check that the settlement includes the invoices or receipts, not only itineraries and confirmations.',
    });
  }

  // Opening the module and getting a draft to file into is one stage: it is
  // safe to run again from the top. A settlement with a record reconnects to
  // the draft the record names; one without looks for a draft of its name — a
  // run that died before its first save — and makes one only when there is
  // none. The alias the draft ends up with is not always the one asked for: a
  // rejected alias can be answered with another (askAboutAlias). It lives out
  // here because a second attempt at this stage re-enters the draft the first
  // one created instead of filling the form again.
  let aliasUsed = alias || PROJECT_ALIAS;
  const { outer, inner, draftName, formFields, saveErrors, settlementNumber, reconnected } = await runStage(page, {
    question: 'Setting up the draft in indfak2 failed. What should the run do?',
    retry: 'Try the draft again',
    retryDetail: 'Goes back to the drafts list and starts over. A draft this settlement already has is re-entered, never duplicated.',
  }, async () => {
    const { outer, inner } = await openExpenseModule(page);
    const intendedName = continuing ? prevSettlement.draft_name : `* ${settlementName}`;
    setStep('draft', `looking for the draft "${intendedName}"`);
    // Rows render after the container appears; a timeout here just means there
    // are no drafts yet.
    await inner.locator('#inner-draft-container .ui-grid-row').first().waitFor({ timeout: 10000 }).catch(() => {});
    const { cell, names } = await findDraftCell(inner, intendedName);
    if (names.length) console.log(`  Existing drafts: ${JSON.stringify(names)}`);

    let draftName, formFields = {}, saveErrors = [];
    if (cell) {
      console.log(continuing
        ? `  Reconnecting to draft "${intendedName}".`
        : `  Reusing existing draft "${intendedName}" (from a previous run).`);
      await cell.click();
      draftName = intendedName;
      await new Promise(r => setTimeout(r, 1500));
    } else if (continuing && filedBefore.length) {
      // Filing into a fresh draft would split the settlement in two, and the
      // documents already filed would be in neither the new draft nor this run.
      throw failure(`The draft "${intendedName}" is no longer among your drafts in indfak2.`, {
        detail: `${filedBefore.length} document(s) of this settlement were filed into it`
          + `${prevSettlement.settlement_number ? ` (settlement no. ${prevSettlement.settlement_number})` : ''}. `
          + `Drafts listed: ${names.join(' · ') || '(none)'}.`,
        hint: 'If it was sent for approval or deleted in indfak2, the new receipts need a settlement of their own. If it was renamed, give it back the name above and try again.',
      });
    } else {
      // No draft yet — or the one the record names is gone with nothing filed
      // in it, which is as good as never having had one.
      if (continuing) console.log(`  The draft "${intendedName}" is gone, and nothing was filed in it — creating it again.`);
      const newDraftLink = inner.locator('#inner-draft-container a').first();
      await newDraftLink.click();
      ({ name: draftName, alias: aliasUsed, formFields, saveErrors } = await fillNewDraft(page, inner, {}, {
        draftName: `* ${settlementName}`,
        alias: alias || undefined,
        travel: plannedTravel || undefined,
        docs: docs,
      }));
    }

    const settlementNumber = await readSettlementNumber(inner);
    if (settlementNumber) console.log(`  Settlement number: ${settlementNumber}`);
    // Two drafts can share a name; they cannot share a number. Nothing has been
    // filed yet, so stopping here costs nothing.
    const recorded = prevSettlement.settlement_number;
    if (cell && continuing && recorded && settlementNumber && settlementNumber !== recorded) {
      throw failure(`The draft named "${intendedName}" is settlement no. ${settlementNumber}, not no. ${recorded}.`, {
        detail: 'Another draft has the same name as this settlement\'s. Nothing was filed into it.',
        hint: 'Rename or delete the other draft in indfak2, then try again.',
      });
    }
    return { outer, inner, draftName, formFields, saveErrors, settlementNumber, reconnected: !!cell && continuing };
  });

  // A draft reconnected to keeps the header an earlier run gave it — type,
  // purpose, travel window — and new lines have to fit that window. A draft
  // made now takes this run's plan.
  const travel = reconnected ? (prevSettlement.travel || null) : (plannedTravel || null);
  if (reconnected) aliasUsed = prevSettlement.alias || aliasUsed;
  const header = reconnected
    ? {
        type: prevSettlement.type, purpose: prevSettlement.purpose,
        form_fields_entered: prevSettlement.form_fields_entered || {},
        save_errors: prevSettlement.save_errors || [],
        created_at: prevSettlement.created_at || prev.run_at || runAt,
      }
    : {
        type: travel ? '2 - Travel settlements (days,expenses,transp.)' : EXPENSE_TYPE,
        purpose: derivePurpose(travel, docs),
        form_fields_entered: formFields, save_errors: saveErrors, created_at: runAt,
      };

  // Supporting documents are attached to the first expense line that succeeds.
  let pendingSupport = supporting.map(d => ({
    path: d.uploadPath,
    file: path.basename(d.filePath),
    description: `Supporting document: ${d.vendor || path.basename(d.filePath, path.extname(d.filePath))}`,
  }));
  let supportAttachedTo = null;
  // True once the line carrying them has saved and their files have moved.
  let supportFiled = false;
  const takePendingSupport = hostFile => {
    if (!pendingSupport.length) return [];
    const extras = pendingSupport;
    pendingSupport = [];
    supportAttachedTo = hostFile;
    return extras;
  };

  const results = [];
  const filedThisRun = [];
  const submitState = { requested: SUBMIT_SETTLEMENT, submitted: false, skipped_reason: null, button: null, errors: [] };

  const supportingNow = () => supporting.map(d => ({
    file: path.basename(d.filePath),
    role: 'supporting',
    plan_reason: d.plan_reason,
    parsed_invoice: parsedFields(d),
    attached_to: supportFiled ? supportAttachedTo : null,
    moved_to_output: supportFiled,
    run_at: runAt,
  }));

  // The settlement as it stands right now. `waiting` is read from the folder
  // rather than worked out: whatever is still in input/ is what the draft is
  // missing, however it got there.
  const recordNow = (final = false) => composeRecord(record, {
    runAt, final, folderName,
    documents: files.map(f => path.basename(f)),
    draftName,
    settlementNumber: settlementNumber || prevSettlement.settlement_number || null,
    alias: aliasUsed, header, travel,
    results, supporting: supportingNow(), filed: filedThisRun.slice(),
    waiting: pendingDocuments(folderPath).map(f => path.basename(f)),
    submit: submitState, questions: ASK_LOG, claude: claudeRecord(),
  });

  // Written as soon as there is a draft and again after every document, so a
  // run that dies part-way leaves a record that matches the draft and the
  // folder — and the next run carries on from exactly there.
  const saveRecord = (final = false) => {
    const file = writeRecord(folderPath, recordNow(final));
    // Tells the desktop app where the record is — from the first save, so a run
    // that fails later still leaves its Details something to show.
    rejsudaiEmit('manifest', { output_folder: folderPath, manifest: file });
    return file;
  };

  // A filed document leaves input/. Its line is in the draft by now, so a file
  // left behind would be filed again by the next run — which is why a move
  // that fails ends the run rather than being logged and forgotten.
  const intoProcessed = doc => {
    const name = path.basename(doc.filePath);
    try {
      fs.mkdirSync(processedDir, { recursive: true });
      moveFile(doc.filePath, path.join(processedDir, name));
      // HEIC receipts: the JPEG that was actually uploaded goes beside the original.
      if (doc.converted) {
        const jpg = uniqueName(path.basename(doc.uploadPath), new Set(fs.readdirSync(processedDir)));
        fs.writeFileSync(path.join(processedDir, jpg), fs.readFileSync(doc.uploadPath));
      }
    } catch (err) {
      saveRecord();
      throw failure(`${name} is filed in the draft, but could not be moved to ${PROCESSED_DIR}/.`, {
        detail: err.message,
        hint: `Move it into ${path.join(folderName, PROCESSED_DIR)} by hand before running this settlement again.`,
      });
    }
    filedThisRun.push(name);
  };

  saveRecord();

  // Process each expense into the draft
  // Set when the user answers a failure question with "stop": the index of the
  // document that was being filed, so the rest can be recorded as untouched.
  let stoppedAt = null;
  rejsudaiEmit('phase', { phase: 'filing', total: expenses.length });
  for (const [docIndex, doc] of expenses.entries()) {
    rejsudaiEmit('progress', { phase: 'filing', index: results.length + 1, total: expenses.length, file: path.basename(doc.filePath), role: doc.role });
    console.log(`\nProcessing: ${path.basename(doc.filePath)} [${doc.role}] (${doc.vendor} ${doc.amount} ${doc.currency})`);
    const docInfo = {
      file: path.basename(doc.filePath),
      role: doc.role,
      plan_reason: doc.plan_reason,
      parsed_invoice: parsedFields(doc),
      run_at: runAt,
    };

    // One failing expense must not kill the whole run. The attempt loop is what
    // makes a retry possible: the browser stays open on the problem while the
    // question is answered, so putting the page right by hand costs one answer
    // rather than a whole re-run.
    let extras = [];
    let done = false;
    for (let attempt = 1; !done; attempt++) {
      try {
        // Always check the transaction grid first — even for pocket_expense. A
        // matching transaction proves the corporate account paid, whatever the
        // plan inferred from the receipt, and prevents double reimbursement.
        const matched = await findMatchingTransaction(page, outer, inner, doc, draftName);
        if (matched && doc.role === 'pocket_expense') {
          console.log('  Plan said out-of-pocket, but a matching card transaction exists — allocating it instead.');
        }

        if (matched) {
          extras = takePendingSupport(docInfo.file);
          // One line PER transaction — multi-selecting rows and clicking Allocate
          // once only allocates one of them. The same invoice is attached to each
          // line; supporting docs go on the first.
          const lineResults = [];
          for (let i = 0; i < matched.rows.length; i++) {
            if (matched.rows.length > 1) console.log(`  Allocating transaction ${i + 1}/${matched.rows.length}.`);
            const res = await allocateOneTransaction(page, inner, matched.rows[i].text, doc.uploadPath, {
              draftName,
              openSelectionPage: i > 0,
              invoice: doc,
              extraAttachments: i === 0 ? extras : [],
            });
            lineResults.push(res);
            if (res.errors.length) break;
          }
          const errors = lineResults.flatMap(r => r.errors);
          const allSaved = lineResults.length === matched.rows.length && errors.length === 0;
          // If the very first line failed, its supporting docs were not attached
          if (!allSaved && extras.length && lineResults[0] && lineResults[0].errors.length) {
            pendingSupport = extras; supportAttachedTo = null;
          }
          results.push({
            ...docInfo, attempts: attempt, expense_type: 'From Card Transaction', matched: true,
            transaction_row: matched.transaction_row, match_reason: matched.match_reason,
            lines_created: lineResults.filter(r => !r.errors.length).length,
            lines_expected: matched.rows.length,
            fields_entered: lineResults[0] ? lineResults[0].fields : null,
            errors, moved_to_output: allSaved,
          });
        } else if (doc.role === 'pocket_expense' || doc.role === 'unknown_expense') {
          // Out of pocket (or no transaction found for an unknown) → Normal cost line
          if (doc.role === 'unknown_expense') console.log('  No card transaction — falling back to Normal cost.');
          extras = takePendingSupport(docInfo.file);
          const { errors, fields } = await createNormalCostLine(page, inner, doc, doc.uploadPath,
            { draftName, extraAttachments: extras, travel });
          // A line that did not save is cancelled, and the supporting documents
          // uploaded to it with it: they still need a line.
          if (errors.length && extras.length) { pendingSupport = extras; supportAttachedTo = null; }
          results.push({
            ...docInfo, attempts: attempt, expense_type: 'Normal Cost', matched: false,
            transaction_row: null, fields_entered: fields, errors,
            moved_to_output: errors.length === 0,
          });
        } else {
          console.log(`  ⚠ No match — skipping (left in ${INPUT_DIR}/ for another run).`);
          results.push({
            ...docInfo, attempts: attempt, expense_type: null, matched: false, transaction_row: null,
            fields_entered: null, errors: [], moved_to_output: false,
          });
        }
        done = true;
      } catch (err) {
        // A closed browser cannot be put right on the page, and asking would
        // only produce the same question on every retry. Let it out to the
        // run's own handler, which reports it and ends the run.
        if (page.isClosed()) throw err;
        const info = describeFailure(err);
        console.error(`  ✗ Failed on ${docInfo.file}: ${info.title}`);
        if (info.hint) console.error(`    → ${info.hint}`);
        const shot = path.join(os.tmpdir(), `rejsudai-fail-${docInfo.file.replace(/[^a-z0-9]/gi, '_')}.png`);
        const shotOk = await page.screenshot({ path: shot, fullPage: true }).then(() => true).catch(() => false);
        if (extras.length) { pendingSupport = extras; supportAttachedTo = null; extras = []; }
        // Tidy the page before anyone is asked to look at it, and so a retry
        // starts from the line-items tab rather than a half-open dialog.
        await closeAllocationDialogIfOpen(inner).catch(() => {});

        const choice = await askAfterExpenseFailure(docInfo.file,
          { ...info, screenshot: shotOk ? shot : null }, { attempt });
        if (choice === 'retry') {
          console.log(`  Retrying ${docInfo.file} (attempt ${attempt + 1}).`);
          continue;
        }
        // Skipped or stopped: the error still has to be readable in the
        // manifest and in the app's result table.
        results.push({
          ...docInfo, attempts: attempt, expense_type: null, matched: false, transaction_row: null,
          fields_entered: null, errors: [info.title], moved_to_output: false,
          error_detail: { while: info.while, detail: info.detail, hint: info.hint, screenshot: shotOk ? shot : null, raw: info.raw.split('\n')[0] },
        });
        if (choice === 'stop') stoppedAt = docIndex;
        done = true;
      }
    }

    // The supporting documents went in with this document's first line. They
    // count as filed before their files move, so that a move that fails still
    // leaves a record saying they are in the draft.
    if (!supportFiled && supportAttachedTo === docInfo.file) {
      supportFiled = true;
      for (const d of supporting) intoProcessed(d);
    }
    if (results[results.length - 1].moved_to_output) intoProcessed(doc);
    saveRecord();
    if (stoppedAt !== null) break;
  }

  // A run stopped by hand leaves the rest of the folder untouched. Those
  // documents are recorded as unprocessed so the manifest is honest about them,
  // their files stay in input/, and — the part that matters — the submit gate
  // below sees an incomplete settlement and will not send it.
  if (stoppedAt !== null) {
    for (const doc of expenses.slice(stoppedAt + 1)) {
      results.push({
        file: path.basename(doc.filePath), role: doc.role, plan_reason: doc.plan_reason,
        parsed_invoice: parsedFields(doc), run_at: runAt,
        expense_type: null, matched: false, transaction_row: null, fields_entered: null,
        errors: ['Not attempted — the run was stopped.'], moved_to_output: false,
      });
    }
    console.log(`\n■ Run stopped — ${expenses.length - stoppedAt - 1} document(s) left for a later run.`);
  }

  // A document that was left out at the reading stage never reached the loop,
  // so nothing above has recorded it. It belongs in the manifest, and it is
  // still in input/, which keeps an incomplete settlement from being sent.
  for (const file of unread) {
    results.push({
      file, role: null, plan_reason: null, parsed_invoice: null, run_at: runAt,
      expense_type: null, matched: false, transaction_row: null, fields_entered: null,
      errors: ['Could not be read — left out of the settlement.'], moved_to_output: false,
    });
  }

  const allocatedCount = results.filter(r => r.moved_to_output).length;
  const unmatchedCount = results.filter(r => !r.moved_to_output).length;
  console.log(`\n✓ Draft "${draftName}": ${allocatedCount} line(s) created this run, ${unmatchedCount} unprocessed.`);
  if (pendingSupport.length) console.log(`  ⚠ Supporting document(s) NOT attached (no expense line succeeded): ${pendingSupport.map(s => s.file).join(', ')}`);

  // Submit, if this run asked for it. A settlement that is missing documents is
  // worse to send than to leave as a draft, so anything unfiled blocks it — and
  // the whole settlement counts, not just this run: whatever is still in input/
  // is missing from the draft, however it got there.
  if (SUBMIT_SETTLEMENT) {
    const { invoices, settlement: { documents_waiting: waiting } } = recordNow();
    const blockers = [];
    if (!invoices.some(i => i.moved_to_output)) blockers.push('no expense line has been filed');
    if (waiting.length) blockers.push(`${waiting.length} document(s) not filed (${waiting.join(', ')})`);
    if (blockers.length) {
      submitState.skipped_reason = blockers.join('; ');
      console.log(`  Not submitting — ${submitState.skipped_reason}. Left as a draft to fix and re-run.`);
    } else {
      const res = await submitSettlement(page, outer, inner, draftName).catch(err => ({
        submitted: false, errors: [err.message.split('\n')[0]],
      }));
      submitState.submitted = res.submitted;
      submitState.button    = res.button || null;
      submitState.errors    = res.errors;
      if (!res.submitted) console.log(`  ⚠ Not submitted: ${res.errors.join(' | ')}`);
    }
  }
  rejsudaiEmit('submit', submitState);
  console.log(submitState.submitted
    ? '  Status: SUBMITTED (sent for approval)'
    : '  Status: DRAFT (not submitted — please review and submit manually)');

  const recordPath = saveRecord(true);
  const waiting = pendingDocuments(folderPath).map(f => path.basename(f));
  if (waiting.length) console.log(`  ${waiting.length} document(s) still in ${INPUT_DIR}/ for another run: ${waiting.join(', ')}`);
  console.log(`  Record: ${recordPath}`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function run() {
  // Flags may appear anywhere; the first non-flag argument is the target.
  const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!arg) {
    console.error('Usage: node bot.js <invoice-file> [--submit|--no-submit]');
    console.error('       node bot.js <folder>          e.g. ai_subscription_fees');
    console.error('  A folder files what is waiting in its input/ (or loose inside it) into the');
    console.error('  settlement\'s draft; add receipts to input/ and run it again to continue.');
    console.error('  --submit     send the settlement for approval when everything filed cleanly');
    console.error('  --no-submit  leave it as a draft even if REJSUDAI_SUBMIT=1 (the default)');
    process.exit(1);
  }
  if (SUBMIT_SETTLEMENT) console.log('Submit mode: the settlement will be sent for approval if everything files cleanly.');

  const targetPath = path.isAbsolute(arg) ? arg : path.join(RECEIPTS_INBOX, arg);
  const isFolder   = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  // A folder with nothing to file, or one already sent for approval, is turned
  // away before a browser is started and a login spent on it.
  if (isFolder) checkFolder(targetPath);

  // Visible browser stays the default (REJSUDAI_HEADLESS unset === headless:false),
  // so CLI behaviour is unchanged; the desktop app's Settings toggle sets it to 1.
  const browser = await chromium.launch({ headless: process.env.REJSUDAI_HEADLESS === '1', slowMo: 700 });
  const page    = await browser.newPage();
  // GUI only: the window has just appeared — move it out of sight before it has
  // had time to take the screen. It comes back on its own if a question needs
  // the page worked on by hand.
  BROWSER_WINDOW = await rejsudaiStowWindow(browser, page);
  // GUI only: stream the page to the desktop app's Browser pane.
  const stopScreencast = await rejsudaiStartScreencast(page);

  try {
    // Signing in is the one stage where the useful answer is often neither
    // retry nor stop: the browser is open on the login page, so finishing the
    // sign-in by hand and telling the run to carry on gets past a rejected code
    // or an unexpected prompt without starting over.
    const signedIn = await runStage(page, {
      question: 'Signing in to indfak2 failed. What should the run do?',
      retry: 'Try signing in again',
      retryDetail: 'Starts the sign-in over from the login page.',
      // Signing in by hand needs a window to sign in through.
      extra: CAN_WORK_THE_PAGE
        ? { value: 'carry_on', label: 'I have signed in myself — carry on',
            detail: 'Uses the session in the open browser window and goes straight to the settlement.' }
        : null,
    }, async () => {
      setStep('login', 'signing in to indfak2');
      await login(page);
    });
    if (signedIn === STAGE_SKIPPED) console.log('Carrying on with the session already open in the browser.');
    if (isFolder) {
      await runFolder(page, targetPath);
    } else {
      console.log(`\nParsing invoice: ${targetPath}`);
      await runSingle(page, targetPath);
    }
  } catch (err) {
    // Reported here rather than at the top level: the browser is still open,
    // so the screenshot shows the page as it was when the run gave up.
    await reportFailure(page, err);
    throw err;
  } finally {
    printClaudeTotals();
    if (stopScreencast) await stopScreencast();
    BROWSER_WINDOW = null;
    await browser.close();
  }
}

if (require.main === module) {
  run().catch(async err => {
    // Anything that failed before the browser was up (a missing folder, a bad
    // API key) is explained here; run() already reported the rest.
    await reportFailure(null, err);
    // Kept for compatibility: the desktop app falls back to this line when a
    // failure arrives without a structured event.
    console.error('Bot failed:', err.message.split('\n')[0]);
    process.exit(1);
  });
}

module.exports = { readSettlementMeta, prepareFile, parseInvoice, planSettlement, planPrompt,
                   callClaude, claudeCost, claudeRecord, mergeClaude,
                   CLAUDE_LOG, login, openExpenseModule,
                   INPUT_DIR, PROCESSED_DIR, RECORD_FILE, pendingDocuments, readRecord, writeRecord,
                   filedEntries, claimFileNames, checkFolder, composeRecord, sameDraftName, runFolder,
                   setStep, failure, describeFailure, reportFailure,
                   askUser, askForOTP, askAboutFailure, askAfterExpenseFailure, askAboutAlias,
                   runStage, STAGE_SKIPPED,
                   ASK_LOG };
