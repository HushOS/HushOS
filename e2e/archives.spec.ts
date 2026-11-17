import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { S3Client } from 'bun';
import { expect, test, type Page, type Request } from '@playwright/test';
import { CANARY, FIXTURE_DIR, PASSWORD, writeFixture } from './fixtures/archives/make';
import { grip, newPage, registerAccount, sha256 } from './helpers';

/*
 * Browsing zip archives in the viewer (docs/file-tools-design.md, section 7 (a)): a zip opens as
 * its list, a folder inside opens, a text entry previews, and an entry downloads to the exact
 * bytes; the 5 GiB ZIP64 fixture lists while the page fetches less than 32 MiB; the AES zip asks
 * for its password, refuses a wrong one and opens with the right one; a central directory of
 * 65 MiB is refused with its message; a 20 MiB compressible entry downloads whole (WebKit's
 * DecompressionStream hands back a write's whole output at once, which once broke the session).
 * After all of it, the fixtures' canary is in no stored object, and not in IndexedDB, Cache
 * Storage or the origin private file system. It sits in deflated entries, where only inflating
 * makes it, and in a stored one, whose archive bytes hold it as they are.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
let large: string;
const started = Date.now();
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const items = (p: Page) => dialog(p).getByRole('list', { name: 'Items' });
const crumbs = (p: Page) => dialog(p).getByRole('navigation', { name: 'Folders in the archive' });

async function open(p: Page, name: string) {
    await row(p, name).locator('button').first().dblclick(grip);
    await expect(dialog(p)).toContainText(name);
}
async function close(p: Page) {
    await p.keyboard.press('Escape');
    await expect(dialog(p)).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    page = await newPage(browser);
    await registerAccount(page);
    large = mkdtempSync(join(tmpdir(), 'hushos-archives-e2e-'));
    const files = [
        join(FIXTURE_DIR, 'basic.zip'),
        join(FIXTURE_DIR, 'aes.zip'),
        join(FIXTURE_DIR, 'deep.zip'),
        writeFixture('zip64-5g.zip', large),
        writeFixture('directory-65m.zip', large),
        writeFixture('compressible.zip', large),
    ];
    await page.locator('input[type=file]').first().setInputFiles(files);
    await expect(page.locator('[data-node-id]')).toHaveCount(6, { timeout: 180_000 });
    for (const name of [
        'basic.zip',
        'aes.zip',
        'zip64-5g.zip',
        'directory-65m.zip',
        'compressible.zip',
    ])
        await expect(row(page, name)).toBeVisible();
});
test.afterAll(async () => {
    await page.close();
});

test('a zip opens as its list, a folder inside opens, a text entry previews and an entry downloads byte for byte', async () => {
    await open(page, 'basic.zip');
    await expect(items(page).getByRole('button', { name: /^docs\b/ })).toBeVisible({
        timeout: 60_000,
    });
    await expect(items(page).getByRole('button', { name: /^pixel\.png\b/ })).toBeVisible();
    await items(page)
        .getByRole('button', { name: /^docs\b/ })
        .click();
    await expect(crumbs(page).locator('[aria-current=page]')).toHaveText('docs');
    await expect(items(page).getByRole('button', { name: /^notes\b/ })).toBeVisible();
    await items(page)
        .getByRole('button', { name: /^readme\.txt\b/ })
        .click();
    await expect(dialog(page)).toContainText('Read me. This entry is deflated.', {
        timeout: 30_000,
    });
    // Back to the folder by its crumb.
    await crumbs(page).getByRole('button', { name: 'docs' }).click();
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        items(page).getByRole('button', { name: 'Download readme.txt' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('readme.txt');
    const expected = new TextEncoder().encode(`Read me. This entry is deflated.\n${CANARY}\n`);
    expect(sha256(readFileSync((await download.path())!))).toBe(sha256(expected));
    await close(page);
});

test('the 5 GiB ZIP64 fixture lists while the page fetches less than 32 MiB', async () => {
    let fetched = 0;
    const count = async (request: Request) => {
        const url = request.url();
        // The app's own code (Vite serves it module by module in development) is not the archive.
        if (/\/(assets|@vite|@fs|@id|node_modules|src)\//.test(url)) return;
        fetched += (await request.sizes().catch(() => ({ responseBodySize: 0 }))).responseBodySize;
    };
    page.on('requestfinished', count);
    await open(page, 'zip64-5g.zip');
    await expect(items(page).getByRole('button', { name: /^zeros-5g\.bin\b/ })).toBeVisible({
        timeout: 60_000,
    });
    await expect(items(page).getByRole('button', { name: /^zeros-5g\.bin\b/ })).toContainText(
        '5 GB',
    );
    page.off('requestfinished', count);
    expect(fetched).toBeGreaterThan(0);
    expect(fetched).toBeLessThan(32 * 1024 * 1024);
    // Downloading it would ask first: 5 GiB from about 5 MB.
    await items(page).getByRole('button', { name: 'Download zeros-5g.bin' }).click();
    await expect(page.getByRole('alertdialog')).toContainText(/This item expands to 5 GB from/);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await close(page);
});

test('the AES zip asks for its password, refuses a wrong one and opens with the right one', async () => {
    await open(page, 'aes.zip');
    const secret = items(page).getByRole('button', { name: /^secret\.txt\b/ });
    await expect(secret).toContainText('Needs a password', { timeout: 60_000 });
    await secret.click();
    const field = dialog(page).getByLabel('Password', { exact: true });
    await field.fill('not the password');
    await dialog(page).getByRole('button', { name: 'Open', exact: true }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText('That password isn’t right.', {
        timeout: 30_000,
    });
    await field.fill(PASSWORD);
    await dialog(page).getByRole('button', { name: 'Open', exact: true }).click();
    await expect(dialog(page)).toContainText('AES-256, AE-2.', { timeout: 30_000 });
    await close(page);
});

test('a central directory of 65 MiB is refused with its message', async () => {
    await open(page, 'directory-65m.zip');
    await expect(dialog(page)).toContainText(
        'This archive’s list of contents is too large to open here. Download it to open it on your computer.',
        { timeout: 60_000 },
    );
    await close(page);
});

test('a 20 MiB compressible entry downloads whole, byte for byte', async () => {
    // What it inflates to, from the fixture's own bytes: its one entry's raw deflate stream.
    const zip = readFileSync(join(large, 'compressible.zip'));
    const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
    const expected = inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(18)));
    await open(page, 'compressible.zip');
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        items(page).getByRole('button', { name: 'Download compressible.txt' }).click(),
    ]);
    const path = await download.path();
    expect(sha256(readFileSync(path!))).toBe(sha256(new Uint8Array(expected)));
    expect(readFileSync(path!).length).toBe(20 * 1024 * 1024);
    await close(page);
});

test('a name of 32,768 parts lists flat and opens; one of 256 parts lists as folders', async () => {
    await open(page, 'deep.zip');
    // The deepest is one row at the top, named by its whole path.
    const flat = items(page).getByRole('button', { name: /^a\/a\/a\// });
    await expect(flat).toBeVisible({ timeout: 60_000 });
    await expect(items(page).getByRole('button', { name: /^b\b/ })).toBeVisible();
    await flat.click();
    await expect(dialog(page)).toContainText('x', { timeout: 30_000 });
    await expect(dialog(page)).not.toContainText('can’t be shown');
    await close(page);
});

test('the canary is in no stored object, and not in IndexedDB, Cache Storage or the private file system', async () => {
    const found = await page.evaluate(async (canary) => {
        const hits: string[] = [];
        const text = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (value instanceof ArrayBuffer) return new TextDecoder('latin1').decode(value);
            if (ArrayBuffer.isView(value))
                return new TextDecoder('latin1').decode(
                    new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
                );
            if (value instanceof Blob) return '';
            if (value && typeof value === 'object')
                return Object.values(value as Record<string, unknown>)
                    .map(text)
                    .join('\n');
            return '';
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
                for (const value of values) {
                    if (
                        value instanceof Blob ||
                        (value && typeof value === 'object' && 'blob' in value)
                    ) {
                        const blob =
                            value instanceof Blob ? value : (value as { blob: unknown }).blob;
                        if (
                            blob instanceof Blob &&
                            new TextDecoder('latin1')
                                .decode(await blob.arrayBuffer())
                                .includes(canary)
                        )
                            hits.push(`idb ${info.name}/${store}`);
                    }
                    if (text(value).includes(canary)) hits.push(`idb ${info.name}/${store}`);
                }
            }
            db.close();
        }
        for (const name of await caches.keys()) {
            const cache = await caches.open(name);
            for (const request of await cache.keys()) {
                const response = await cache.match(request);
                const body = response ? await response.arrayBuffer() : new ArrayBuffer(0);
                if (new TextDecoder('latin1').decode(body).includes(canary))
                    hits.push(`cache ${name} ${request.url}`);
            }
        }
        const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
            for await (const [name, handle] of (
                dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
            ).entries()) {
                if (handle.kind === 'directory')
                    await walk(handle as FileSystemDirectoryHandle, `${path}/${name}`);
                else {
                    const file = await (handle as FileSystemFileHandle).getFile();
                    if (new TextDecoder('latin1').decode(await file.arrayBuffer()).includes(canary))
                        hits.push(`opfs ${path}/${name}`);
                }
            }
        };
        // WebKit in an automated, ephemeral profile has no private file system to open: nothing to scan there.
        const root = await navigator.storage.getDirectory().catch(() => null);
        if (root) await walk(root, '');
        return hits;
    }, CANARY);
    expect(found).toEqual([]);

    // The store, every object written since this file began: the archives' ciphertext only.
    const client = new S3Client({
        endpoint: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9000',
        region: process.env.STORAGE_REGION || 'us-east-1',
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || 'hushos-drive',
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
        bucket: process.env.E2E_STORAGE_BUCKET ?? process.env.STORAGE_BUCKET,
    });
    let checked = 0;
    let startAfter: string | undefined;
    for (;;) {
        const listing = await client.list({ startAfter, maxKeys: 1000 });
        const contents = listing.contents ?? [];
        for (const item of contents) {
            const modified = item.lastModified ? new Date(item.lastModified).getTime() : Date.now();
            if (modified < started - 60_000) continue;
            const bytes = await client.file(item.key).bytes();
            expect(Buffer.from(bytes).includes(CANARY), item.key).toBe(false);
            checked++;
        }
        if (!listing.isTruncated || contents.length === 0) break;
        startAfter = contents.at(-1)!.key;
    }
    // The four archives at least, and every one of them ciphertext.
    expect(checked).toBeGreaterThanOrEqual(4);
});
