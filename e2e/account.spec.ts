import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { grip, newPage, PASSWORD, registerAccount } from './helpers';

/*
 * The account's own weight: deleting it waits for the password and the word
 * DELETE, refuses a wrong password without deleting anything, and leaves an
 * account that can no longer sign in. And an upload that doesn't fit offers
 * the ways out; freeing room from there finishes the same upload.
 */

const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');

function fileNamed(name: string, text: string) {
    const path = join(mkdtempSync(join(tmpdir(), 'hushos-account-')), name);
    writeFileSync(path, text);
    return path;
}

test('deleting the account asks for the password and DELETE, and the account is gone', async ({
    browser,
}) => {
    test.setTimeout(300_000);
    const page = await newPage(browser);
    const { email } = await registerAccount(page);
    await page.goto('/app/account', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Show' }).click();
    await page.getByRole('button', { name: 'Delete account' }).click();
    const confirm = dialog(page).getByRole('button', { name: 'Delete forever' });
    await expect(confirm).toBeDisabled();
    await dialog(page).getByLabel('Password', { exact: true }).fill('not-my-password-at-all');
    // The word has to be typed exactly.
    await dialog(page).getByLabel('Type DELETE to confirm').fill('delete');
    await expect(confirm).toBeDisabled();
    await dialog(page).getByLabel('Type DELETE to confirm').fill('DELETE');
    await expect(confirm).toBeEnabled();
    // A wrong password deletes nothing.
    await confirm.click();
    await expect(dialog(page).getByRole('alert')).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/app\/account/);

    await dialog(page).getByLabel('Password', { exact: true }).fill(PASSWORD);
    await confirm.click();
    await expect(page).toHaveURL(/\/account-deleted/, { timeout: 60_000 });
    await expect(page.getByText('Your account is deleted')).toBeVisible();

    // The same email and password no longer open anything.
    await page.goto('/login', { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: /email/i }).fill(email);
    const password = page.locator('input[autocomplete=current-password]');
    await password.fill(PASSWORD);
    await password.press('Enter');
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 60_000 });
    await expect(page).not.toHaveURL(/\/app/);
    await page.context().close();
});

test('an upload that does not fit offers the ways out, and emptying the trash finishes it', async ({
    browser,
}) => {
    test.setTimeout(300_000);
    const page = await newPage(browser);
    await registerAccount(page);
    const input = page.locator('input[type=file]').first();

    // Something in the trash, so emptying it frees room.
    await input.setInputFiles([fileNamed('old notes.txt', 'last year’s notes\n')]);
    await expect(row(page, 'old notes.txt')).toBeVisible({ timeout: 60_000 });
    await row(page, 'old notes.txt').locator('button').first().click(grip);
    await page.keyboard.press('Backspace');
    await expect(row(page, 'old notes.txt')).toHaveCount(0);

    // The server refuses the next upload for lack of room, once.
    let refused = false;
    await page.route(/\/uploads(\?.*)?$/, async (route) => {
        if (refused || route.request().method() !== 'POST') return route.continue();
        refused = true;
        await route.fulfill({
            status: 402,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 'over-quota',
                message: 'Not enough storage.',
                data: { freeBytes: '0' },
            }),
        });
    });
    await input.setInputFiles([fileNamed('big plan.txt', 'the plan that did not fit\n')]);
    await expect(dialog(page).getByRole('heading', { name: 'Not enough room' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(dialog(page)).toContainText('“big plan.txt” needs');
    // Closing it leaves the way back on the refused row.
    await dialog(page).getByRole('button', { name: 'Not now' }).click();
    const transfers = page.locator('section[aria-label=Transfers]');
    await expect(transfers).toContainText('Not enough room');
    await transfers.getByRole('button', { name: 'Make room' }).click();
    const empty = dialog(page).getByRole('button', { name: /^Empty trash/ });
    await expect(empty).toContainText('Frees');
    await empty.click();
    // The trash is gone and the refused upload goes again, this time through.
    await expect(page.getByText('Trash emptied')).toBeVisible({ timeout: 60_000 });
    await expect(row(page, 'big plan.txt')).toBeVisible({ timeout: 60_000 });
    await page.goto('/app/trash', { waitUntil: 'networkidle' });
    await expect(page.getByText('Trash is empty')).toBeVisible({ timeout: 60_000 });
    await page.context().close();
});
