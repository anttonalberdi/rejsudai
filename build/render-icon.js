'use strict';
// Renders build/icon.svg -> build/icon.png (1024x1024) using the Chromium that
// Playwright already installs for the bot. Run after editing icon.svg:
//   node build/render-icon.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>${svg}`
  );
  await page.screenshot({ path: path.join(__dirname, 'icon.png'), omitBackground: true });
  await browser.close();
  console.log('build/icon.png written');
})();
