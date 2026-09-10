# Rejsud

A small macOS desktop app that files travel and expense settlements into
**indfak2.dk**. It is a window around the existing `bot.js` automation — the
same Playwright + Claude pipeline that used to be driven from a terminal, now
with a Dock icon, a settlement list, a live log, and Aliases and Settings
screens.

No terminal, no Claude Code, no agent permissions are needed to run it.

![Settlements view](build/icon.png)

---

## What it does

1. **New settlement** opens a page where you name the settlement, pick its
   project alias from your library (or create one on the spot), and drop the
   receipts into a drop box — or point it at a folder and use every document
   inside instead. **Run settlement** creates the settlement's folder in your
   receipts inbox, copies the receipts in, and files it immediately; the list
   then shows it as **Running**.
2. It also scans the receipts inbox for folders already holding receipts (e.g.
   `ai_subscription_fees`) and lists them as pending settlements — select some
   and press **Process**.
3. For each one it runs the automation: Claude reads the receipts, plans the
   settlement, and Playwright drives a real Chromium through indfak2 — logging
   in with 2FA, creating the draft, matching card transactions, filling line
   items, and uploading the source files.
4. The **Browser** pane above the log mirrors what Chromium is doing, live —
   the same view whether the browser is hidden or on screen. **Expand** gives it
   the whole window. It is a mirror, not a browser: clicks on it go nowhere.
   Drag the divider between any two panes to resize them (double-click one to
   put it back, or focus it and use the arrow keys); the sizes are remembered
   between launches.
5. Per settlement you get a status (queued / running / done / submitted /
   failed), the error message if it failed, and buttons to open the output
   folder and its `manifest.json`.
6. **Remove** on a settlement deletes it again — a saved one you no longer want,
   or a half-processed folder left behind by a failed run. See *Removing a
   settlement* below.
7. The window follows your macOS appearance, or is pinned light or dark under
   **Settings → Appearance**. See *Appearance* below.

## Draft, or submitted

By default a run stops at a **draft**: everything is filed, and you review and
send it in indfak2 yourself, exactly as the CLI always did.

**Submit for approval**, on the settlement list toolbar and next to *Run
settlement* on the compose page (both show the same choice), sends each
settlement on to your approver as soon as it is filed. The choice is remembered
between launches, is fixed for the duration of a run, and asks for confirmation
before the run starts — tick *Don't ask again* in that dialog, or turn the
question back on under **Settings → Submitting**.

A settlement is only sent when the whole folder made it in: every document
filed, every supporting document attached, no line-save errors. Anything left
over and it stays a draft, says why in the result and the manifest, and the
unprocessed receipts stay in the inbox folder for a re-run. Submitting is also
verified rather than assumed — a settlement counts as sent only once it has left
the drafts list in indfak2.

## Prerequisites

- macOS on Apple silicon (the build targets `arm64`).
- Node.js 18+ and npm — only for development and for building the `.dmg`. The
  finished app bundles its own Node runtime.
- An indfak2 account with 2FA, and an Anthropic API key.

## First-run setup

Until the indfak2 username, password and Anthropic API key are stored, the app
opens on **Settings** every time and says so at the top of the Credentials card;
once they are in place it opens on the settlement list instead. Fill in:

1. **Credentials** — indfak2 username, password, TOTP secret, Anthropic API key.
   These are encrypted with Electron's `safeStorage` (which on macOS wraps a key
   held in your login Keychain) and written to
   `~/Library/Application Support/Rejsud/credentials.enc` with mode `0600`. They
   are never written to a `.env`, never bundled into the app, and are passed to
   the automation only as environment variables for the length of a run. Any
   credential value that somehow appears in the automation's output is replaced
   with `«redacted»` before the log pane ever sees it.

   *TOTP secret*: when you enrol two-factor authentication on indfak2, the QR
   code has a **16-character code printed directly below it** — the one offered
   for typing into an authenticator by hand. That code is the secret: copy-paste
   it into the TOTP field. Copy it exactly as displayed, and if indfak2 prints it
   in spaced groups (`abcd efgh ijkl mnop`), delete the spaces. It is Base32, so
   `A–Z` and `2–7` only — a `0`, `1`, `8` or `9` means you have copied the wrong
   string. It is *not* the 6-digit number the authenticator app displays: that
   rotates every 30 seconds, whereas this is the fixed seed behind it and you
   enter it once. Finish enrolment normally by scanning the same QR code with
   your phone — the app and your phone then derive identical codes from it.

   With the secret, the app generates 2FA codes itself and runs unattended.
   Without it, each run pauses and asks you for a code in a dialog. Settings
   repeats all of this behind "How do I get it?", and `setup-totp.js` can extract
   the secret straight out of the enrolment QR code if indfak2 ever shows you the
   image alone.

   *Anthropic API key*: create one at
   [console.anthropic.com](https://console.anthropic.com/settings/keys) →
   Settings → API keys → **Create key**, on an account with billing set up
   (this is the developer console and is billed per use, separate from a
   Claude.ai subscription). The key starts with `sk-ant-` and is displayed only
   once — copy it straight into the field, and if you lose it, revoke it there
   and create a new one.

2. **Folders** — the claims output folder, where manifests and processed
   receipts are written. Defaults to your home directory.

3. **Expense defaults** — alias option, type, purpose, and the corporate-card
   description. These are used for non-travel settlements; trips are detected
   automatically and select the travel type and purpose themselves.

4. **Chromium** — see below.

The projects you book costs on live on their own **Aliases** tab, between
Settlements and Settings: each entry is a short name of your own plus the alias
code indfak2 knows it by (`1240351001`), the New settlement page picks from this
list, and the marked entry is the one it starts on. **Save aliases** there is
separate from **Save settings**, so the two pages never overwrite each other.
Codes may hold letters, digits, dots, dashes and underscores.

### Chromium (one-time, ~150 MB)

Playwright needs a Chromium build that is not bundled in the `.dmg`. The app
resolves it in this order and shows which one it is using in Settings:

1. its own copy in `~/Library/Application Support/Rejsud/playwright-browsers`
2. Playwright's standard shared cache at `~/Library/Caches/ms-playwright` — so
   if you have ever run `playwright install`, it is reused and nothing is
   downloaded
3. otherwise: Settings → Browser → **Download Chromium…** fetches it into (1)

Whichever wins is passed to the automation as `PLAYWRIGHT_BROWSERS_PATH`.

> The Chromium version must match the installed Playwright. Playwright 1.63
> wants build `1243`; an older cached build does not count, and Settings will
> offer the download.

**Browser visibility.** Chromium runs **visible** by default so you can watch
the automation and step in if indfak2 asks something unexpected. Settings has a
headless toggle if you would rather it ran hidden.

## Appearance

**Settings → Appearance** picks between **Auto**, **Light** and **Dark**. Auto
is the default and follows the macOS appearance, turning with it mid-session.
The choice applies the moment you pick it — it is not waiting on **Save
settings** — and is remembered in `settings.json` as `theme`.

The whole window turns, the Browser pane and the log included: both used to be
dark whatever the rest of the window was doing. The colours are one set of
`light-dark(light, dark)` custom properties in `app/renderer/app.css`, so a
theme is a single `color-scheme` declaration rather than a second palette;
`app.js` stamps `data-theme` on the document for a pinned choice, and `main.js`
sets the same value on Electron's `nativeTheme` so the traffic lights, the
native dialogs and the backdrop behind the page turn with it.

## Development

```bash
npm install
npm run playwright:install   # one-time Chromium download (shared cache)
npm run dev
```

For development you can also drop a `.env` next to `bot.js` (see
`.env.example`); the app reads it as a fallback and Settings offers **Import
from .env** to move those values into the Keychain. `.env` is gitignored.

> `npm run dev` starts with `unset ELECTRON_RUN_AS_NODE` on purpose. Some
> editor-integrated terminals export that variable, which would make `electron .`
> boot as plain Node and fail with `Cannot read properties of undefined (reading 'handle')`.

## Building the `.dmg`

```bash
npm run dist
```

Produces `dist/Rejsud-1.0.0-arm64.dmg` (~129 MB) and `dist/mac-arm64/Rejsud.app`.

### The icon

`build/icon.svg` is the source of the app icon: the REJSUDai mark (paper plane +
AI sparkles) on the macOS icon grid. `electron-builder` reads the rendered
`build/icon.png` and makes the `.icns` from it, so after editing the SVG run:

```bash
node build/render-icon.js
```

which rasterises it to `build/icon.png` at 1024x1024 using the Chromium that
Playwright already installs. `app/renderer/logo.svg` is the same mark without the
icon-grid padding, shown next to the wordmark in the window's top bar.

### Gatekeeper (unsigned build)

The build is **unsigned**, which is fine for personal use. macOS will refuse to
open it on a double-click the first time. Instead:

**right-click the app → Open → Open** in the dialog.

You only need to do this once. If macOS still refuses, clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Rejsud.app
```

To sign and notarize instead, set `mac.identity` in `package.json` to your
Developer ID and add notarization credentials — the hardened-runtime
entitlements are already in place at `build/entitlements.mac.plist`.

## The CLI still works

`bot.js` is untouched as an automation and still runs standalone for debugging:

```bash
node bot.js ai_subscription_fees              # folder mode
node bot.js /path/to/invoice.pdf              # single-file mode
node bot.js ai_subscription_fees --submit     # …and send it for approval
node delete-draft.js "draft name substring"   # clean up after a crashed run
```

Those read credentials and paths from `.env` as they always did. `CLAUDE.md`
documents the automation's behaviour, settlement logic, and edge cases in full.

`run-pending.sh` is the original Linux-era batch script (it still has
`/home/anttonalberdi` paths hardcoded); the app's Process button replaces it.

## Composing a settlement in the app

**New settlement** is a front end for the settlement folder `bot.js` already
reads — it does not change the automation.

- The folder is named after the settlement alone: the name is slugified
  (everything that is not a letter or digit becomes `_`) only so it makes a
  usable directory name. The name as you typed it and the alias code are written
  beside the receipts as `.rejsud.json`, which is what `bot.js` reads — so the
  page can show the draft name (`* Oslo conference`) before anything is created,
  and a settlement saved now is still filed on the right project weeks later.
- The alias comes from the library (the **Aliases** tab) as a
  dropdown of `<short name> — <code>`, starting on the marked default. Picking
  **New alias…** reveals a short-name and code pair: **Add to library** saves it
  without filing anything, and running the settlement saves it anyway, so an
  alias typed once is in the dropdown from then on. Only the code reaches
  indfak2 — the short name exists so the dropdown and the settlement list read
  as project names rather than digits.
- Receipts can be dropped in, chosen from a file dialog, or taken wholesale from
  a declared folder. Dropped folders are expanded; anything that is not a PDF,
  PNG, JPEG or HEIC is listed as skipped rather than silently dropped.
- The two sources are alternatives: declaring a folder replaces the dropped
  files, and dropping files clears the declared folder.
- Receipts are **copied** into the inbox folder — the originals stay where they
  are, which matters because the automation moves processed files to the claims
  output and deletes the inbox folder when it is done.
- A name whose folder already exists is refused (the page says so while you
  type), so a second settlement can never merge into a pending one.

## When a run fails

A failure is reported as four things rather than a stack trace: **what went
wrong**, **which step it happened in**, **the evidence**, and **what to fix**.
They appear on the settlement card in the list, and in the terminal for a CLI
run:

```
✖ Alias "1241143252" does not exist in indfak2, or this account cannot use it.
  While: selecting the project alias 1241143252
  Detail: Searching for "1241143252" returned: 1240351001 - InsituMicroSeq/Hologenomics
  → Fix the alias on the settlement, or set the right default alias in Settings.
  Screenshot: /var/folders/…/rejsud-failure-1757500000000.png
```

- The **screenshot** is taken before the browser closes, so it shows the page
  exactly as it was when the run gave up. *Screenshot* on the card opens it.
- **Technical details** on the card reveals the original Playwright message and
  the top of its call log — the thing to paste into a bug report.
- **While a run is going**, the status line above the log names the step in
  progress (*Selecting the project alias 1241143252*, *Searching the card
  transactions for CWT*), so a stall is visible while it is happening. That step
  is what a failure is attributed to, so both read the same way.
- Recognised causes get their own wording and fix: no network, wrong password,
  a rejected 2FA code, a missing alias, a rate-limited or unpaid Claude key, a
  missing Chromium, a full disk. Anything else falls back to *Timed out while
  &lt;step&gt; — &lt;the thing&gt; never appeared*, which still says where it was.
- A **single document** failing does not stop the run: its readable error, hint
  and screenshot are recorded per document in `manifest.json`
  (`invoices[].error_detail`) and shown in the *Details* table.

## Removing a settlement

Every row in the settlement list has a **Remove** button, which is the inverse of
**Save settlement**: a settlement that has not been filed is only its inbox
folder, so removing it deletes that folder and the receipts copied into it.

- It asks first, in a native confirmation naming the settlement and how many
  receipts go with it. The originals you dropped in are never touched — the
  inbox holds copies.
- Only a folder sitting **directly inside the receipts inbox** can be removed.
  The renderer names the target, but the main process re-checks it against the
  configured inbox and refuses anything else, a symlink included, so a stale row
  can never take an unrelated folder with it.
- A settlement whose folder the automation has already consumed stays listed for
  its result; its button says **Remove from list** and only clears the row.
- Removing is blocked while a run is in progress — the runner holds a snapshot of
  the queue, and deleting a folder out from under it would fail mid-batch.
- It removes nothing in indfak2. A draft already created there has to be deleted
  in indfak2 itself (or with `node delete-draft.js "<name>"` from the repo).

## How the app wraps the automation

The indfak2 automation is deliberately **not** rewritten — it is fragile,
hard-won, and treated as a black box.

- The Electron main process spawns `bot.js` as a child process, one settlement
  folder per invocation, mirroring `run-pending.sh`. It uses Electron's own
  bundled Node via `ELECTRON_RUN_AS_NODE=1`, so no system Node is required.
- All configuration and credentials go in through the child's **environment
  variables** — the same names `bot.js` already reads. No `.env` is written.
- `stdout`/`stderr` are streamed to the log pane; `manifest.json` is read back
  for the structured per-settlement result.
- The child also gets Node's **IPC channel** as a fourth stdio slot, which
  carries only the live browser frames — base64 JPEGs would otherwise swamp the
  log and be pointlessly scanned by the credential redaction pass.
- Only one run happens at a time — indfak2 is a single interactive session — and
  a second run is blocked while one is in progress.

### The changes made to `bot.js`

All of them are inert unless `REJSUD_GUI=1` is set, which only the app does, so
CLI behaviour is unchanged. They are marked with comments in the source:

| Change | Why |
|---|---|
| `rejsudEmit()` helper | Writes one-line `@@REJSUD {json}` progress events to stdout so the app can show progress and locate the manifest without screen-scraping prose. Emits nothing when `REJSUD_GUI` is unset. |
| `rejsudAskGuiForOTP()` in `getOTP()` | The old `readline` fallback prompted on a terminal that a windowed app does not have, and would hang forever. Under the GUI it asks the app for a code and reads it from stdin instead. The terminal prompt is kept for CLI runs. |
| `headless: process.env.REJSUD_HEADLESS === '1'` | Backs the Settings toggle. With the variable unset this is `false` — identical to the original hardcoded value. |
| `SUBMIT_SETTLEMENT` + `submitSettlement()` | Backs the *Submit for approval* toggle (`REJSUD_SUBMIT=1`), and `--submit` on the CLI. Unset, the run ends on a draft exactly as before. |
| `setStep()` / `describeFailure()` / `reportFailure()` | A Playwright abort reads `locator.waitFor: Timeout 10000ms exceeded` and names only a selector, which tells the user nothing. Each stage of the run now declares what it is doing, and a failure is reported as cause + step + evidence + fix — as a `@@REJSUD error` event for the app, and as a printed block on the CLI. See *When a run fails* below. |
| `rejsudStartScreencast()` after `browser.newPage()` | Feeds the Browser pane. Requires `app/lib/screencast.js` lazily and only when the app spawned the process (`process.send` exists), so a CLI run neither loads it nor pays for it. Failures are logged and ignored — a dead preview must not fail a settlement. |

Beyond the optional submit step at the very end of a run, no control flow in the
indfak2 or Playwright logic was changed.

### Why `asar` is disabled

The build sets `asar: false`. The automation runs as a *plain Node* child
process, and plain Node cannot read files inside an asar archive — `bot.js` and
its dependencies have to exist as real files on disk.

## Layout

```
bot.js, delete-draft.js, setup-totp.js, …   the original automation (preserved)
CLAUDE.md                                   automation documentation
app/main.js                                 app lifecycle, IPC, child processes
app/preload.js                              the entire renderer API surface
app/lib/settings.js                         non-secret settings (userData JSON)
app/lib/credentials.js                      safeStorage/Keychain + .env fallback
app/lib/inbox.js                            inbox scan, new-settlement folders, removal
app/lib/runner.js                           spawns bot.js, streams output, queue
app/lib/browsers.js                         Playwright Chromium resolve/install
app/lib/screencast.js                       live browser frames (runs inside bot.js)
app/renderer/                               the window (plain HTML/CSS/JS)
app/renderer/logo.svg                       top-bar mark
build/icon.svg, build/render-icon.js        app-icon source + rasteriser
build/                                      icon + hardened-runtime entitlements
```

The renderer runs with `contextIsolation: true` and `nodeIntegration: false`; it
has no filesystem or child-process access and cannot read a credential value —
only whether one is set and where it came from.

## Privacy

The app makes no network calls of its own: no telemetry, no analytics, no crash
reporting. The only outbound traffic is what the automation already made — the
Anthropic API for reading invoices, and indfak2.dk — plus the one-time Chromium
download if you use it.
