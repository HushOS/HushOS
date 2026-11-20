import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { grip, newContext, PASSWORD, registerAccount } from './helpers';

/*
 * Editing 1c on the web: the editor's unsaved text is sealed on this browser, offered back when the
 * file opens again (after a closed tab, or a lock and unlock), restored as an unsaved edit or
 * through the stale choices when someone saved since, removed by Save, Discard and sign-out, and
 * never held in the clear: what IndexedDB keeps is ciphertext.
 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]').first();
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const editor = (p: Page) => p.getByRole('textbox', { name: /^Contents of / });
const offer = (p: Page) => p.locator('[data-draft-offer]');
const OFFER = /^Restore your unsaved changes from .+/;

const files = mkdtempSync(join(tmpdir(), 'hushos-drafts-'));
const write = (name: string, text: string) => {
    const path = join(files, name);
    writeFileSync(path, text);
    return path;
};

async function openDrive(p: Page) {
    await p.goto('/app/drive');
    await expect(row(p, 'draft.txt')).toBeVisible({ timeout: 60_000 });
}

async function openEditor(p: Page, name: string) {
    await row(p, name).getByRole('link', { name, exact: true }).click();
    await dialog(p).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(p)).toBeVisible({ timeout: 60_000 });
}

async function retype(p: Page, text: string) {
    await editor(p).click();
    await p.keyboard.press('ControlOrMeta+a');
    await p.keyboard.insertText(text);
    await expect(editor(p)).toContainText(text);
}

/* The rows of the drafts database, or null when there is no such database (never made here). */
async function draftRows(p: Page) {
    return p.evaluate(async () => {
        const names = (await indexedDB.databases()).map((database) => database.name);
        if (!names.includes('hushos-drafts')) return null;
        return new Promise<unknown[]>((resolve, reject) => {
            const request = indexedDB.open('hushos-drafts');
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('drafts')) {
                    db.close();
                    return resolve([]);
                }
                const all = db.transaction('drafts').objectStore('drafts').getAll();
                all.onsuccess = () => {
                    db.close();
                    resolve(all.result);
                };
                all.onerror = () => reject(all.error);
            };
            request.onerror = () => reject(request.error);
        });
    });
}
const draftCount = async (p: Page) => (await draftRows(p))?.length ?? 0;

/*
 * How many times `canary` appears, as UTF-8 bytes, anywhere in this origin's IndexedDB: every
 * database, every store, every value (strings, byte arrays and blobs alike).
 */
async function canaryHits(p: Page, canary: string) {
    return p.evaluate(async (needle) => {
        const wanted = new TextEncoder().encode(needle);
        const chunks: Uint8Array[] = [];
        const take = async (value: unknown, depth = 0): Promise<void> => {
            if (depth > 8 || value === null || value === undefined) return;
            if (typeof value === 'string') chunks.push(new TextEncoder().encode(value));
            else if (value instanceof ArrayBuffer) chunks.push(new Uint8Array(value));
            else if (ArrayBuffer.isView(value))
                chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            else if (value instanceof Blob) chunks.push(new Uint8Array(await value.arrayBuffer()));
            else if (typeof value === 'object')
                for (const inner of Object.values(value)) await take(inner, depth + 1);
        };
        for (const { name } of await indexedDB.databases()) {
            if (!name) continue;
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(name);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            for (const store of Array.from(db.objectStoreNames)) {
                const values = await new Promise<unknown[]>((resolve, reject) => {
                    const all = db.transaction(store).objectStore(store).getAll();
                    all.onsuccess = () => resolve(all.result);
                    all.onerror = () => reject(all.error);
                });
                for (const value of values) await take(value);
            }
            db.close();
        }
        let hits = 0;
        for (const chunk of chunks)
            for (let at = 0; at + wanted.length <= chunk.length; at++) {
                let match = true;
                for (let i = 0; i < wanted.length && match; i++)
                    match = chunk[at + i] === wanted[i];
                if (match) hits++;
            }
        return hits;
    }, canary);
}

/*
 * Types `text` and leaves the page at once, inside the editor's two-second write delay: `pagehide`
 * locks the tab first of all, and the lock seals the text as the key goes (authClient.beforeLock).
 * The event is dispatched here, then the tab closed once the draft is kept: a real close can end
 * the page before that write lands (the browser guarantees nothing after pagehide), which is the
 * limit the security page states. `timer`: no pagehide; the delay's own write keeps it.
 */
async function typeAndCloseTab(text: string, name = 'draft.txt', { timer = false } = {}) {
    await openEditor(page, name);
    await retype(page, text);
    if (!timer)
        await page.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })),
        );
    await expect.poll(() => draftCount(page), { timeout: 15_000 }).toBe(1);
    // As a person closing the tab: no beforeunload prompt, nothing saved.
    await page.close();
    page = await context.newPage();
    await openDrive(page);
}

async function downloaded(p: Page, name: string) {
    await row(p, name).locator('button').first().click(grip);
    const [download] = await Promise.all([
        p.waitForEvent('download'),
        p.getByRole('button', { name: 'Download', exact: true }).first().click(),
    ]);
    return readFileSync((await download.path())!, 'utf8');
}

async function close(p: Page) {
    await dialog(p).getByRole('button', { name: 'Close preview' }).click();
    await expect(p.locator('[data-slot=dialog-content]')).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    context = await newContext(browser);
    page = await context.newPage();
    await registerAccount(page, 'Ines Moreau');
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([write('draft.txt', 'saved text\n'), write('stale.txt', 'first version\n')]);
    await expect(page.locator('[data-node-id]')).toHaveCount(2, { timeout: 90_000 });
});
test.afterAll(async () => {
    await context.close();
});

test('a closed tab’s unsaved text is offered back, Restore brings it back unsaved, and Save removes the draft', async () => {
    await typeAndCloseTab('unsaved after a closed tab');
    await openEditor(page, 'draft.txt');
    await expect(offer(page).getByText(OFFER)).toBeVisible({ timeout: 30_000 });
    // Until it is answered, the file's own text shows and nothing can be typed into it.
    await expect(editor(page)).toContainText('saved text');
    await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
    await offer(page).getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(offer(page)).toHaveCount(0);
    await expect(editor(page)).toContainText('unsaved after a closed tab');
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
    // Unsaved: Save is on, and the file still holds what it held.
    const save = dialog(page).getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => draftCount(page), { timeout: 15_000 }).toBe(0);
    await close(page);
    expect(await downloaded(page, 'draft.txt')).toBe('unsaved after a closed tab');
    // Opened again: nothing offered.
    await openEditor(page, 'draft.txt');
    await expect(editor(page)).toContainText('unsaved after a closed tab');
    await expect(offer(page)).toHaveCount(0);
    await close(page);
});

test('Discard removes the draft and asks nothing more', async () => {
    await typeAndCloseTab('thrown away from the draft');
    await openEditor(page, 'draft.txt');
    await expect(offer(page).getByText(OFFER)).toBeVisible({ timeout: 30_000 });
    await offer(page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(offer(page)).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(editor(page)).toContainText('unsaved after a closed tab');
    await expect(editor(page)).not.toContainText('thrown away from the draft');
    await expect.poll(() => draftCount(page), { timeout: 15_000 }).toBe(0);
    // Nothing changed, so closing asks nothing; opened again, nothing is offered.
    await close(page);
    await openEditor(page, 'draft.txt');
    await expect(editor(page)).toContainText('unsaved after a closed tab');
    await expect(offer(page)).toHaveCount(0);
    await close(page);
});

test('someone saved since the draft: Restore leads to the stale choices, never over their version', async () => {
    await typeAndCloseTab('mine, from the draft', 'stale.txt');
    // Someone else's save meanwhile: the same name uploaded again, as a new version.
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([write('stale.txt', 'theirs\n')]);
    await expect(dialog(page)).toContainText('“stale.txt” is already here');
    await dialog(page).getByRole('button', { name: 'Continue' }).click();
    await expect.poll(() => downloaded(page, 'stale.txt'), { timeout: 60_000 }).toBe('theirs\n');
    await openEditor(page, 'stale.txt');
    await expect(offer(page).getByText(OFFER)).toBeVisible({ timeout: 30_000 });
    await expect(editor(page)).toContainText('theirs');
    await offer(page).getByRole('button', { name: 'Restore', exact: true }).click();
    const choices = page.getByRole('alertdialog');
    await expect(choices).toContainText('This file changed');
    for (const choice of ['Save on top', 'Save as a copy', 'Open theirs'])
        await expect(choices.getByRole('button', { name: choice })).toBeVisible();
    // Behind the choices (a modal hides the editor from the accessibility tree), the draft's text.
    await expect(page.locator('.cm-content')).toContainText('mine, from the draft');
    // Cancelled, a plain Save still asks first: it never lands over theirs.
    await choices.getByRole('button', { name: 'Cancel' }).click();
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(choices).toContainText('This file changed', { timeout: 60_000 });
    expect(await draftCount(page)).toBe(1);
    await choices.getByRole('button', { name: 'Save on top' }).click();
    await expect(dialog(page).getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => draftCount(page), { timeout: 15_000 }).toBe(0);
    await close(page);
    expect(await downloaded(page, 'stale.txt')).toBe('mine, from the draft');
});

test('locked, the draft is ciphertext only and nothing is offered; after the unlock it is', async () => {
    const canary = `lock-canary-${Date.now()}`;
    // Another window, its Lock question already open before anything is typed here.
    const locker = await context.newPage();
    await openDrive(locker);
    await locker.getByRole('button', { name: 'Account menu' }).click();
    await locker.getByRole('menuitem', { name: 'Lock on this browser' }).click();
    const lock = locker.getByRole('alertdialog').getByRole('button', { name: 'Lock', exact: true });
    await expect(lock).toBeVisible();
    await page.bringToFront();
    await openEditor(page, 'draft.txt');
    await retype(page, canary);
    // Locked from the other window at once, inside this one's two-second write delay: the lock
    // asks this tab's editor to write first.
    await lock.click();
    await expect(
        locker.getByRole('heading', { level: 1, name: 'HushOS is locked here' }),
    ).toBeVisible();
    await locker.close();
    await page.bringToFront();
    await expect(
        page.getByRole('heading', { level: 1, name: 'HushOS is locked here' }),
    ).toBeVisible({ timeout: 90_000 });
    // While locked: no editor, no offer, and the canary nowhere in IndexedDB, as bytes.
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await expect(offer(page)).toHaveCount(0);
    expect(await draftCount(page)).toBe(1);
    expect(await canaryHits(page, canary)).toBe(0);
    await page.locator('input[autocomplete=current-password]').fill(PASSWORD);
    await page.locator('input[autocomplete=current-password]').press('Enter');
    await expect(dialog(page).getByRole('heading', { name: 'draft.txt' })).toBeVisible({
        timeout: 60_000,
    });
    await dialog(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(offer(page).getByText(OFFER)).toBeVisible({ timeout: 30_000 });
    await expect(editor(page)).not.toContainText(canary);
    await offer(page).getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(editor(page)).toContainText(canary);
    // Closed with Discard changes: the draft goes with them.
    await dialog(page).getByRole('button', { name: 'Close preview' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-slot=dialog-content]')).toHaveCount(0);
    await expect.poll(() => draftCount(page), { timeout: 15_000 }).toBe(0);
});

test('signing out deletes the drafts: no database, no canary', async () => {
    const canary = `signout-canary-${Date.now()}`;
    await typeAndCloseTab(canary, 'draft.txt', { timer: true });
    expect(await draftCount(page)).toBe(1);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
    await expect.poll(() => draftRows(page), { timeout: 30_000 }).toBeNull();
    expect(await canaryHits(page, canary)).toBe(0);
});
