import { expect, test, type Page } from '@playwright/test';
import {
    close,
    dialog,
    downloaded,
    editingAccount,
    openEditor,
    retype,
    row,
    write,
} from './editing';
import {
    addContact,
    grip,
    newContext,
    newFolder,
    openFolder,
    registerAccount,
    shareWith,
} from './helpers';

/*
 * Editing on the web, who may and when: only those who may change a file are offered Edit (a
 * viewer of a share gets none, an editor of it edits, a file's own grant wins over its folder's),
 * and signing out drops the editor's text without the changes holding it up. The other editing
 * specs: editing-files (open, save, encodings, leaving), editing-preview (Markdown, diagrams, what
 * the editor loads) and editing-conflicts (someone else saved first, the lock).
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
let ownerEmail: string;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    ({ page, email: ownerEmail } = await editingAccount(browser, ['notes.txt']));
});
test.afterAll(async () => {
    await page.context().close();
});

test('a viewer gets no Edit; an editor of the share edits', async ({ browser }) => {
    test.setTimeout(300_000);
    const guest = await (await newContext(browser)).newPage();
    const guestEmail = (await registerAccount(guest, 'Ines Okafor')).email;
    await page.goto('/app/contacts');
    await addContact(page, guestEmail);
    await page.goto('/app/drive');
    for (const [folder, role] of [
        ['Viewing', undefined],
        ['Editing', 'Can edit'],
    ] as const) {
        await newFolder(page);
        await page.getByPlaceholder('Reports/2026').fill(folder);
        await page.keyboard.press('Enter');
        await openFolder(page, folder);
        await page
            .locator('input[type=file]')
            .first()
            .setInputFiles([write(`${folder}.txt`, `${folder} text`)]);
        await expect(row(page, `${folder}.txt`)).toBeVisible({ timeout: 60_000 });
        await page.locator('[data-crumb-id]').first().click();
        await row(page, folder).locator('button').first().click(grip);
        await page.getByRole('button', { name: 'Share', exact: true }).click();
        await shareWith(page, /Ines Okafor/, role);
        await expect(page.getByText(/shared with Ines Okafor/)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
    }
    expect(ownerEmail).toBeTruthy();

    await guest.goto('/app/shared');
    await guest.locator('[data-shared="Viewing"]').getByRole('link', { name: 'Viewing' }).click();
    await row(guest, 'Viewing.txt').getByRole('link', { name: 'Viewing.txt', exact: true }).click();
    await expect(dialog(guest).locator('.rt-code')).toContainText('Viewing text', {
        timeout: 60_000,
    });
    await expect(dialog(guest).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await close(guest);

    // A file inside the folder shared to edit, shared on its own to the same person to view: its own grant wins.
    await openFolder(page, 'Editing');
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([write('Locked.txt', 'Locked text')]);
    await expect(row(page, 'Locked.txt')).toBeVisible({ timeout: 60_000 });
    await row(page, 'Locked.txt').locator('button').first().click(grip);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await shareWith(page, /Ines Okafor/);
    await expect(page.getByText(/shared with Ines Okafor/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
    await page.locator('[data-crumb-id]').first().click();

    await guest.goto('/app/shared');
    await expect(guest.locator('[data-shared="Locked.txt"]')).toBeVisible({ timeout: 60_000 });
    await guest.locator('[data-shared="Editing"]').getByRole('link', { name: 'Editing' }).click();
    await row(guest, 'Locked.txt').getByRole('link', { name: 'Locked.txt', exact: true }).click();
    await expect(dialog(guest).locator('.rt-code')).toContainText('Locked text', {
        timeout: 60_000,
    });
    await expect(dialog(guest).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await close(guest);
    await openEditor(guest, 'Editing.txt');
    await retype(guest, 'edited by the editor');
    await guest.keyboard.press('ControlOrMeta+s');
    await expect(dialog(guest).getByText('Saved', { exact: true })).toBeVisible({
        timeout: 60_000,
    });
    await close(guest);
    await guest.context().close();

    await openFolder(page, 'Editing');
    // The owner learns of the editor's save from the change feed (every 8 s, lib/drive/feed.ts), as a
    // person would: Download fetches the version the listing shows, so wait for the new one's size.
    await expect(row(page, 'Editing.txt')).toContainText('20 B', { timeout: 30_000 });
    expect((await downloaded(page, 'Editing.txt')).toString()).toBe('edited by the editor');
});

test('signing out drops the editor’s text, and the changes don’t hold it up', async () => {
    test.setTimeout(240_000);
    await page.goto('/app/drive');
    await openEditor(page, 'notes.txt');
    await retype(page, 'typed before signing out');
    // Signed out from another tab while this one holds unsaved changes.
    const leaver = await page.context().newPage();
    await leaver.goto('/app/drive');
    await expect(row(leaver, 'notes.txt')).toBeVisible({ timeout: 60_000 });
    await leaver.getByRole('button', { name: 'Account menu' }).click();
    await leaver.getByRole('menuitem', { name: 'Sign out' }).click();
    await leaver.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(leaver).toHaveURL(/\/login/, { timeout: 60_000 });
    await leaver.close();
    // Back on this tab: it looks at the session again as it comes into view.
    await page.bringToFront();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page).toHaveURL(/\/login/, { timeout: 90_000 });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await expect(page.getByText('typed before signing out')).toHaveCount(0);
});
