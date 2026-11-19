import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { S3Client, SQL } from 'bun';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { ciphertextSize, THUMBNAIL_MAX_BYTES } from '../packages/crypto/src/drive';
import { cutJpeg } from '../apps/web/src/lib/images-pdf/jpeg';
import {
    FIXTURES,
    leaks,
    looksUpright,
    readPdf,
} from '../apps/web/src/lib/images-pdf/pdf-reader.testkit';
import { e2eDatabase, grip, newPersistentContext, registerAccount } from './helpers';

/*
 * One PDF from a selection of images (docs/file-tools-design.md, section 7 (b)): three images
 * reordered make a three-page PDF in that order, read back with pdf.js; a JPEG with GPS EXIF
 * leaves none of it in the PDF (searched for in the PDF's bytes); a phone photo stored sideways
 * stands upright; the PDF lands in the folder at its padded size; a run cancelled while its PDF
 * uploads leaves nothing. Then the plaintext checks: neither the images' metadata nor the PDF's
 * own bytes are in any stored object, IndexedDB, Cache Storage, the private file system or the
 * browser's profile on disk.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
let context: BrowserContext | undefined;
let profile: string | undefined;
let downloads: string | undefined;
const started = Date.now();
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const transfers = (p: Page) => p.locator('section[aria-label=Transfers]');
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const IMAGES = ['page-1.jpg', 'page-2.jpg', 'page-3.jpg', 'gps.jpg', 'phone-rotated.jpg'];
/* The image data of gps.jpg, as cut: what its PDF holds in plaintext, and nothing in storage may. */
const PDF_CANARY = (() => {
    const cut = cutJpeg(new Uint8Array(readFileSync(join(FIXTURES, 'gps.jpg')))).bytes;
    return Buffer.from(cut.subarray(cut.length - 200, cut.length - 120));
})();
const SOURCE_CANARY = Buffer.from('HushCanaryCam');

function removeMade(dir: string | undefined) {
    if (!dir || dirname(dir) !== tmpdir() || !basename(dir).startsWith('hushos-images-pdf-'))
        return;
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

/* Convert, then One PDF, from the selection's own menu. */
async function onePdf(p: Page, names: string[]) {
    await select(p, names);
    await row(p, names[0]!).click({ button: 'right', position: grip.position });
    await p.getByRole('menuitem', { name: 'Convert' }).click();
    await p.getByRole('menuitem', { name: 'One PDF' }).click();
    await expect(dialog(p).getByRole('heading', { name: /One PDF from/ })).toBeVisible();
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

test.beforeAll(async ({ playwright, browserName, launchOptions }) => {
    test.setTimeout(240_000);
    profile = mkdtempSync(join(tmpdir(), 'hushos-images-pdf-profile-'));
    downloads = mkdtempSync(join(tmpdir(), 'hushos-images-pdf-downloads-'));
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
        .setInputFiles(IMAGES.map((name) => join(FIXTURES, name)));
    for (const name of IMAGES) await expect(row(page, name)).toBeVisible({ timeout: 120_000 });
    await expect(transfers(page)).toContainText(/uploaded/, { timeout: 120_000 });
    await page.getByRole('button', { name: 'Clear finished' }).click();
});

test.afterAll(async () => {
    await context?.close();
    removeMade(profile);
    removeMade(downloads);
});

test('three images reordered make a three-page PDF in that order', async () => {
    await onePdf(page, ['page-1.jpg', 'page-2.jpg', 'page-3.jpg']);
    const form = dialog(page);
    await expect(form).toContainText(
        'Location, camera and other photo details are left out. The colour profile is kept.',
    );
    const name = form.getByRole('textbox', { name: 'Name' });
    await expect(name).toHaveValue('page-1.pdf');
    // page-3 to the front with its own button (the keyboard's way), then page-1 to the end.
    await form.getByRole('button', { name: 'Move page-3.jpg earlier' }).click();
    await form.getByRole('button', { name: 'Move page-3.jpg earlier' }).click();
    await form.getByRole('button', { name: 'Move page-1.jpg later' }).click();
    await expect(form.locator('[data-image-id]')).toHaveText([
        /page-3\.jpg/,
        /page-2\.jpg/,
        /page-1\.jpg/,
    ]);
    // The name follows the first image until the person types one.
    await expect(name).toHaveValue('page-3.pdf');
    await form.getByRole('button', { name: 'Fit to each image' }).click();
    await form.getByRole('button', { name: 'Make PDF' }).click();
    await expect(form).toHaveCount(0);
    await expect(transfers(page)).toContainText('Making page-3.pdf');
    await expect(transfers(page)).toContainText('Saved in My files', { timeout: 60_000 });
    await expect(row(page, 'page-3.pdf')).toBeVisible();

    const pdf = await download(page, 'page-3.pdf');
    const pages = await readPdf(pdf);
    // Fit: each page is its image. page-3 is 250x250, page-2 200x300, page-1 300x200.
    expect(pages.map((each) => [each.width, each.height])).toEqual([
        [250, 250],
        [200, 300],
        [300, 200],
    ]);
    for (const each of pages) expect(looksUpright(each)).toBe(true);
});

test('a JPEG with GPS EXIF leaves none inside the PDF, and a rotated phone photo stands upright', async () => {
    await onePdf(page, ['phone-rotated.jpg', 'gps.jpg']);
    const form = dialog(page);
    await form.getByRole('button', { name: 'A4' }).click();
    await form.getByRole('button', { name: '12 mm' }).click();
    await form.getByRole('textbox', { name: 'Name' }).fill('Trip.pdf');
    await form.getByRole('button', { name: 'Make PDF' }).click();
    await expect(transfers(page)).toContainText('Saved in My files', { timeout: 60_000 });
    const pdf = await download(page, 'Trip.pdf');
    // Searched in the PDF's own bytes: no EXIF, XMP or IPTC signature, no GPS latitude, no canary.
    expect(leaks(pdf)).toEqual([]);
    expect(Buffer.from(pdf).includes(Buffer.from('Exif'))).toBe(false);
    const pages = await readPdf(pdf);
    // In the list's order: gps.jpg, then the phone photo.
    expect(pages.map((each) => each.image)).toEqual([
        { width: 240, height: 160 },
        { width: 300, height: 400 },
    ]);
    const phone = pages[1]!;
    // Stored 300x400, sideways; shown on landscape A4, turned upright.
    expect(phone.width).toBeGreaterThan(phone.height);
    expect(looksUpright(phone)).toBe(true);
    expect(looksUpright(pages[0]!)).toBe(true);
});

test('the PDF appears in the folder at its padded size', async () => {
    const pdf = await download(page, 'Trip.pdf');
    const id = await row(page, 'Trip.pdf').getAttribute('data-node-id');
    const database = new SQL(e2eDatabase().url);
    try {
        const [object] = await database`
            select o.object_key, o.ciphertext_size, o.content_suite
            from file_versions v join drive_objects o on o.id = v.object_id
            where v.node_id = ${id}`;
        expect(object).toBeTruthy();
        const stored = Number(object.ciphertext_size);
        // What the store holds is that size, to the byte.
        const client = storage();
        expect((await client.file(object.object_key).bytes()).byteLength).toBe(stored);
        // A Padmé-padded size for these plaintext bytes and some thumbnail, never the bare length.
        let matches = false;
        for (let thumbnail = 0; thumbnail <= THUMBNAIL_MAX_BYTES && !matches; thumbnail++)
            matches = ciphertextSize(object.content_suite, pdf.byteLength, thumbnail) === stored;
        expect(matches).toBe(true);
    } finally {
        await database.close();
    }
});

test('a run cancelled while its PDF uploads leaves nothing', async () => {
    // The store never answers the PDF's upload, so the run is caught mid-save.
    const held: Route[] = [];
    await page.route(
        (url) => /^https?:\/\/(127\.0\.0\.1|localhost):9000\//.test(url.href),
        (route) => (route.request().method() === 'PUT' ? void held.push(route) : route.continue()),
    );
    await onePdf(page, ['page-1.jpg', 'page-2.jpg']);
    await dialog(page).getByRole('textbox', { name: 'Name' }).fill('Cancelled.pdf');
    await dialog(page).getByRole('button', { name: 'Make PDF' }).click();
    await expect.poll(() => held.length, { timeout: 60_000 }).toBeGreaterThan(0);
    await transfers(page).getByRole('button', { name: 'Cancel Making Cancelled.pdf' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click();
    // The held part now reaches the store after all: the stop must still leave nothing.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const route of held) await route.continue().catch(() => {});
    await expect(transfers(page)).toContainText(/Cancelled\. Nothing was saved\./, {
        timeout: 60_000,
    });
    await expect(row(page, 'Cancelled.pdf')).toHaveCount(0);
    // Nothing of it on the server either: no node named by an open upload, no upload left open.
    const database = new SQL(e2eDatabase().url);
    try {
        // This account's workspace only, from the held part's object key: other files run in parallel.
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
    await expect(row(page, 'Trip.pdf')).toBeVisible({ timeout: 60_000 });
    await expect(row(page, 'Cancelled.pdf')).toHaveCount(0);
    // A cancelled run leaves no record behind to ask about.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

function storage() {
    return new S3Client({
        endpoint: process.env.STORAGE_ENDPOINT || 'http://127.0.0.1:9000',
        region: process.env.STORAGE_REGION || 'us-east-1',
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || 'hushos-drive',
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
        bucket: process.env.E2E_STORAGE_BUCKET ?? process.env.STORAGE_BUCKET,
    });
}

test('no plaintext reaches storage: not the store, IndexedDB, Cache Storage, the private file system or the profile', async () => {
    // Byte for byte: a browser's 'latin1' decoder is Windows-1252, which would miss bytes 0x80 to 0x9F.
    const canaries = [[...PDF_CANARY], [...SOURCE_CANARY]];
    const scan = () =>
        page.evaluate(async (needles) => {
            const hits: string[] = [];
            const holds = (data: ArrayBuffer | ArrayBufferView) => {
                const bytes =
                    data instanceof ArrayBuffer
                        ? new Uint8Array(data)
                        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                return needles.some((needle) => {
                    outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
                        for (let j = 0; j < needle.length; j++)
                            if (bytes[i + j] !== needle[j]) continue outer;
                        return true;
                    }
                    return false;
                });
            };
            // A string holds bytes as code points 0 to 255, as a page that kept them in one would.
            const asText = needles.map((needle) => String.fromCharCode(...needle));
            const visit = async (value: unknown, where: string, depth = 0): Promise<void> => {
                if (depth > 8 || value === null || value === undefined) return;
                if (typeof value === 'string') {
                    if (asText.some((needle) => value.includes(needle))) hits.push(where);
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
        }, canaries);
    const found = await scan();
    expect(found).toEqual([]);

    // Every object written since this file began, the PDFs' among them: ciphertext only.
    const client = storage();
    let checked = 0;
    let startAfter: string | undefined;
    for (;;) {
        const listing = await client.list({ startAfter, maxKeys: 1000 });
        const contents = listing.contents ?? [];
        for (const item of contents) {
            const modified = item.lastModified ? new Date(item.lastModified).getTime() : Date.now();
            if (modified < started - 60_000) continue;
            const bytes = Buffer.from(await client.file(item.key).bytes());
            expect(bytes.includes(PDF_CANARY), item.key).toBe(false);
            expect(bytes.includes(SOURCE_CANARY), item.key).toBe(false);
            checked++;
        }
        if (!listing.isTruncated || contents.length === 0) break;
        startAfter = contents.at(-1)!.key;
    }
    // The five images and the two PDFs at least.
    expect(checked).toBeGreaterThanOrEqual(7);

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
                else if (info.isFile()) {
                    const bytes = readFileSync(path);
                    if (bytes.includes(PDF_CANARY) || bytes.includes(SOURCE_CANARY))
                        hits.push(path);
                }
            } catch {
                // Gone meanwhile (the browser's own temporary files).
            }
        }
    };
    scanDisk(profile!);
    expect(hits).toEqual([]);
    // Last, once nothing was found anywhere: the scanner finds what it looks for (planted after the disk scan,
    // which a database's own log on disk would otherwise trip): the PDF's bytes planted in IndexedDB and the private file system.
    await page.evaluate(
        async (bytes) => {
            const planted = new Uint8Array(bytes);
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.open('hushos-canary-probe');
                request.onupgradeneeded = () => request.result.createObjectStore('probe');
                request.onsuccess = () => {
                    const tx = request.result.transaction('probe', 'readwrite');
                    tx.objectStore('probe').put({ bytes: planted }, 'one');
                    tx.oncomplete = () => (request.result.close(), resolve());
                    tx.onerror = () => reject(tx.error);
                };
                request.onerror = () => reject(request.error);
            });
            const root = await navigator.storage.getDirectory().catch(() => null);
            if (root) {
                const writable = await (
                    await root.getFileHandle('canary-probe', { create: true })
                ).createWritable();
                await writable.write(planted);
                await writable.close();
            }
        },
        [...PDF_CANARY],
    );
    const planted = await scan();
    expect(planted).toContain('idb hushos-canary-probe/probe');
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            const request = indexedDB.deleteDatabase('hushos-canary-probe');
            request.onsuccess = request.onerror = request.onblocked = resolve;
        });
        const root = await navigator.storage.getDirectory().catch(() => null);
        await root?.removeEntry('canary-probe').catch(() => {});
    });
});
