// Playwright codegen recording of a manual indfak2 session, kept as a reference
// for the selectors it captured. Not used by the app or by bot.js.
// The credentials this was recorded with have been replaced with env lookups —
// never commit real ones here.
import { test, expect } from '@playwright/test';

const expenseAlias = process.env.EXPENSE_ALIAS;
const corporateCardHolder = process.env.CORPORATE_CARD_HOLDER;
const transactionLabel = process.env.CARD_TRANSACTION_LABEL;

if (!expenseAlias || !corporateCardHolder || !transactionLabel) {
  throw new Error('Set EXPENSE_ALIAS, CORPORATE_CARD_HOLDER, and CARD_TRANSACTION_LABEL to run this recorded reference.');
}

test('test', async ({ page }) => {
  await page.goto('https://indfak2.dk/login/#/');
  await page.locator('#select_value_label_0').click();
  await page.getByText('English').click();
  await page.getByRole('textbox', { name: 'User name' }).click();
  await page.getByRole('textbox', { name: 'User name' }).click();
  await page.getByRole('textbox', { name: 'User name' }).click({
    button: 'right'
  });
  await page.getByRole('textbox', { name: 'User name' }).fill(process.env.INDFAK_USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).click({
    button: 'right'
  });
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.INDFAK_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('textbox', { name: 'Code *' }).click();
  await page.getByRole('textbox', { name: 'Code *' }).click();
  await page.getByRole('textbox', { name: 'Code *' }).fill(process.env.TOTP_CODE);
  await page.getByRole('button', { name: 'Ok' }).click();
  await page.getByRole('button', { name: 'Expense' }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('#ecm_link').click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().locator('#inner-draft-container a').click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Name *' }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Name *' }).fill('AI fees');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Name *' }).press('ArrowLeft');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Name *' }).press('ArrowLeft');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Name *' }).press('ArrowLeft');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Name *' }).press('ArrowLeft');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Name *' }).fill('AI service fees');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByLabel('Type').selectOption('object:433');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Alias *' }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Alias *' }).click({
    button: 'right'
  });
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Alias *' }).fill(expenseAlias);
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('link', { name: new RegExp(`^${expenseAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByLabel('Purpose').selectOption('object:437');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().locator('a').nth(4).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().locator('li:nth-child(2) > .mfb-component__button--child').first().click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().locator('.ng-scope.ng-isolate-scope.stretch').click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().locator('[id="1781065767066-2-uiGrid-006P-cell"] > .grid-group-item > .file-selector').click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('gridcell', { name: transactionLabel }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().locator('[id="1781065767066-2-uiGrid-006Q-cell"]').getByText(corporateCardHolder).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('button', { name: ' Allocate' }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('button', { name: 'Upload attachment' }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().locator('#attachmentButton').click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().locator('#attachmentButton').setInputFiles('Invoice-C8C5A404-0026.pdf');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Description *' }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('textbox', { name: 'Description *' }).fill('Invoice');
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('iframe').contentFrame().getByRole('button', { name: ' Save' }).click();
  await page.locator('iframe[title="ibistic"]').contentFrame().getByRole('listitem', { name: 'Main menu (F7)' }).locator('a').click();
  await page.locator('iframe[title="ibistic"]').contentFrame().getByText('Main menu Travel and expense').click();
  await page.locator('iframe[title="ibistic"]').contentFrame().locator('#ecm_link').click();
});
