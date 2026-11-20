import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
    close,
    dialog,
    downloaded,
    editingAccount,
    editor,
    openEditor,
    retype,
    row,
    slowListings,
} from './editing';
import { grip, PASSWORD } from './helpers';

/*
 * Editing on the web, when the file moves on under the editor: a save after someone else's offers
 * Save on top, Save as a copy and Open theirs, and each does what it says; a lock drops the
 * editor's text, and its draft offers it back after the unlock. The other editing specs:
 * editing-files (open, save, encodings, leaving), editing-preview (Markdown, diagrams, what the
 * editor loads) and editing-access (who may edit, signing out).
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
let other: Page;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    ({ page } = await editingAccount(browser, ['notes.txt']));
});
test.afterAll(async () => {
    await page.context().close();
});

test.describe('when someone else saved first', () => {
    test.beforeAll(async () => {
        // A second tab of the same person: "someone else" is any other save of the file.
        other = await page.context().newPage();
        await other.goto('/app/drive');
        await expect(row(other, 'notes.txt')).toBeVisible({ timeout: 60_000 });
    });

    /*
     * Mine open with an edit, theirs saved meanwhile from the other tab; then mine saves. Both are
     * opened before either types: an editor opened on a file another tab has unsaved text in is
     * offered that tab's draft once it is kept (two seconds after typing; WebKit's run got there).
     */
    async function race(mine: string, theirs: string) {
        await openEditor(page, 'notes.txt');
        await openEditor(other, 'notes.txt');
        await retype(page, mine);
        await retype(other, theirs);
        await other.keyboard.press('ControlOrMeta+s');
        await expect(dialog(other).getByText('Saved', { exact: true })).toBeVisible({
            timeout: 60_000,
        });
        await close(other);
        await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
        const choices = page.getByRole('alertdialog');
        await expect(choices).toContainText('This file changed', { timeout: 60_000 });
        for (const choice of ['Save on top', 'Save as a copy', 'Open theirs'])
            await expect(choices.getByRole('button', { name: choice })).toBeVisible();
        return choices;
    }

    test('Save on top makes a new version after theirs, and both stay in history', async () => {
        const choices = await race('mine on top', 'theirs first');
        await choices.getByRole('button', { name: 'Save on top' }).click();
        await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({
            timeout: 60_000,
        });
        await close(page);
        expect((await downloaded(page, 'notes.txt')).toString()).toBe('mine on top');
        await row(page, 'notes.txt')
            .locator('button')
            .first()
            .click({ ...grip, button: 'right' });
        await page.getByRole('menuitem', { name: 'Versions' }).click();
        const [earlier] = await Promise.all([
            page.waitForEvent('download'),
            dialog(page).getByRole('button', { name: 'Download earlier version' }).first().click(),
        ]);
        expect(readFileSync((await earlier.path())!, 'utf8')).toBe('theirs first');
        await page.keyboard.press('Escape');
    });

    test('Save as a copy makes a file beside it under the next free name', async () => {
        const choices = await race('mine as a copy', 'theirs again');
        await choices.getByRole('button', { name: 'Save as a copy' }).click();
        await expect(dialog(page).getByText('Saved as “notes (2).txt”')).toBeVisible({
            timeout: 60_000,
        });
        await close(page);
        expect((await downloaded(page, 'notes (2).txt')).toString()).toBe('mine as a copy');
        expect((await downloaded(page, 'notes.txt')).toString()).toBe('theirs again');
    });

    test('closing while a copy is on its way never offers Discard: it waits, then closes', async () => {
        const choices = await race('mine, copied as it closed', 'theirs once more');
        // Every listing the copy asks for (its folder, the next free name, the copy's row) held back.
        const restore = await slowListings(page, 3_000);
        await choices.getByRole('button', { name: 'Save as a copy' }).click();
        await dialog(page).getByRole('button', { name: 'Close preview' }).click();
        await expect(dialog(page)).toContainText('Finishing your save, then closing');
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0, {
            timeout: 60_000,
        });
        await restore();
        expect((await downloaded(page, 'notes (3).txt')).toString()).toBe(
            'mine, copied as it closed',
        );
        expect((await downloaded(page, 'notes.txt')).toString()).toBe('theirs once more');
    });

    test('Open theirs discards mine only after a confirmation', async () => {
        const choices = await race('mine, discarded', 'theirs to open');
        await choices.getByRole('button', { name: 'Open theirs' }).click();
        const confirm = page.getByRole('alertdialog');
        await expect(confirm).toContainText('Discard your changes?');
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        // Cancelled: back to the three choices, nothing discarded.
        await expect(choices.getByRole('button', { name: 'Save on top' })).toBeVisible();
        await choices.getByRole('button', { name: 'Open theirs' }).click();
        const restore = await slowListings(page, 3_000);
        await confirm.getByRole('button', { name: 'Discard changes' }).click();
        // While their version is looked up: nothing can be typed or saved into the text on its way out.
        await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
        await expect(
            dialog(page).getByRole('button', { name: 'Save', exact: true }),
        ).toBeDisabled();
        await expect(editor(page)).toContainText('theirs to open', { timeout: 60_000 });
        await restore();
        await expect(editor(page)).not.toContainText('mine, discarded');
        await close(page);
        expect((await downloaded(page, 'notes.txt')).toString()).toBe('theirs to open');
        await other.close();
    });
});

test('locking drops the editor’s text, and its draft offers it back after the unlock', async () => {
    await openEditor(page, 'notes.txt');
    await retype(page, 'typed before the lock');
    // Its draft is kept before the lock comes (e2e/drafts.spec.ts covers drafts themselves).
    await expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const names = (await indexedDB.databases()).map(({ name }) => name);
                    if (!names.includes('hushos-drafts')) return 0;
                    return new Promise<number>((resolve, reject) => {
                        const request = indexedDB.open('hushos-drafts');
                        request.onsuccess = () => {
                            const db = request.result;
                            const count = db.transaction('drafts').objectStore('drafts').count();
                            count.onsuccess = () => {
                                db.close();
                                resolve(count.result);
                            };
                        };
                        request.onerror = () => reject(request.error);
                    });
                }),
            { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(1);
    // Locked from another tab while this one holds unsaved changes.
    const locker = await page.context().newPage();
    await locker.goto('/app/drive');
    await expect(row(locker, 'notes.txt')).toBeVisible({ timeout: 60_000 });
    await locker.getByRole('button', { name: 'Account menu' }).click();
    await locker.getByRole('menuitem', { name: 'Lock on this browser' }).click();
    await locker
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Lock', exact: true })
        .click();
    await expect(
        locker.getByRole('heading', { level: 1, name: 'HushOS is locked here' }),
    ).toBeVisible();
    await locker.close();
    await page.bringToFront();
    await expect(
        page.getByRole('heading', { level: 1, name: 'HushOS is locked here' }),
    ).toBeVisible({
        timeout: 90_000,
    });
    // The lock isn't held up by the unsaved changes, and nothing of them is left on the page.
    await expect(page.getByText('typed before the lock')).toHaveCount(0);
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await page.locator('input[autocomplete=current-password]').fill(PASSWORD);
    await page.locator('input[autocomplete=current-password]').press('Enter');
    // The viewer comes back over the folder (the address still names the file), not the editor.
    await expect(dialog(page).getByRole('heading', { name: 'notes.txt' })).toBeVisible({
        timeout: 60_000,
    });
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page)).toContainText('theirs to open', { timeout: 60_000 });
    await expect(editor(page)).not.toContainText('typed before the lock');
    // The draft is offered; discarded, it goes and the file's text stays.
    const offer = page.locator('[data-draft-offer]');
    await expect(offer).toContainText('Restore your unsaved changes from');
    await offer.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(offer).toHaveCount(0);
    await expect(editor(page)).not.toContainText('typed before the lock');
    await close(page);
});
