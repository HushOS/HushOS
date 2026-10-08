import { expect, test, type Page } from '@playwright/test';
import { grip, newPage, registerAccount, sampleFiles } from './helpers';

/*
 * Drive at phone width. The checks are the ones a person spots by eye and a
 * desktop run never does: nothing scrolls sideways, the selection toolbar
 * stays on one line, the header's search label is not clipped, and the
 * viewer still opens and closes with touch-sized controls.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });

test.beforeAll(async ({ browser }) => {
    // Registration runs OPAQUE and key setup in the browser; WebKit on a CI runner needs the room.
    test.setTimeout(300_000);
    page = await newPage(browser);
    await registerAccount(page);
    const samples = sampleFiles();
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([samples.files.markdown, samples.files.image, samples.files.binary]);
    await expect(page.locator('section[aria-label=Transfers]')).toContainText(/3 files uploaded/, {
        timeout: 90_000,
    });
});
test.afterAll(async () => {
    await page.close();
});

async function noSidewaysScroll(p: Page) {
    const overflow = await p.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0);
}

test('the folder view fits the phone: no sideways scroll, one-line toolbar, whole header label', async () => {
    await noSidewaysScroll(page);
    // The header keeps search and the account menu on one line, the search label whole.
    const search = page.getByRole('button', { name: 'Search' });
    await expect(search).toBeVisible();
    const clipped = await search.evaluate((el) => {
        const label = el.querySelector('span');
        return label ? label.scrollWidth > label.clientWidth + 1 : true;
    });
    expect(clipped, 'search label is clipped').toBe(false);
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

    await row(page, 'pixel.png').locator('button').first().click(grip);
    const toolbar = page.locator('[data-selection-bar]');
    const box = await toolbar.boundingBox();
    expect(box, 'toolbar box').not.toBeNull();
    expect(box!.height, 'toolbar wrapped to a second line').toBeLessThanOrEqual(48);
    const fits = await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits, 'toolbar overflows').toBe(true);
    await noSidewaysScroll(page);
});

test('the viewer opens full screen and closes from its own control', async () => {
    await row(page, 'notes.md').locator('button').first().dblclick(grip);
    const dialog = page.locator('[data-slot=dialog-content]');
    await expect(dialog.locator('.rt-markdown')).toBeVisible({ timeout: 60_000 });
    const size = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(Math.round(size!.width)).toBe(viewport.width);
    await dialog.getByRole('button', { name: /close preview/i }).click();
    await expect(dialog).toHaveCount(0);
    await noSidewaysScroll(page);
});

test('on a touch screen taps toggle rows into the selection, and a second tap removes one', async () => {
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-selection-bar]')).toHaveCount(0);
    await row(page, 'pixel.png').locator('button').first().click(grip);
    // With one row selected, every row's thumbnail shows the badge that adds it.
    await expect(page.getByRole('checkbox', { name: 'Select notes.md' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select notes.md' }).click();
    await expect(page.getByText(/^2 selected$/)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select notes.md' })).toBeChecked();
    await page.getByRole('checkbox', { name: 'Select pixel.png' }).click();
    await expect(page.getByText(/^1 selected$/)).toBeVisible();
    // Select all lives behind the bar's menu; the bar's own close button lets go of everything.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Select all' }).click();
    await expect(page.getByText(/^3 selected$/)).toBeVisible();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(page.locator('[data-selection-bar]')).toHaveCount(0);
    // With nothing selected the badges go, and the thumbnails stay.
    await expect(page.getByRole('checkbox', { name: 'Select notes.md' })).toBeHidden();
    await row(page, 'notes.md').locator('button').first().click(grip);
    await expect(page.getByText(/^1 selected$/)).toBeVisible();
    // The rest of the actions live behind one menu, so the bar stays one line.
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Versions' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-selection-bar]')).toHaveCount(0);
    await noSidewaysScroll(page);
});

test('the grid view lays tiles out without overflow', async () => {
    await page.getByRole('button', { name: /show as grid/i }).click();
    await expect(row(page, 'pixel.png')).toBeVisible();
    await noSidewaysScroll(page);
    await page.getByRole('button', { name: /show as list/i }).click();
});
