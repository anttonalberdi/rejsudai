# rejsud-bot

> **This automation is now wrapped in a macOS desktop app.** `README.md` is the
> user's guide to that app; `DEVELOPING.md` covers building it, its
> Keychain-backed credential storage, and how it spawns `bot.js`.
> Everything below still describes `bot.js` itself, which is unchanged as an
> automation and still runs standalone as `node bot.js <folder>`. The only edits
> made for the app — a `@@REJSUD` progress emitter, a GUI 2FA prompt replacing
> the terminal `readline` fallback, a `REJSUD_HEADLESS` toggle, and a CDP
> screencast (`app/lib/screencast.js`) that mirrors the page into the app's
> Browser pane — are inert unless `REJSUD_GUI=1` is set, and are marked with
> comments in the source.


Playwright + Claude API automation that logs into **indfak2.dk** (KU's indfak2 expense system), creates expense report drafts, matches card transactions, and attaches invoice PDFs.

## Quick start

```bash
cp .env.example .env   # fill in credentials
npm install
node bot.js ai_subscription_fees               # folder mode
node bot.js invoice.pdf                        # single-file mode
node bot.js ai_subscription_fees --submit      # file, then send for approval
```

## Modes

### Folder mode
```
node bot.js <settlement_folder>
```
- Folder must exist under `RECEIPTS_INBOX` (default: `~/macos_shared/receipts-inbox/`)
- The folder is named after the settlement and nothing else. What its name cannot
  carry — the project alias, and the settlement name exactly as it was typed —
  lives in a `.rejsud.json` written beside the receipts by the desktop app:
  `{ "name": "AI Subscription Fees", "alias": "1240351001" }`. A folder made by
  hand has no such file: its own name becomes the settlement name
  (`ai_subscription_fees` → `AI Subscription Fees`) and the alias falls back to
  `EXPENSE_ALIAS` / `EXPENSE_ALIAS_OPTION`.
- Accepts PDFs, PNG/JPEG, and **HEIC photos of physical receipts** (converted to
  JPEG via `heic-convert` for both Claude parsing and indfak2 upload)
- Creates **one draft** named `* <Settlement Name>` for all documents inside
- A **settlement-plan step** (one Claude call over all parsed documents) classifies
  each file — see "Complex settlements" below. Simple folders (all card-paid
  invoices) behave exactly as before.
- Card expenses are matched to a card transaction by vendor keywords + date + amount;
  out-of-pocket expenses become **Normal cost** lines; supporting documents are
  attached to the first successful expense line.
- **Only processed files** move to `CLAIMS_OUTPUT/YYYYMMDD-HHMMSS[-settlementNumber]/` —
  a file in claims-output means it actually made it into the settlement
  (allocated, entered as normal cost, or attached as support). For HEIC receipts
  the converted `.jpg` that was actually uploaded is copied alongside the original.
  Unprocessed files stay in the inbox folder for retry; the inbox folder is only
  deleted when every file was processed.
- Manifest (`manifest.json`) written inside the output folder with three sections:
  - `settlement` — draft name, settlement number, alias, type, purpose,
    `form_fields_entered` (label → value snapshot read back from the draft form),
    save errors, counts split into `expenses_card` / `expenses_normal_cost` /
    `expenses_unprocessed`, status
  - `invoices[]` — per expense: `role` + `plan_reason` (from the settlement plan),
    `expense_type` (`"From Card Transaction"` or `"Normal Cost"`), `parsed_invoice`
    (vendor/amount/currency/date/document_kind/payment_method from Claude),
    `matched`, `transaction_row` (full text of the selected grid row),
    `fields_entered` (line-dialog snapshot + attachment names), `errors`,
    `moved_to_output`
  - `supporting_documents[]` — per supporting file: `attached_to` (which expense
    line it was uploaded to), `moved_to_output`

### Submitting (opt-in)

A run ends on a **draft** unless it is told otherwise: `--submit` on the command
line, or `REJSUD_SUBMIT=1` (what the app's "Submit for approval" toggle sets).
`--no-submit` overrides both.

`submitSettlement()` runs after the last expense line:

- **Gated on a complete settlement.** Nothing is sent while a document is
  unfiled, a supporting document is unattached, or no line was created — a claim
  that is missing a receipt is worse to send than to leave as a draft, and the
  unprocessed files are still in the inbox for a re-run. Single-file mode adds
  one more gate: a draft that was *picked* rather than created may hold unrelated
  lines, so it is never sent.
- **Finds the button by scored label**, not an exact name (`Send`, `Submit`,
  `Send til godkendelse`, …), skipping Save/Cancel/Delete. When nothing scores,
  the error lists every visible button label so the tenant's wording can be added.
- **Walks a wizard, not a button.** Sending is multi-step on this tenant: the
  observed sequence is **"Send (1 of 2)" → "Send"**. It clicks, re-scans (later
  steps may be labelled `Next`/`Finish` rather than `Send`), and clicks again, up
  to four steps; the pressed labels are recorded in `submit.button`. It stops as soon as a click changes no visible button label, so a
  step that did not take can never loop.
- **Confirms** only inside a real modal — a global search would find the send
  button again and press it twice.
- **Verifies rather than assumes**: it returns to the drafts list through the
  outer frame's `#ecm_link` (NOT `openExpenseModule()` — after the wizard runs,
  the top-level `Expense` button matches three elements and Playwright's strict
  mode throws) and checks the settlement has left the list. Still listed, or an
  `Errors count: N` banner appeared, and it reports "not submitted" and leaves
  the draft alone.
- Records the outcome in `settlement.submit`
  (`requested` / `submitted` / `skipped_reason` / `button` / `errors`) and in
  `settlement.status` (`SUBMITTED — sent for approval`).

### Complex settlements (trips: mixed invoices, receipt photos, out-of-pocket costs)

Travel settlements are recognized automatically — there is no separate mode.
After parsing every file (Claude vision extracts `document_kind`, vendor, payment
date, amount, currency, `payment_method`, booking `references`), `planSettlement()`
makes one Claude call over all the metadata and assigns each file a role:

| Role | Meaning | Bot behavior |
|---|---|---|
| `card_expense` | Paid with the corporate card (`CORPORATE_CARD` env var describes it, default SEB Eurocard/Mastercard) or invoiced to a corporate travel account | Match to card transaction → allocate ("From Card Transaction") |
| `pocket_expense` | Clearly paid personally (cash or a non-corporate card on the receipt) | Create a **Normal cost** line directly (no transaction search) |
| `unknown_expense` | Real cost, payment method not determinable | Try transaction match first; **fall back to Normal cost** if nothing matches |
| `supporting` | Not a payment proof: itineraries/e-tickets duplicating an invoice (shared booking ref), event programmes, participant lists | Attached to the first expense line that succeeds, never its own line |

Key behaviors this enables:
- **Booking vs. execution dates**: the parse prompt defines `date` as the *payment*
  date (a trip booked in April but flown in May matches the April card transaction).
- **Receipt photos**: HEIC converted to JPEG; sparse receipts still match via
  vendor keywords + exact amount + ±3-day date window.
- **Duplicate cost documents**: an e-ticket and the agency invoice sharing a PNR —
  the invoice is the expense, the e-ticket becomes supporting.
- **Multi-transaction invoices**: travel-account invoices (e.g. CWT) are charged
  as one card transaction per ticket/fee — a 2130 DKK invoice can be
  1324 + 781 + 25 on the statement. When no single row matches exactly, the
  matcher searches keyword+date-passing rows for a subset whose amounts sum to
  the invoice total. The subset is allocated as **one line per transaction**
  (`allocateOneTransaction`, re-finding each row by its full text) with the same
  invoice PDF attached to every line — selecting several checkboxes and clicking
  Allocate once only allocates ONE of them.
- **Travel settlement type**: when the plan detects a trip it returns a `travel`
  block (`start`/`end` dates of the executed travel window, origin/destination
  city + country — parsed from the CWT itinerary). `fillNewDraft` then selects
  **Type "2 - Travel settlements (days,expenses,transp.)"** instead of
  `EXPENSE_TYPE` and fills the Travel details section it unlocks: Travel Dates
  (Departure/Arrival), Departure place and Destination place (two
  "Country"/"City or Town" pairs, index 0 = departure, 1 = destination).
  Purpose is derived from the destination ("2 - Outside Denmark" for foreign
  trips). Cost-line dates must fall inside the travel window — without it they
  are rejected with a misleading "Invalid date. Format: M/DD/YYYY" error.
- **Crash resume**: if a draft named `* <Settlement Name>` already exists, a
  re-run enters it instead of creating a duplicate. One failing expense no longer
  aborts the run — the error is recorded in the manifest (`errors`), a screenshot
  is saved next to the other temp files (`os.tmpdir()/rejsud-fail-<file>.png`,
  its path recorded in the manifest so the app can open it), claimed supporting
  docs are returned to the pending pool, and processing continues. Files already in the draft from
  a crashed run should be removed from the inbox folder by hand before re-running.
- Processing order: card/unknown expenses first, pocket expenses last — an
  unmatched card search leaves the allocation dialog open for reuse, and the
  normal-cost flow closes it (`closeAllocationDialogIfOpen`, Cancel button, never
  Escape).

### Single-file mode
```
node bot.js /path/to/invoice.pdf
```
- Parses invoice, asks Claude which existing draft to use (or creates new)
- Matches transaction, attaches PDF
- Writes JSON manifest to `CLAIMS_OUTPUT`

### Deleting drafts
```
node delete-draft.js "<draft name substring>"
```
Deletes ALL drafts whose name contains the given text (e.g. leftovers from a
crashed run). The draft list is a ui-grid: rows are selected via their
`.file-selector` toggle, which switches the toolbar to bulk mode where a
"Delete" button appears; a confirmation modal follows. The script aborts before
clicking Delete unless the selected-row count exactly matches the rows found.

## Environment variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `INDFAK_USERNAME` | — | Login email |
| `INDFAK_PASSWORD` | — | Login password |
| `TOTP_SECRET` | — | Base32 TOTP secret (if omitted, prompts interactively) |
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `RECEIPTS_INBOX` | `~/macos_shared/receipts-inbox` | Where to look for input folders/files |
| `CLAIMS_OUTPUT` | `~/macos_shared/claims-output` | Where to write processed output |
| `EXPENSE_ALIAS` | `1240351001` | Default project alias code |
| `EXPENSE_ALIAS_OPTION` | `1240351001 - InsituMicroSeq/...` | Full alias label for pinned-list match |
| `EXPENSE_TYPE` | `1 -Settlement` | Dropdown partial match for Type field (non-travel folders; trips auto-select Type 2) |
| `EXPENSE_PURPOSE` | `2 - Outside Denmark` | Dropdown partial match for Purpose field (non-travel; trips derive it from the destination) |
| `CORPORATE_CARD` | `SEB Eurocard (a Mastercard, issued by SEB)` | Card description used by the settlement plan to tell corporate-card receipts from out-of-pocket ones |
| `REJSUD_SUBMIT` | unset (draft) | `1` sends a cleanly filed settlement for approval; same as `--submit` |

## Architecture

```
run()
 ├─ login(page)                          TOTP + credentials
 ├─ runFolder(page, folderPath)
 │   ├─ readSettlementMeta()             alias + settlement name (.rejsud.json,
 │   │                                    falling back to the folder name)
 │   ├─ prepareFile() × N               HEIC → JPEG (tmp dir, cleaned up after)
 │   ├─ parseInvoice() × N              Claude vision → {document_kind, vendor, date,
 │   │                                    amount, currency, payment_method, references, keywords}
 │   ├─ planSettlement(docs)             Claude → role per file (card_expense /
 │   │                                    pocket_expense / unknown_expense / supporting)
 │   │                                    + trip_start / trip_end travel window
 │   ├─ openExpenseModule(page)          → {outer, inner}  (two nested iframes)
 │   ├─ reuse existing draft by name, or
 │   ├─ fillNewDraft(page, inner, …)    name / type / alias / departure / arrival /
 │   │                                    purpose; two-save pattern
 │   ├─ readSettlementNumber(inner)      reads disabled/readonly numeric input
 │   └─ loop over expenses (card/unknown first, pocket last):
 │       ├─ findMatchingTransaction      card + unknown: returns matched row(s)
 │       ├─ allocateOneTransaction × N  one line per matched transaction
 │       │   └─ allocateAndUpload        invoice attached to each line; supporting
 │       │                                docs as extra attachments on the first
 │       ├─ createNormalCostLine         pocket, or unknown with no match → "Normal Cost"
 │       │                                (date/amount/currency/cost type/means of payment)
 │       └─ saveLineAndVerify            every line save verified (form must close)
 │   ├─ submitSettlement()            only with --submit/REJSUD_SUBMIT=1, and only
 │   │                                    when nothing was left unfiled; verified by
 │   │                                    re-reading the drafts list
 │   └─ write manifest, copy processed files, rmSync inbox folder when empty
 └─ runSingle(page, invoicePath)
     ├─ prepareFile() + parseInvoice()
     ├─ openExpenseModule()
     ├─ pickOrCreateDraft()              Claude picks existing or new
     ├─ fillNewDraft() if new
     └─ findMatchingTransaction + allocateOneTransaction × N
```

Shared line-items helpers: `ensureLineItemsTab()` (toast wait, draft re-entry, tab
navigation, FAB visibility), `openFabChild(inner, mainFab, 'card'|'normal')` (hover +
forced-open fallback chain; 'normal' finds the child by `data-mfb-label` match,
falling back to `li:nth-child(1)`), `closeAllocationDialogIfOpen()` (Cancel/close
button — never Escape), `uploadAttachment()` (Upload attachment → file chooser →
Description → dialog Save; called once per attachment, so one line can carry the
invoice plus supporting documents).

## Failure reporting

A Playwright abort (`locator.waitFor: Timeout 10000ms exceeded` + a call log of
selectors) says nothing about what the bot was doing, so every failure is
translated before it leaves `bot.js`:

- `setStep(step, label)` is called at each stage that can fail on its own —
  `login`, `expense_module`, `draft`, `alias`, `parsing`, `planning`,
  `transactions`, `line`, `submit`. Labels are lowercase gerunds written to read
  mid-sentence (*"Timed out while &lt;label&gt;"*) and are also emitted as a
  `@@REJSUD step` event, which drives the app's live status line. Never
  `toLowerCase()` a label — they carry names (`CWT`, `Expense module`).
- `failure(title, { detail, hint })` throws an error that already knows its own
  explanation (`err.rejsud`); `describeFailure()` passes those through untouched.
  Use it wherever the code knows more than the stack trace does — the alias
  search, login, the Expense module.
- `describeFailure(err)` → `{ title, while, detail, hint, raw, step }`. It
  recognises environment-level causes first (network, closed browser, missing
  Chromium, Claude 401/429/billing, ENOENT, ENOSPC), then falls back to a
  step-aware timeout sentence built from the locator in the call log
  (`describeTarget`). Adding a new case is one `if` in the chain.
- `reportFailure(page, err)` screenshots the live page (before `browser.close()`
  in `run()`'s `catch`, which is why the catch is there and not at the top
  level), emits `@@REJSUD error`, prints the readable block, and marks the error
  `rejsudReported` so the top-level handler does not double-report. It is called
  again at the top level with `page = null` for failures that happen before the
  browser exists.
- Per-document failures inside the expense loop use the same translation: the
  manifest gets `errors: [title]` plus `error_detail` (`while` / `detail` /
  `hint` / `screenshot` / `raw`), and the run continues.
- App side: `runner.js` keeps the last `error` event as `this.lastFailure`,
  redacts every string in it, and sends it on the `settlement` event as
  `failure` (with `error` set to its title for the old shape). The renderer's
  `failureBlock()` draws cause → step → detail → hint, plus *Screenshot* and
  *Technical details* buttons. `"Bot failed: <msg>"` is still parsed as the
  fallback for a crash that never reached `reportFailure`.

## iframe structure

The expense module lives in two nested iframes:

```js
const outer = page.locator('iframe[title="ibistic"]').contentFrame();
const inner = outer.locator('iframe').contentFrame();
```

All DOM interactions go through `inner`. The outer frame holds `#ecm_link` (navigation) and the inner frame holds the Angular SPA.

## Key implementation notes

### Two-save pattern
Angular's Purpose dropdown only loads options after the first save creates a DB record. The bot tries to fill Purpose before the first save (`Promise.race` with 5 s timeout); if that fails it falls back to save → fill Purpose → save again.

### FAB (floating action button)
On the line-items tab, clicking "Create from card transaction" requires:
1. Hover over `.mfb-component__button--main` to expand child buttons (CSS `:hover` transition)
2. Click `li:nth-child(2) > .mfb-component__button--child`

The synthetic hover doesn't always expand the MFB menu — children stay at `scale(0)`
(zero bounding box, so Playwright never considers them visible). The bot uses a
fallback chain: normal click (5 s) → set `data-mfb-state="open"` on the
`ul[data-mfb-toggle]` menu + hover the parent `<li>` → `click({ force: true })` →
DOM-level `el.click()` via `evaluate` (fires `ng-click` regardless of geometry).

State detection: the bot checks whether `.mfb-component__button--main` is visible —
it only renders visibly on the line-items tab. If not visible, it clicks the
line-items tab link (role-based regex, falling back to `a.nth(4)`) and waits for
the FAB to appear. (Anchor-index detection via `a.nth(4)` class was abandoned:
saved line items add anchors that shift the indices, which broke the second
dialog-open after a successful allocation.)

### Toast blocking
A "Success" toast after saves intercepts pointer events. The bot waits for `#toast-container` to be hidden before proceeding.

### Verified saves (`saveLineAndVerify`)
Line-item validation failures show an **"Errors count: N"** banner — NOT an
`.alert-danger`, so `checkErrors` misses them — and silently keep the cost form
open. A save click can also be swallowed while the form is settling. The bot
clicks Save up to 3×, succeeds only when the form actually closes (Cancel button
gone), and reports the banner + field hints otherwise. On failure the form is
cancelled so the next expense starts clean, and the file stays in the inbox.

### Date inputs need real keystrokes
`fill()` sets a date input's value without key events, leaving the Angular
directive's model invalid even though the field LOOKS right. `typeDateInto()`
clicks, selects-all, types via `pressSequentially`, then Tabs out. It mirrors
the format of the field's current value (observed M/DD/YYYY). Month/day order
is inferred from the component values (>12 ⇒ that slot is the day); the
current value may be a prefill other than today (e.g. the trip departure), so
"doesn't read as today" must never flip the order to day-first.

### `.stretch` is not a dialog marker
`#inner-draft-container` and other page containers also carry
`.ng-scope.ng-isolate-scope.stretch`. Detect the open allocation page via the
" Allocate" button (`allocationPageOpen`), never via `.stretch` visibility —
the old check false-positived after successful allocations and made the bot
"reuse" a dialog that wasn't open (empty-grid no-matches on valid transactions).

### Draft list is a ui-grid, not links
Draft names are `h4` cells inside `#inner-draft-container .ui-grid-row`;
clicking the name opens the draft, clicking the row's `.file-selector` selects
it (toolbar switches to bulk mode: Delete appears; single-select hides Delete
in the kebab ⋮ menu after Edit).

### No-match dialog reuse
When no card transaction matches a vendor, the allocation dialog is left open (no Escape press — that navigates the outer Angular frame and destroys the inner iframe context). The next `findMatchingTransaction` call detects `.ng-scope.ng-isolate-scope.stretch` visible and reuses the same open dialog.

### File copy on network mounts
`fs.copyFileSync` fails with `ENOTSUP` on macOS SMB/virtiofs mounts. The bot uses `fs.writeFileSync(dest, fs.readFileSync(src))` instead.

### Claude API — cache_control
Both API calls use `cache_control: { type: "ephemeral" }`:
- `parseInvoice`: instruction text block placed **before** the document block so the instruction is cached independently of document content. Subsequent invoice parsing calls hit the instruction cache.
- `pickOrCreateDraft`: static system prompt cached so repeated calls in the same session don't re-bill the preamble.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A failure shows as a raw `locator.waitFor: Timeout` with no explanation | The failing step has no `setStep()`, or the cause has no rule in `describeFailure` | Add the `setStep()` call, or `throw failure(...)` at the source where the code knows what went wrong |
| `MFA failed` | Wrong `TOTP_SECRET` or clock drift | Check secret; sync system clock |
| `#inner-draft-container` never visible | Network slow; ECM link didn't load | Bot retries 3× with 2 s gaps |
| Purpose validation error after save | Purpose options didn't load before first save | Two-save fallback handles this automatically |
| FAB child button not visible | Synthetic hover didn't expand MFB menu | Fallback chain: force `data-mfb-state="open"` → force click → DOM `el.click()` |
| `ENOTSUP copyfile` | Network mount (virtiofs/SMB) | Fixed: read+write instead of copyFileSync |
| `locator.hover: Timeout` on FAB main | Not on line-items tab (anchor indices shifted after an allocation) | Fixed: state detection via FAB visibility, not anchor index |
| Single mode says "No existing drafts" despite drafts existing | Draft list read as `<a>` links, but it's a ui-grid (h4 name cells) | Fixed: `pickOrCreateDraft` reads `.ui-grid-row h4` cells like folder mode |
| Claude vision rejects a receipt photo | HEIC format (iPhone default) | Fixed: `prepareFile()` converts HEIC → JPEG before parsing/upload |
| Expense filed as Normal Cost but the card charge appears later | `unknown_expense` fallback fired before the transaction posted | Review the draft before submitting; delete the Normal Cost line and re-run, or wait a few days before running trip settlements |
| Supporting doc left in inbox | No expense line succeeded in the run | Re-run after fixing matches; it attaches to the first successful line |
| `--submit` run still ends on a draft | Something was left unfiled (the gate), or the send button was not found | Read `settlement.submit` in the manifest: `skipped_reason` names the missing piece; an `errors` entry listing visible buttons means the tenant's send button needs adding to `findSubmitControl` |
| Normal-cost dialog fields not filled | Field labels differ from Description/Date/Amount/Currency | Check the `Normal-cost form snapshot` log line and manifest `fields_entered`; adjust locators in `createNormalCostLine` |
| Line save fails with "Invalid date. Format: M/DD/YYYY" despite a correct-looking date | Cost date outside the draft's Departure–Arrival window, or date was `fill()`ed instead of typed | Fixed: plan supplies `trip_start`/`trip_end` for Departure/Arrival; dates typed via `typeDateInto` |
| Line logged "Allocated" but missing from the draft | Save click swallowed / validation banner not detected (pre-`saveLineAndVerify`) | Fixed: saves are verified (form must close); failures recorded in manifest `errors`, file kept in inbox |
| "Reusing open allocation dialog" then empty-grid no-match on a valid transaction | `.stretch` false-positive dialog detection | Fixed: `allocationPageOpen()` checks the " Allocate" button |
| Invoice total spans several card transactions | Travel-account billing (one charge per ticket/fee) | Fixed: subset-sum match + one line per transaction, same invoice attached to each |
