import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import {
    addContact,
    grip,
    hydrated,
    newContext,
    newFolder,
    openFolder,
    PASSWORD,
    registerAccount,
    shareWith,
} from './helpers';

/*
 * Editing 1a on the web: a text file opens in the editor, a save is a new version holding
 * exactly the edit, a file the editor can't keep byte for byte opens read-only, a save after
 * someone else's offers Save on top, Save as a copy and Open theirs and each does what it
 * says, leaving with changes asks first, a lock drops the editor's text, and only those who
 * may change a file are offered Edit.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
let other: Page;
let ownerEmail: string;
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]').first();
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const editor = (p: Page) => p.getByRole('textbox', { name: /^Contents of / });

const files = mkdtempSync(join(tmpdir(), 'hushos-editing-'));
const write = (name: string, bytes: string | Uint8Array) => {
    const path = join(files, name);
    writeFileSync(path, bytes);
    return path;
};

async function openEditor(p: Page, name: string) {
    await row(p, name).getByRole('link', { name, exact: true }).click();
    await dialog(p).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(p)).toBeVisible({ timeout: 60_000 });
}

/* Replaces the whole text, as a person selecting everything and typing would. */
async function retype(p: Page, text: string) {
    await editor(p).click();
    await p.keyboard.press('ControlOrMeta+a');
    await p.keyboard.insertText(text);
    // Taken in by the editor (its document, not only the page), before the test goes on.
    await expect(editor(p)).toContainText(text);
}

/* Holds every folder listing back for `ms` while armed: a slow server between a click and its answer. */
async function slowListings(p: Page, ms: number) {
    await p.route('**/nodes/*/children*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        await route.continue().catch(() => {});
    });
    return () => p.unroute('**/nodes/*/children*');
}

/* How many earlier versions a file has, from its Versions dialog. */
async function earlierVersions(p: Page, name: string) {
    await row(p, name)
        .locator('button')
        .first()
        .click({ ...grip, button: 'right' });
    await p.getByRole('menuitem', { name: 'Versions' }).click();
    await expect(dialog(p)).toContainText(`Versions of “${name}”`);
    // Counted once the list has come.
    await expect(dialog(p).getByText('Current version', { exact: true })).toBeVisible({
        timeout: 60_000,
    });
    const count = await dialog(p).getByRole('button', { name: 'Download earlier version' }).count();
    await p.keyboard.press('Escape');
    await expect(p.locator('[data-slot=dialog-content]')).toHaveCount(0);
    return count;
}

async function close(p: Page) {
    await dialog(p).getByRole('button', { name: 'Close preview' }).click();
    await expect(p.locator('[data-slot=dialog-content]')).toHaveCount(0);
}

/* The file's current bytes, as Download gives them. */
async function downloaded(p: Page, name: string) {
    await row(p, name).locator('button').first().click(grip);
    const [download] = await Promise.all([
        p.waitForEvent('download'),
        p.getByRole('button', { name: 'Download', exact: true }).first().click(),
    ]);
    return readFileSync((await download.path())!);
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    page = await (await newContext(browser)).newPage();
    ownerEmail = (await registerAccount(page, 'Maya Lindqvist')).email;
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([
            write('notes.txt', 'Grüße\nline two\nno final newline'),
            write('windows.txt', 'first\r\nsecond\r\n'),
            write('marked.md', Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('# Title\n')])),
            write('latin.txt', Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a])),
            write('config.json', '{\n  "a": 1\n}\n'),
            // No extension and no type: the viewer reads it to find it is text.
            write('README', 'Read me first\n'),
            // One of each language and parser the preload brings, for its test.
            write('settings.yaml', 'name: hushos\nitems:\n  - a\n'),
            write('main.rs', 'fn main() {\n    println!("hi");\n}\n'),
            write('Cargo.toml', '[package]\nname = "hushos"\n'),
        ]);
    await expect(page.locator('[data-node-id]')).toHaveCount(9, { timeout: 90_000 });
});
test.afterAll(async () => {
    await page.context().close();
});

test('after the post-unlock preload, opening JSON, YAML, Rust or TOML fetches no code the preload didn’t', async () => {
    // Every script a fresh load of the drive fetches, its post-unlock preload of every viewer,
    // grammar, parser and the check's worker included.
    const preloaded = new Set<string>();
    const script = (request: Request) =>
        request.resourceType() === 'script' ? request.url().split('?')[0]! : null;
    const before = (request: Request) => {
        const url = script(request);
        if (url) preloaded.add(url);
    };
    page.on('request', before);
    await page.reload();
    await expect(page.locator('html[data-viewers-preloaded="true"]')).toHaveCount(1, {
        timeout: 90_000,
    });
    await expect(page.locator('[data-node-id]')).toHaveCount(9, { timeout: 60_000 });
    // The preload's workers (the thumbnailer's) may still be fetching their own imports once its
    // last step returned: what they fetch belongs to the preload too, whatever is opened later.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    page.off('request', before);
    // From here, opening a file of any kind fetches no script the preload didn't, so what a device
    // fetches never says which kind was edited. A production build fetches nothing at all: each
    // chunk and the worker's one file come from the cache. The development server can't show
    // that: every new worker asks again for its own unbundled imports (the browser reports each
    // ask, cached or not), and those are exactly the ones the preload's worker fetched. So the
    // check, for each kind on its own: nothing outside what the preload fetched.
    for (const name of ['config.json', 'settings.yaml', 'main.rs', 'Cargo.toml']) {
        const fetched = new Set<string>();
        const listen = (request: Request) => {
            const url = script(request);
            if (url) fetched.add(url);
        };
        page.on('request', listen);
        await openEditor(page, name);
        // Long enough for its colouring and its structured-text check to have started.
        await page.waitForTimeout(1_500);
        await close(page);
        page.off('request', listen);
        expect(
            [...fetched].filter((url) => !preloaded.has(url)),
            name,
        ).toEqual([]);
    }
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
        ['windows.txt', 'This file uses Windows line endings, which HushOS can’t edit yet.'],
        ['marked.md', 'HushOS can’t edit this file’s encoding yet.'],
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

test.describe('when someone else saved first', () => {
    test.beforeAll(async () => {
        // A second tab of the same person: "someone else" is any other save of the file.
        other = await page.context().newPage();
        await other.goto('/app/drive');
        await expect(row(other, 'notes.txt')).toBeVisible({ timeout: 60_000 });
    });

    /* Mine open with an edit, theirs saved meanwhile from the other tab; then mine saves. */
    async function race(mine: string, theirs: string) {
        await openEditor(page, 'notes.txt');
        await retype(page, mine);
        await openEditor(other, 'notes.txt');
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

test('locking drops the editor’s text', async () => {
    await openEditor(page, 'notes.txt');
    await retype(page, 'typed before the lock');
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
    await close(page);
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
