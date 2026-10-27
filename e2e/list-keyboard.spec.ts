import { expect, test, type Locator, type Page } from '@playwright/test';
import { grip, newPage, registerAccount } from './helpers';

/*
 * The file list from the keyboard: the arrows move on from the row the keys are on, one
 * row at a time wears the focus outline and only while the keys are in the list, and
 * Enter on a selected row opens it when it is the whole selection and leaves a larger
 * selection be. Last, the palette's field keeps a focus mark under forced colours. One
 * account and four files for the whole file; each test starts afresh, so a failure
 * leaves the others to run.
 *
 * A desktop browser that focuses a row's button on a click (Chromium) is where these
 * broke: that button kept the keys while the arrows moved the selection. The steps are
 * written to come out the same where a click focuses nothing.
 */

let page: Page;
const NAMES = ['row-1.txt', 'row-2.txt', 'row-3.txt', 'row-4.txt'];

const rows = (p: Page) => p.locator('[data-node-id]');
const nameOf = (row: Locator) => row.locator('[data-row-name]');
/* How many items draw a solid outline: the focus mark, whichever way it was drawn. */
const outlined = (p: Page) =>
    p.evaluate(
        () =>
            [...document.querySelectorAll('[data-node-id]')].filter(
                (item) => getComputedStyle(item).outlineStyle === 'solid',
            ).length,
    );
const selectedRows = (p: Page) => p.locator('[data-node-id][aria-selected=true]');

/* A fresh start: nothing selected, the keys on the page, the four rows in name order. */
async function reset(p: Page) {
    await p.goto('/app/drive', { waitUntil: 'networkidle' });
    await expect(rows(p)).toHaveCount(NAMES.length, { timeout: 60_000 });
    for (const [i, file] of NAMES.entries()) await expect(rows(p).nth(i)).toContainText(file);
}
/* Tab until the keys reach `target`, as a person would; a handful of stops at most. */
async function tabTo(p: Page, target: Locator) {
    for (let i = 0; i < 8; i++) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await p.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
}
test.beforeAll(async ({ browser }) => {
    // Registration runs OPAQUE and key setup in the browser; WebKit on a CI runner needs the room.
    test.setTimeout(300_000);
    page = await newPage(browser);
    await registerAccount(page);
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles(
            NAMES.map((file) => ({
                name: file,
                mimeType: 'text/plain',
                buffer: Buffer.from(`${file}\n`),
            })),
        );
    await expect(rows(page)).toHaveCount(NAMES.length, { timeout: 90_000 });
});
test.afterAll(async () => {
    await page.close();
});

test('the arrows move on from the row whose name has the keys', async () => {
    await reset(page);
    await nameOf(rows(page).nth(2)).focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(3)).toHaveAttribute('aria-selected', 'true');
    await expect(nameOf(rows(page).nth(3))).toBeFocused();
    await expect(selectedRows(page)).toHaveCount(1);
});

test('one row wears the focus outline when Tab takes the keys on from the arrows', async () => {
    await reset(page);
    await nameOf(rows(page).nth(0)).focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await tabTo(page, nameOf(rows(page).nth(2)));
    await expect.poll(() => outlined(page)).toBe(1);
    await expect(rows(page).nth(2)).toHaveCSS('outline-style', 'solid');
});

test('the outline leaves the row when the keys leave the list', async () => {
    await reset(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(1)).toHaveCSS('outline-style', 'solid');
    // The selection stays; the mark that says the keys are here goes with them.
    await page.getByRole('button', { name: 'Add', exact: true }).focus();
    await expect.poll(() => outlined(page)).toBe(0);
    await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('Enter opens the one selected row the arrows moved to', async () => {
    await reset(page);
    await rows(page).nth(0).click(grip);
    await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/preview=/);
    await expect(page.locator('[data-slot=dialog-content]')).toContainText(NAMES[1]!);
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/preview=/);
});

test('Enter keeps a selection the arrows stretched', async () => {
    await reset(page);
    await rows(page).nth(0).click(grip);
    await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(selectedRows(page)).toHaveCount(2);
    await page.keyboard.press('Enter');
    // Nothing is meant to change, so give a wrong click its moment to land first.
    await page.waitForTimeout(500);
    await expect(selectedRows(page)).toHaveCount(2);
    await expect(page).not.toHaveURL(/preview=/);
});

test('in the grid the arrows move focus and selection together', async () => {
    await reset(page);
    await page.getByRole('button', { name: /show as grid/i }).click();
    try {
        await nameOf(rows(page).nth(0)).focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await expect(rows(page).nth(2)).toHaveAttribute('data-selected', 'true');
        await expect(nameOf(rows(page).nth(2))).toBeFocused();
        await expect.poll(() => outlined(page)).toBe(1);
        await expect(rows(page).nth(2)).toHaveCSS('outline-style', 'solid');
    } finally {
        await page.getByRole('button', { name: /show as list/i }).click();
    }
});

test('in forced colours the palette field shows it has the keys', async () => {
    await reset(page);
    await page.emulateMedia({ forcedColors: 'active' });
    try {
        await page.keyboard.press('/');
        const field = page.locator('[data-slot=command-input]');
        await expect(field).toBeFocused();
        // Forced colours drop the field's ring and tint; only an outline survives.
        await expect(field).toHaveCSS('outline-style', 'solid');
        await page.keyboard.press('Escape');
    } finally {
        await page.emulateMedia({ forcedColors: 'none' });
    }
});
