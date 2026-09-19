import { expect, test, type Page } from '@playwright/test';
import { grip, newContext, registerAccount, sampleFiles } from './helpers';

/*
 * Mod+K anywhere under /app: the same palette goes places, empties the trash
 * behind a confirmation, lends the folder view's actions while a folder is on
 * screen, and locks the device. The sidebar entry opens it for a mouse or a
 * thumb.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const palette = (p: Page) => p.getByPlaceholder(/Search files and folders/);

test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    page = await (await newContext(browser)).newPage();
    await registerAccount(page);
    const samples = sampleFiles();
    await page.locator('input[type=file]').first().setInputFiles([samples.files.markdown]);
    await expect(row(page, 'notes.md')).toBeVisible({ timeout: 60_000 });
});
test.afterAll(async () => {
    await page.context().close();
});

test('goes places from any page, and the folder view lends its actions', async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette(page)).toBeVisible();
    // In a folder: its actions are offered, with the selection spelled out.
    await expect(page.getByRole('option', { name: /New folder/ })).toBeVisible();
    await palette(page).fill('shared by');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/app\/shared\?view=by-me/);
    // Off the folder view, its actions are gone and places remain.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('option', { name: /New folder/ })).toHaveCount(0);
    await palette(page).fill('contacts');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/app\/contacts/);
});

test('empties the trash from anywhere, after asking', async () => {
    await page.goto('/app/drive', { waitUntil: 'networkidle' });
    await row(page, 'notes.md').locator('button').first().click(grip);
    await page.keyboard.press('Backspace');
    await expect(row(page, 'notes.md')).toHaveCount(0);
    // A full navigation: the entry is a real button only once the page has hydrated.
    await page.goto('/app/contacts', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Search' }).click();
    await palette(page).fill('empty trash');
    await page.keyboard.press('Enter');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Empty trash' }).click();
    await expect(page.getByText('Trash emptied: 1 item')).toBeVisible({ timeout: 60_000 });
    await page.goto('/app/trash');
    await expect(page.getByText('The trash is empty.')).toBeVisible();
});

test('locks this device, after asking', async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await palette(page).fill('lock');
    await page.keyboard.press('Enter');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Lock device' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Unlock this device' })).toBeVisible();
});
