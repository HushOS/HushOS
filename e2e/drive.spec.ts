import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, grip, newPage, registerAccount, sampleFiles, sha256 } from './helpers';

/*
 * Drive, driven the way a person drives it: sign up, upload, preview, download,
 * organise, lock. One account and one page for the whole file, in order, because
 * each step builds on the last and a fresh account per test would spend most of
 * the run on OPAQUE registrations.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
let samples: ReturnType<typeof sampleFiles>;

const rows = (p: Page) => p.locator('[data-node-id]');
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const transfers = (p: Page) => p.locator('section[aria-label=Transfers]');

async function openPreview(p: Page, name: string) {
    await row(p, name).locator('button').first().dblclick(grip);
    await expect(dialog(p)).toContainText(name);
}
async function closePreview(p: Page) {
    await p.keyboard.press('Escape');
    await expect(dialog(p)).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
    // Registration runs OPAQUE and key setup in the browser; WebKit on a CI runner needs the room.
    test.setTimeout(300_000);
    page = await newPage(browser);
    samples = sampleFiles();
    await registerAccount(page);
});
test.afterAll(async () => {
    await page.close();
});

test('uploads encrypt on the device and land in the folder with thumbnails where they apply', async () => {
    const input = page.locator('input[type=file]').first();
    await input.setInputFiles([
        samples.files.binary,
        samples.files.markdown,
        samples.files.code,
        samples.files.image,
        samples.files.text,
    ]);
    // The folder is the witness, not the transfers panel: a dev-server reload on a
    // cold CI run empties the panel's in-memory list, the folder is the server's.
    await expect(rows(page)).toHaveCount(5, { timeout: 90_000 });
    // The image's thumbnail is rendered by the uploader and decrypted back for the row.
    await expect(row(page, 'pixel.png').locator('img')).toBeVisible({ timeout: 60_000 });
    await expect(row(page, 'payload.bin').locator('img')).toHaveCount(0);
});

test('the list sorts by a column, flips on a second click, and keeps the order after a reload', async () => {
    // Compared by id: a row's text changes as its thumbnail replaces the file-type label.
    const names = () =>
        rows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-node-id') ?? ''));
    const bySize = page.getByRole('button', { name: 'Sort by size' });
    await bySize.click();
    await expect(page.locator('th[aria-sort=descending]')).toContainText('Size');
    const largestFirst = await names();
    await bySize.click();
    await expect(page.locator('th[aria-sort=ascending]')).toContainText('Size');
    expect(await names()).toEqual([...largestFirst].reverse());
    await page.reload();
    await expect(rows(page)).toHaveCount(5, { timeout: 60_000 });
    await expect(page.locator('th[aria-sort=ascending]')).toContainText('Size');
    expect(await names()).toEqual([...largestFirst].reverse());
    // Back to the default, so the rest of the file sees the order it expects.
    await page.getByRole('button', { name: 'Sort by name' }).click();
    await expect(page.locator('th[aria-sort=ascending]')).toContainText('Name');
});

test('previews render each kind on the device: Markdown as a document, code highlighted, unknown text sniffed', async () => {
    await openPreview(page, 'notes.md');
    const rendered = dialog(page).locator('.rt-markdown');
    // The first rich-text render pulls the Markdown pipeline and Shiki's core; a
    // cold dev server on a slow runner can take a while to serve those chunks.
    await expect(rendered).toBeVisible({ timeout: 60_000 });
    await expect(rendered.locator('h1')).toHaveText('Notes');
    // Raw HTML is dropped, the link opens only on a click, the fence highlights.
    await expect(dialog(page).locator('script')).toHaveCount(0);
    await expect(rendered.locator('a[href="https://example.com"]')).toHaveAttribute(
        'target',
        '_blank',
    );
    await expect(rendered.locator('.shiki span').first()).toBeVisible();
    await dialog(page)
        .getByRole('button', { name: /show source/i })
        .click();
    await expect(dialog(page).locator('.rt-code')).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect(dialog(page)).toContainText('payload.bin');
    await expect(dialog(page)).toContainText('no preview');

    await openPreviewVia(page, 'ArrowLeft', 'notes.md');
    await openPreviewVia(page, 'ArrowLeft', 'module.ts');
    await expect(dialog(page).locator('.shiki span').first()).toBeVisible();
    await expect(dialog(page).locator('.rt-gutter li')).toHaveCount(4);

    await openPreviewVia(page, 'ArrowRight', 'notes.md');
    await closePreview(page);

    await openPreview(page, 'README');
    await expect(dialog(page).locator('.rt-code')).toContainText('plain text without an extension');
    await closePreview(page);

    await openPreview(page, 'pixel.png');
    await expect(dialog(page).locator('img')).toBeVisible();
    await closePreview(page);
});

async function openPreviewVia(p: Page, key: 'ArrowLeft' | 'ArrowRight', expectName: string) {
    await p.keyboard.press(key);
    await expect(dialog(p)).toContainText(expectName);
}

test('holding an arrow key through every file never locks the device', async () => {
    await openPreview(page, 'module.ts');
    for (let i = 0; i < 40; i++)
        await page.keyboard.press(i % 3 === 2 ? 'ArrowLeft' : 'ArrowRight');
    await page.waitForTimeout(1500);
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByText('Unlock this device')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await closePreview(page);
    // The worker still holds its keys: a preview opens normally afterwards.
    await openPreview(page, 'pixel.png');
    await expect(dialog(page).locator('img')).toBeVisible();
    await closePreview(page);
});

test('a downloaded file decrypts to the exact bytes that were uploaded', async () => {
    await row(page, 'payload.bin').locator('button').first().click(grip);
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download', exact: true }).first().click(),
    ]);
    expect(download.suggestedFilename()).toBe('payload.bin');
    const path = await download.path();
    expect(sha256(readFileSync(path!))).toBe(samples.hashes.binary);
    await expect(transfers(page)).toContainText(/Saved/);
});

test('folders nest from one dialog, rows drag into them, and a selection downloads as a zip', async () => {
    // The folder's own controls give way to the selection bar while anything is selected.
    await page.keyboard.press('Escape');
    await page
        .getByRole('button', { name: /new folder/i })
        .first()
        .click();
    await page.getByPlaceholder('Reports/2026').fill('photos/inner');
    await page.keyboard.press('Enter');
    await expect(row(page, 'photos')).toBeVisible();

    await row(page, 'pixel.png').dragTo(row(page, 'photos'));
    await expect(page.getByText(/moved to “photos”/)).toBeVisible();
    await expect(row(page, 'pixel.png')).toHaveCount(0);

    await row(page, 'photos').locator('button').first().dblclick(grip);
    const crumb = page.locator('[data-crumb-id]').first();
    await expect(crumb).toHaveText('Drive');
    await expect(row(page, 'inner')).toBeVisible();
    await expect(row(page, 'pixel.png')).toBeVisible();
    // Dropping on a breadcrumb moves back up.
    await row(page, 'pixel.png').dragTo(crumb);
    await expect(page.getByText(/moved to the top folder/)).toBeVisible();

    // A folder in the path drags too: inner, picked up from the breadcrumb and dropped on
    // Drive, moves to the top with the page still showing it. Its own parent is no target.
    await row(page, 'inner').locator('button').first().dblclick(grip);
    const open = page.locator('[data-crumb-drag]').last();
    await expect(open).toHaveText('inner');
    await open.dragTo(page.locator('[data-crumb-id]').nth(1));
    await expect(page.locator('[data-crumb-id]')).toHaveCount(2);
    await open.dragTo(crumb);
    await expect(page.getByText('“inner” moved to the top folder')).toBeVisible();
    await expect(page.locator('[data-crumb-id]')).toHaveCount(1);
    await crumb.click();
    await expect(row(page, 'inner')).toBeVisible();
    // Back where the rest of this suite expects it, by the ordinary route.
    await row(page, 'inner').dragTo(row(page, 'photos'));
    await expect(page.getByText('“inner” moved to “photos”')).toBeVisible();
    await expect(row(page, 'pixel.png')).toBeVisible();

    await page.keyboard.press('ControlOrMeta+a');
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('d')]);
    expect(download.suggestedFilename()).toBe('HushOS files.zip');
    const path = await download.path();
    const listing = execFileSync('unzip', ['-l', path!]).toString();
    for (const name of ['payload.bin', 'notes.md', 'module.ts', 'pixel.png', 'README'])
        expect(listing).toContain(name);
});

test('copy: a file copies beside itself under a “(copy)” name, a folder copies with what is inside, and Alt-drag copies', async () => {
    await row(page, 'notes.md').locator('button').first().click(grip);
    await page.keyboard.press('c');
    await expect(dialog(page)).toContainText('Copy “notes.md”');
    await page.getByRole('button', { name: 'Copy to top folder' }).click();
    await expect(row(page, 'notes (copy).md')).toBeVisible();
    await expect(row(page, 'notes.md')).toBeVisible();

    // The copy is a real file: it previews as the same document.
    await openPreview(page, 'notes (copy).md');
    await expect(dialog(page).locator('.rt-markdown')).toContainText('Notes');
    await closePreview(page);

    // A folder copy walks the tree: photos/inner comes along.
    await row(page, 'photos')
        .locator('button')
        .first()
        .click({ ...grip, button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy to…' }).click();
    await page.getByRole('button', { name: 'Copy to top folder' }).click();
    await expect(row(page, 'photos (copy)')).toBeVisible();
    await row(page, 'photos (copy)').locator('button').first().dblclick(grip);
    await expect(row(page, 'inner')).toBeVisible();
    await page.locator('[data-crumb-id]').first().click();

    // Alt while dropping copies instead of moving.
    await page.keyboard.down('Alt');
    await row(page, 'pixel.png').dragTo(row(page, 'photos'));
    await page.keyboard.up('Alt');
    await expect(page.getByText(/copied to “photos”/)).toBeVisible();
    await expect(row(page, 'pixel.png')).toBeVisible();
    await row(page, 'photos').locator('button').first().dblclick(grip);
    await expect(row(page, 'pixel.png')).toBeVisible();
    await page.locator('[data-crumb-id]').first().click();
    await expect(row(page, 'notes.md')).toBeVisible();
});

test('versions: uploading a name again keeps the earlier version, which restores and deletes', async () => {
    await page.locator('input[type=file]').first().setInputFiles([samples.files.text]);
    // The name is taken, so nothing uploads until the person chooses.
    await expect(dialog(page)).toContainText('“README” already exists');
    await dialog(page).getByRole('button', { name: 'Replace' }).click();
    await expect(
        transfers(page).getByRole('listitem').filter({ hasText: 'README' }).last(),
    ).toContainText('Done', { timeout: 60_000 });
    await expect(rows(page)).toHaveCount(8);

    await row(page, 'README')
        .locator('button')
        .first()
        .click({ ...grip, button: 'right' });
    await page.getByRole('menuitem', { name: 'Versions…' }).click();
    await expect(dialog(page)).toContainText('Versions of “README”');
    await expect(dialog(page).getByText('Current version', { exact: true })).toBeVisible();
    await expect(dialog(page).getByText('Earlier version', { exact: true })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Restore earlier version' }).click();
    await expect(page.getByText(/Earlier version of “README” restored/)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);

    await row(page, 'README')
        .locator('button')
        .first()
        .click({ ...grip, button: 'right' });
    await page.getByRole('menuitem', { name: 'Versions…' }).click();
    await expect(dialog(page).getByText('Earlier version', { exact: true })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Delete earlier version' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete version' }).click();
    await expect(page.getByText(/Earlier version of “README” deleted/)).toBeVisible();
    await expect(dialog(page).getByText('Earlier version', { exact: true })).toHaveCount(0);
    await expect(dialog(page).getByText('Current version', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
});

test('a taken name can also be kept under another name or skipped, once or for the whole drop', async () => {
    const input = page.locator('input[type=file]').first();
    // Keep both, with the suggested "(2)" name edited.
    await input.setInputFiles([samples.files.markdown]);
    await expect(dialog(page)).toContainText('“notes.md” already exists');
    const name = dialog(page).getByRole('textbox');
    await expect(name).toHaveValue('notes (2).md');
    await name.fill('notes.md');
    await expect(dialog(page).getByRole('button', { name: 'Keep both' })).toBeDisabled();
    await name.fill('notes-again.md');
    await dialog(page).getByRole('button', { name: 'Keep both' }).click();
    await expect(row(page, 'notes-again.md')).toBeVisible({ timeout: 60_000 });
    await expect(rows(page)).toHaveCount(9);

    // Skip, applied to the rest of the drop: one dialog, nothing uploads.
    await input.setInputFiles([samples.files.markdown, samples.files.text]);
    await expect(dialog(page)).toContainText('“notes.md” already exists');
    await expect(dialog(page)).toContainText('1 other file');
    await dialog(page).getByRole('checkbox').click();
    await dialog(page).getByRole('button', { name: 'Skip' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(9);
    await expect(transfers(page)).not.toContainText(/Uploading/);

    // Closing the dialog is a skip as well.
    await input.setInputFiles([samples.files.image]);
    await expect(dialog(page)).toContainText('“pixel.png” already exists');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(9);
});

test('the viewer lives in the URL: a name link opens it, arrows replace the entry, back closes it', async () => {
    await row(page, 'notes.md').getByRole('link', { name: 'notes.md' }).click();
    await expect(dialog(page)).toContainText('notes.md');
    await expect(page).toHaveURL(/preview=/);
    const first = page.url();
    await page.keyboard.press('ArrowRight');
    await expect(page).not.toHaveURL(first);
    await expect(page).toHaveURL(/preview=/);
    await page.goBack();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/preview=/);

    // A modifier click opens the same preview in a new tab.
    const [tab] = await Promise.all([
        page.context().waitForEvent('page'),
        row(page, 'notes.md')
            .getByRole('link', { name: 'notes.md' })
            .click({ modifiers: ['ControlOrMeta'] }),
    ]);
    // A fresh tab server-renders /app from cold; on a shared CI dev server that
    // takes longer than the default, the same as the dialog below.
    await expect(tab).toHaveURL(/preview=/, { timeout: 60_000 });
    await expect(tab.locator('[data-slot=dialog-content]')).toContainText('notes.md', {
        timeout: 60_000,
    });
    await tab.close();

    // Closing from the viewer's own control also steps back, so the history has no leftover entry.
    await row(page, 'notes.md').getByRole('link', { name: 'notes.md' }).click();
    await expect(page).toHaveURL(/preview=/);
    await dialog(page)
        .getByRole('button', { name: /close preview/i })
        .click();
    await expect(page).not.toHaveURL(/preview=/);
    // A folder name is a link too.
    await row(page, 'photos').getByRole('link', { name: 'photos' }).click();
    await expect(page).toHaveURL(/\/app\/drive\/f\//);
    await expect(row(page, 'inner')).toBeVisible();
    await page.locator('[data-crumb-id]').first().click();
});

test('the grid view shows thumbnails and the choice survives a reload', async () => {
    await page.getByRole('button', { name: /show as grid/i }).click();
    await expect(row(page, 'pixel.png').locator('img')).toBeVisible({ timeout: 60_000 });
    await page.reload();
    await expect(page.getByRole('button', { name: /show as list/i })).toBeVisible();
    await page.getByRole('button', { name: /show as list/i }).click();
});

test('locking drops every key and unlocking opens the same folder again', async () => {
    await page.getByRole('button', { name: /lock this device/i }).click();
    await page.getByRole('button', { name: 'Lock device' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Unlock this device' })).toBeVisible();
    // Locking must not leave the header's unlock dialog open over the page.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.locator('input[autocomplete=current-password]').fill(PASSWORD);
    await page.locator('input[autocomplete=current-password]').press('Enter');
    await expect(rows(page).first()).toBeVisible({ timeout: 60_000 });
    await openPreview(page, 'notes.md');
    await expect(dialog(page).locator('.rt-markdown')).toBeVisible();
    await closePreview(page);
});

test('trash: restore brings a file back, delete forever and empty trash remove the rest for good', async () => {
    await row(page, 'module.ts').locator('button').first().click(grip);
    await page.keyboard.press('Backspace');
    await expect(row(page, 'module.ts')).toHaveCount(0);
    await row(page, 'README').locator('button').first().click(grip);
    await page.keyboard.press('Backspace');
    await expect(row(page, 'README')).toHaveCount(0);

    await page.goto('/app/trash');
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
    await expect(page.getByText('module.ts')).toBeVisible();
    await page.getByRole('button', { name: /delete “module.ts” forever/i }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete forever' }).click();
    await expect(page.getByText(/deleted forever/)).toBeVisible();
    await expect(page.getByText('module.ts')).toHaveCount(0);
    await expect(page.getByText('README')).toBeVisible();

    await page.getByRole('button', { name: /empty trash/i }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Empty trash' }).click();
    await expect(page.getByText(/Trash emptied/)).toBeVisible();
    await expect(page.getByText('The trash is empty.')).toBeVisible();

    await page.goto('/app/drive');
    await expect(row(page, 'notes.md')).toBeVisible();
    await expect(row(page, 'module.ts')).toHaveCount(0);
    await expect(row(page, 'README')).toHaveCount(0);
});

test('the transfers panel closes from its header once everything has finished, and asks before cancelling what has not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hushos-close-'));
    const path = join(dir, 'closing.txt');
    writeFileSync(path, 'a note on the way out\n');
    await page.locator('input[type=file]').first().setInputFiles([path]);
    await expect(row(page, 'closing.txt')).toBeVisible({ timeout: 60_000 });
    await expect(transfers(page)).toContainText(/finished/, { timeout: 60_000 });
    // Finished: the cross simply closes the panel, keeping every file where it is.
    await transfers(page).getByRole('button', { name: 'Close transfers' }).click();
    await expect(transfers(page)).toHaveCount(0);
    await expect(row(page, 'closing.txt')).toBeVisible();
    // On its way: the cross asks first, and "Keep going" leaves the transfer alone.
    const big = join(dir, 'still-going.bin');
    writeFileSync(big, Buffer.alloc(24 * 1024 * 1024, 7));
    await page.locator('input[type=file]').first().setInputFiles([big]);
    await expect(transfers(page)).toBeVisible();
    await transfers(page).getByRole('button', { name: 'Pause all' }).click();
    await transfers(page).getByRole('button', { name: 'Cancel all transfers' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Cancel 1 transfer?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep going' }).click();
    await expect(transfers(page)).toContainText(/paused/i);
    await transfers(page).getByRole('button', { name: 'Cancel all transfers' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel it' }).click();
    await expect(transfers(page)).toHaveCount(0);
    await expect(row(page, 'still-going.bin')).toHaveCount(0);
});
