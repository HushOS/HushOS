import { expect, test, type Page } from '@playwright/test';
import { newContext, registerAccount, sampleFiles } from './helpers';

/*
 * Office documents preview on the device: a Word file as a document with its
 * markup neutralised, a workbook as tables with sheet tabs, a deck as an
 * outline in slide order. Nothing is rendered as HTML.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
let samples: ReturnType<typeof sampleFiles>;
const row = (name: string) =>
    page.locator('[data-node-id]').filter({ has: page.getByText(name, { exact: true }) });
const dialog = () => page.locator('[data-slot=dialog-content]');

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    samples = sampleFiles();
    page = await (await newContext(browser)).newPage();
    await registerAccount(page);
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([
            samples.files.docx,
            samples.files.xlsx,
            samples.files.pptx,
            samples.files.csv,
        ]);
    await expect(row('memo.docx')).toBeVisible({ timeout: 90_000 });
    await expect(row('figures.xlsx')).toBeVisible();
    await expect(row('cities.csv')).toBeVisible();
    await expect(row('deck.pptx')).toBeVisible();
});
test.afterAll(async () => {
    await page.context().close();
});

test('a Word document renders as a document, with markup shown as text', async () => {
    await row('memo.docx').getByRole('link', { name: 'memo.docx' }).click();
    const doc = dialog().locator('[data-office=docx]');
    await expect(doc.getByRole('heading', { name: 'Quarterly memo' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(doc).toContainText('Revenue grew in every region.');
    // The script tag typed into the document is text, not an element.
    await expect(doc).toContainText('<script>alert(1)</script>');
    expect(await doc.locator('script').count()).toBe(0);
    await page.keyboard.press('Escape');
});

test('a workbook renders as tables with sheet tabs', async () => {
    await row('figures.xlsx').getByRole('link', { name: 'figures.xlsx' }).click();
    const sheet = dialog().locator('[data-office=sheet]');
    await expect(sheet.getByRole('cell', { name: 'South' })).toBeVisible({ timeout: 60_000 });
    await expect(sheet.getByRole('cell', { name: '3400' })).toBeVisible();
    await sheet.getByRole('tab', { name: 'Notes' }).click();
    await expect(sheet.getByRole('cell', { name: 'Second sheet' })).toBeVisible();
    await expect(sheet.getByRole('cell', { name: 'South' })).toHaveCount(0);
    await page.keyboard.press('Escape');
});

test('a CSV renders as a table, quoted fields whole and accents intact', async () => {
    await row('cities.csv').getByRole('link', { name: 'cities.csv' }).click();
    const sheet = dialog().locator('[data-office=sheet]');
    await expect(sheet.getByRole('cell', { name: 'Porto, Old Town' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(sheet.getByRole('cell', { name: 'S\u00e3o Paulo' })).toBeVisible();
    await expect(sheet.getByRole('cell', { name: '12325232' })).toBeVisible();
    await expect(sheet.getByRole('tab')).toHaveCount(0);
    // The text itself is one click away, and the table one click back.
    await sheet.getByRole('button', { name: 'Show source' }).click();
    await expect(sheet).toContainText('city,country,population');
    await expect(sheet).toContainText('"Porto, Old Town",Portugal,231800');
    await expect(sheet.getByRole('cell')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Show table' }).click();
    await expect(sheet.getByRole('cell', { name: 'Porto, Old Town' })).toBeVisible();
    await page.keyboard.press('Escape');
});

test('a deck renders as an outline in slide order', async () => {
    await row('deck.pptx').getByRole('link', { name: 'deck.pptx' }).click();
    const slides = dialog().locator('[data-office=slides]');
    await expect(slides.locator('[data-slide]')).toHaveCount(2, { timeout: 60_000 });
    await expect(slides.locator('[data-slide="1"]')).toContainText('Welcome');
    await expect(slides.locator('[data-slide="1"]')).toContainText('The first slide');
    await expect(
        slides.locator('[data-slide="2"]').getByRole('heading', { name: 'Plan' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
});
