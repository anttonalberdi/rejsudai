# Changelog

Notable changes to Rejsudai, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There is one version number for the whole thing: the app and the automation
(`bot.js`) it drives ship together, and the `.dmg` on a release is named after
it.

**Cutting a release.** Don't edit `package.json` — publish a GitHub release on a
`vX.Y.Z` tag and [`.github/workflows/release.yml`](.github/workflows/release.yml)
takes the version from the tag, builds `Rejsudai-X.Y.Z-arm64.dmg` and
`Rejsudai-X.Y.Z-x64.dmg`, and uploads both.
Before tagging, close off the section below by giving it the release date, add a
fresh `## [Unreleased]` above it, and add the tag's link at the foot of this
file.

---

## [Unreleased]

---

## [1.0.3] — 2026-09-11

_A filed settlement can take more receipts, the app says when a newer version
is out, and every Claude call is on the record with what it cost._

### Added

- **Update notices.** On launch Rejsudai checks its GitHub releases. When a
  newer version has a download for this Mac's processor, a top-right tag opens
  that exact `.dmg` in the normal browser.
- **One-click Chromium setup.** The top-right Chromium tag is now a button:
  click it to start the same first-run download available in Settings.
- **A filed settlement can take more receipts.** Settlements now stay in the
  list after they are filed. **Add receipts…** on one (or dropping files onto
  it) and processing it again files them into the same indfak2 draft. The run
  reconnects to that draft by its exact name and settlement number. It stops
  rather than starting a second draft when the first has gone. It also plans
  the new receipts with the filed ones in view, so a document covering a cost
  that is already in the draft is attached as evidence, not claimed twice. A
  receipt identical to one already in the settlement is turned away when you
  add it. A settlement already sent for approval takes nothing more. A new
  **Partly filed** status marks a settlement with a draft and receipts waiting
  for it.
- **Every Claude call is on the record, with what it cost.** The log now shows
  each prompt sent to Claude, the reply that came back, the tokens used and an
  estimated cost. The parsing instruction is printed once and referred back to
  after that. A run ends with the settlement's total, even when it failed.
  `manifest.json` gains a `claude` section with the total, the prices it was
  worked out with, and every call in full, and the *Details* tab shows the
  total. Attached receipts are named in the prompt, never copied into it. The
  figure is an estimate from Anthropic's list prices; the Anthropic invoice is
  what counts.

### Changed

- **One folder per settlement, kept for as long as the settlement.** Receipts
  wait in the settlement's `input/` folder and move to `processed/` as soon as
  their line is saved in indfak2. Its `manifest.json` sits beside them and
  covers the whole settlement across every run. Nothing is written to
  claims-output any more, and a settlement's folder is no longer deleted once
  everything is filed. The claims-output setting is gone from Settings;
  *Folders* now shows where the settlements are kept. Settlements filed
  before this change live on in claims-output and cannot be continued.
- The record is saved after every document rather than once at the end, so a
  run that crashes part-way leaves the settlement knowing exactly what is in
  its draft, and the next run carries on from there.
- A folder made by hand, with its receipts loose inside, still works: they are
  read as input and move to `processed/` once filed. `run-pending.sh` skips
  settlements whose receipts are all filed.

### Fixed

- **A draft is found by its whole name.** Re-entering a draft matched any draft
  whose name *contained* the settlement's, so `* Oslo` could have filed into
  `* Oslo Workshop`.
- **Supporting documents on a failed out-of-pocket line are no longer lost.**
  When a Normal cost line would not save, the documents uploaded with it were
  still recorded as attached, although the form they were on had been
  cancelled. They now wait for the next line, like after any other failure.
- **A ticket bought directly is filed as a cost, not stapled to another
  line.** Every ticket and booking confirmation used to be read as evidence
  with no price. A DSB train ticket, the only record of the journey's cost, was
  attached to a café receipt, and the fare never became a line. Tickets now
  keep their price and become an expense of their own. The exception is a
  ticket covered by a travel-agency invoice in the same settlement: that one is
  still attached to the invoice, and a check after the plan makes sure the same
  booking is never filed twice.
- **A cost paid before the trip no longer fails on its date.** indfak2 only
  accepts line dates between Departure and Arrival. An out-of-pocket line paid
  outside that window is now dated at the nearer end of the trip. Its
  description keeps the real payment date, and the manifest notes the change.

---

## [1.0.2] — 2026-09-10

_A run that hits trouble now asks instead of ending, and the right-hand pane
grows a Details tab to say what happened._

### Added

- **A run asks before it gives up.** When something goes wrong, the run stops
  with Chromium still open on the page that went wrong and offers a way forward
  instead of ending there.
  - **A document that will not file**: try it again (after putting the page
    right by hand), skip it, or stop the run. Previously the error was recorded
    and the document skipped, which meant a whole re-run for a problem that
    often takes one click to fix.
  - **A failure that used to end the run on the spot** — signing in, reading a
    document, planning the settlement, opening the draft — is now asked about
    too: try that step again, take the way past it where there is one (*I have
    signed in myself — carry on*, *leave this document out*), or stop and have
    it reported exactly as before. A briefly rate-limited Claude call or a
    sign-in that needed one nudge no longer costs the whole run.
  - The screenshot on a failure report is now taken at the moment things broke
    rather than when the run ends, so it shows the failure and not the state of
    the page after someone has been putting it right.
  - Questions can be answered from the keyboard (each option is numbered), and
    the app bounces in the Dock while one is waiting, so a run does not sit
    blocked behind another window.
  - *Details* and `manifest.json` now record every question the run asked and
    what was answered, and mark any document that took more than one try. A 2FA
    code is never written to either.
  - A stopped run records every document it never reached, so the manifest is
    honest about them and the submit gate sees an incomplete settlement — a
    stopped run can never be sent for approval.
  - A question nobody answers takes the safe option (skip, and on with the run)
    after five minutes, so a queue is never held up by a window nobody is
    looking at. Both the asking and the wait are under **Settings → When a
    document will not file**; turned off, a run behaves exactly as it did
    before.
  - **An alias indfak2 will not take** is now a question with the answer in
    it: every alias from Settings is offered as a choice, and the one picked
    fills the draft in place of the one that failed (for that run — Settings is
    left alone). A mistyped alias code used to leave *try the same thing again*
    and *stop* as the only ways forward.
  - The 2FA prompt now rides the same channel. Answers carry the id of the
    question they belong to, so a reply that arrives after its question timed
    out can no longer land on the next one.

### Changed

- **A finished settlement says whether it is Ready or Submitted**, instead of
  both reading *Done*. *Ready* means the draft is complete in indfak2 and the
  approval is yours to press; *Submitted* means the run pressed it. The two were
  the same word for the one thing worth knowing at the end of a run.
- **The right-hand pane is two tabs: Browser and Details.** The details of a
  settlement — what was filed, what the run asked, what went wrong — used to be
  a modal you opened from a button on the card, and a failure was a block of red
  text on the card itself. Both now live in the pane, which has room for them.
  Starting a run brings up *Browser*; clicking a settlement brings up its
  *Details*; a batch that ends in a failure comes to rest on that failure.
- **A settlement is removed with the bin at the left-hand end of its row**,
  rather than a *Remove* button among the actions. The confirmation, and what it
  deletes, are unchanged.
- **Chromium stays off your screen** instead of taking over the desktop when a
  run begins. The Browser pane already mirrors the page, so the window was only
  ever in the way — and it is still a real window, parked out of sight rather
  than closed: it comes back, on the page that needs you, when the run stops to
  ask something that wants the page put right by hand. It is parked off the edge
  of the desktop rather than minimised to the Dock, because macOS stops drawing
  a minimised window, which freezes the Browser pane. Running Chromium hidden
  altogether is still a Settings toggle, and a `node bot.js` run from a terminal
  is unchanged — with no Browser pane to fall back on, the window stays where it
  was.

### Fixed

- **A wrong alias was reported as a slow Expense module.** Answering *Try the
  draft again* re-ran that stage from its first step — clicking the portal's
  "Expense" button — which is not something that can be done from inside the
  module, where the failed attempt had left the page. It timed out there, and
  that timeout replaced the real cause in the report. The step now goes back to
  the drafts list through the module's own navigation when the module is
  already open.
- **A retry that fails somewhere else no longer buries what went wrong first.**
  The failure that started a stage is what gets reported, with whatever the
  retry ran into kept alongside it.
- Modals are drawn above the pane splitters. A splitter used to paint a strip
  across the middle of a dialog and swallow clicks that landed on it.
- The receipts inbox is created when it isn't there, instead of the settlement
  list showing a permanent "Inbox folder not found — set it in Settings"
  warning. Settings has had no inbox field since settlements are composed in the
  app, so no path could clear that warning; the inbox is the app's own working
  folder now, and only a path that genuinely cannot be created or read is
  reported, with the reason.
- The wordmark in the top bar read *REJSUDAIai* — the last syllable was in the
  mark twice, once in the name and once in the italic ending it borrows from.

---

## [1.0.1] — 2026-09-10

_Fixes the first-run Chromium download, which was broken in both 1.0.0 `.dmg`s._

### Fixed

- **"Download Chromium…" failed with `exit code 1`.** The packaging filter
  `!**/test/**` stripped `node_modules/playwright/lib/mcp/test/` — 56 KB of
  Playwright's own runtime code, required at the top of its CLI — so every
  invocation of `playwright/cli.js` in a packaged build died with
  `Cannot find module './mcp/test/testBackend'` before it reached the network.
  Both `.dmg`s were affected; it only surfaced on a Mac with no Chromium in
  Playwright's shared cache, since anywhere `playwright install` had ever run
  the app reused that copy and never pressed the button.
- A failed Chromium download now reports the line that names the cause instead
  of only its exit code.

---

## [1.0.0] — 2026-09-10

_The first release: the indfak2 automation as a macOS app._

### Added

**The app**

- macOS window (Electron, Apple silicon and Intel) with three tabs — **Settlements**,
  **Aliases**, **Settings**. No terminal, no Claude Code, no agent permissions.
- **New settlement**: name it, pick its project alias from your library or add
  one inline, and drop receipts in — or point at a folder and use everything
  inside. Creating it writes the inbox folder plus a `.rejsudai.json` carrying the
  alias and the name exactly as typed, then files it immediately. **Save
  settlement** keeps it for later instead.
- Any folder of receipts already sitting in the inbox is listed as a pending
  settlement; select several and **Process** files them in one batch, one
  `bot.js` invocation per settlement.
- **Browser pane** mirrors the live Chromium through a CDP screencast
  (`app/lib/screencast.js`), with an expand toggle and draggable, remembered
  pane sizes.
- **Status line** above the log names the step in progress (*Selecting the
  project alias*, *Searching the card transactions*), so a
  stall is visible while it happens.
- Live log of the run, with every credential value replaced by `«redacted»`
  before the pane ever sees it.
- Per settlement: a status (queued / running / done / submitted / failed), a
  Details table, and buttons to open the output folder and its `manifest.json`.
- **Remove** deletes a settlement's inbox folder after a confirmation naming it
  and its receipt count — only for a folder directly inside the configured
  inbox, never during a run, and never anything in indfak2.
- 2FA prompt in a dialog when no TOTP secret is stored, so a run can still be
  completed by hand.
- **Appearance**: Auto (follows macOS, mid-session included), Light or Dark,
  applied the moment it is picked; the log and Browser pane turn with it.
- **Submit for approval** toggle on the settlement list and the compose page,
  remembered between launches, with a confirmation before a sending run
  (dismissable via *Don't ask again*).

**Credentials and configuration**

- indfak2 username, password, TOTP secret and Anthropic API key encrypted with
  Electron `safeStorage` (macOS login Keychain) at
  `~/Library/Application Support/Rejsudai/credentials.enc`, mode `0600`. They are
  never written to a `.env`, never bundled, and reach the automation only as
  environment variables for the length of a run.
- A dev `.env` is read as a read-only fallback, with a one-click **Import from
  .env**.
- **Aliases** tab: the project library (`short name` + indfak2 code), saved
  separately from settings so the two pages cannot overwrite each other. New
  installs start with an empty library: no project alias ships as a default, in
  the documentation, or in the recorded browser selectors.
- Settings for the claims-output folder, expense defaults (alias option, type,
  purpose, corporate-card description), and a headless toggle.
- Chromium is resolved from the app's own copy, then Playwright's shared cache,
  and can be downloaded on demand from Settings; the winner is passed on as
  `PLAYWRIGHT_BROWSERS_PATH`.
- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`:
  no filesystem or child-process access, and it can read only *whether* a
  credential is set, never its value.

**Filing settlements (`bot.js`)**

- Folder mode creates one draft per settlement folder and files every document
  inside it; single-file mode asks Claude to pick an existing draft or make a
  new one.
- Reads PDFs, PNG/JPEG, and HEIC photos of paper receipts (converted to JPEG for
  both parsing and upload).
- A settlement-plan step classifies each document as `card_expense`,
  `pocket_expense`, `unknown_expense` or `supporting`, so trips with mixed
  invoices, e-tickets and out-of-pocket costs file correctly without a separate
  mode.
- Card expenses are matched to a card transaction by vendor keywords, payment
  date (±3 days) and amount; out-of-pocket costs become Normal cost lines;
  supporting documents are attached to the first successful line.
- Travel-account invoices split across several charges are matched by
  subset-sum and allocated as one line per transaction, with the invoice
  attached to each.
- Trips select the travel settlement type and fill the travel window,
  departure and destination, which is what keeps cost-line dates valid.
- Every line save is verified — the form must actually close — and the
  "Errors count: N" banner is read back rather than assumed away.
- Optional **submit**: `--submit` or `REJSUDAI_SUBMIT=1` walks the multi-step send
  wizard, but only for a settlement with nothing left unfiled, and confirms the
  draft has left the list before calling it sent.
- One failing document no longer aborts a run: the error, a hint and a
  screenshot are recorded against it and the rest is still filed. Unprocessed
  receipts stay in the inbox, and a re-run re-enters the existing draft instead
  of creating a second one.
- `manifest.json` per run records the settlement, each expense (role, matched
  transaction, fields entered, attachments, errors) and each supporting
  document.
- Failures are translated before they leave the automation: cause, the step it
  happened in, the evidence and the fix, for recognised causes (no network,
  wrong password, rejected 2FA, missing alias, rate-limited or unpaid Anthropic
  key, missing Chromium, full disk) and as a step-aware sentence otherwise.
- The CLI is unchanged and still works standalone: the app's additions to
  `bot.js` (`@@REJSUDAI` events, the GUI 2FA prompt, `REJSUDAI_HEADLESS`, the
  screencast) are inert unless `REJSUDAI_GUI=1`.

**Build and distribution**

- `npm run dist` produces two unsigned `.dmg`s — `Rejsudai-<version>-arm64.dmg`
  for Apple silicon and `Rejsudai-<version>-x64.dmg` for Intel — plus the
  `Rejsudai.app` behind each; Chromium is deliberately not bundled. Both build
  from either kind of Mac: nothing here compiles natively, so electron-builder
  only fetches the matching Electron binary. `dmg.artifactName` is set
  explicitly because electron-builder's default drops the architecture for x64
  and would ship an unlabelled `.dmg` beside the arm64 one.
- `asar` is disabled — the automation runs as a plain-Node child process, which
  cannot read files inside an asar archive.
- Hardened-runtime entitlements in `build/entitlements.mac.plist`, ready for a
  Developer ID if the build is ever signed.
- GitHub Actions release workflow builds both `.dmg`s on one Apple-silicon
  runner (the Intel one as a cross-build) and uploads them whenever a release is
  published; `workflow_dispatch` rebuilds a release by hand.
- App icon and top-bar mark from `build/icon.svg`, rasterised by
  `node build/render-icon.js`.

**Documentation**

- `README.md` is the user's guide: installing, the Gatekeeper step, credentials,
  filing a settlement, and what happens when a run fails.
- `DEVELOPING.md` covers running from source, building, releasing, how the app
  wraps the automation, and the changes made to `bot.js`.
- `CLAUDE.md` documents the automation itself — settlement logic, the indfak2
  DOM quirks it works around, and the troubleshooting table.

### Known limitations

- macOS 13 or later, on Apple silicon or Intel.
- The build is unsigned, so a fresh install needs
  `xattr -dr com.apple.quarantine /Applications/Rejsudai.app` once — including
  after each update.
- Chromium is a ~150 MB one-time download on first run.
- One run at a time: indfak2 is a single interactive session.

---

## Before 1.0.0

Rejsudai started as `bot.js`, a Playwright + Claude script driven from a terminal
(`node bot.js <folder>`). Nothing before 1.0.0 was tagged or released; the
history is in the git log, from the initial commit through
`Wrap the indfak2 automation in a macOS desktop app` and
`Add settlement creation, live browser mirror, submit, and readable failures`.
That CLI still works — see [`DEVELOPING.md`](DEVELOPING.md).

<!-- Add one link per release as it is tagged. -->
[1.0.3]: https://github.com/anttonalberdi/rejsudai/releases/tag/v1.0.3
[1.0.2]: https://github.com/anttonalberdi/rejsudai/releases/tag/v1.0.2
[1.0.1]: https://github.com/anttonalberdi/rejsudai/releases/tag/v1.0.1
[1.0.0]: https://github.com/anttonalberdi/rejsudai/releases/tag/v1.0.0
