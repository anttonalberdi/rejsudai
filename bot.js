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
const RECEIPTS_INBOX       = process.env.RECEIPTS_INBOX       || '/home/anttonalberdi/macos_shared/receipts-inbox';
const CLAIMS_OUTPUT        = process.env.CLAIMS_OUTPUT        || '/home/anttonalberdi/macos_shared/claims-output';
const PROJECT_ALIAS        = process.env.EXPENSE_ALIAS        || '1240351001';
const PROJECT_ALIAS_OPTION = process.env.EXPENSE_ALIAS_OPTION || '1240351001 - InsituMicroSeq/Villum/ salary and run';
const EXPENSE_TYPE         = process.env.EXPENSE_TYPE         || '1 -Settlement';
const EXPENSE_PURPOSE      = process.env.EXPENSE_PURPOSE      || '2 - Outside Denmark';
// Describes the corporate card so Claude can tell card-paid receipts (which appear
// as card transactions in indfak2) from out-of-pocket ones (which don't).
const CORPORATE_CARD       = process.env.CORPORATE_CARD       || 'SEB Eurocard (a Mastercard) — and the SEB Rejsekonto corporate travel account, which travel-agency invoices (e.g. CWT) are charged to (card references like "DC 3614...")';

// ---------------------------------------------------------------------------
// FOLDER NAME PARSER
// Expects format: <alias>-<settlement_name_with_underscores>
// e.g. 1240351001-ai_subscription_fees → alias=1240351001, name=AI Subscription Fees
// ---------------------------------------------------------------------------
function parseFolderName(folderName) {
  const dashIdx = folderName.indexOf('-');
  if (dashIdx < 0) return { alias: null, settlementName: folderName.replace(/_/g, ' ') };
  const alias = folderName.slice(0, dashIdx);
  const raw   = folderName.slice(dashIdx + 1).replace(/_/g, ' ');
  // Title-case each word; uppercase words of ≤2 chars (handles acronyms like AI, UK)
  const settlementName = raw
    .split(' ')
    .map(w => w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return { alias, settlementName };
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
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Extract from this expense document and reply ONLY with a JSON object (no markdown):
{"document_kind": "invoice" | "receipt" | "itinerary" | "booking_confirmation" | "event_document" | "other",
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
- Documents that are not themselves proof of a payment (itineraries, e-tickets, booking confirmations, event programmes, participant lists) get document_kind accordingly and amount/currency/payment_method null (amounts printed on them are informational).
- For itineraries/e-tickets also include "travel": {"start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "origin_city": "...", "origin_country": "...", "destination_city": "...", "destination_country": "..."} describing the whole trip (outbound departure to final return); omit for other documents.
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
// ---------------------------------------------------------------------------
async function planSettlement(docs, settlementName) {
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

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    system: [{
      type: 'text',
      text: `You plan how to file expense settlements in a travel-expense system (indfak2).
The employee's corporate card is: ${CORPORATE_CARD}. Costs paid with it (or invoiced to a corporate travel account) appear as card transactions in the system and are filed as "From card transaction". Costs paid personally (cash or a personal card) never appear there and are filed as "Normal cost" (out-of-pocket reimbursement).
Documents that are not proof of a payment (itineraries, e-tickets, booking confirmations, event programmes, participant lists) are supporting documents: not expense lines, but attached to one of the expense lines as evidence.
If two documents cover the same cost (e.g. an e-ticket and the agency invoice sharing a booking reference), the invoice is the expense and the other is supporting, attached to it.

Reply ONLY with JSON (no markdown):
{"travel": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "origin_city": "...", "origin_country": "...", "destination_city": "...", "destination_country": "..."} | null,
 "documents": [{"file": "...", "role": "card_expense" | "pocket_expense" | "unknown_expense" | "supporting", "attach_to": "<file of the expense it supports, or null>", "reason": "short"}]}

- "travel": present when the settlement is a TRIP (there are itinerary/hotel/transport documents). Use the TRAVELER'S OWN itinerary: "start" = their outbound departure date, "end" = their return date (NOT the booking date, and NOT the event's last day if the traveler returns earlier); places come from the itinerary. null for non-trip settlements (e.g. subscriptions).
- "card_expense": clearly paid with the corporate card / corporate travel account.
- "pocket_expense": clearly paid personally (cash or a card that is not the corporate card).
- "unknown_expense": a real cost but the payment method cannot be determined.
- "supporting": not an expense line; set attach_to to the most related expense file, or null for any.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: `Settlement: "${settlementName}"\n\nDocuments:\n${JSON.stringify(docList, null, 2)}`,
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
  return { travel: plan.travel || null };
}

// ---------------------------------------------------------------------------
// 1c. PICK OPTION — Claude chooses one entry from a dropdown's option list
// (used for tenant-specific dropdowns like "Cost type" whose options are only
// known at runtime). Falls back to an "other"-like option, then the first.
// ---------------------------------------------------------------------------
async function pickOption(options, context, instruction) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-8',
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
// When REJSUD_GUI=1 the parent process is the desktop app, which reads stdout
// line by line. Structured events are emitted as a single line prefixed with
// @@REJSUD so the app can show progress and find the manifest without having to
// screen-scrape the human-readable log. Everything else is unchanged.
// ---------------------------------------------------------------------------
const REJSUD_GUI = process.env.REJSUD_GUI === '1';

function rejsudEmit(event, data = {}) {
  if (!REJSUD_GUI) return;
  try { process.stdout.write(`@@REJSUD ${JSON.stringify({ event, ...data })}\n`); } catch {}
}

// Asks the desktop app for a TOTP code and waits for it on stdin. Used only as
// the no-TOTP_SECRET fallback; with a secret configured this is never reached.
function rejsudAskGuiForOTP() {
  return new Promise((resolve, reject) => {
    rejsudEmit('totp_request');
    let buf = '';
    const onData = chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      cleanup();
      if (!line || line === 'CANCEL') reject(new Error('2FA code not provided — run cancelled.'));
      else resolve(line);
    };
    const onEnd = () => { cleanup(); reject(new Error('2FA code not provided — input closed.')); };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.pause();
    };
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
  });
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
  // No TOTP_SECRET configured. Under the desktop app, ask the GUI for a code
  // (a terminal readline prompt would hang a windowed app with no visible
  // prompt); on the CLI keep the original interactive prompt.
  if (REJSUD_GUI) return rejsudAskGuiForOTP();
  const readline = require('readline').createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    readline.question('Enter TOTP code from your authenticator app: ', code => { readline.close(); resolve(code.trim()); });
  });
}

// ---------------------------------------------------------------------------
// 3. LOGIN
// ---------------------------------------------------------------------------
async function login(page) {
  await page.goto('https://indfak2.dk/login/#/');
  await page.locator('#select_value_label_0').click();
  await page.getByText('English').click();
  await page.getByRole('textbox', { name: 'User name' }).fill(process.env.INDFAK_USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.INDFAK_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('textbox', { name: 'Code *' }).fill(await getOTP());
  await page.getByRole('button', { name: 'Ok' }).click();

  try {
    await page.getByRole('button', { name: 'Expense' }).waitFor({ timeout: 10000 });
  } catch {
    throw new Error('MFA failed — TOTP code rejected. Check TOTP_SECRET in .env.');
  }
  console.log('Logged in.');
}

// ---------------------------------------------------------------------------
// 4. NAVIGATE TO EXPENSE MODULE
// ---------------------------------------------------------------------------
async function openExpenseModule(page) {
  await page.getByRole('button', { name: 'Expense' }).click();
  const outer = page.locator('iframe[title="ibistic"]').contentFrame();
  await outer.locator('#ecm_link').waitFor({ timeout: 15000 });
  await outer.locator('#ecm_link').click();

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

  await inner.locator('#inner-draft-container').waitFor({ timeout: 10000 });
  return { outer, inner };
}

// ---------------------------------------------------------------------------
// 5. LINE-ITEMS TAB + FAB HELPERS
// ---------------------------------------------------------------------------
async function ensureLineItemsTab(inner, draftName = null) {
  // Wait for any success/error toast to clear — it intercepts pointer events
  await inner.locator('#toast-container').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

  // Recovery: if on draft list (e.g. after a previous Escape), re-enter the draft first.
  if (await inner.locator('#inner-draft-container').isVisible().catch(() => false) && draftName) {
    const draftLink = inner.locator('#inner-draft-container .ui-grid-row h4, #inner-draft-container a').filter({ hasText: draftName }).first();
    if (await draftLink.isVisible().catch(() => false)) {
      console.log(`  Re-entering draft "${draftName}".`);
      await draftLink.click();
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
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-8',
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

async function fillNewDraft(page, inner, invoice, opts = {}) {
  const alias       = opts.alias     || PROJECT_ALIAS;
  const expenseName = opts.draftName || `* ${invoice.vendor} - ${invoice.date.slice(0, 7)}`;
  const travel      = opts.travel    || null;

  await inner.getByRole('textbox', { name: 'Name *' }).fill(expenseName);
  // Trips use Type 2 ("Travel settlements (days,expenses,transp.)"), which
  // unlocks the Travel details section; everything else uses EXPENSE_TYPE.
  await selectByPartialLabel(inner.getByLabel('Type'), travel ? 'Travel settlements' : EXPENSE_TYPE);
  await new Promise(r => setTimeout(r, 1000)); // form re-renders on type change

  const aliasField = inner.getByRole('textbox', { name: 'Alias *' });
  await aliasField.click();

  await page.waitForResponse(r => r.url().includes('pinned_and_most_used'), { timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));

  let aliasOption;
  if (opts.alias) {
    // Folder mode: always type alias code and pick first matching link from search results
    const searchResponse = page.waitForResponse(r => r.url().includes('dimension_usages'), { timeout: 15000 });
    await aliasField.fill(alias);
    await aliasField.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true })));
    await searchResponse;
    await new Promise(r => setTimeout(r, 500));
    aliasOption = inner.getByRole('link', { name: new RegExp('^' + alias) }).first();
  } else {
    // Config mode: check pinned list first, fall back to search
    aliasOption = inner.getByText(PROJECT_ALIAS_OPTION, { exact: false });
    if (!await aliasOption.isVisible().catch(() => false)) {
      const searchResponse = page.waitForResponse(r => r.url().includes('dimension_usages'), { timeout: 15000 });
      await aliasField.fill(alias);
      await aliasField.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true })));
      await searchResponse;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  await aliasOption.waitFor({ timeout: 10000 });
  await aliasOption.click();
  await new Promise(r => setTimeout(r, 800));

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
    return { name: expenseName, formFields, saveErrors: [...saveErrors1, ...saveErrors2] };
  }

  console.log(`New draft created: "${expenseName}"`);
  return { name: expenseName, formFields, saveErrors: saveErrors1 };
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
    await page.screenshot({ path: `/tmp/rejsud-save-fail-${Date.now()}.png`, fullPage: true }).catch(() => {});
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
  // a misleading "Invalid date. Format: M/DD/YYYY" error.
  const dateBox = inner.getByRole('textbox', { name: /date/i }).first();
  if (await dateBox.count() && invoice.date) {
    const v = await typeDateInto(dateBox, invoice.date);
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
  console.log(`  Normal-cost form snapshot: ${JSON.stringify(fields)}`);

  const lineErrors = await saveLineAndVerify(inner, `normal-cost save (${invoice.vendor})`);
  if (lineErrors.length) {
    await page.screenshot({ path: `/tmp/rejsud-save-fail-${Date.now()}.png`, fullPage: true }).catch(() => {});
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejsud-'));
  const prep = await prepareFile(invoicePath, tmpDir);
  const invoice = await parseInvoice(prep.parsePath);
  console.log('Invoice details:', invoice);

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
  }

  const manifestPath = path.join(CLAIMS_OUTPUT, `${invoice.date}_${invoice.vendor.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  rejsudEmit('manifest', { output_folder: CLAIMS_OUTPUT, manifest: manifestPath });
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
// FOLDER RUN
// Parses alias + settlement name from folder name, creates one draft for all
// documents in the folder. A Claude planning step decides per document whether
// it is a card expense (matched to a card transaction), an out-of-pocket
// expense (entered as a "Normal cost" line), or a supporting document
// (attached to the first successful expense line).
// ---------------------------------------------------------------------------
async function runFolder(page, folderPath) {
  const folderName = path.basename(folderPath);
  const { alias, settlementName } = parseFolderName(folderName);

  const files = fs.readdirSync(folderPath)
    .filter(f => /\.(pdf|png|jpe?g|heic)$/i.test(f))
    .map(f => path.join(folderPath, f));

  if (files.length === 0) throw new Error(`No invoice files found in ${folderPath}`);

  console.log(`\nFolder: ${folderName}`);
  console.log(`  Alias:           ${alias || '(from config)'}`);
  console.log(`  Settlement name: ${settlementName}`);
  console.log(`  Documents found: ${files.length}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejsud-'));
  try {
    await runFolderInner(page, folderPath, folderName, alias, settlementName, files, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runFolderInner(page, folderPath, folderName, alias, settlementName, files, tmpDir) {
  // Parse all documents up-front (before opening the browser flow)
  const docs = [];
  rejsudEmit('phase', { phase: 'parsing', total: files.length });
  for (const f of files) {
    rejsudEmit('progress', { phase: 'parsing', index: docs.length + 1, total: files.length, file: path.basename(f) });
    console.log(`  Parsing ${path.basename(f)}...`);
    const prep = await prepareFile(f, tmpDir);
    const inv  = await parseInvoice(prep.parsePath);
    console.log(`    → [${inv.document_kind}] ${inv.vendor}  ${inv.amount} ${inv.currency}  ${inv.date}  pay: ${inv.payment_method || '?'}`);
    docs.push({ ...inv, filePath: f, uploadPath: prep.uploadPath, converted: prep.converted });
  }

  // Plan the settlement: card expense / out-of-pocket expense / supporting doc
  rejsudEmit('phase', { phase: 'planning' });
  const { travel } = await planSettlement(docs, settlementName);
  console.log('\nSettlement plan:');
  if (travel) console.log(`  Travel: ${travel.origin_city} (${travel.origin_country}) → ${travel.destination_city} (${travel.destination_country}), ${travel.start} → ${travel.end}`);
  for (const d of docs) console.log(`  ${d.role.padEnd(15)} ${path.basename(d.filePath)} — ${d.plan_reason}`);

  // Card-matched (and unknown) expenses first, out-of-pocket last: an unmatched
  // card search leaves the allocation dialog open for reuse by the NEXT card
  // search, so normal-cost lines (which need that dialog closed) go at the end.
  const expenses = [
    ...docs.filter(d => d.role === 'card_expense' || d.role === 'unknown_expense'),
    ...docs.filter(d => d.role === 'pocket_expense'),
  ];
  const supporting = docs.filter(d => d.role === 'supporting');
  if (expenses.length === 0) throw new Error('Plan found no expense documents in the folder.');

  const { outer, inner } = await openExpenseModule(page);

  // Reuse an existing draft with this name (left over from a crashed run) so a
  // re-run continues into the same settlement instead of creating a duplicate.
  // The draft list is a ui-grid: names are h4 cells inside .ui-grid-row (NOT
  // links). Clicking the name cell opens the draft.
  const intendedName = `* ${settlementName}`;
  await inner.locator('#inner-draft-container .ui-grid-row').first().waitFor({ timeout: 10000 }).catch(() => {});
  const draftTexts = (await inner.locator('#inner-draft-container .ui-grid-row h4').allTextContents().catch(() => []))
    .map(t => t.trim()).filter(Boolean);
  if (draftTexts.length) console.log(`  Existing drafts: ${JSON.stringify([...new Set(draftTexts)])}`);
  const existingDraft = inner.locator('#inner-draft-container .ui-grid-row h4').filter({ hasText: intendedName }).first();

  let draftName, formFields = {}, saveErrors = [];
  if (await existingDraft.isVisible().catch(() => false)) {
    console.log(`  Reusing existing draft "${intendedName}" (from a previous run).`);
    await existingDraft.click();
    draftName = intendedName;
    await new Promise(r => setTimeout(r, 1500));
  } else {
    const newDraftLink = inner.locator('#inner-draft-container a').first();
    await newDraftLink.click();
    ({ name: draftName, formFields, saveErrors } = await fillNewDraft(page, inner, {}, {
      draftName: intendedName,
      alias: alias || undefined,
      travel: travel || undefined,
      docs: docs,
    }));
  }

  const settlementNumber = await readSettlementNumber(inner);
  if (settlementNumber) console.log(`  Settlement number: ${settlementNumber}`);

  // Supporting documents are attached to the first expense line that succeeds.
  let pendingSupport = supporting.map(d => ({
    path: d.uploadPath,
    file: path.basename(d.filePath),
    description: `Supporting document: ${d.vendor || path.basename(d.filePath, path.extname(d.filePath))}`,
  }));
  let supportAttachedTo = null;
  const takePendingSupport = hostFile => {
    if (!pendingSupport.length) return [];
    const extras = pendingSupport;
    pendingSupport = [];
    supportAttachedTo = hostFile;
    return extras;
  };

  // Process each expense into the draft
  const results = [];
  rejsudEmit('phase', { phase: 'filing', total: expenses.length });
  for (const doc of expenses) {
    rejsudEmit('progress', { phase: 'filing', index: results.length + 1, total: expenses.length, file: path.basename(doc.filePath), role: doc.role });
    console.log(`\nProcessing: ${path.basename(doc.filePath)} [${doc.role}] (${doc.vendor} ${doc.amount} ${doc.currency})`);
    const docInfo = {
      file: path.basename(doc.filePath),
      role: doc.role,
      plan_reason: doc.plan_reason,
      parsed_invoice: {
        vendor: doc.vendor, amount: doc.amount,
        currency: doc.currency, date: doc.date,
        document_kind: doc.document_kind || null,
        payment_method: doc.payment_method || null,
        keywords: doc.keywords || [],
      },
    };

    // One failing expense must not kill the whole run — record the error,
    // restore any supporting docs it claimed, and continue with the rest.
    let extras = [];
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
          ...docInfo, expense_type: 'From Card Transaction', matched: true,
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
          { draftName, extraAttachments: extras });
        results.push({
          ...docInfo, expense_type: 'Normal Cost', matched: false,
          transaction_row: null, fields_entered: fields, errors,
          moved_to_output: errors.length === 0,
        });
      } else {
        console.log('  ⚠ No match — skipping (left in inbox for retry).');
        results.push({
          ...docInfo, expense_type: null, matched: false, transaction_row: null,
          fields_entered: null, errors: [], moved_to_output: false,
        });
      }
    } catch (err) {
      console.error(`  ✗ Failed on ${docInfo.file}: ${err.message.split('\n')[0]}`);
      await page.screenshot({ path: `/tmp/rejsud-fail-${docInfo.file.replace(/[^a-z0-9]/gi, '_')}.png`, fullPage: true }).catch(() => {});
      if (extras.length) { pendingSupport = extras; supportAttachedTo = null; }
      results.push({
        ...docInfo, expense_type: null, matched: false, transaction_row: null,
        fields_entered: null, errors: [err.message.split('\n')[0]], moved_to_output: false,
      });
      await closeAllocationDialogIfOpen(inner).catch(() => {});
    }
  }

  const allocatedCount = results.filter(r => r.moved_to_output).length;
  const unmatchedCount = results.filter(r => !r.moved_to_output).length;
  console.log(`\n✓ Draft "${draftName}" complete: ${allocatedCount} line(s) created, ${unmatchedCount} unprocessed.`);
  if (pendingSupport.length) console.log(`  ⚠ Supporting document(s) NOT attached (no expense line succeeded): ${pendingSupport.map(s => s.file).join(', ')}`);
  console.log('  Status: DRAFT (not submitted — please review and submit manually)');

  // Build output folder name: YYYYMMDD-HHMMSS[-settlementNumber]
  const now = new Date();
  const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  const outputFolderName = settlementNumber ? `${ts}-${settlementNumber}` : ts;
  const outputFolderPath = path.join(CLAIMS_OUTPUT, outputFolderName);
  fs.mkdirSync(outputFolderPath, { recursive: true });

  const supportingResults = supporting.map(d => ({
    file: path.basename(d.filePath),
    plan_reason: d.plan_reason,
    attached_to: supportAttachedTo,
    moved_to_output: !!supportAttachedTo,
  }));

  // Write manifest inside the output folder
  const manifest = {
    run_at: new Date().toISOString(), mode: 'folder',
    settlement: {
      draft_name: draftName,
      settlement_number: settlementNumber || null,
      original_folder: folderName,
      alias: alias || PROJECT_ALIAS,
      type: travel ? '2 - Travel settlements (days,expenses,transp.)' : EXPENSE_TYPE,
      purpose: derivePurpose(travel, docs),
      travel: travel || null,
      form_fields_entered: formFields,
      save_errors: saveErrors,
      expenses_total: results.length,
      expenses_card: results.filter(r => r.expense_type === 'From Card Transaction' && r.moved_to_output).length,
      expenses_normal_cost: results.filter(r => r.expense_type === 'Normal Cost' && r.moved_to_output).length,
      expenses_unprocessed: unmatchedCount,
      status: 'DRAFT — not submitted, review and submit manually',
    },
    invoices: results,
    supporting_documents: supportingResults,
  };
  fs.writeFileSync(path.join(outputFolderPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // Tell the desktop app exactly where the results landed (it reads the
  // manifest for the per-settlement result view and the "open folder" button).
  rejsudEmit('manifest', { output_folder: outputFolderPath, manifest: path.join(outputFolderPath, 'manifest.json') });

  // Move only the PROCESSED files into the output folder — a file in
  // claims-output means it actually made it into the settlement. Unprocessed
  // files stay in the inbox folder so a later run can retry them.
  // Use readFileSync+writeFileSync instead of copyFileSync — the latter uses a
  // kernel copyfile(2) syscall that fails with ENOTSUP on some network mounts.
  const processedFiles = new Set([
    ...results.filter(r => r.moved_to_output).map(r => r.file),
    ...supportingResults.filter(s => s.moved_to_output).map(s => s.file),
  ]);
  for (const doc of docs) {
    if (!processedFiles.has(path.basename(doc.filePath))) continue;
    fs.writeFileSync(path.join(outputFolderPath, path.basename(doc.filePath)), fs.readFileSync(doc.filePath));
    // HEIC receipts: also keep the converted JPEG that was actually uploaded
    if (doc.converted) {
      fs.writeFileSync(path.join(outputFolderPath, path.basename(doc.uploadPath)), fs.readFileSync(doc.uploadPath));
    }
    fs.unlinkSync(doc.filePath);
  }
  const leftover = docs.filter(d => !processedFiles.has(path.basename(d.filePath)));
  if (leftover.length === 0) {
    fs.rmSync(folderPath, { recursive: true, force: true });
  } else {
    console.log(`  ${leftover.length} unprocessed file(s) left in ${folderPath} for retry.`);
  }

  console.log(`  Output: ${outputFolderPath}`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function run() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node bot.js <invoice-file>');
    console.error('       node bot.js <folder>          e.g. 1240351001-ai_subscription_fees');
    process.exit(1);
  }

  const targetPath = path.isAbsolute(arg) ? arg : path.join(RECEIPTS_INBOX, arg);
  const isFolder   = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();

  // Visible browser stays the default (REJSUD_HEADLESS unset === headless:false),
  // so CLI behaviour is unchanged; the desktop app's Settings toggle sets it to 1.
  const browser = await chromium.launch({ headless: process.env.REJSUD_HEADLESS === '1', slowMo: 700 });
  const page    = await browser.newPage();

  try {
    await login(page);
    if (isFolder) {
      await runFolder(page, targetPath);
    } else {
      console.log(`\nParsing invoice: ${targetPath}`);
      await runSingle(page, targetPath);
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('Bot failed:', err.message);
    process.exit(1);
  });
}

module.exports = { parseFolderName, prepareFile, parseInvoice, planSettlement, login, openExpenseModule };
