import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { grip, newPage, registerAccount } from './helpers';

/*
 * A file's type is whatever the uploader's client recorded, and a preview's URL can be opened
 * in a tab of its own. "notes.wav" recorded as text/html once played through the media worker
 * as an HTML page on this origin, with no script policy: the tab could read the viewer's keys.
 * Previews now hand the browser the recorded type only when it is the kind being shown. This
 * holds that, and holds the real thing: a video, audio past the worker's 16 MB line, an image
 * and an SVG still open and play.
 */

test.describe.configure({ mode: 'serial' });

let page: Page;
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });

/* Past PREVIEW_LIMITS.media (16 MB): played through the download worker, not a blob. */
const LARGE = 17 * 1024 * 1024;
const fixture = (...parts: string[]) =>
    readFileSync(join(import.meta.dirname, 'fixtures', ...parts));

/* A 440 Hz tone as 16-bit mono PCM WAV, at least `bytes` long. */
function tone(bytes: number) {
    const rate = 44_100;
    const samples = Math.ceil(Math.max(bytes - 44, 2) / 2);
    const out = Buffer.alloc(44 + samples * 2);
    out.write('RIFF', 0);
    out.writeUInt32LE(36 + samples * 2, 4);
    out.write('WAVEfmt ', 8);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(1, 22);
    out.writeUInt32LE(rate, 24);
    out.writeUInt32LE(rate * 2, 28);
    out.writeUInt16LE(2, 32);
    out.writeUInt16LE(16, 34);
    out.write('data', 36);
    out.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++)
        out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
    return out;
}

/* A page that marks the tab if it ever runs, padded to `bytes`. */
function fakePage(bytes: number) {
    const head = '<!doctype html><title>quiet</title><script>document.title = "ran";</script><!--';
    const tail = '-->';
    return Buffer.from(head + ' '.repeat(Math.max(0, bytes - head.length - tail.length)) + tail);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#2c428e"/></svg>`;

test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    page = await newPage(browser);
    await registerAccount(page);
    await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([
            { name: 'clip.webm', mimeType: 'video/webm', buffer: fixture('media', 'clip.webm') },
            { name: 'short.wav', mimeType: 'audio/wav', buffer: tone(64 * 1024) },
            { name: 'long.wav', mimeType: 'audio/wav', buffer: tone(LARGE) },
            { name: 'coast.jpg', mimeType: 'image/jpeg', buffer: fixture('photos', 'coast.jpg') },
            { name: 'mark.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) },
            { name: 'small.wav', mimeType: 'text/html', buffer: fakePage(4 * 1024) },
            { name: 'notes.wav', mimeType: 'text/html', buffer: fakePage(LARGE) },
        ]);
    await expect(page.locator('[data-node-id]')).toHaveCount(7, { timeout: 180_000 });
});
test.afterAll(async () => {
    await page.close();
});

async function open(name: string) {
    await row(page, name).locator('button').first().dblclick(grip);
    await expect(dialog(page)).toContainText(name);
}
async function close() {
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
}

/* The download worker's player page for the open preview, once it has loaded. */
async function playerFrame() {
    await expect(dialog(page).locator('iframe')).toHaveCount(1, { timeout: 60_000 });
    await expect
        .poll(() => page.frames().some((f) => f.url().includes('/hushos-download/player/')))
        .toBe(true);
    return page.frames().find((f) => f.url().includes('/hushos-download/player/'))!;
}

test('a real video plays in the preview', async () => {
    await open('clip.webm');
    const video = dialog(page).locator('video');
    await expect(video).toHaveCount(1, { timeout: 60_000 });
    await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.error])).toEqual([
        160,
        null,
    ]);
    await close();
});

test('real audio plays, as a blob and past 16 MB through the worker', async () => {
    await open('short.wav');
    const audio = dialog(page).locator('audio');
    await expect(audio).toHaveCount(1, { timeout: 60_000 });
    await expect
        .poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(1);
    expect(await audio.evaluate((a: HTMLAudioElement) => a.error)).toBeNull();
    await close();

    await open('long.wav');
    const frame = await playerFrame();
    await expect
        .poll(() => frame.evaluate(() => document.querySelector('audio')?.readyState ?? 0), {
            timeout: 60_000,
        })
        .toBeGreaterThanOrEqual(1);
    // 17 MB of 16-bit mono at 44.1 kHz is about 202 seconds.
    expect(
        await frame.evaluate(() => Math.round(document.querySelector('audio')!.duration)),
    ).toBeGreaterThan(200);
    // Its media URL opened in a tab of its own: still audio, played by the browser's own page.
    const src = await frame.evaluate(() => document.querySelector('audio')!.src);
    const tab = await page.context().newPage();
    const response = await tab.goto(src);
    expect(response?.headers()['content-type']).toBe('audio/wav');
    // And it plays there: the browser's player page may load it under the worker's policy.
    await expect
        .poll(
            () =>
                tab.evaluate(
                    () => document.querySelector<HTMLMediaElement>('video, audio')?.readyState ?? 0,
                ),
            {
                timeout: 30_000,
            },
        )
        .toBeGreaterThanOrEqual(1);
    await tab.close();
    await close();
});

test('an image and an SVG still show', async () => {
    for (const name of ['coast.jpg', 'mark.svg']) {
        await open(name);
        const image = dialog(page).locator('img').first();
        await expect
            .poll(() => image.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), {
                timeout: 30_000,
            })
            .toBeGreaterThan(0);
        await close();
    }
});

test('a small file recorded as a page is handed over as neither', async ({ browserName }) => {
    await open('small.wav');
    const audio = dialog(page).locator('audio');
    await expect(audio).toHaveCount(1, { timeout: 60_000 });
    const src = await audio.evaluate((a: HTMLAudioElement) => a.src);
    expect(src.startsWith('blob:')).toBe(true);
    // Opened in a tab of its own: never a page that runs. Chromium saves it as a file; WebKit
    // doesn't open another tab's blob URL at all, so there only the first holds.
    const tab = await page.context().newPage();
    const download = tab.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
    await tab.goto(src).catch(() => {});
    if (browserName === 'chromium') expect(await download).not.toBeNull();
    else await tab.waitForTimeout(1_500);
    expect(await tab.title().catch(() => '')).not.toBe('ran');
    await tab.close();
    await close();
});

test('a large file recorded as a page never runs as one in a tab of its own', async ({
    browserName,
}) => {
    await open('notes.wav');
    const frame = await playerFrame();
    const src = await frame.evaluate(() => document.querySelector('audio')!.src);
    expect(src).toContain('/hushos-download/media/');
    // Opened as "Open audio in new tab" would, in the same browser while the preview is open:
    // the worker answers it as a file to save, never a page to run. Chromium shows that as a
    // download; whatever a browser does with it, the page's script never runs.
    const tab = await page.context().newPage();
    const answered: Record<string, string>[] = [];
    tab.on('response', (response) => {
        if (response.url() === src) answered.push(response.headers());
    });
    const download = tab.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
    await tab.goto(src).catch(() => {});
    if (browserName === 'chromium') expect(await download).not.toBeNull();
    else await tab.waitForTimeout(1_500);
    expect(await tab.title().catch(() => '')).not.toBe('ran');
    if (answered[0]) {
        expect(answered[0]['content-type']).toBe('application/octet-stream');
        expect(answered[0]['content-security-policy']).toContain('sandbox');
    }
    await tab.close();
    await close();
});
