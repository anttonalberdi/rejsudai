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

### Added

- **Intel Macs are supported.** A release now carries two `.dmg`s — the existing
  `Rejsudai-<version>-arm64.dmg` for Apple silicon and a new
  `Rejsudai-<version>-x64.dmg` for Intel Macs (an 8-core Core i9 MacBook Pro,
  say). `npm run dist` builds both from either kind of Mac: nothing in the app
  compiles natively, so electron-builder only fetches the matching Electron
  binary. The release workflow uploads both from its one Apple-silicon runner.

### Changed

- `dmg.artifactName` is set explicitly so the Intel `.dmg` is named `-x64`;
  electron-builder's default drops the architecture for x64 and would have
  shipped an unlabelled `Rejsudai-<version>.dmg` next to the arm64 one.
- README's download section now names both files and how to tell which Mac you
  have.

---

## [1.0.0] — 2026-09-10

_The first release: the indfak2 automation as a macOS app._

### Added

**The app**

- macOS window (Electron, Apple silicon) with three tabs — **Settlements**,
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

- `npm run dist` produces an unsigned `Rejsudai-<version>-arm64.dmg` and
  `Rejsudai.app`; Chromium is deliberately not bundled.
- `asar` is disabled — the automation runs as a plain-Node child process, which
  cannot read files inside an asar archive.
- Hardened-runtime entitlements in `build/entitlements.mac.plist`, ready for a
  Developer ID if the build is ever signed.
- GitHub Actions release workflow builds the `.dmg` on an Apple-silicon runner
  and uploads it whenever a release is published; `workflow_dispatch` rebuilds
  one by hand.
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

- macOS on Apple silicon only.
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
[1.0.0]: https://github.com/anttonalberdi/rejsudai/releases/tag/v1.0.0
