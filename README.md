# Rejsud

A small macOS desktop app that files travel and expense settlements into
**indfak2.dk**. It is a window around the existing `bot.js` automation — the
same Playwright + Claude pipeline that used to be driven from a terminal, now
with a Dock icon, a settlement list, a live log, and a Settings screen.

No terminal, no Claude Code, no agent permissions are needed to run it.

![Settlements view](build/icon.png)

---

## What it does

1. Scans your receipts inbox for folders named `<alias>-<name>`
   (e.g. `1240351001-ai_subscription_fees`) and lists them as pending settlements.
2. You select some and press **Process**.
3. For each one it runs the automation: Claude reads the receipts, plans the
   settlement, and Playwright drives a real Chromium through indfak2 — logging
   in with 2FA, creating the draft, matching card transactions, filling line
   items, and uploading the source files.
4. Per settlement you get a status (queued / running / done / failed), the error
   message if it failed, and buttons to open the output folder and its
   `manifest.json`.

Drafts are **never submitted** — the app leaves them for you to review and
submit in indfak2 yourself, exactly as the CLI always did.

## Prerequisites

- macOS on Apple silicon (the build targets `arm64`).
- Node.js 18+ and npm — only for development and for building the `.dmg`. The
  finished app bundles its own Node runtime.
- An indfak2 account with 2FA, and an Anthropic API key.

## First-run setup

Open **Settings** in the app and fill in:

1. **Credentials** — indfak2 username, password, TOTP secret, Anthropic API key.
   These are encrypted with Electron's `safeStorage` (which on macOS wraps a key
   held in your login Keychain) and written to
   `~/Library/Application Support/Rejsud/credentials.enc` with mode `0600`. They
   are never written to a `.env`, never bundled into the app, and are passed to
   the automation only as environment variables for the length of a run. Any
   credential value that somehow appears in the automation's output is replaced
   with `«redacted»` before the log pane ever sees it.

   *TOTP secret*: the Base32 secret from your indfak2 authenticator enrolment.
   With it, the app generates 2FA codes itself and runs unattended. Without it,
   each run pauses and asks you for a code in a dialog. Settings has a "How do I
   get it?" note, and `setup-totp.js` can extract it from the enrolment QR code.

2. **Folders** — the receipts inbox and the claims output folder. Defaults are
   `~/claude_vm/receipts-inbox` and `~/claude_vm/claims-output`.

3. **Expense defaults** — project alias, alias option, type, purpose, and the
   corporate-card description. These are used for non-travel settlements; trips
   are detected automatically and select the travel type and purpose themselves.

4. **Chromium** — see below.

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
node bot.js 1240351001-ai_subscription_fees   # folder mode
node bot.js /path/to/invoice.pdf              # single-file mode
node delete-draft.js "draft name substring"   # clean up after a crashed run
```

Those read credentials and paths from `.env` as they always did. `CLAUDE.md`
documents the automation's behaviour, settlement logic, and edge cases in full.

`run-pending.sh` is the original Linux-era batch script (it still has
`/home/anttonalberdi` paths hardcoded); the app's Process button replaces it.

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

No control flow in the indfak2 or Playwright logic was changed.

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
app/lib/inbox.js                            inbox scan (<alias>-<name> folders)
app/lib/runner.js                           spawns bot.js, streams output, queue
app/lib/browsers.js                         Playwright Chromium resolve/install
app/renderer/                               the window (plain HTML/CSS/JS)
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
