import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { S3Client, SQL } from 'bun';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { pdfPages } from '../apps/web/src/lib/pdf-tools/pdf-reader.testkit';
import expected from './fixtures/pdfs/expected.json';
import { e2eDatabase, grip, newPersistentContext, registerAccount } from './helpers';

/*
 * Edit pages (docs/file-tools-design.md, section 7 (c)), against e2e/fixtures/pdfs: merging gives
 * the sum of the pages, in the order and turned as the dialog left them; splitting gives one file a
 * range; a new version keeps the earlier one; Save as images gives one image a page at the size the
 * resolution makes it; the signed PDF warns and the password PDF is refused. Then the plaintext
 * checks, after a run cancelled mid-upload too: the fixtures' canary is in no stored object,
 * IndexedDB, Cache Storage, the private file system or the browser's profile on disk.
 */

test.describe.configure({ mode: 'serial' });

const FIXTURES = join(__dirname, 'fixtures/pdfs');
const FILES = [
    'plain.pdf',
    'rotated.pdf',
    'signed.pdf',
    'encrypted.pdf',
    'outline-form.pdf',
    'transparency.pdf',
    'user-unit.pdf',
];
const CANARY = Buffer.from(expected.canary);
const pagesOf = (name: string) => expected.files.find((file) => file.file === name)!.pages!;

let page: Page;
let context: BrowserContext | undefined;
let profile: string | undefined;
let downloads: string | undefined;
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const transfers = (p: Page) => p.locator('section[aria-label=Transfers]');
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });

function removeMade(dir: string | undefined) {
    if (!dir || dirname(dir) !== tmpdir() || !basename(dir).startsWith('hushos-pdf-tools-')) return;
    rmSync(dir, { recursive: true, force: true });
}

async function select(p: Page, names: string[]) {
    await p.keyboard.press('Escape');
    for (const [index, name] of names.entries())
        await row(p, name)
            .locator('button')
            .first()
            .click(index === 0 ? grip : { ...grip, modifiers: ['ControlOrMeta'] });
}

/* Edit pages from the selection's own menu, the transfers panel's finished rows cleared first. */
async function editPages(p: Page, names: string[]) {
    const clear = p.getByRole('button', { name: 'Clear finished' });
    if (await clear.isVisible()) await clear.click();
    await select(p, names);
    await row(p, names[0]!).click({ button: 'right', position: grip.position });
    await p.getByRole('menuitem', { name: 'Edit pages' }).click();
    await expect(dialog(p).getByRole('heading', { name: /^Edit pages of/ })).toBeVisible();
}

async function download(p: Page, name: string) {
    await select(p, [name]);
    const [file] = await Promise.all([
        p.waitForEvent('download'),
        p.getByRole('button', { name: 'Download', exact: true }).first().click(),
    ]);
    expect(file.suggestedFilename()).toBe(name);
    return new Uint8Array(readFileSync((await file.path())!));
}

const readBack = pdfPages;

/* A PNG's width and height from its header. */
function pngSize(bytes: Uint8Array) {
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

function storage() {
    return new S3Client({
        endpoint: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9000',
        region: process.env.STORAGE_REGION || 'us-east-1',
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || 'hushos-drive',
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
        bucket: process.env.E2E_STORAGE_BUCKET ?? process.env.STORAGE_BUCKET,
    });
}

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
    test.setTimeout(240_000);
    profile = mkdtempSync(join(tmpdir(), 'hushos-pdf-tools-profile-'));
    downloads = mkdtempSync(join(tmpdir(), 'hushos-pdf-tools-downloads-'));
    const use = test.info().project.use;
    context = await newPersistentContext(playwright[browserName], profile, {
        ...launchOptions,
        baseURL: use.baseURL,
        viewport: use.viewport,
        userAgent: use.userAgent,
        deviceScaleFactor: use.deviceScaleFactor,
        acceptDownloads: true,
        downloadsPath: downloads,
    });
    page = context.pages()[0] ?? (await context.newPage());
    await registerAccount(page);
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles(FILES.map((name) => join(FIXTURES, name)));
    for (const name of FILES) await expect(row(page, name)).toBeVisible({ timeout: 120_000 });
    await expect(transfers(page)).toContainText(/uploaded/, { timeout: 120_000 });
    await page.getByRole('button', { name: 'Clear finished' }).click();
});

test.afterAll(async () => {
    await context?.close();
    removeMade(profile);
    removeMade(downloads);
});

test('merging gives the sum of the pages, turned and in the order the dialog left them', async () => {
    await editPages(page, ['plain.pdf', 'rotated.pdf']);
    const form = dialog(page);
    const tiles = form.locator('[data-page]');
    await expect(tiles).toHaveCount(5, { timeout: 30_000 });
    // As read: plain's three, then rotated's two, each turned as its PDF has it.
    expect(
        await tiles.evaluateAll((all) => all.map((tile) => tile.getAttribute('data-rotate'))),
    ).toEqual(['0', '0', '0', '180', '90']);
    // Page 1 turned a quarter; page 3 put first with its own button, the keyboard's way.
    await form.getByRole('button', { name: 'Rotate page 1' }).click();
    await form.getByRole('button', { name: 'Move page 3 earlier' }).click();
    await form.getByRole('button', { name: 'Move page 2 earlier' }).click();
    // Several PDFs are one new file, named after the first.
    await expect(form.getByRole('button', { name: 'One file' })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('plain (merged).pdf');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(transfers(page)).toContainText('Making plain (merged).pdf');
    await expect(transfers(page)).toContainText('Saved in My files', { timeout: 60_000 });

    const merged = await readBack(await download(page, 'plain (merged).pdf'));
    const [letter, a4, small] = pagesOf('plain.pdf');
    const [rotatedLetter, wide] = pagesOf('rotated.pdf');
    expect(merged).toEqual([
        { ...small, label: 'Page 3' },
        { ...letter, rotate: 90, label: 'Page 1' },
        { ...a4, label: 'Page 2' },
        { ...rotatedLetter, label: 'Page 1' },
        { ...wide, label: 'Page 2' },
    ]);
    // The sources are untouched beside it.
    for (const name of ['plain.pdf', 'rotated.pdf']) await expect(row(page, name)).toBeVisible();
});

test('splitting gives one file a range, named for its pages', async () => {
    await editPages(page, ['plain.pdf']);
    const form = dialog(page);
    await expect(form.locator('[data-page]')).toHaveCount(3, { timeout: 30_000 });
    await form.getByRole('button', { name: 'Split after page 1' }).click();
    await expect(form.getByRole('button', { name: 'Split after page 1' })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    // Split, a new version can't be: the choice is the files.
    await expect(form.getByRole('button', { name: 'New version' })).toHaveCount(0);
    await expect(form.getByRole('button', { name: '2 files' })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(form.getByRole('list', { name: 'Files' })).toHaveText(
        /plain \(page 1\)\.pdf\s*plain \(pages 2–3\)\.pdf/,
    );
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(transfers(page)).toContainText('Splitting plain.pdf');
    // One run, one row, two files.
    await expect(transfers(page)).toContainText('Saved in My files', { timeout: 60_000 });
    await expect(row(page, 'plain (page 1).pdf')).toBeVisible();
    await expect(row(page, 'plain (pages 2–3).pdf')).toBeVisible();
    const [letter, a4, small] = pagesOf('plain.pdf');
    expect(await readBack(await download(page, 'plain (page 1).pdf'))).toEqual([
        { ...letter, label: 'Page 1' },
    ]);
    expect(await readBack(await download(page, 'plain (pages 2–3).pdf'))).toEqual([
        { ...a4, label: 'Page 2' },
        { ...small, label: 'Page 3' },
    ]);
});

test('a new version keeps the earlier one, which still has every page', async () => {
    const id = await row(page, 'plain.pdf').getAttribute('data-node-id');
    await editPages(page, ['plain.pdf']);
    const form = dialog(page);
    await expect(form.locator('[data-page]')).toHaveCount(3, { timeout: 30_000 });
    // Nothing changed yet: a version the same as the last isn't offered.
    await expect(form.getByRole('button', { name: 'New version' })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: 'Remove page 2' }).click();
    await expect(form.locator('[data-page]')).toHaveCount(2);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(transfers(page)).toContainText('Saved as a new version', { timeout: 60_000 });
    // Two versions of the one file, the earlier one's object still in the store at its size.
    const database = new SQL(e2eDatabase().url);
    try {
        const versions = await database`
            select v.id, o.object_key, o.ciphertext_size from file_versions v
            join drive_objects o on o.id = v.object_id
            where v.node_id = ${id} order by v.created_at`;
        expect(versions).toHaveLength(2);
        const client = storage();
        for (const version of versions)
            expect((await client.file(version.object_key).bytes()).byteLength).toBe(
                Number(version.ciphertext_size),
            );
    } finally {
        await database.close();
    }
    // The file as the folder lists it now is the new version.
    await page.reload();
    await expect(row(page, 'plain.pdf')).toBeVisible({ timeout: 60_000 });
    const [letter, , small] = pagesOf('plain.pdf');
    expect(await readBack(await download(page, 'plain.pdf'))).toEqual([
        { ...letter, label: 'Page 1' },
        { ...small, label: 'Page 3' },
    ]);
    await expect(row(page, 'plain (2).pdf')).toHaveCount(0);
});

test('Save as images gives one PNG a page, at 150 dpi, turned with the page', async () => {
    await editPages(page, ['rotated.pdf']);
    const form = dialog(page);
    await expect(form.locator('[data-page]')).toHaveCount(2, { timeout: 30_000 });
    await form.getByRole('button', { name: 'Images' }).click();
    await expect(form.getByRole('button', { name: 'PNG' })).toHaveAttribute('aria-pressed', 'true');
    await expect(form.getByRole('button', { name: '150 dpi' })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    // An image has no signature or form to lose: no warning about them.
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(transfers(page)).toContainText('Saving rotated.pdf as images');
    await expect(transfers(page)).toContainText('Saved in My files', { timeout: 90_000 });
    await row(page, 'rotated (images)').getByRole('link', { name: 'rotated (images)' }).click();
    await expect(row(page, 'page 001.png')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'page 002.png')).toBeVisible();
    await expect(page.locator('[data-node-id]')).toHaveCount(2);
    // Letter turned 180 stays 1275 by 1650; the wide page turned 90 stands 844 by 1500.
    expect(pngSize(await download(page, 'page 001.png'))).toEqual({ width: 1275, height: 1650 });
    expect(pngSize(await download(page, 'page 002.png'))).toEqual({ width: 844, height: 1500 });
    await page.goBack();
    await expect(row(page, 'rotated.pdf')).toBeVisible();
});

test('Save as images draws a transparency group, and a page in units of two points at its full size', async () => {
    await editPages(page, ['transparency.pdf', 'user-unit.pdf']);
    const form = dialog(page);
    await expect(form.locator('[data-page]')).toHaveCount(2, { timeout: 30_000 });
    await form.getByRole('button', { name: 'Images' }).click();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(transfers(page)).toContainText('Saved in My files', { timeout: 90_000 });
    await row(page, 'transparency (images)')
        .getByRole('link', { name: 'transparency (images)' })
        .click();
    await expect(row(page, 'page 002.png')).toBeVisible({ timeout: 30_000 });
    expect(pngSize(await download(page, 'page 001.png'))).toEqual({ width: 1275, height: 1650 });
    // 300 by 200 units of two points: 600 by 400 points, 1250 by 833 at 150 dpi, never clipped to its MediaBox.
    expect(pngSize(await download(page, 'page 002.png'))).toEqual({ width: 1250, height: 833 });
    await page.goBack();
    await expect(row(page, 'plain.pdf')).toBeVisible();
});

test('the signed PDF warns before saving, a form warns, and the password PDF is refused', async () => {
    await editPages(page, ['signed.pdf']);
    let form = dialog(page);
    await expect(form.locator('[data-page]')).toHaveCount(1, { timeout: 30_000 });
    await expect(form).toContainText('Its digital signature won’t be valid in the new file.');
    await expect(form).toContainText('Bookmarks and form fields may not carry over.');
    await form.getByRole('button', { name: 'Cancel' }).click();

    await editPages(page, ['outline-form.pdf']);
    form = dialog(page);
    await expect(form.locator('[data-page]')).toHaveCount(2, { timeout: 30_000 });
    await expect(form).toContainText('Bookmarks and form fields may not carry over.');
    await expect(form).not.toContainText('digital signature');
    await form.getByRole('button', { name: 'Cancel' }).click();

    await editPages(page, ['encrypted.pdf']);
    form = dialog(page);
    await expect(form.getByRole('alert')).toHaveText(
        'This PDF has a password. Remove it in another app, then try again.',
        { timeout: 30_000 },
    );
    await expect(form.locator('[data-page]')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await form.locator('form').getByRole('button', { name: 'Close' }).click();
    // Merging it with another is refused the same way, naming it.
    await editPages(page, ['plain.pdf', 'encrypted.pdf']);
    await expect(dialog(page).getByRole('alert')).toHaveText(
        '“encrypted.pdf” has a password. Remove it in another app, then try again.',
        { timeout: 30_000 },
    );
    await dialog(page).locator('form').getByRole('button', { name: 'Close' }).click();
});

test('a save cancelled while its PDF uploads leaves nothing', async () => {
    const held: Route[] = [];
    await page.route(
        (url) => /^https?:\/\/(127\.0\.0\.1|localhost):9000\//.test(url.href),
        (route) => (route.request().method() === 'PUT' ? void held.push(route) : route.continue()),
    );
    await editPages(page, ['rotated.pdf', 'outline-form.pdf']);
    const form = dialog(page);
    await expect(form.locator('[data-page]')).toHaveCount(4, { timeout: 30_000 });
    await form.getByRole('textbox', { name: 'Name' }).fill('Cancelled.pdf');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => held.length, { timeout: 60_000 }).toBeGreaterThan(0);
    await transfers(page).getByRole('button', { name: 'Cancel Making Cancelled.pdf' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const route of held) await route.continue().catch(() => {});
    await expect(transfers(page)).toContainText(/Cancelled\. Nothing was saved\./, {
        timeout: 60_000,
    });
    await expect(row(page, 'Cancelled.pdf')).toHaveCount(0);
    const database = new SQL(e2eDatabase().url);
    try {
        const workspace = /\/ws\/([0-9a-f-]{36})\//.exec(held[0]!.request().url())?.[1];
        expect(workspace).toBeTruthy();
        const open = await database`
            select count(*)::int as n from drive_uploads
            where workspace_id = ${workspace!} and status in ('open', 'completing')`;
        expect(open[0].n).toBe(0);
    } finally {
        await database.close();
    }
    await page.reload();
    await expect(row(page, 'plain.pdf')).toBeVisible({ timeout: 60_000 });
    await expect(row(page, 'Cancelled.pdf')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('no plaintext reaches storage: not the store, IndexedDB, Cache Storage, the private file system or the profile', async () => {
    const needle = [...CANARY];
    const scan = () =>
        page.evaluate(async (bytes) => {
            const hits: string[] = [];
            const holds = (data: ArrayBuffer | ArrayBufferView) => {
                const view =
                    data instanceof ArrayBuffer
                        ? new Uint8Array(data)
                        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                outer: for (let i = 0; i + bytes.length <= view.length; i++) {
                    for (let j = 0; j < bytes.length; j++)
                        if (view[i + j] !== bytes[j]) continue outer;
                    return true;
                }
                return false;
            };
            const text = String.fromCharCode(...bytes);
            const visit = async (value: unknown, where: string, depth = 0): Promise<void> => {
                if (depth > 8 || value === null || value === undefined) return;
                if (typeof value === 'string') {
                    if (value.includes(text)) hits.push(where);
                } else if (value instanceof Blob) {
                    if (holds(await value.arrayBuffer())) hits.push(where);
                } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                    if (holds(value)) hits.push(where);
                } else if (typeof value === 'object')
                    for (const inner of Object.values(value as Record<string, unknown>))
                        await visit(inner, where, depth + 1);
            };
            for (const info of await indexedDB.databases()) {
                if (!info.name) continue;
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open(info.name!);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                for (const store of db.objectStoreNames) {
                    const values = await new Promise<unknown[]>((resolve, reject) => {
                        const request = db.transaction(store).objectStore(store).getAll();
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    for (const value of values) await visit(value, `idb ${info.name}/${store}`);
                }
                db.close();
            }
            for (const name of await caches.keys()) {
                const cache = await caches.open(name);
                for (const request of await cache.keys()) {
                    const response = await cache.match(request);
                    if (response && holds(await response.arrayBuffer()))
                        hits.push(`cache ${name} ${request.url}`);
                }
            }
            const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
                for await (const [name, handle] of (
                    dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
                ).entries()) {
                    if (handle.kind === 'directory')
                        await walk(handle as FileSystemDirectoryHandle, `${path}/${name}`);
                    else if (
                        holds(
                            await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer(),
                        )
                    )
                        hits.push(`opfs ${path}/${name}`);
                }
            };
            const root = await navigator.storage.getDirectory().catch(() => null);
            if (root) await walk(root, '');
            return hits;
        }, needle);
    expect(await scan()).toEqual([]);

    // Every object this account's workspace holds, sources, outputs, images and versions: ciphertext only.
    const database = new SQL(e2eDatabase().url);
    let workspace: string;
    let keys: string[];
    try {
        const id = await row(page, 'plain.pdf').getAttribute('data-node-id');
        const [node] = await database`select workspace_id from drive_nodes where id = ${id}`;
        workspace = node.workspace_id;
        const objects = await database`
            select o.object_key from drive_nodes n
            join file_versions v on v.node_id = n.id
            join drive_objects o on o.id = v.object_id
            where n.workspace_id = ${workspace}`;
        keys = objects.map((object: { object_key: string }) => object.object_key);
        // Seven sources, the merge, two splits, a second version and four images.
        expect(keys.length).toBeGreaterThanOrEqual(15);
    } finally {
        await database.close();
    }
    const client = storage();
    const inspected = new Set<string>();
    let startAfter: string | undefined;
    for (;;) {
        const listing = await client.list({
            prefix: `ws/${workspace}/`,
            startAfter,
            maxKeys: 1000,
        });
        const contents = listing.contents ?? [];
        for (const item of contents) {
            const bytes = Buffer.from(await client.file(item.key).bytes());
            expect(bytes.includes(CANARY), item.key).toBe(false);
            inspected.add(item.key);
        }
        if (!listing.isTruncated || contents.length === 0) break;
        startAfter = contents.at(-1)!.key;
    }
    expect(keys.filter((key) => !inspected.has(key))).toEqual([]);

    // The browser's own files on disk (a Blob paged out would land here); downloads are kept apart.
    const hits: string[] = [];
    const scanDisk = (dir: string) => {
        let names: string[] = [];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            const path = join(dir, name);
            try {
                const info = lstatSync(path);
                if (info.isDirectory()) scanDisk(path);
                else if (info.isFile() && readFileSync(path).includes(CANARY)) hits.push(path);
            } catch {
                // Gone meanwhile (the browser's own temporary files).
            }
        }
    };
    scanDisk(profile!);
    expect(hits).toEqual([]);
    // Last: the scanner finds what it looks for, planted in IndexedDB once the disk was scanned.
    await page.evaluate(async (bytes) => {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open('hushos-canary-probe');
            request.onupgradeneeded = () => request.result.createObjectStore('probe');
            request.onsuccess = () => {
                const tx = request.result.transaction('probe', 'readwrite');
                tx.objectStore('probe').put({ bytes: new Uint8Array(bytes) }, 'one');
                tx.oncomplete = () => (request.result.close(), resolve());
                tx.onerror = () => reject(tx.error);
            };
            request.onerror = () => reject(request.error);
        });
    }, needle);
    expect(await scan()).toContain('idb hushos-canary-probe/probe');
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                const request = indexedDB.deleteDatabase('hushos-canary-probe');
                request.onsuccess = request.onerror = request.onblocked = resolve;
            }),
    );
});
