<img src="build/icon.png" alt="" width="120" align="right">

# Rejsudai

**Files your travel and expense settlements into indfak2.dk for you.**

Drop the receipts in, name the settlement, press go. Rejsudai reads every receipt,
logs into indfak2 with your 2FA, creates the draft, matches each cost to the
right card transaction, fills in the line items and uploads the documents — while
you watch it happen in the app.

No terminal. No setup beyond filling in your credentials once.

**[⬇︎ Download the latest version](https://github.com/anttonalberdi/rejsudai/releases/latest)** — for any Mac: `-arm64.dmg` for Apple silicon (M1 and later), `-x64.dmg` for Intel.

---

## Installing

1. Download the `.dmg` for your Mac from the
   [latest release](https://github.com/anttonalberdi/rejsudai/releases/latest):

   | Your Mac | File |
   |---|---|
   | Apple silicon — M1, M2, M3, M4 | `Rejsudai-<version>-arm64.dmg` |
   | Intel — e.g. a Core i9 MacBook Pro | `Rejsudai-<version>-x64.dmg` |

   Not sure which you have? Apple menu → **About This Mac**: an Apple-silicon
   Mac shows a *Chip* line (Apple M1, M2, …), an Intel Mac a *Processor* line.
2. Open it and drag **Rejsudai** into your Applications folder.
3. The app is not signed with an Apple developer certificate, so macOS will
   refuse to open it the first time — possibly saying it is *damaged*. It isn't.
   Open Terminal, paste this line and press return:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Rejsudai.app
   ```

   That is a one-off. Rejsudai opens normally from then on, and updates you install
   later need the same line again.

Rejsudai checks GitHub when it opens. If a newer build is available for your
Mac's processor, the **Update … available** tag in the top-right opens the
matching `.dmg` download in your normal browser.

## Before you start

You need three things:

- **A Mac running macOS 13 (Ventura) or later** — Apple silicon or Intel, both
  are supported.
- **An indfak2 account with two-factor authentication** set up.
- **An Anthropic API key**, which is what reads your receipts. Create one at
  [console.anthropic.com](https://console.anthropic.com/settings/keys) →
  Settings → API keys → **Create key**, on an account with billing set up. This
  is the developer console and is billed per use — it is separate from a
  Claude.ai subscription. The key starts with `sk-ant-` and is shown only once,
  so copy it straight into Rejsudai. If you lose it, revoke it there and make a new
  one.

## First run

Until your credentials are stored, Rejsudai opens on **Settings** every time and
says so at the top. Fill in:

### 1. Credentials

Your indfak2 username and password, your TOTP secret, and your Anthropic API
key.

**The TOTP secret** is what lets Rejsudai generate your 2FA codes and run
unattended. When you enrol two-factor authentication on indfak2, the QR code has
a **16-character code printed directly below it** — the one offered for typing
into an authenticator app by hand. *That* is the secret. Copy it into the field
exactly as displayed, and if indfak2 prints it in spaced groups
(`abcd efgh ijkl mnop`), delete the spaces. It is Base32, so `A–Z` and `2–7`
only — a `0`, `1`, `8` or `9` means you have copied the wrong string. It is
**not** the 6-digit number your authenticator shows, which changes every 30
seconds; this is the fixed seed behind it, and you enter it once. Finish
enrolment normally by scanning the same QR code with your phone — Rejsudai and your
phone then produce identical codes.

Without the secret, Rejsudai still works: each run pauses and asks you for a code
in a dialog.

> **Where your credentials live.** They are encrypted with your macOS login
> Keychain and written to
> `~/Library/Application Support/Rejsudai/credentials.enc`, readable only by you.
> They are never bundled into the app, and they reach the automation only as
> environment variables for the length of a run. If a credential somehow appears
> in a run's output, it is replaced with `«redacted»` before the log shows it.

### 2. Folders

Nothing to set. **Settings → Folders** shows where your settlements are kept
(`~/Rejsudai/receipts-inbox`), with a button to open it. Each settlement is a
folder in there: `input/` holds the receipts waiting to be filed,
`processed/` the ones already in the indfak2 draft, and `manifest.json` the
record of what went where.

### 3. Expense defaults

Alias option, type, purpose, and the description of your corporate card. These
are used for ordinary settlements; trips are recognised automatically and pick
the travel type and purpose themselves.

### 4. Chromium (one-time, ~150 MB)

Rejsudai drives a real browser, which is too big to ship inside the app. Settings →
Browser shows which one it is using; if there isn't one, press **Download
Chromium…** and it fetches its own copy. If you have ever used Playwright on this
Mac, the browser already in its cache is reused and nothing is downloaded.

Chromium **stays off your screen**: the Browser pane already shows you
everything it is doing, so there is no reason for a browser window to take over
your desktop when a run starts. It is still a real window, parked out of sight
rather than closed — it comes back, on the page that needs you, if the run stops
to ask something that wants the page put right by hand. Settings has a toggle to
run it hidden instead, with no window at all.

(It is parked off the edge of the desktop rather than minimised to the Dock:
macOS stops drawing a minimised window altogether, which freezes the Browser
pane. Off screen, it behaves exactly like a window you can see.)

### Your projects: the Aliases tab

The projects you book costs on live on the **Aliases** tab, between Settlements
and Settings. Each entry is a short name of your own plus the alias code indfak2
knows it by (`your-alias-code`). The New settlement page picks from this list, and the
marked entry is the one it starts on. **Save aliases** is separate from **Save
settings**, so the two pages never overwrite each other.

## Filing a settlement

**New settlement** opens a page where you name the settlement, pick its project
alias (or create one on the spot), and drop the receipts in — or point it at a
folder and use every document inside. **Run settlement** files it immediately;
the list then shows it as **Running**.

- Receipts can be **PDFs, PNGs, JPEGs or HEIC photos** of paper receipts.
  Anything else is listed as skipped rather than silently dropped.
- A **ticket bought directly** (a DSB ticket, say) is filed as a cost of its
  own. If you bought it before the trip, the line is dated on the day you
  left, because indfak2 won't accept a date outside the trip. The day you paid
  stays in the description. A ticket that duplicates a travel-agency invoice
  in the same settlement is attached to that invoice instead.
- Receipts are **copied** in. Your originals stay where they are.
- Dropping files and declaring a folder are alternatives — doing one clears the
  other.
- A name that another settlement already has is refused while you type, so a
  new settlement can never merge into an existing one. To add to that one, use
  its **Add receipts…** instead (below).
- Picking **New alias…** reveals a short-name and code pair. **Add to library**
  saves it without filing anything, and running the settlement saves it anyway,
  so an alias typed once is in the dropdown from then on. Only the code reaches
  indfak2 — the short name is there so the list reads as project names rather
  than digits.

**A settlement stays in the list after it is filed**, with its receipts and
its record, for as long as you keep it. Rejsudai also lists any folder of
receipts it finds in the settlements folder, including ones made by hand.
Select the ones with something to file and press **Process** to file them in
one batch.

### Adding receipts to a settlement later

The hotel invoice arrives a week after the trip, or a receipt turns up in a
coat pocket. Press **Add receipts…** on the settlement (or drop the files onto
it) and process it again. The receipts go into the settlement's `input/`
folder, and the run files them into **the same draft** in indfak2. It never
starts a second one.

- The run **reconnects** to the draft by its exact name and checks the
  settlement number against the one it recorded. If the draft has gone from
  your drafts (sent, deleted or renamed in indfak2 since), the run stops and
  says so. It does not start a fresh draft that would split the settlement in
  two.
- It **knows what is already filed**. Reading the new receipts, it sees the
  ones already in the draft, so an e-ticket for a flight whose invoice went in
  last week is attached as evidence, not claimed a second time.
- A receipt **identical** to one already in the settlement is turned away when
  you add it, with a note saying which one it matches. One that only shares a
  name is kept under a new name (`hotel-2.pdf`).
- The draft keeps its header: the trip dates, type and purpose it was created
  with. A new out-of-pocket cost paid before the trip is dated on the day you
  left, like any other.
- **Evidence alone cannot be added.** An itinerary or a booking confirmation
  is attached to a cost line filed in the same run, and Rejsudai cannot open a
  line already in the draft to add one. Add it together with a cost, or attach
  it in indfak2 by hand.
- A settlement that has been **sent for approval** takes nothing more. Put the
  new receipts in a settlement of their own.

### What the status on a settlement means

| | |
|---|---|
| **Queued** | Waiting to be filed for the first time. |
| **Running** | Being filed into indfak2 now. |
| **Partly filed** | It has a draft in indfak2, and receipts waiting to go into it — ones you added since, or ones that did not make it last time. Process it to file them. |
| **Ready** | Every receipt is filed. The draft is complete in indfak2 and the approval is yours to press. |
| **Submitted** | Sent for approval — the run pressed it for you, because *Submit for approval* was on. |
| **Failed** | Something stopped it. The reason is on the **Details** tab. |
| **Cancelled** | The run was stopped before this settlement finished. |
| **Empty** | The folder has no receipts in it yet. |

The distinction worth knowing is **Ready** against **Submitted**: both mean the
run did its job, but only one of them means indfak2 has been asked to approve
anything. A *Ready* settlement is still sitting there waiting for you. If you
send it yourself in indfak2, the app cannot tell and it goes on saying *Ready*.
Delete it from the list once you no longer need its record.

### Watching a run

The right-hand pane has two tabs. **Browser** mirrors what the browser is doing,
live — the same view whether Chromium is hidden or parked off screen. **Details**
holds everything known about one settlement: what was filed, what the run asked
you, and anything that went wrong.

They swap themselves as the work moves. Starting a run brings up **Browser**,
because that is the thing that is moving; clicking any settlement brings up its
**Details**, because that is the thing you just asked about; and a batch that
ends with a failure comes to rest on the failure, rather than leaving it behind
a tab you have to think to press. Either tab can be picked by hand at any time.
**Expand** gives whichever is showing the whole window.
It is a mirror, not a browser: clicking it does nothing. Drag the divider between
any two panes to resize them (double-click one to put it back, or focus it and
use the arrow keys); the sizes are remembered between launches.

Above the log, a status line names the step in progress — *Selecting the project
alias*, *Searching the card transactions* — so a stall is
visible while it is happening. *Waiting for your answer* means the run has
stopped and put a question on screen; see [It asks before it gives
up](#it-asks-before-it-gives-up).

Each settlement shows a status (see above), the error if it failed, and buttons
to add receipts, open its folder, and open its `manifest.json`, the record of
exactly what was filed where. Its **Details** cover the whole settlement across
every run: each document filed, each one still waiting, every question asked,
and what Claude cost in total.

### What Claude was asked, and what it cost

Every time a run asks Claude something (reading a receipt, planning the
settlement, choosing a cost type), the log shows the prompt that was sent, the
reply that came back, the tokens used and the estimated cost. A run ends with
the total for the run, even if it failed. The **Details** tab shows the total
for the whole settlement below the table, every run included, and
`manifest.json` keeps every call in full under `claude`. Attached receipts are
named in the prompt, not copied into it.

The estimate is worked out from the token counts Claude reports and Anthropic's
list prices. Your Anthropic bill is the final word.

## Draft, or submitted

By default a run stops at a **draft**: everything is filed, and you review and
send it in indfak2 yourself.

**Submit for approval** — on the settlement list toolbar and next to *Run
settlement*, both the same choice — sends each settlement on to your approver as
soon as it is filed. The choice is remembered between launches, is fixed for the
duration of a run, and asks for confirmation before the run starts. Tick *Don't
ask again* in that dialog, or turn the question back on under **Settings →
Submitting**.

A settlement is only sent when all of it made it in: every document filed,
across every run, every supporting document attached, no line-save errors.
Anything left over and it stays a draft, says why, and leaves the unprocessed
receipts in its `input/` folder for another go. Sending is verified rather than assumed — a settlement
counts as submitted only once it has actually left the drafts list in indfak2.

## When a run fails

A failure is reported as four things rather than a stack trace: **what went
wrong**, **which step it happened in**, **the evidence**, and **what to fix**.

```
✖ Alias "your-alias-code" does not exist in indfak2, or this account cannot use it.
  While: selecting the project alias your-alias-code
  Detail: Searching for "your-alias-code" returned no accessible aliases
  → Fix the alias on the settlement, or set the right default alias in Settings.
```

- The four of them are on the settlement's **Details** tab — click the
  settlement, or let a failed batch bring it up for you.
- **Screenshot** opens a picture of the page exactly as it was when the run gave
  up — it is taken before the browser closes.
- **Technical details** reveals the underlying message, which is the thing to
  paste into a bug report.
- Common causes get their own wording and fix: no network, a wrong password, a
  rejected 2FA code, a missing alias, a rate-limited or unpaid Anthropic key, a
  missing browser, a full disk.
- **One bad document does not stop the run.** Its own error, hint and screenshot
  are recorded against it in the *Details* table, and everything else is still
  filed.

### It asks before it gives up

When something goes wrong, the run stops and asks — with Chromium still open on
the page that went wrong, showing what it says went wrong.

**A document that will not file** is offered three answers:

- **Try this document again.** The browser window comes back on screen, on the
  page that went wrong: put it right by hand — dismiss whatever indfak2 is complaining about, close a dialog that
  should not be there — and then retry. This is the one that saves a whole
  re-run.
- **Skip it and carry on.** The document stays in the settlement's `input/`
  for another day and the rest of the folder is filed.
- **Stop the run here.** Lines already filed stay in the draft; everything else
  keeps for next time. A stopped run is never submitted, whatever the *Submit
  for approval* toggle says — the settlement is incomplete by definition.

**A failure that stops the whole run** — signing in, reading a document,
planning the settlement, opening the draft — is asked about the same way. These
used to end a run on the spot, which is a poor answer to a Claude call that was
briefly rate-limited or a sign-in that needed one nudge:

- **Try again.** Runs that step over. For a sign-in that means starting from the
  login page; for a document, sending it to Claude again; for the draft, going
  back to the drafts list — a draft the run already started is re-entered, never
  duplicated.
- **A way past it, where there is one.** *I have signed in myself — carry on*
  uses the session you just signed into in the open browser window. *Leave this
  document out* files the rest of the folder and notes the one that was left in
  the manifest.
- **Stop the run.** Reports the failure exactly as it always did.

**An alias indfak2 will not take** is the one failure whose answer is neither a
retry nor a fix on the page, so it is asked differently: the question lists the
aliases from your library and files the draft under the one you pick. It counts
for that run only — the settlement's own alias and the default in Settings are
left as they were, so fix them there if the wrong one keeps coming up.

Answer with the mouse, or with the number keys — each option is numbered, and
the arrows move between them. If the window is behind something else when a
question comes up, the app bounces in the Dock until you look at it: nothing is
happening until you do.

Afterwards, the settlement's *Details* tab lists every question the run asked
and what was answered, and marks any document that took more than one try — a
settlement somebody steered by hand says so, rather than reading like one the
automation filed on its own. The same is in `manifest.json`, under
`settlement.questions`.

Nothing is lost by ignoring the window: after five minutes the question takes
the safe answer on its own — skip the document and carry on, or, for a failure
that stops the run, stop and report it, which is what it would have done anyway.
So a queue left running overnight is never held up by a prompt nobody is looking
at. Both the asking and the wait are under **Settings → When something goes wrong**
— untick it and a run never stops to ask, exactly as before.

Receipts that didn't make it stay in the settlement's `input/` folder, so a
re-run picks up where the last one stopped, in the same draft. Each receipt
moves to `processed/` the moment its line is saved, so even a run that crashed
part-way leaves the settlement knowing exactly what is in the draft.

## Removing a settlement

The **bin** at the left-hand end of a settlement row deletes the settlement's
folder: the receipts copied into it, filed or waiting, and its record.

- It asks first, naming the settlement and what goes with it. For one that has
  been filed, that includes the record of what went into its draft.
- The originals you added are never touched. The settlement folder holds copies.
- Removing is blocked while a run is in progress.
- **It removes nothing in indfak2.** A draft there, or a settlement already
  sent, stays until you delete it in indfak2 itself.

## Appearance

**Settings → Appearance** picks between **Auto**, **Light** and **Dark**. Auto is
the default and follows macOS, turning with it mid-session. The choice applies
the moment you pick it — it is not waiting on **Save settings** — and the whole
window turns, the Browser pane and the log included.

## Privacy

Rejsudai makes no network calls of its own: no telemetry, no analytics, no crash
reporting. The only outbound traffic is the work itself — the Anthropic API to
read your receipts, and indfak2.dk — plus the one-time Chromium download.

---

Building Rejsudai, running it from source, or working on the automation:
[`DEVELOPING.md`](DEVELOPING.md).
