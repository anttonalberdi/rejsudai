# Developing Rejsud

Everything in this file is for working on the app or building it yourself. If
you just want to *use* Rejsud, [`README.md`](README.md) is the whole story.

## Running from source

```bash
npm install
npm run playwright:install   # one-time Chromium download (shared cache)
npm run dev
```

For development you can drop a `.env` next to `bot.js` (see `.env.example`); the
app reads it as a fallback and Settings offers **Import from .env** to move those
values into the Keychain. `.env` is gitignored.

> `npm run dev` starts with `unset ELECTRON_RUN_AS_NODE` on purpose. Some
> editor-integrated terminals export that variable, which would make `electron .`
> boot as plain Node and fail with `Cannot read properties of undefined (reading 'handle')`.

## Building the `.dmg`

```bash
npm run dist
```

Produces `dist/Rejsud-<version>-arm64.dmg` (~135 MB) and
`dist/mac-arm64/Rejsud.app`. Chromium is *not* in there — the app downloads it on
first run — so the build needs no Playwright browsers.

### Releasing through GitHub Actions

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds the
`.dmg` on a `macos-latest` (Apple silicon) runner and uploads it to the release
whenever one is **published**. It needs no secrets: there is nothing to compile
natively, no Chromium to fetch, and the build is unsigned.

`npm run dist` passes `--publish never`, and has to. On a checkout that has the
release tag on it, electron-builder otherwise decides to publish the artifacts
itself and dies with *GitHub Personal Access Token is not set* — after building
a perfectly good `.dmg`. Uploading is the workflow's last step
(`gh release upload`), not electron-builder's job.

The workflow rewrites `package.json`'s version from the tag name before building
(not committed back), so tagging `v1.0.1` produces `Rejsud-1.0.1-arm64.dmg`.
`workflow_dispatch` rebuilds an existing release by hand.

The README does not name a version or a filename anywhere — it links to
`releases/latest` — so a release never has to edit it.
[`CHANGELOG.md`](CHANGELOG.md) does need editing: before tagging, date its
pending section, open a fresh `## [Unreleased]` above it, and add the tag's
link at the foot of the file. The release notes are that section.

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

### Signing (the build is unsigned)

`mac.identity` is `null`, so electron-builder never re-signs the bundle: what
ships is the stock Electron binary's ad-hoc linker signature (`Signature=adhoc`,
`Sealed Resources=none`). That is fine for a locally built app, which carries no
quarantine flag. A `.dmg` **downloaded from a release** is quarantined, and
against an unsealed ad-hoc bundle macOS usually refuses with *"Rejsud is damaged
and can't be opened"* rather than offering the right-click → Open escape hatch —
which is why the README tells users to run `xattr -dr com.apple.quarantine`.

To sign and notarize properly, set `mac.identity` to your Developer ID and add
notarization credentials (`CSC_LINK`, `CSC_KEY_PASSWORD`, and an app-specific
password or API key) as repository secrets — the hardened-runtime entitlements
are already in place at `build/entitlements.mac.plist`.

### Why `asar` is disabled

The build sets `asar: false`. The automation runs as a *plain Node* child
process, and plain Node cannot read files inside an asar archive — `bot.js` and
its dependencies have to exist as real files on disk.

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
| `setStep()` / `describeFailure()` / `reportFailure()` | A Playwright abort reads `locator.waitFor: Timeout 10000ms exceeded` and names only a selector, which tells the user nothing. Each stage of the run now declares what it is doing, and a failure is reported as cause + step + evidence + fix — as a `@@REJSUD error` event for the app, and as a printed block on the CLI. |
| `rejsudStartScreencast()` after `browser.newPage()` | Feeds the Browser pane. Requires `app/lib/screencast.js` lazily and only when the app spawned the process (`process.send` exists), so a CLI run neither loads it nor pays for it. Failures are logged and ignored — a dead preview must not fail a settlement. |

Beyond the optional submit step at the very end of a run, no control flow in the
indfak2 or Playwright logic was changed.

### How a failure is reported

A failure is translated into four things rather than a stack trace — **what went
wrong**, **which step it happened in**, **the evidence**, and **what to fix** —
before it leaves `bot.js`. `setStep()` names the stage, `failure()` throws an
error that already knows its own explanation, `describeFailure()` recognises
environment-level causes (network, credentials, Claude billing, missing
Chromium, full disk) before falling back to a step-aware timeout sentence, and
`reportFailure()` screenshots the live page before the browser closes. `CLAUDE.md`
covers the chain in full; the user-facing half is in the README.

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
.github/workflows/release.yml               builds the .dmg on release
```

The renderer runs with `contextIsolation: true` and `nodeIntegration: false`; it
has no filesystem or child-process access and cannot read a credential value —
only whether one is set and where it came from.

## Theming internals

The colours are one set of `light-dark(light, dark)` custom properties in
`app/renderer/app.css`, so a theme is a single `color-scheme` declaration rather
than a second palette; `app.js` stamps `data-theme` on the document for a pinned
choice, and `main.js` sets the same value on Electron's `nativeTheme` so the
traffic lights, the native dialogs and the backdrop behind the page turn with it.
