// One-off: open a draft and dump its line items + totals.
require('dotenv').config();
const { chromium } = require('playwright');
const { login, openExpenseModule } = require('./bot.js');

(async () => {
  const name = process.argv[2] || '* Hologen Training Week';
  const browser = await chromium.launch({ headless: false, slowMo: 400 });
  const page = await browser.newPage();
  try {
    await login(page);
    const { inner } = await openExpenseModule(page);
    await new Promise(r => setTimeout(r, 4000));
    const h4 = inner.locator('#inner-draft-container .ui-grid-row h4').filter({ hasText: name }).first();
    await h4.click();
    await new Promise(r => setTimeout(r, 4000));
    const rows = (await inner.locator('.ui-grid-row').allTextContents().catch(() => []))
      .map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    console.log('LINES:');
    for (const r of [...new Set(rows)]) console.log('  -', r.slice(0, 160));
    await page.screenshot({ path: '/tmp/draft-state.png', fullPage: true });
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
