'use strict';
// Runs as a short-lived plain-Node child so PLAYWRIGHT_BROWSERS_PATH is read
// cleanly at require time (playwright resolves it once, on load).
// Prints one JSON line: {"executable": "...", "exists": true|false}
const fs = require('fs');
try {
  const { chromium } = require('playwright');
  const executable = chromium.executablePath();
  process.stdout.write(JSON.stringify({ executable, exists: fs.existsSync(executable) }));
} catch (err) {
  process.stdout.write(JSON.stringify({ executable: null, exists: false, error: err.message }));
}
