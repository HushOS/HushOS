import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { basename, dirname, join } from 'node:path';
import { S3Client } from 'bun';
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import { CANARY, FIXTURE_DIR, PASSWORD, writeFixture, writeZip } from './fixtures/archives/make';
import { grip, newPersistentContext, registerAccount, sha256 } from './helpers';

/*
 * Browsing zip archives in the viewer (docs/file-tools-design.md, section 7 (a)): a zip opens as
 * its list, a folder inside opens, a text entry previews, and an entry downloads to the exact
 * bytes; a 40 MiB stored archive lists while the page fetches less than 32 MiB of it; the 5 GiB
 * ZIP64 fixture lists and asks before a download; the AES zip asks
 * for its password, refuses a wrong one and opens with the right one; a central directory of
 * 65 MiB is refused with its message; a 20 MiB compressible entry downloads whole (WebKit's
 * DecompressionStream hands back a write's whole output at once, which once broke the session);
 * three 8 MiB stored entries of a 24 MiB archive (read by range, not whole) download side by
 * side, each through a reader of its own, byte for byte.
 * A 48 MiB entry of the canary is downloaded and stopped part way. After all of it, the fixtures'
 * canary is in no stored object, not in IndexedDB, Cache Storage or the origin private file
 * system, and not in the browser's profile directory on disk (a persistent profile, where a
 * paged-out Blob would land; downloads are kept apart from it). It sits in deflated entries,
 * where only inflating makes it, and in stored ones, whose archive bytes hold it as they are.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
let context: BrowserContext | undefined;
let large: string | undefined;
let profile: string | undefined;
const started = Date.now();
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const items = (p: Page) => dialog(p).getByRole('list', { name: 'Items' });
const crumbs = (p: Page) => dialog(p).getByRole('navigation', { name: 'Folders in the archive' });

/* Three 8 MiB stored entries, each its own pattern: past 16 MiB, so the archive is read by range. */
const SIDE = [0, 1, 2].map((n) =>
    new Uint8Array(8 * 1024 * 1024).map((_, i) => (i * (31 + 2 * n) + n * 7) & 0xff),
);
function sideBySide(dir: string) {
    const path = join(dir, 'side-by-side.zip');
    writeFileSync(
        path,
        writeZip(SIDE.map((data, n) => ({ name: `part-${n}.bin`, data, method: 0 }))),
    );
    return path;
}

/* One 48 MiB stored entry of the canary, line after line: read by range, long enough to stop part way. */
function canary48(dir: string) {
    const path = join(dir, 'canary-48m.zip');
    const line = new TextEncoder().encode(`${CANARY}\n`);
    const data = new Uint8Array(48 * 1024 * 1024);
    for (let at = 0; at + line.length <= data.length; at += line.length) data.set(line, at);
    writeFileSync(path, writeZip([{ name: 'canary.txt', data, method: 0 }]));
    return path;
}

/* A directory this file made in the system's temporary one, and only such: removed whatever is in it. */
function removeMade(dir: string | undefined) {
    if (!dir || dirname(dir) !== tmpdir() || !basename(dir).startsWith('hushos-archives-')) return;
    rmSync(dir, { recursive: true, force: true });
}

/* Five 8 MiB stored entries, 40 MiB on disk: more than the listing may fetch, so it can only list by range. */
function range40(dir: string) {
    const path = join(dir, 'range-40m.zip');
    writeFileSync(
        path,
        writeZip(
            [0, 1, 2, 3, 4].map((n) => ({
                name: `part-${n}.bin`,
                data: new Uint8Array(8 * 1024 * 1024).map((_, i) => (i * 131 + n * 17) & 0xff),
                method: 0,
            })),
        ),
    );
    return path;
}

async function open(p: Page, name: string) {
    await row(p, name).locator('button').first().dblclick(grip);
    await expect(dialog(p)).toContainText(name);
}
async function close(p: Page) {
    await p.keyboard.press('Escape');
    await expect(dialog(p)).toHaveCount(0);
}

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
    test.setTimeout(300_000);
    const dir = mkdtempSync(join(tmpdir(), 'hushos-archives-e2e-'));
    large = dir;
    // A profile of its own on disk, scanned for the canary at the end; downloads land apart from it.
    profile = mkdtempSync(join(tmpdir(), 'hushos-archives-profile-'));
    const use = test.info().project.use;
    context = await newPersistentContext(playwright[browserName], profile, {
        ...launchOptions,
        baseURL: use.baseURL,
        viewport: use.viewport,
        userAgent: use.userAgent,
        deviceScaleFactor: use.deviceScaleFactor,
        acceptDownloads: true,
        downloadsPath: join(dir, 'downloads'),
    });
    page = context.pages()[0] ?? (await context.newPage());
    await registerAccount(page);
    const files = [
        join(FIXTURE_DIR, 'basic.zip'),
        join(FIXTURE_DIR, 'aes.zip'),
        join(FIXTURE_DIR, 'deep.zip'),
        writeFixture('zip64-5g.zip', dir),
        writeFixture('directory-65m.zip', dir),
        writeFixture('compressible.zip', dir),
        sideBySide(dir),
        range40(dir),
        canary48(dir),
    ];
    await page.locator('input[type=file]').first().setInputFiles(files);
    await expect(page.locator('[data-node-id]')).toHaveCount(9, { timeout: 240_000 });
    for (const name of [
        'basic.zip',
        'aes.zip',
        'zip64-5g.zip',
        'directory-65m.zip',
        'compressible.zip',
    ])
        await expect(row(page, name)).toBeVisible();
});
// The generated fixtures (over 100 MiB) and the profile go, a setup that stopped part way included.
test.afterAll(async () => {
    await context?.close();
    removeMade(large);
    removeMade(profile);
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

test('a 40 MiB stored archive lists by range: the page fetches less than 32 MiB of it', async () => {
    // Every response's size, waited for once the list shows: a whole read (40 MiB and its padding) fails this.
    const sizes: Promise<number>[] = [];
    const count = (request: Request) => {
        // The app's own code (Vite serves it module by module in development) is not the archive.
        if (/\/(assets|@vite|@fs|@id|node_modules|src)\//.test(request.url())) return;
        sizes.push(
            request
                .sizes()
                .then((size) => size.responseBodySize)
                .catch(() => 0),
        );
    };
    page.on('requestfinished', count);
    await open(page, 'range-40m.zip');
    await expect(items(page).getByRole('button', { name: /^part-4\.bin\b/ })).toBeVisible({
        timeout: 60_000,
    });
    page.off('requestfinished', count);
    const fetched = (await Promise.all(sizes)).reduce((sum, size) => sum + size, 0);
    expect(fetched).toBeGreaterThan(0);
    expect(fetched).toBeLessThan(32 * 1024 * 1024);
    await close(page);
});

test('the 5 GiB ZIP64 fixture lists its 5 GB entry and asks before downloading it', async () => {
    await open(page, 'zip64-5g.zip');
    await expect(items(page).getByRole('button', { name: /^zeros-5g\.bin\b/ })).toContainText(
        '5 GB',
        { timeout: 60_000 },
    );
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
    const zip = readFileSync(join(large!, 'compressible.zip'));
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

test('three 8 MiB stored entries of a 24 MiB archive download side by side, byte for byte', async () => {
    await open(page, 'side-by-side.zip');
    await expect(items(page).getByRole('button', { name: 'Download part-2.bin' })).toBeVisible({
        timeout: 60_000,
    });
    const downloads = Promise.all(
        [0, 1, 2].map((n) =>
            page.waitForEvent('download', {
                predicate: (download) => download.suggestedFilename() === `part-${n}.bin`,
                timeout: 180_000,
            }),
        ),
    );
    for (const n of [0, 1, 2])
        await items(page)
            .getByRole('button', { name: `Download part-${n}.bin` })
            .click();
    for (const [n, download] of (await downloads).entries()) {
        const path = await download.path();
        expect(sha256(readFileSync(path!)), `part-${n}.bin`).toBe(sha256(SIDE[n]!));
    }
    // The archive stayed open: nothing counted the three side by side as the worker reading too much.
    await expect(dialog(page)).not.toContainText("couldn't be processed");
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

test('a download of the canary stopped part way is let go of', async () => {
    await open(page, 'canary-48m.zip');
    // Stopped from inside the page the moment its bar shows some of it written and not all: from
    // outside, a fast engine (WebKit) finishes 48 MiB between seeing the bar and clicking.
    const stopped = page.evaluate(
        () =>
            new Promise<string>((resolve, reject) => {
                const look = () => {
                    const bars = document.querySelectorAll('[data-slot=dialog-content] li');
                    for (const bar of bars) {
                        const text = bar.textContent ?? '';
                        const stop = bar.querySelector<HTMLButtonElement>(
                            'button[aria-label="Stop"]',
                        );
                        if (!stop || !/(^|\D)[1-9]\d?%$/.test(text)) continue;
                        observer.disconnect();
                        clearTimeout(timer);
                        stop.click();
                        resolve(text);
                        return;
                    }
                };
                const observer = new MutationObserver(look);
                observer.observe(document.body, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                });
                const timer = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error('The download never showed part of it written.'));
                }, 60_000);
            }),
    );
    await items(page).getByRole('button', { name: 'Download canary.txt' }).click();
    expect(await stopped).toMatch(/[1-9]\d?%$/);
    await expect(dialog(page).getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await close(page);
});

test('the canary is in no stored object, and not in IndexedDB, Cache Storage, the private file system or the profile on disk', async () => {
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

    // The browser's own files on disk, after the download stopped part way: a Blob paged out, a cache,
    // a database the page never named. The downloads the tests kept are elsewhere (downloadsPath).
    const hits: string[] = [];
    const scan = (dir: string) => {
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
                if (info.isDirectory()) scan(path);
                else if (info.isFile() && readFileSync(path).includes(CANARY)) hits.push(path);
            } catch {
                // Gone meanwhile (the browser's own temporary files): nothing to read.
            }
        }
    };
    scan(profile!);
    expect(hits).toEqual([]);
});
