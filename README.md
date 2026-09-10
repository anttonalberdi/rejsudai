<img src="build/icon.png" alt="" width="120" align="right">

# Rejsud

**Files your travel and expense settlements into indfak2.dk for you.**

Drop the receipts in, name the settlement, press go. Rejsud reads every receipt,
logs into indfak2 with your 2FA, creates the draft, matches each cost to the
right card transaction, fills in the line items and uploads the documents — while
you watch it happen in the window.

No terminal. No setup beyond filling in your credentials once.

**[⬇︎ Download the latest version](https://github.com/anttonalberdi/rejsudai/releases/latest)** — a `.dmg` for Macs with Apple silicon (M1 and later).

---

## Installing

1. Download `Rejsud-<version>-arm64.dmg` from the
   [latest release](https://github.com/anttonalberdi/rejsudai/releases/latest).
2. Open it and drag **Rejsud** into your Applications folder.
3. The app is not signed with an Apple developer certificate, so macOS will
   refuse to open it the first time — possibly saying it is *damaged*. It isn't.
   Open Terminal, paste this line and press return:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Rejsud.app
   ```

   That is a one-off. Rejsud opens normally from then on, and updates you install
   later need the same line again.

## Before you start

You need two things:

- **An indfak2 account with two-factor authentication** set up.
- **An Anthropic API key**, which is what reads your receipts. Create one at
  [console.anthropic.com](https://console.anthropic.com/settings/keys) →
  Settings → API keys → **Create key**, on an account with billing set up. This
  is the developer console and is billed per use — it is separate from a
  Claude.ai subscription. The key starts with `sk-ant-` and is shown only once,
  so copy it straight into Rejsud. If you lose it, revoke it there and make a new
  one.

## First run

Until your credentials are stored, Rejsud opens on **Settings** every time and
says so at the top. Fill in:

### 1. Credentials

Your indfak2 username and password, your TOTP secret, and your Anthropic API
key.

**The TOTP secret** is what lets Rejsud generate your 2FA codes and run
unattended. When you enrol two-factor authentication on indfak2, the QR code has
a **16-character code printed directly below it** — the one offered for typing
into an authenticator app by hand. *That* is the secret. Copy it into the field
exactly as displayed, and if indfak2 prints it in spaced groups
(`abcd efgh ijkl mnop`), delete the spaces. It is Base32, so `A–Z` and `2–7`
only — a `0`, `1`, `8` or `9` means you have copied the wrong string. It is
**not** the 6-digit number your authenticator shows, which changes every 30
seconds; this is the fixed seed behind it, and you enter it once. Finish
enrolment normally by scanning the same QR code with your phone — Rejsud and your
phone then produce identical codes.

Without the secret, Rejsud still works: each run pauses and asks you for a code
in a dialog.

> **Where your credentials live.** They are encrypted with your macOS login
> Keychain and written to
> `~/Library/Application Support/Rejsud/credentials.enc`, readable only by you.
> They are never bundled into the app, and they reach the automation only as
> environment variables for the length of a run. If a credential somehow appears
> in a run's output, it is replaced with `«redacted»` before the log shows it.

### 2. Folders

Where processed receipts and manifests are written. Defaults to your home
folder.

### 3. Expense defaults

Alias option, type, purpose, and the description of your corporate card. These
are used for ordinary settlements; trips are recognised automatically and pick
the travel type and purpose themselves.

### 4. Chromium (one-time, ~150 MB)

Rejsud drives a real browser, which is too big to ship inside the app. Settings →
Browser shows which one it is using; if there isn't one, press **Download
Chromium…** and it fetches its own copy. If you have ever used Playwright on this
Mac, the browser already in its cache is reused and nothing is downloaded.

Chromium runs **visible** by default so you can watch and step in if indfak2 asks
something unexpected. Settings has a toggle to run it hidden.

### Your projects: the Aliases tab

The projects you book costs on live on the **Aliases** tab, between Settlements
and Settings. Each entry is a short name of your own plus the alias code indfak2
knows it by (`1240351001`). The New settlement page picks from this list, and the
marked entry is the one it starts on. **Save aliases** is separate from **Save
settings**, so the two pages never overwrite each other.

## Filing a settlement

**New settlement** opens a page where you name the settlement, pick its project
alias (or create one on the spot), and drop the receipts in — or point it at a
folder and use every document inside. **Run settlement** files it immediately;
the list then shows it as **Running**.

- Receipts can be **PDFs, PNGs, JPEGs or HEIC photos** of paper receipts.
  Anything else is listed as skipped rather than silently dropped.
- Receipts are **copied** in. Your originals stay where they are.
- Dropping files and declaring a folder are alternatives — doing one clears the
  other.
- A name whose folder already exists is refused while you type, so a new
  settlement can never merge into a pending one.
- Picking **New alias…** reveals a short-name and code pair. **Add to library**
  saves it without filing anything, and running the settlement saves it anyway,
  so an alias typed once is in the dropdown from then on. Only the code reaches
  indfak2 — the short name is there so the list reads as project names rather
  than digits.

Rejsud also lists any folder of receipts it finds sitting in your inbox as a
pending settlement. Select some and press **Process** to file them in one batch.

### Watching a run

The **Browser** pane mirrors what the browser is doing, live — the same view
whether the browser is hidden or on screen. **Expand** gives it the whole window.
It is a mirror, not a browser: clicking it does nothing. Drag the divider between
any two panes to resize them (double-click one to put it back, or focus it and
use the arrow keys); the sizes are remembered between launches.

Above the log, a status line names the step in progress — *Selecting the project
alias 1240351001*, *Searching the card transactions for CWT* — so a stall is
visible while it is happening.

Each settlement ends with a status (queued / running / done / submitted /
failed), the error if it failed, and buttons to open its output folder and its
`manifest.json` — the record of exactly what was filed where.

## Draft, or submitted

By default a run stops at a **draft**: everything is filed, and you review and
send it in indfak2 yourself.

**Submit for approval** — on the settlement list toolbar and next to *Run
settlement*, both the same choice — sends each settlement on to your approver as
soon as it is filed. The choice is remembered between launches, is fixed for the
duration of a run, and asks for confirmation before the run starts. Tick *Don't
ask again* in that dialog, or turn the question back on under **Settings →
Submitting**.

A settlement is only sent when the whole folder made it in: every document filed,
every supporting document attached, no line-save errors. Anything left over and
it stays a draft, says why, and leaves the unprocessed receipts in the inbox
folder for another go. Sending is verified rather than assumed — a settlement
counts as submitted only once it has actually left the drafts list in indfak2.

## When a run fails

A failure is reported as four things rather than a stack trace: **what went
wrong**, **which step it happened in**, **the evidence**, and **what to fix**.

```
✖ Alias "1241143252" does not exist in indfak2, or this account cannot use it.
  While: selecting the project alias 1241143252
  Detail: Searching for "1241143252" returned: 1240351001 - InsituMicroSeq/Hologenomics
  → Fix the alias on the settlement, or set the right default alias in Settings.
```

- **Screenshot** on the card opens a picture of the page exactly as it was when
  the run gave up — it is taken before the browser closes.
- **Technical details** reveals the underlying message, which is the thing to
  paste into a bug report.
- Common causes get their own wording and fix: no network, a wrong password, a
  rejected 2FA code, a missing alias, a rate-limited or unpaid Anthropic key, a
  missing browser, a full disk.
- **One bad document does not stop the run.** Its own error, hint and screenshot
  are recorded against it in the *Details* table, and everything else is still
  filed.

Receipts that didn't make it stay in the inbox folder, so a re-run picks up where
the last one stopped. A re-run also re-enters the existing draft rather than
creating a second one.

## Removing a settlement

**Remove** on a settlement row is the inverse of saving one: a settlement that
has not been filed is only its folder of copied receipts, so removing it deletes
that folder.

- It asks first, naming the settlement and how many receipts go with it.
- The originals you dropped in are never touched — the inbox holds copies.
- A settlement already filed stays listed for its result; its button says
  **Remove from list** and only clears the row.
- Removing is blocked while a run is in progress.
- **It removes nothing in indfak2.** A draft already created there has to be
  deleted in indfak2 itself.

## Appearance

**Settings → Appearance** picks between **Auto**, **Light** and **Dark**. Auto is
the default and follows macOS, turning with it mid-session. The choice applies
the moment you pick it — it is not waiting on **Save settings** — and the whole
window turns, the Browser pane and the log included.

## Privacy

Rejsud makes no network calls of its own: no telemetry, no analytics, no crash
reporting. The only outbound traffic is the work itself — the Anthropic API to
read your receipts, and indfak2.dk — plus the one-time Chromium download.

---

Building Rejsud, running it from source, or working on the automation:
[`DEVELOPING.md`](DEVELOPING.md).
