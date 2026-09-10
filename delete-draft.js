// One-off utility: delete all expense drafts whose name contains the given text.
//   node delete-draft.js "<draft name substring>"
// The draft list is a ui-grid. Selecting rows via .file-selector switches the
// toolbar to bulk mode, which has a "Delete" button. The script verifies that
// EXACTLY the matching rows are selected before clicking Delete.
require('dotenv').config();
const { chromium } = require('playwright');
const { login, openExpenseModule } = require('./bot.js');

(async () => {
  const namePattern = process.argv[2];
  if (!namePattern) {
    console.error('Usage: node delete-draft.js "<draft name substring>"');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false, slowMo: 700 });
  const page = await browser.newPage();
  try {
    await login(page);
    const { inner } = await openExpenseModule(page);
    await new Promise(r => setTimeout(r, 4000));

    const rows = inner.locator('#inner-draft-container .ui-grid-row').filter({ hasText: namePattern });
    const total = await rows.count();
    if (total === 0) {
      console.log(`No draft matching "${namePattern}". Nothing to do.`);
      return;
    }
    console.log(`Found ${total} draft row(s) matching "${namePattern}":`);
    for (let i = 0; i < total; i++) {
      console.log(`  - ${(await rows.nth(i).textContent()).replace(/\s+/g, ' ').trim().slice(0, 90)}`);
    }

    // Select each matching row, verifying the checkmark sticks
    for (let i = 0; i < total; i++) {
      const selBox = rows.nth(i).locator('.file-selector');
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await selBox.evaluate(el => el.classList.contains('selected')).catch(() => false)) break;
        await selBox.click().catch(() => {});
        await new Promise(r => setTimeout(r, 600));
      }
    }

    const selectedCount = await inner.locator('#inner-draft-container .file-selector.selected').count();
    console.log(`Selected ${selectedCount} row(s), expected ${total}.`);
    if (selectedCount !== total) {
      console.error('Selection mismatch — ABORTING before Delete to avoid deleting wrong drafts.');
      await page.screenshot({ path: '/tmp/delete-abort.png', fullPage: true }).catch(() => {});
      return;
    }

    // Multi-select shows a "Delete" toolbar button directly; single-select
    // hides it in the kebab (⋮) menu right after the Edit button.
    let delBtn = inner.getByRole('button', { name: /delete|slet/i }).first();
    if (!(await delBtn.isVisible().catch(() => false))) {
      console.log('No direct Delete button — opening the kebab menu next to Edit...');
      const opened = await inner.locator('body').evaluate(body => {
        const btns = Array.from(body.querySelectorAll('button, [role="button"]')).filter(el => el.offsetParent !== null);
        const editBtn = btns.find(el => el.textContent.replace(/\s+/g, ' ').trim() === 'Edit');
        if (!editBtn) return 'edit button not found';
        const idx = btns.indexOf(editBtn);
        for (let i = idx + 1; i < btns.length; i++) {
          const t = btns[i].textContent.replace(/\s+/g, ' ').trim();
          if (!t) { btns[i].click(); return 'clicked'; }
          if (t.startsWith('Send')) break;
        }
        return 'kebab not found';
      }).catch(e => `evaluate failed: ${e.message}`);
      console.log(`Kebab: ${opened}`);
      await new Promise(r => setTimeout(r, 1200));
      const items = (await inner.locator('[role="menuitem"]:visible, .dropdown-menu li:visible, md-menu-content :is(button,a):visible').allTextContents().catch(() => []))
        .map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
      console.log('Menu items:', JSON.stringify(items));
      delBtn = inner.locator('[role="menuitem"], .dropdown-menu li a, .dropdown-menu li, md-menu-content button, md-menu-content a')
        .filter({ hasText: /delete|slet/i }).first();
    }
    if (!(await delBtn.isVisible().catch(() => false))) {
      console.error('Delete action not found — aborting.');
      await page.screenshot({ path: '/tmp/delete-nobutton.png', fullPage: true }).catch(() => {});
      return;
    }
    console.log('Clicking Delete...');
    await delBtn.click();
    await new Promise(r => setTimeout(r, 1500));

    // Confirmation modal — try the inner frame first, then the page itself
    for (const scope of [inner, page]) {
      const confirm = scope.getByRole('button', { name: /^(yes|ok|ja|confirm|delete|slet)\s*$/i }).first();
      if (await confirm.isVisible().catch(() => false)) {
        console.log(`Confirming ("${(await confirm.textContent()).trim()}")...`);
        await confirm.click();
        break;
      }
    }
    await new Promise(r => setTimeout(r, 3000));

    const remaining = await inner.locator('#inner-draft-container .ui-grid-row').filter({ hasText: namePattern }).count().catch(() => -1);
    console.log(`Remaining matching drafts: ${remaining}`);
    await page.screenshot({ path: '/tmp/delete-after.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
