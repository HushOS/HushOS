import { deflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, registerAccount } from './helpers';

/*
 * Not a test: the screenshots for the app manifest and the marketing pages,
 * taken from a fresh account with real-looking files, so they never show
 * anyone's data. Run on demand with `SCREENSHOTS=1 bunx playwright test
 * e2e/screenshots.spec.ts --project=chromium`; the suite skips it otherwise.
 * Output lands in apps/web/public/screenshots.
 */

test.skip(!process.env.SCREENSHOTS, 'Screenshots are taken on demand.');
test.describe.configure({ mode: 'serial' });

const OUT = 'apps/web/public/screenshots';
const row = (p: Page, name: string) =>
    p.locator('[data-node-id]').filter({ has: p.getByText(name, { exact: true }) });
const dialog = (p: Page) => p.locator('[data-slot=dialog-content]');

/* A soft two-colour gradient with a horizon, enough for a thumbnail to look like a photo. */
function gradientPng(
    width: number,
    height: number,
    top: [number, number, number],
    bottom: [number, number, number],
    horizon = 0.62,
) {
    const stride = width * 3 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        raw[y * stride] = 0;
        const t = y / height;
        const mix = t < horizon ? t / horizon : 1;
        const shade = t < horizon ? 1 : 0.55 + 0.45 * ((1 - t) / (1 - horizon));
        for (let x = 0; x < width; x++) {
            const offset = y * stride + 1 + x * 3;
            const wave = t < horizon ? 0 : Math.sin(x / 23 + y / 7) * 6;
            raw[offset] = Math.round((top[0] + (bottom[0] - top[0]) * mix) * shade + wave);
            raw[offset + 1] = Math.round((top[1] + (bottom[1] - top[1]) * mix) * shade + wave);
            raw[offset + 2] = Math.round((top[2] + (bottom[2] - top[2]) * mix) * shade + wave);
        }
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc32 = (buf: Buffer) => {
        let c = 0xffffffff;
        for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/* A one-page PDF with a title and a few lines, valid enough for any reader. */
function simplePdf(title: string, lines: string[]) {
    const text = [
        'BT',
        '/F1 22 Tf',
        '72 740 Td',
        `(${title}) Tj`,
        '/F1 12 Tf',
        '0 -36 Td',
        ...lines.flatMap((line) => [`(${line}) Tj`, '0 -18 Td']),
        'ET',
    ].join('\n');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(Buffer.byteLength(out));
        out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return out;
}

function fixtures() {
    const dir = mkdtempSync(join(tmpdir(), 'hushos-shots-'));
    const write = (name: string, bytes: Buffer | string) => {
        const path = join(dir, name);
        writeFileSync(path, bytes);
        return path;
    };
    return {
        readingList: write(
            'Reading list.md',
            '# Reading list\n\nBooks to get through before the year is out.\n\n## Fiction\n\n- *The Remains of the Day*, Kazuo Ishiguro\n- *Piranesi*, Susanna Clarke\n- *Small Things Like These*, Claire Keegan\n\n## To understand things better\n\n- *The Age of Surveillance Capitalism*, Shoshana Zuboff\n- *Thinking, Fast and Slow*, Daniel Kahneman\n\n## Lent out\n\n| Book | To | Since |\n| --- | --- | --- |\n| *Pachinko* | Sam | March |\n| *Normal People* | Priya | June |\n',
        ),
        lease: write(
            'Lease agreement.pdf',
            simplePdf('Residential lease agreement', [
                'Flat 3, 14 Rua das Flores, Lisbon',
                'Term: 1 October 2026 to 30 September 2027',
                'Rent: 1,150 EUR per month, due on the first',
                'Deposit: two months, held in escrow',
                'Signed by both parties on 12 September 2026',
            ]),
        ),
        budget: write(
            'Budget 2026.csv',
            'Month,Rent,Groceries,Transport,Savings\nJanuary,1150,412,86,400\nFebruary,1150,388,79,400\nMarch,1150,431,92,450\nApril,1150,405,88,450\nMay,1150,398,84,500\nJune,1150,442,95,500\n',
        ),
        lasagne: write(
            "Grandma's lasagne.md",
            "# Grandma's lasagne\n\nServes six, or four if one of them is Uncle Tomas.\n\n## Ragù\n\n- 500 g beef mince\n- 1 onion, 1 carrot, 1 stick of celery, all diced small\n- 400 g tinned tomatoes\n- A glass of red wine\n- Two hours on the lowest heat. Do not rush this part.\n\n## Assembly\n\nBéchamel, ragù, pasta, repeat. Parmesan on top. 40 minutes at 180 °C, then ten minutes standing before you cut it.\n",
        ),
        trip: write(
            'Trip plan.md',
            '# Lisbon, 3 to 9 October\n\n## Flights\n\n- Out: Thursday 07:40, arrive 10:15\n- Back: Wednesday 18:30\n\n## Days\n\n1. Alfama and the castle\n2. Belém: the tower, the monastery, and the pastéis\n3. Sintra by train\n4. Free day; LX Factory in the evening\n5. Cascais by the coast road\n',
        ),
        belem: write(
            'Belém at sunset.png',
            gradientPng(960, 640, [252, 176, 96], [86, 52, 92], 0.6),
        ),
        tram: write('Tram 28.png', gradientPng(960, 640, [142, 196, 232], [200, 168, 120], 0.55)),
        alfama: write(
            'Tiles in Alfama.png',
            gradientPng(960, 640, [60, 110, 168], [230, 220, 200], 0.45),
        ),
        sintra: write(
            'Sintra palace.png',
            gradientPng(960, 640, [120, 160, 120], [244, 208, 88], 0.5),
        ),
        report: write(
            'Q3 report.md',
            '# Q3 report\n\n## Summary\n\nRevenue grew in every region. Costs held flat. Two hires start in October.\n\n## Numbers\n\n| Region | Q2 | Q3 |\n| --- | --- | --- |\n| North | 1,200 | 1,480 |\n| South | 3,400 | 3,910 |\n| East | 900 | 1,050 |\n',
        ),
        figures: write(
            'Figures.csv',
            'Region,Q2,Q3\nNorth,1200,1480\nSouth,3400,3910\nEast,900,1050\n',
        ),
    };
}

let page: Page;
let files: ReturnType<typeof fixtures>;
let email: string;

/*
 * A new browser context carries the session cookie but not the device key, so
 * the app asks for the password again: the unlock form on this device, or the
 * sign-in form when the remembered email did not come along either.
 */
async function signInAgain(p: Page) {
    await p.goto('/app', { waitUntil: 'networkidle' });
    const password = p.locator('input[autocomplete=current-password]');
    await expect(password).toBeVisible({ timeout: 60_000 });
    const emailField = p.getByRole('textbox', { name: /email/i });
    if ((await emailField.count()) && !(await emailField.inputValue()))
        await emailField.fill(email);
    await password.fill(PASSWORD);
    await password.press('Enter');
    await expect(row(p, 'Family')).toBeVisible({ timeout: 60_000 });
}

async function newFolder(p: Page, path: string) {
    await p
        .getByRole('button', { name: /new folder/i })
        .first()
        .click();
    await p.getByPlaceholder('Reports/2026').fill(path);
    await p.keyboard.press('Enter');
    await expect(dialog(p)).toHaveCount(0);
}
async function upload(p: Page, paths: string[], last: string) {
    await p.locator('input[type=file]').first().setInputFiles(paths);
    await expect(row(p, last)).toBeVisible({ timeout: 90_000 });
    await expect(p.getByText(/Uploading/)).toHaveCount(0, { timeout: 90_000 });
}
async function settle(p: Page) {
    const clear = p.getByRole('button', { name: 'Clear finished' });
    if (await clear.count()) await clear.click();
    await p.mouse.move(0, 0);
    await p.waitForTimeout(600);
}
async function into(p: Page, name: string) {
    await row(p, name).getByRole('link', { name }).click();
    await expect(p).toHaveURL(/\/app\/f\//);
    await expect(p.locator('nav[aria-label=breadcrumb] li').last()).toHaveText(name);
}
async function up(p: Page) {
    await p.locator('[data-crumb-id]').first().click();
    await expect(p).toHaveURL(/\/app\/?$/);
    await expect(row(p, 'Family')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    files = fixtures();
    page = await (
        await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    ).newPage();
    // A fresh account each run; the address is unique in the part the sidebar truncates.
    ({ email } = await registerAccount(
        page,
        'Maya Lindqvist',
        `maya.lindqvist@mail-${Date.now().toString(36)}.example.com`,
    ));
    await newFolder(page, 'Family/Lisbon 2026');
    await newFolder(page, 'Finances');
    await newFolder(page, 'Recipes');
    await newFolder(page, 'Work/Q3 planning');
    await upload(page, [files.readingList, files.lease, files.trip], 'Trip plan.md');
    await into(page, 'Family');
    await into(page, 'Lisbon 2026');
    await upload(page, [files.belem, files.tram, files.alfama, files.sintra], 'Sintra palace.png');
    await expect(row(page, 'Belém at sunset.png').locator('img')).toBeVisible({ timeout: 60_000 });
    await up(page);
    await into(page, 'Finances');
    await upload(page, [files.budget], 'Budget 2026.csv');
    await up(page);
    await into(page, 'Recipes');
    await upload(page, [files.lasagne], "Grandma's lasagne.md");
    await up(page);
    await into(page, 'Work');
    await into(page, 'Q3 planning');
    await upload(page, [files.report, files.figures], 'Figures.csv');
    await up(page);
});
test.afterAll(async () => {
    await page.context().close();
});

/* Every screenshot in one theme; called twice, since each has a dark twin. */
async function wideShots(p: Page, suffix: string) {
    await settle(p);
    await p.screenshot({ path: `${OUT}/drive-wide${suffix}.png` });

    await into(p, 'Family');
    await into(p, 'Lisbon 2026');
    const grid = p.getByRole('button', { name: /show as grid/i });
    if (await grid.count()) await grid.click();
    await expect(row(p, 'Belém at sunset.png').locator('img')).toBeVisible({ timeout: 60_000 });
    await settle(p);
    await p.screenshot({ path: `${OUT}/drive-grid${suffix}.png` });
    await p.getByRole('button', { name: /show as list/i }).click();
    await up(p);

    await row(p, 'Reading list.md').getByRole('link', { name: 'Reading list.md' }).click();
    await expect(dialog(p).getByRole('heading', { name: 'Reading list' })).toBeVisible({
        timeout: 60_000,
    });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/preview${suffix}.png` });
    await p.keyboard.press('Escape');
    await expect(dialog(p)).toHaveCount(0);

    // The share dialog with a fresh link and its QR code is taller than the drive frame.
    await p.setViewportSize({ width: 1280, height: 1040 });
    await row(p, 'Family').locator('button').first().click();
    await p.getByRole('button', { name: 'Share', exact: true }).click();
    await dialog(p).getByRole('button', { name: 'Create link' }).click();
    await expect(dialog(p).locator('button[aria-label="Copy Link"]')).toBeVisible();
    // The link carries this page's origin; the picture should show the hosted one.
    await p.evaluate(() => {
        const walker = document.createTreeWalker(
            document.querySelector('[data-slot=dialog-content]')!,
            NodeFilter.SHOW_TEXT,
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode())
            if (node.textContent?.includes(window.location.origin))
                node.textContent = node.textContent.replaceAll(
                    window.location.origin,
                    'https://hushos.com',
                );
    });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/share${suffix}.png` });
    await p.keyboard.press('Escape');
    await expect(dialog(p)).toHaveCount(0);
    await p.setViewportSize({ width: 1280, height: 800 });
}

async function phoneShots(p: Page, suffix: string) {
    await signInAgain(p);
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${OUT}/drive-narrow${suffix}.png` });
    await into(p, 'Family');
    await into(p, 'Lisbon 2026');
    const grid = p.getByRole('button', { name: /show as grid/i });
    if (await grid.count()) await grid.click();
    await expect(row(p, 'Belém at sunset.png').locator('img')).toBeVisible({ timeout: 60_000 });
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${OUT}/phone-grid${suffix}.png` });
}

test('the wide screenshots, light and dark', async ({ browser }) => {
    test.setTimeout(600_000);
    await wideShots(page, '');
    const dark = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
        storageState: await page.context().storageState(),
    });
    const p = await dark.newPage();
    await signInAgain(p);
    await wideShots(p, '-dark');
    await dark.close();
});

test('the phone screenshots, light and dark', async ({ browser }) => {
    test.setTimeout(600_000);
    for (const [suffix, colorScheme] of [
        ['', 'light'],
        ['-dark', 'dark'],
    ] as const) {
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            colorScheme,
            storageState: await page.context().storageState(),
        });
        await phoneShots(await context.newPage(), suffix);
        await context.close();
    }
});
