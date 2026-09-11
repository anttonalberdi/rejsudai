# rejsudai-bot

> **This automation is now wrapped in a macOS desktop app.** `README.md` is the
> user's guide to that app; `DEVELOPING.md` covers building it, its
> Keychain-backed credential storage, and how it spawns `bot.js`.
> Everything below still describes `bot.js` itself, which is unchanged as an
> automation and still runs standalone as `node bot.js <folder>`. The only edits
> made for the app — a `@@REJSUDAI` progress emitter, a GUI 2FA prompt replacing
> the terminal `readline` fallback, a `REJSUDAI_HEADLESS` toggle, a CDP
> screencast (`app/lib/screencast.js`) that mirrors the page into the app's
> Browser pane, and `rejsudaiStowWindow()`, which parks the Chromium window off
> screen behind that mirror — are inert unless `REJSUDAI_GUI=1` is set, and are
> marked with comments in the source.


Playwright + Claude API automation that logs into **indfak2.dk** (KU's indfak2 expense system), creates expense report drafts, matches card transactions, and attaches invoice PDFs.

## Repository conventions

**Authorship.** Every commit and pull request in this repository is authored by
`anttonalberdi` alone. Do not add a `Co-Authored-By:` trailer, a "Generated with"
line, or any other mention of Claude, Claude Code or Anthropic to a commit
message, a PR description, or a release note — regardless of who or what wrote
the change.

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
- Folder must exist under `RECEIPTS_INBOX` (default: `~/Rejsudai/receipts-inbox/`)
- **A settlement is one folder, kept for as long as the settlement exists:**
  ```
  <settlement>/
    .rejsudai.json   name + alias (written by the app)
    input/           documents waiting to be filed
    processed/       documents already in the indfak2 draft
    manifest.json    the settlement's record, rewritten after every document
  ```
  A run files whatever is in `input/` — plus anything loose in the folder, which
  is how a folder made by hand works — into the settlement's one draft. **To
  continue a settlement, put more receipts in `input/` and run it again**: the
  run reconnects to the draft its record names and carries on. See
  "Continuing a settlement" below.
- The folder is named after the settlement and nothing else. What its name cannot
  carry — the project alias, and the settlement name exactly as it was typed —
  lives in a `.rejsudai.json` written beside the receipts by the desktop app:
  `{ "name": "AI Subscription Fees", "alias": "your-alias-code" }`. A folder made by
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
- **A file moves from `input/` to `processed/` the moment its line saves** —
  a file in `processed/` means it actually made it into the draft (allocated,
  entered as normal cost, or attached as support). For HEIC receipts the
  converted `.jpg` that was actually uploaded goes alongside the original.
  Unprocessed files stay in `input/` for the next run. Nothing is deleted: the
  folder outlives the run. (`CLAIMS_OUTPUT` is single-file mode's only.)
- **The record (`manifest.json`) is cumulative and written as the run goes** —
  first as soon as there is a draft, then after every document, then at the
  end. A run that dies part-way leaves a record that matches the draft and the
  folder, and the next run carries on from exactly there. Each save lays this
  run over the record *as the run found it* (`composeRecord()`, pure, so it
  can be tested without a browser): earlier runs' **filed** entries carry over,
  a document tried again replaces its old entry, and an earlier failure whose
  file is gone drops out. Written to `manifest.json.tmp` and renamed into
  place. Sections:
  - `manifest_version: 2`, `run_at` (the latest run), `updated_at`
  - `settlement` — draft name, settlement number, alias, type, purpose,
    `travel`, `created_at`, `form_fields_entered` (label → value snapshot read
    back from the draft form — from the run that created the draft), save
    errors, counts over the **whole settlement** (`expenses_card` /
    `expenses_normal_cost` / `expenses_unprocessed`), `documents_waiting`
    (read off `input/`, not worked out), `submit` (the latest run's),
    `questions` (every question any run asked and what was answered — a 2FA
    code is recorded as `(code supplied)` and never verbatim), status
  - `invoices[]` — per expense: `role` + `plan_reason` (from the settlement plan),
    `expense_type` (`"From Card Transaction"` or `"Normal Cost"`), `parsed_invoice`
    (vendor/amount/currency/date/document_kind/payment_method/**references**/
    **travel** from Claude — what a later run's plan needs to recognise a cost
    already filed), `matched`, `transaction_row` (full text of the selected grid
    row), `fields_entered` (line-dialog snapshot + attachment names), `attempts`
    (how many tries it took — more than one means somebody retried it),
    `errors`, `run_at`, `moved_to_output` (true once the file is in
    `processed/`; the name predates the folder layout)
  - `supporting_documents[]` — per supporting file: `parsed_invoice`,
    `attached_to` (which expense line it was uploaded to), `moved_to_output`
  - `runs[]` — one entry per run: `run_at`, `finished`, `documents` it set out
    to file, `filed`, `submit`, its Claude cost
  - `claude` — every Claude call the settlement took across all its runs, and
    what it cost: `estimated_cost_usd` (the total), `tokens` (`input` /
    `cache_write` / `cache_read` / `output`), `rates_usd_per_mtok` (the prices
    the estimate used) and `calls[]` — see "Claude calls are on the record"

### Continuing a settlement

Receipts found after a settlement was filed go into its `input/` (the app's
*Add receipts…*, or by hand) and the settlement is run again. What makes that
safe:

- **`checkFolder()` runs before Chromium starts**: a settlement whose record
  says it was submitted is refused (*"already been sent for approval"*), and so
  is one with nothing in `input/`.
- **Reconnect, never duplicate.** A record that names a draft means the run
  must file into that draft: it is found by **exact name** (`findDraftCell` —
  case and whitespace aside; a substring match would let `* Oslo` open
  `* Oslo Workshop`), and its settlement number is checked against the
  record's. Not found and documents were filed into it → a failure (sent,
  deleted or renamed in indfak2 — the hint says which fix fits which). Not
  found and nothing was filed → it is created again, as good as a first run.
- **The header stays as it was.** A reconnected draft keeps the record's type,
  purpose, alias and travel window; new Normal cost lines are dated into that
  window. The plan's own `travel` is used only for a draft made now.
- **The plan sees what is already filed.** `planSettlement(docs, name,
  { filed, draftTravel })` puts the filed documents in the prompt as context the
  reply must not list, with the rule that a new document covering a cost
  already filed is supporting. The shared-reference guard counts filed
  invoices and receipts as payments too, so a CWT e-ticket added a week after
  its invoice is demoted to supporting whatever the plan said.
- **Names are identities.** `claimFileNames()` renames a new document that
  shares a name with one already filed (`hotel.pdf` → `hotel-2.pdf`), and a
  file the record says is filed but which is still in `input/` and missing from
  `processed/` — a run that died between saving its line and moving it — is
  moved to `processed/` rather than filed a second time.
- **Evidence alone has nowhere to go.** Supporting documents ride on a line
  filed in the same run, and there is no automation for adding an attachment to
  a line already in the draft. A batch that is only supporting documents fails
  with *"None of the documents is a cost of its own"* and says to attach them
  in indfak2 by hand.
- **The submit gate looks at the whole settlement**: nothing filed anywhere, or
  anything still in `input/` — re-read from disk, however it got there — and it
  stays a draft.
- A move to `processed/` that fails ends the run (after saving the record): a
  filed document left in `input/` would otherwise be filed again.

### Submitting (opt-in)

A run ends on a **draft** unless it is told otherwise: `--submit` on the command
line, or `REJSUDAI_SUBMIT=1` (what the app's "Submit for approval" toggle sets).
`--no-submit` overrides both.

`submitSettlement()` runs after the last expense line:

- **Gated on a complete settlement.** Nothing is sent while a document is
  unfiled, a supporting document is unattached, or no line was created — a claim
  that is missing a receipt is worse to send than to leave as a draft, and the
  unprocessed files are still in `input/` for a re-run. Single-file mode adds
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
| `supporting` | No price of its own (itineraries, event programmes, participant lists), or a ticket/booking confirmation whose cost an invoice in the folder already files (shared booking ref) | Attached to the first expense line that succeeds, never its own line |

Key behaviors this enables:
- **Booking vs. execution dates**: the parse prompt defines `date` as the *payment*
  date (a trip booked in April but flown in May matches the April card transaction).
- **Receipt photos**: HEIC converted to JPEG; sparse receipts still match via
  vendor keywords + exact amount + ±3-day date window.
- **Duplicate cost documents**: an e-ticket and the agency invoice sharing a PNR —
  the invoice is the expense, the e-ticket becomes supporting. The plan prompt
  says so, and `planSettlement()` enforces it after the reply: a ticket, booking
  confirmation or itinerary the plan made an expense that shares a reference
  (5+ characters, case and spaces ignored) with an invoice or receipt that is
  also an expense is put back to supporting. A double claim is too costly to
  rest on one prompt.
- **Tickets bought directly**: a DSB ticket (or any ticket bought from the
  operator) is often the only record of a journey's cost. The parse prompt
  therefore keeps the price printed on tickets and booking confirmations (every
  ticket, seat reservation and fee on the document added together) and does
  not decide whether it is a duplicate. That is the plan's job, with every
  document in view. With no invoice covering it, the ticket is an expense,
  usually `unknown_expense`. Until 2026-09 the parse prompt nulled the amount on
  every ticket and the plan made them all supporting. A DSB ticket was then
  stapled to an unrelated line as evidence, and the fare never became a line
  of its own.
- **Costs paid outside the travel window**: a ticket bought weeks ahead is
  still a trip cost, but indfak2 rejects a line dated before Departure or after
  Arrival. `createNormalCostLine` dates such a line at the nearer end of the
  window. The description keeps the real payment date, and the manifest's
  `fields_entered` gets a `Date note` saying so. Card lines are unaffected: they
  take the transaction's own date.
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
- **Crash resume**: the record is saved after every document and each filed
  file has already moved to `processed/`, so a re-run after a crash files only
  what is still in `input/`, into the draft the record names (see "Continuing a
  settlement"). A run that died before its first save has no record; it looks
  for a draft named `* <Settlement Name>` and enters it instead of creating a
  duplicate. One failing expense no longer
  aborts the run — the error is recorded in the manifest (`errors`), a screenshot
  is saved next to the other temp files (`os.tmpdir()/rejsudai-fail-<file>.png`,
  its path recorded in the manifest so the app can open it), claimed supporting
  docs are returned to the pending pool, and processing continues. A Normal
  cost line whose save fails returns its supporting docs too — the form is
  cancelled, and they with it.
- **A failing document asks before it is given up on** — the browser is still
  open on the page that failed, so *retry* (after putting the page right by
  hand), *skip* and *stop* are all offered. See "Asking instead of giving up".
  Unattended, and with asking turned off, it skips: the behaviour above.
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
- Writes JSON manifest to `CLAIMS_OUTPUT`, with the same `claude` section as folder mode

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
| `RECEIPTS_INBOX` | `~/Rejsudai/receipts-inbox` | Where settlement folders live (each with `input/`, `processed/`, `manifest.json`), and where a bare file argument is looked up |
| `CLAIMS_OUTPUT` | `~/Rejsudai/claims-output` | Single-file mode's manifests. Folder mode keeps everything in the settlement folder |
| `EXPENSE_ALIAS` | unset | Default project alias code; required for a hand-created folder |
| `EXPENSE_ALIAS_OPTION` | unset | Optional full alias label for pinned-list matching |
| `EXPENSE_TYPE` | `1 -Settlement` | Dropdown partial match for Type field (non-travel folders; trips auto-select Type 2) |
| `EXPENSE_PURPOSE` | `2 - Outside Denmark` | Dropdown partial match for Purpose field (non-travel; trips derive it from the destination) |
| `CORPORATE_CARD` | `SEB Eurocard (a Mastercard, issued by SEB)` | Card description used by the settlement plan to tell corporate-card receipts from out-of-pocket ones |
| `REJSUDAI_SUBMIT` | unset (draft) | `1` sends a cleanly filed settlement for approval; same as `--submit` |
| `REJSUDAI_ALIASES` | unset (set by the app) | JSON `[{name, code}]` — the app's alias library, offered as choices when indfak2 rejects an alias. A CLI run without it gets only retry/stop |
| `REJSUDAI_ASK` | unset (ask when there is someone to ask) | `0` never stops to ask — a document that cannot be filed is skipped, as it always was; `1` forces asking. Unset means the app and a terminal ask, a piped run does not |
| `REJSUDAI_ASK_TIMEOUT` | `300` | Seconds a question waits before taking its default; `0` waits indefinitely |

## Architecture

```
(Stages marked ✻ are wrapped in `runStage`: on failure they ask rather than
end the run — try again, take the way past, or stop.)

run()
 ├─ checkFolder()                        before Chromium: nothing in input/, or
 │                                        already submitted → refused
 ├─ login(page)                       ✻  TOTP + credentials
 ├─ runFolder(page, folderPath)
 │   ├─ readSettlementMeta()             alias + settlement name (.rejsudai.json,
 │   │                                    falling back to the folder name)
 │   ├─ readRecord()                     manifest.json from earlier runs, or null
 │   ├─ claimFileNames()                 new names never clash with filed ones;
 │   │                                    a filed-but-unmoved file goes to processed/
 │   ├─ prepareFile() × N               HEIC → JPEG (tmp dir, cleaned up after)
 │   ├─ parseInvoice() × N           ✻  Claude vision → {document_kind, vendor, date,
 │   │                                    amount, currency, payment_method, references, keywords}
 │   │                                    (only what is in input/ — filed documents come
 │   │                                    from the record)
 │   ├─ planSettlement(docs, …, filed) ✻ Claude → role per file (card_expense /
 │   │                                    pocket_expense / unknown_expense / supporting)
 │   │                                    + trip_start / trip_end travel window, with the
 │   │                                    documents already filed as context
 │   ├─ openExpenseModule(page)       ✻  → {outer, inner}  (two nested iframes)
 │   │                                    (module + draft are one stage)
 │   ├─ findDraftCell()                  the record's draft (exact name, number
 │   │                                    checked), or `* <name>` from a crashed run, or
 │   ├─ fillNewDraft(page, inner, …)    name / type / alias (selectAlias — asks
 │   │                                    for another one if indfak2 rejects it) /
 │   │                                    departure / arrival / purpose;
 │   │                                    two-save pattern
 │   ├─ readSettlementNumber(inner)      reads disabled/readonly numeric input
 │   ├─ saveRecord()                     first save, as soon as there is a draft
 │   └─ loop over expenses (card/unknown first, pocket last):
 │       ├─ findMatchingTransaction      card + unknown: returns matched row(s)
 │       ├─ allocateOneTransaction × N  one line per matched transaction
 │       │   └─ allocateAndUpload        invoice attached to each line; supporting
 │       │                                docs as extra attachments on the first
 │       ├─ createNormalCostLine         pocket, or unknown with no match → "Normal Cost"
 │       │                                (date/amount/currency/cost type/means of payment)
 │       ├─ saveLineAndVerify            every line save verified (form must close)
 │       ├─ askAfterExpenseFailure     on failure: retry / skip / stop, with the
 │       │                              browser still open on the problem
 │       └─ intoProcessed + saveRecord  the filed file (and its supporting docs)
 │                                      leave input/; the record is rewritten
 │   ├─ submitSettlement()            only with --submit/REJSUDAI_SUBMIT=1, and only
 │   │                                    when nothing in the settlement is unfiled;
 │   │                                    verified by re-reading the drafts list
 │   └─ saveRecord(final)                the settlement's record, whole
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
  `@@REJSUDAI step` event, which drives the app's live status line. Never
  `toLowerCase()` a label — they carry names (`CWT`, `Expense module`).
- `failure(title, { detail, hint })` throws an error that already knows its own
  explanation (`err.rejsudai`); `describeFailure()` passes those through untouched.
  Use it wherever the code knows more than the stack trace does — the alias
  search, login, the Expense module.
- `describeFailure(err)` → `{ title, while, detail, hint, raw, step }`. It
  recognises environment-level causes first (network, closed browser, missing
  Chromium, Claude 401/429/billing, ENOENT, ENOSPC), then falls back to a
  step-aware timeout sentence built from the locator in the call log
  (`describeTarget`). Adding a new case is one `if` in the chain.
- `reportFailure(page, err)` screenshots the live page (before `browser.close()`
  in `run()`'s `catch`, which is why the catch is there and not at the top
  level), emits `@@REJSUDAI error`, prints the readable block, and marks the error
  `rejsudaiReported` so the top-level handler does not double-report. It is called
  again at the top level with `page = null` for failures that happen before the
  browser exists.
- Per-document failures inside the expense loop use the same translation: the
  manifest gets `errors: [title]` plus `error_detail` (`while` / `detail` /
  `hint` / `screenshot` / `raw`), and the run continues — after asking what to
  do with it (below).
- App side: `runner.js` keeps the last `error` event as `this.lastFailure`,
  redacts every string in it, and sends it on the `settlement` event as
  `failure` (with `error` set to its title for the old shape). The renderer's
  `failureBlock()` draws cause → step → detail → hint, plus *Screenshot* and
  *Technical details* buttons, into the **Details** tab of the stage pane — the
  card carries only the red border and the `Failed` chip, and a batch that ends
  with a failure opens that settlement's Details on its own. `"Bot failed: <msg>"` is still parsed as the
  fallback for a crash that never reached `reportFailure`.

## Asking instead of giving up

A document that could not be filed used to end one way: the error went into the
manifest and the run moved on. It now asks first, because the browser is still
open on the page that failed and the useful answers are all the user's to give.

- **`askUser({ kind, question, detail, context, options, fallback, required, timeoutMs })`**
  is the channel. Under the app the question goes out as a `@@REJSUDAI ask`
  event and the answer comes back on **stdin** as `{"id":…,"answer":…}`; on the
  CLI the question is printed to stderr and the reply read from the same place.
  There is exactly one stdin reader (`openAnswerChannel`) — two would each eat
  half the answers, which is why the 2FA prompt was folded into this and no
  longer runs its own `readline`.
- **Every question carries an id.** An answer for a question that has already
  timed out is dropped rather than delivered to the next one.
- **Every question carries a `fallback`**: what the run would have done on its
  own. It is taken when asking is off, when the reply is empty, and when the
  timeout passes unanswered — so turning asking off changes nothing about how a
  run behaves. A `fallback` that is not the old behaviour is a bug.
- **`required: true`** (the 2FA code) is asked even where questions are turned
  off, including a piped CLI run: there is no fallback that gets past it.
- **stdin is `unref()`ed except while a question is outstanding.** A resumed
  stdin holds the event loop open, which would leave the process running after
  the last settlement and stall the app's queue.
- **`askAfterExpenseFailure()`** is the one caller in the expense loop:
  - `retry` — the attempt loop runs the document again, after the user has put
    the page right in the browser by hand.
  - `skip` — the `fallback`: recorded in the manifest, file left in `input/`.
  - `stop` — every remaining document is recorded as `Not attempted`, which
    keeps the manifest honest and leaves the **submit gate** looking at an
    incomplete settlement, so a stopped run can never send one.
  - A **closed page rethrows instead of asking** — a dead browser cannot be
    fixed on the page, and a retry would only ask the same question again.
- App side: `runner.js` holds the outstanding question as `pendingAsk`, routes
  `kind: 'totp'` to the existing 2FA modal and everything else to the generic
  one, redacts every string in it (a question can carry raw Playwright text),
  and answers with `answerAsk(id, answer)`. It clears the prompt when the child
  exits, when the run is cancelled, and on `ask_close` — a modal must never
  outlive the question behind it.
- **`askAboutAlias()`** is asked where the alias search fails, inside
  `fillNewDraft` — a wrong alias is a configuration mistake whose fix is
  another alias, not a page that needs a hand. It offers every alias in
  `KNOWN_ALIASES` (the app's library, handed over as `REJSUDAI_ALIASES`), plus
  *look for the same one again* and *stop*. The chosen alias is searched for by
  code (never through `EXPENSE_ALIAS_OPTION`, which belongs to the alias the
  run was configured with), applies to that run only, and is what the manifest
  records as `settlement.alias`. Answering *stop* marks the error
  `rejsudaiAsked` so the draft stage around it does not put a second, vaguer
  question about the same failure.
- **`runStage(page, { question, retry, retryDetail, extra }, fn)`** does the
  same for the stages that used to end the run outright: signing in, reading a
  document, planning, and opening the module + getting a draft (in both folder
  and single-file mode). Each is safe to attempt again on its own — `login()`
  starts from the login page, the Claude calls are pure, and the draft stage
  re-enters a draft it half-created by name, which is the crash-resume path a
  re-run takes anyway, rather than duplicating it.
  - `extra` is the caller's own way past the failure, returned as the
    `STAGE_SKIPPED` sentinel: *I have signed in myself — carry on* (use the
    session in the open window and skip `login()`), and *leave this document
    out* at the reading stage.
  - `CAN_WORK_THE_PAGE` (`REJSUDAI_HEADLESS !== '1'`) gates the answers that
    need a window to work in — signing in by hand, putting a page right before a
    retry. With Chromium hidden they are not offered, and the answers that
    remain are worded for it: the Browser pane is a mirror, not a browser.
  - `fallback` is `'stop'`, which rethrows the original error to the run's own
    handler — so an unattended run, or one with asking turned off, ends exactly
    where it did before.
  - A document left out at the reading stage is recorded in the manifest
    (`Could not be read — left out of the settlement`) and counts as unfiled,
    so it blocks the submit gate like any other missing document.
- **The window comes back before a question is asked.** Under the app Chromium
  is parked off screen (`rejsudaiStowWindow()`), because the Browser pane is the
  view; but the first answer to most of these questions is *put the page right
  and retry*, so `askAboutFailure()` restores its position and focus before
  every one of them, and leaves it on screen — a run that has needed a person
  has stopped being a background job. Off screen is not hidden:
  `CAN_WORK_THE_PAGE` still holds. **Do not "improve" this to a minimised
  window** — a minimised window on macOS stops compositing, which takes the
  screencast (0 frames, and it stays dead after the window is restored),
  `page.screenshot()` (blocks until it times out) and Playwright's actionability
  waits with it.
  - **A retry that fails elsewhere does not overwrite the first cause.** The
    stage keeps the first attempt's `describeFailure()` result and, when it
    finally gives up on a different failure, reports the original title, hint
    and screenshot with *"Trying again stopped elsewhere: …"* appended to the
    detail. The first failure is the one that has to be fixed; the second is
    usually just the page being somewhere else by then.
- **The screenshot is taken when the stage breaks**, kept on the error as
  `err.rejsudaiScreenshot`, and preferred by `reportFailure` over a fresh one. A
  shot taken after someone has spent two minutes putting the page right is a
  picture of the repair, not of the failure.
- **Every question is on the record.** `ASK_LOG` collects `{ at, kind,
  question, answer, label, answered }` for each one and goes into the manifest
  as `settlement.questions`; `answered: false` marks one that timed out into its
  default. The answer is logged to stdout too, so the log a user copies into a
  bug report shows what they were asked and what they chose. A 2FA code is the
  one answer never recorded verbatim — it is stored as `(code supplied)`.
  Per-document `attempts` counts the tries, so a line that only went in on the
  third go does not read like one that went in first time. The app shows both in
  the result view.
- What is still outside all this: the manifest write and the file moves at the
  end of a run, and `submitSettlement`, which records its own errors instead of
  throwing.

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
cancelled so the next expense starts clean, and the file stays in `input/`.

### Date inputs need real keystrokes
`fill()` sets a date input's value without key events, leaving the Angular
directive's model invalid even though the field LOOKS right. `typeDateInto()`
clicks, selects-all, types via `pressSequentially`, then Tabs out. It mirrors
the format of the field's current value (observed M/DD/YYYY). Month/day order
is inferred from the component values (>12 ⇒ that slot is the day); the
current value may be a prefill other than today (e.g. the trip departure), so
"doesn't read as today" must never flip the order to day-first.

### `openExpenseModule` has to survive a second call
The draft stage is retried from the top, so the module step runs again from
wherever the last attempt broke — usually *inside* the module, on a half-filled
draft form, where the portal's top-level `Expense` button is no use (gone, or
matching three elements once the send wizard has run). Waiting for it there
times out, and since `CURRENT_STEP` is `expense_module` by then, that timeout is
what gets reported — burying the real failure. So the step tries the outer
frame's `#ecm_link` first when it is already in the DOM (the same door
`submitSettlement` uses to get back to the drafts list) and only clicks the
`Expense` button when that is not available.

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

A draft is entered by `findDraftCell(inner, name)`: the whole cell text
compared to the name, case and whitespace aside, first *visible* match (the
grid can render a cell twice). Never `filter({ hasText: name })` for this — a
string `hasText` is a case-insensitive **substring** match, which lets
`* Oslo` open `* Oslo Workshop`. `submitSettlement`'s check that the
settlement *left* the list deliberately keeps the loose `includes` match: there
a false match errs towards "not submitted".

### No-match dialog reuse
When no card transaction matches a vendor, the allocation dialog is left open (no Escape press — that navigates the outer Angular frame and destroys the inner iframe context). The next `findMatchingTransaction` call detects `.ng-scope.ng-isolate-scope.stretch` visible and reuses the same open dialog.

### File copy on network mounts
`fs.copyFileSync` fails with `ENOTSUP` on macOS SMB/virtiofs mounts. The bot uses `fs.writeFileSync(dest, fs.readFileSync(src))` instead. Moving a filed document from `input/` to `processed/` is a `rename` (same folder tree), falling back to read + write + unlink when the mount refuses (`moveFile`).

### Claude API — cache_control
Both API calls use `cache_control: { type: "ephemeral" }`:
- `parseInvoice`: instruction text block placed **before** the document block so the instruction is cached independently of document content. Subsequent invoice parsing calls hit the instruction cache.
- `pickOrCreateDraft`: static system prompt cached so repeated calls in the same session don't re-bill the preamble.

Whether a marker caches anything is visible now: every call's cache tokens
(written / read) are in the log and the manifest. A prefix shorter than the
model's minimum (1,024 tokens on Opus 4.8) is silently not cached — no error,
just zeros on both.

### Claude calls are on the record
Every request goes through `callClaude({ purpose, subject }, params)` — never
`anthropic.messages.create` directly — which records it in `CLAUDE_LOG` and
prints it to the log as it happens:

- **What was sent**: the system prompt and each message as text. A document or
  image is named (`[document attached: application/pdf, 84 KB]`), never
  reproduced — base64 is useless to a reader and would bloat both the log and
  the manifest. In the log only, a long text block already printed in full
  (the parsing instruction, once per document) is shown as *"(the same text as
  in Claude #N)"*; the manifest always carries it in full.
- **What came back**: the reply text and `stop_reason`.
- **What it cost**: the token counts from `usage`, priced by `claudeCost()`
  against `CLAUDE_PRICES` (USD per MTok; cache writes 1.25× input for the
  5-minute cache and 2× for the 1-hour one, reads 0.1×). A model missing from
  the table gets `estimated_cost_usd: null`, not a guess. **Changing
  `CLAUDE_MODEL` means checking its row in `CLAUDE_PRICES`.**
- A call that throws is recorded with `error` and a cost of 0 (an API error is
  not billed), then rethrown unchanged, so `describeFailure` sees the same
  error it always did.
- `purpose` is the calling function (`parse_invoice`, `plan_settlement`,
  `pick_option`, `pick_draft`); `subject` is the file or settlement it was
  about. A stage retried through `runStage` shows up as another call. The
  retried call was billed, so it belongs in the total.

`claudeRecord()` is what the manifest gets as `claude`; `printClaudeTotals()`
prints the same total in `run()`'s `finally`. That way a run that failed before
writing a manifest still says what it spent. The app shows the total at the foot
of the Details pane.

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
| Supporting doc left in `input/` | No expense line succeeded in the run | Re-run after fixing matches; it attaches to the first successful line |
| *"None of the documents is a cost of its own"* on a settlement that was already filed | Only supporting documents were added, and there is no automation for attaching to a line already in the draft | Attach them in indfak2 by hand and delete them from `input/`, or add them together with the cost they belong to |
| *"The draft … is no longer among your drafts"* | The settlement was sent, deleted or renamed in indfak2 after it was filed | Sent or deleted: file the new receipts as a settlement of their own. Renamed: give the draft back its name and retry |
| *"The draft named … is settlement no. X, not no. Y"* | Another draft has this settlement's name | Rename or delete the other draft in indfak2, then retry — nothing was filed into it |
| A receipt in `input/` was renamed `x-2.pdf` | A document with that name is already filed in the settlement | Nothing to fix — names are identities in the record, so the new one gets its own |
| *"Nothing to file"* before the browser even starts | `input/` is empty, or the record says the settlement was submitted | Add receipts; a submitted settlement takes no more — start a new one |
| A train ticket was attached to another line as "supporting" and its fare never became a line | Parse prompt nulled every ticket's price; plan made every ticket supporting | Fixed: tickets keep their price and are an expense unless an invoice in the folder shares their booking reference |
| `--submit` run still ends on a draft | Something was left unfiled (the gate), or the send button was not found | Read `settlement.submit` in the manifest: `skipped_reason` names the missing piece; an `errors` entry listing visible buttons means the tenant's send button needs adding to `findSubmitControl` |
| Normal-cost dialog fields not filled | Field labels differ from Description/Date/Amount/Currency | Check the `Normal-cost form snapshot` log line and manifest `fields_entered`; adjust locators in `createNormalCostLine` |
| Line save fails with "Invalid date. Format: M/DD/YYYY" despite a correct-looking date | Cost date outside the draft's Departure–Arrival window, or date was `fill()`ed instead of typed | Fixed: plan supplies `trip_start`/`trip_end` for Departure/Arrival; dates typed via `typeDateInto` |
| Line logged "Allocated" but missing from the draft | Save click swallowed / validation banner not detected (pre-`saveLineAndVerify`) | Fixed: saves are verified (form must close); failures recorded in manifest `errors`, file kept in inbox |
| "Reusing open allocation dialog" then empty-grid no-match on a valid transaction | `.stretch` false-positive dialog detection | Fixed: `allocationPageOpen()` checks the " Allocate" button |
| Invoice total spans several card transactions | Travel-account billing (one charge per ticket/fee) | Fixed: subset-sum match + one line per transaction, same invoice attached to each |
| A failure is reported as a slow Expense module, but the run clearly got further than that | A retried stage re-entered `openExpenseModule` from inside the module | Fixed: the step re-enters via `#ecm_link`, and a stage now reports the failure that started it rather than the one its retry hit |
| An alias is wrong and the only answers offered are retry and stop | No alias library reached `bot.js` (a CLI run, or `REJSUDAI_ALIASES` unset) | Set `EXPENSE_ALIAS` to the right code, or run from the app, which passes its whole alias library |
| A document was skipped without anyone being asked | Asking is off (`REJSUDAI_ASK=0`, or the Settings toggle), or the question timed out and took its default | Turn *Settings → When something goes wrong* back on, or raise the timeout (`0` waits indefinitely) |
| A settlement's Claude cost looks high | Retried stages (each attempt is its own call), or a long PDF (every page is read as an image as well as text) | Read `claude.calls` in the manifest: each call's `purpose`, `subject` and `tokens` say which step and which document the tokens went to |
| A queued run looks stuck and the status line reads *Waiting for your answer* | It is paused on a question | Answer it, or let it time out into its default — the timeout exists so a queue is never blocked by a window nobody is watching |
