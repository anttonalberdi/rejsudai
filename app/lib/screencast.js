'use strict';
// Live browser view for the desktop app. This is wrapper code, not automation:
// it runs *inside* the bot.js child process (required lazily, only when the app
// spawned it) and streams what Chromium is painting to the parent, which shows
// it in the Browser pane.
//
// A second CDP session on the automation's own page does the work — Chromium's
// Page.startScreencast pushes JPEG frames, so nothing is polled and the page is
// never touched. Every failure is swallowed: a broken preview must never take a
// settlement down with it.

// Frames are captured at the page's viewport size and scaled to fit these
// bounds — set to Playwright's default 1280x720 viewport so nothing is
// downscaled on the way out. The pane shows far less than that; the detail is
// there for the Expand view.
const DEFAULTS = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 };

// `send` receives { data, width, height }, where data is base64 JPEG.
// Resolves to a stop function.
async function startScreencast(page, send, options = {}) {
  const session = await page.context().newCDPSession(page);
  // Domain state is per-session, so this leaves Playwright's own session alone.
  await session.send('Page.enable');

  session.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
    try {
      send({ data, width: metadata && metadata.deviceWidth, height: metadata && metadata.deviceHeight });
    } catch {
      // Parent gone or the channel is closed — keep acking so nothing stalls.
    }
    // The ack is what asks Chromium for the next frame: skip it and the stream
    // stops after one. It also paces the stream to how fast we can forward.
    try {
      await session.send('Page.screencastFrameAck', { sessionId });
    } catch {
      // Session detached mid-frame (page closed, browser closing).
    }
  });

  await session.send('Page.startScreencast', { ...DEFAULTS, ...options });

  return async () => {
    try {
      await session.send('Page.stopScreencast');
    } catch {}
    try {
      await session.detach();
    } catch {}
  };
}

module.exports = { startScreencast };
