import { expect, test, type Page } from '@playwright/test';
import {
    close,
    dialog,
    downloaded,
    earlierVersions,
    editingAccount,
    editor,
    openEditor,
    retype,
    row,
    slowListings,
    utf16le,
} from './editing';
import { hydrated } from './helpers';

/*
 * Editing on the web, the file side: a text file opens in the editor, a save is a new version
 * holding exactly the edit in the file's own encoding, byte order mark and line breaks, a file the
 * editor can't keep byte for byte opens read-only, broken JSON still saves with a warning, and
 * leaving with changes asks first. The other editing specs: editing-preview (Markdown, diagrams,
 * what the editor loads), editing-conflicts (someone else saved first, the lock) and
 * editing-access (who may edit, signing out).
 */

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    ({ page } = await editingAccount(browser, [
        'notes.txt',
        'windows.txt',
        'utf16.txt',
        'mixed.txt',
        'classic.txt',
        'latin.txt',
        'config.json',
        'README',
    ]));
});
test.afterAll(async () => {
    await page.context().close();
});

test('a save is a new version that changes only the edited bytes', async () => {
    await openEditor(page, 'notes.txt');
    await expect(editor(page)).toContainText('Grüße');
    const save = dialog(page).getByRole('button', { name: 'Save', exact: true });
    // Nothing to save until something changed.
    await expect(save).toBeDisabled();
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    await page.keyboard.insertText(' ✓');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(save).toBeDisabled();
    await close(page);
    // Byte for byte: the edit, and no final newline added where there was none.
    expect([...(await downloaded(page, 'notes.txt'))]).toEqual([
        ...Buffer.from('Grüße ✓\nline two\nno final newline'),
    ]);
});

test('Ctrl or Cmd+S with nothing changed saves nothing', async () => {
    const before = await earlierVersions(page, 'config.json');
    await openEditor(page, 'config.json');
    await editor(page).click();
    // Twice: the second press is the editor's too, never the browser's Save Page.
    await page.keyboard.press('ControlOrMeta+s');
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForTimeout(1_500);
    await expect(dialog(page).getByText('Saved', { exact: true })).toHaveCount(0);
    // Still the editor: the browser's Save Page never opened over it.
    await expect(editor(page)).toBeVisible();
    await close(page);
    expect(await earlierVersions(page, 'config.json')).toBe(before);
});

test('Back that drops the viewer’s address closes an editor with nothing unsaved', async () => {
    await openEditor(page, 'notes.txt');
    await page.goBack();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/preview=/);
    // Just saved, the same: it closes, and stays on the folder.
    await openEditor(page, 'notes.txt');
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('!');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('ControlOrMeta+s');
    await expect(editor(page)).toBeVisible();
    await page.goBack();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
    await expect(page).toHaveURL(/\/app\/drive/);
    await expect(page).not.toHaveURL(/preview=/);
    expect((await downloaded(page, 'notes.txt')).toString()).toBe(
        'Grüße ✓\nline two\nno final newline!',
    );
});

test('a file the viewer found to be text by reading it offers Edit', async () => {
    await row(page, 'README').getByRole('link', { name: 'README', exact: true }).click();
    await expect(dialog(page)).toContainText('Read me first', { timeout: 60_000 });
    await dialog(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page)).toContainText('Read me first', { timeout: 60_000 });
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
    await close(page);
});

test('with no answer for its folder, the editor never opens the row the viewer held', async () => {
    await row(page, 'notes.txt').getByRole('link', { name: 'notes.txt', exact: true }).click();
    await page.route('**/nodes/*/children*', (route) => route.abort());
    await dialog(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(dialog(page).getByText('This file couldn’t be opened for editing.')).toBeVisible({
        timeout: 60_000,
    });
    await expect(editor(page)).toHaveCount(0);
    await page.unroute('**/nodes/*/children*');
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(editor(page)).toBeVisible({ timeout: 60_000 });
    await close(page);
});

test('files the editor can’t keep exactly open read-only with a note', async () => {
    for (const [name, note] of [
        ['classic.txt', 'This file uses line endings HushOS can’t edit without changing them.'],
        ['latin.txt', 'This file uses an encoding HushOS can’t edit without changing it.'],
    ] as const) {
        await openEditor(page, name);
        await expect(dialog(page).getByText(note)).toBeVisible();
        await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toHaveCount(
            0,
        );
        await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
        await close(page);
    }
});

test('a UTF-16 file is saved in UTF-16 with its byte order mark, and a line typed is CRLF like the rest', async () => {
    await openEditor(page, 'utf16.txt');
    await expect(editor(page)).toContainText('Grüße');
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('drei');
    await page.keyboard.press('Enter');
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await close(page);
    expect([...(await downloaded(page, 'utf16.txt'))]).toEqual([
        ...utf16le('Grüße\r\nzwei\r\ndrei\r\n'),
    ]);
});

test('a CRLF file keeps CRLF, and its missing final newline stays missing', async () => {
    await openEditor(page, 'windows.txt');
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('third');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await close(page);
    expect((await downloaded(page, 'windows.txt')).toString('latin1')).toBe(
        'first\r\nsecond\r\nthird',
    );
});

test('a mixed file says which line break a save writes, and an edit writes them all that way', async () => {
    const before = await earlierVersions(page, 'mixed.txt');
    await openEditor(page, 'mixed.txt');
    const note = dialog(page).getByText(
        'This file mixes line endings; saving uses Windows (CRLF).',
    );
    await expect(note).toBeVisible();
    // Unchanged, there is nothing to save, so its bytes stay exactly as they were.
    await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForTimeout(1_000);
    await expect(dialog(page).getByText('Saved', { exact: true })).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('d');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    // One line break from here on: nothing mixed is left to say.
    await expect(note).toHaveCount(0);
    await close(page);
    expect((await downloaded(page, 'mixed.txt')).toString('latin1')).toBe('a\r\nb\r\nc\r\nd');
    // One new version: the edit's (the Ctrl+S with nothing changed made none). Asked again until the
    // dialog lists it, never from a list cached before the save.
    await expect
        .poll(() => earlierVersions(page, 'mixed.txt'), { timeout: 30_000 })
        .toBe(before + 1);
});

test('broken JSON gets a warning beside Save, and still saves', async () => {
    await openEditor(page, 'config.json');
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('}');
    await expect(
        dialog(page).getByRole('status').filter({ hasText: 'This JSON doesn’t parse at line 4.' }),
    ).toBeVisible();
    // On a phone's width the warning moves under the header and is still read out.
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(
        dialog(page).getByRole('status').filter({ hasText: 'This JSON doesn’t parse at line 4.' }),
    ).toBeVisible();
    await page.setViewportSize(size);
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await close(page);
    expect((await downloaded(page, 'config.json')).toString()).toBe('{\n  "a": 1\n}\n}');
});

test('closing while a save is on its way never offers Discard: it waits, then closes', async () => {
    await openEditor(page, 'config.json');
    await retype(page, '{"finished": true}');
    const restore = await slowListings(page, 4_000);
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    // The save may still publish, so nothing offers to discard it: the editor says it is finishing.
    await expect(dialog(page)).toContainText('Finishing your save, then closing');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0, { timeout: 60_000 });
    await restore();
    expect((await downloaded(page, 'config.json')).toString()).toBe('{"finished": true}');
});

test('Escape closes the editor, unless its search panel is open, which it closes first', async () => {
    await openEditor(page, 'notes.txt');
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+f');
    const search = dialog(page).locator('.cm-search');
    await expect(search).toBeVisible();
    await page.keyboard.press('Escape');
    // The panel went; the editor stays.
    await expect(search).toHaveCount(0);
    await expect(editor(page)).toBeVisible();
    // Nothing to close inside it now: Escape is Close.
    await editor(page).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
});

test('leaving with changes asks first', async () => {
    await openEditor(page, 'notes.txt');
    await retype(page, 'not kept');
    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Discard your changes?');
    await ask.getByRole('button', { name: 'Keep editing' }).click();
    await expect(editor(page)).toContainText('not kept');
    // The browser's Back is asked about too.
    await page.goBack();
    await expect(ask).toContainText('Discard your changes?');
    await ask.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
    expect((await downloaded(page, 'notes.txt')).toString()).toBe(
        'Grüße ✓\nline two\nno final newline!',
    );
});

test('Ctrl or Cmd+S while Discard is being asked saves nothing', async () => {
    const before = (await downloaded(page, 'notes.txt')).toString();
    await openEditor(page, 'notes.txt');
    await retype(page, 'thrown away');
    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Discard your changes?');
    await page.keyboard.press('ControlOrMeta+s');
    await ask.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
    // Long enough for a save started by the keypress to have landed.
    await page.waitForTimeout(4_000);
    expect((await downloaded(page, 'notes.txt')).toString()).toBe(before);
});

test('leaving for a page outside the app asks first too', async () => {
    await page.goto('/security');
    // Into the app inside this page (once it has hydrated), so Back is the app's own move.
    const into = page.getByRole('link', { name: 'Go to Drive' }).first();
    await hydrated(into);
    await into.click();
    await expect(row(page, 'notes.txt')).toBeVisible({ timeout: 60_000 });
    await openEditor(page, 'notes.txt');
    await retype(page, 'not kept either');
    // The editor has taken the change (Save is on) before anything leaves.
    await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    // Back past the folder to the public page, in one step.
    await page.evaluate(() => window.history.go(-2));
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Discard your changes?');
    await ask.getByRole('button', { name: 'Keep editing' }).click();
    await expect(editor(page)).toContainText('not kept either');
    await expect(page).toHaveURL(/\/app\/drive/);
    await page.evaluate(() => window.history.go(-2));
    await ask.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page).toHaveURL(/\/security/);
    await page.goto('/app/drive');
    await expect(row(page, 'notes.txt')).toBeVisible({ timeout: 60_000 });
});
