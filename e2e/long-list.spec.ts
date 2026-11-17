import { expect, test, type Page } from '@playwright/test';
import { grip, newFolder, newPage, openFolder, registerAccount, seedFolders } from './helpers';

/*
 * A folder long enough that the list draws only the rows near the screen (components/drive/
 * virtual-list.tsx): the keys, a Shift-click range, the row semantics and the right-click
 * menu must reach rows that are not drawn, or were never drawn together. One account and a
 * folder of 300 rows for the whole file; each test starts at the top with nothing selected.
 */

let page: Page;
const COUNT = 300;
const name = (index: number) => `row-${String(index).padStart(3, '0')}`;

const rows = (p: Page) => p.locator('[data-node-id]');
// By the name's text, not its link's role: an open menu hides the page from the role tree.
const row = (p: Page, index: number) =>
    rows(p).filter({ has: p.locator('[data-row-name]').getByText(name(index), { exact: true }) });
const nameOf = (p: Page, index: number) => row(p, index).locator('[data-row-name]');
// The selection bar, found the same way while a menu hides the page from the role tree.
const selection = (p: Page) => p.locator('[data-selection-bar]');

/* Scrolls the page's sheet so row `index` is about at the top. */
async function scrollToRow(p: Page, index: number) {
    await p.evaluate((index) => {
        const sheet = document.querySelector('[data-scroll-restoration-id="app-sheet"]')!;
        const height = document.querySelector('[data-node-id]')!.getBoundingClientRect().height;
        sheet.scrollTop = height * index;
    }, index);
}

async function reset(p: Page) {
    await p.keyboard.press('Escape');
    await scrollToRow(p, 0);
    await expect(row(p, 0)).toBeInViewport();
    await expect(p.locator('[data-node-id][aria-selected=true]')).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    page = await newPage(browser);
    await registerAccount(page);
    await newFolder(page);
    await page.getByPlaceholder('Reports/2026').fill('Long');
    await page.keyboard.press('Enter');
    await openFolder(page, 'Long');
    await seedFolders(
        page,
        Array.from({ length: COUNT }, (_, index) => name(index)),
    );
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(COUNT + 1), {
        timeout: 120_000,
    });
});
test.afterAll(async () => {
    await page.close();
});

test('only the rows near the screen are drawn, and each says where it sits in the whole list', async () => {
    await reset(page);
    expect(await rows(page).count()).toBeLessThan(60);
    await scrollToRow(page, 200);
    await expect(row(page, 200)).toBeVisible();
    // The header row is the first; row-200 is the 201st item.
    await expect(page.locator('thead tr')).toHaveAttribute('aria-rowindex', '1');
    await expect(row(page, 200)).toHaveAttribute('aria-rowindex', '202');
    await expect(row(page, 201)).toHaveAttribute('aria-rowindex', '203');
    await expect(page.locator('table')).toHaveAttribute('aria-rowcount', String(COUNT + 1));
    await expect(row(page, 0)).toHaveCount(0);
});

test('the arrows move past the drawn rows, and the row with the keys stays drawn and comes back', async () => {
    await reset(page);
    await row(page, 0).click(grip);
    await nameOf(page, 0).focus();
    for (let step = 0; step < 40; step++) await page.keyboard.press('ArrowDown');
    await expect(row(page, 40)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 40)).toBeInViewport();
    await expect(nameOf(page, 40)).toBeFocused();
    // The first row has been let go of as the list moved on.
    await expect(row(page, 0)).toHaveCount(0);

    // Scrolled far away, the row with the keys is kept: the keys stay on it.
    await scrollToRow(page, 250);
    await expect(row(page, 250)).toBeVisible();
    await expect(nameOf(page, 40)).toBeFocused();
    // And the next arrow brings the list back to the row after it.
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 41)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 41)).toBeInViewport();
    await expect(nameOf(page, 41)).toBeFocused();
});

test('a Shift-click range spans rows that were never drawn together', async () => {
    await reset(page);
    await row(page, 2).click(grip);
    await expect(selection(page)).toContainText('1 selected');
    await scrollToRow(page, 245);
    await expect(row(page, 250)).toBeVisible();
    // The rows between were never drawn with these two (row-002 stays drawn: it has the keys).
    await expect(row(page, 120)).toHaveCount(0);
    await row(page, 250).click({ ...grip, modifiers: ['Shift'] });
    await expect(selection(page)).toContainText('249 selected');
    await expect(row(page, 250)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 249)).toHaveAttribute('aria-selected', 'true');
});

test('a right-click on a row deep in the list selects it and its menu acts on it', async () => {
    await reset(page);
    await scrollToRow(page, 178);
    await expect(row(page, 180)).toBeVisible();
    await row(page, 180).click({ button: 'right', position: { x: 600, y: 28 } });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /^Open/ })).toBeVisible();
    await expect(row(page, 180)).toHaveAttribute('aria-selected', 'true');
    await expect(selection(page)).toContainText('1 selected');
    await menu.getByRole('menuitem', { name: /^Rename/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox')).toHaveValue(name(180));
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
});
