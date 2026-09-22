import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
    expect,
    test,
    type Browser,
    type BrowserContextOptions,
    type Page,
} from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import * as XLSX from 'xlsx';

/*
 * What every Drive test needs: an account created through the real sign-up
 * flow (the verification link comes out of MailHog), and files on disk with
 * known bytes to upload and compare against after a download.
 */

export const MAILHOG_URL = process.env.E2E_MAILHOG_URL ?? 'http://localhost:8025';
export const PASSWORD = 'correct-horse-battery-staple-9';

/*
 * Where to click a row to select it: the padding before its icon. The name is a
 * link that opens the file, the icon becomes a checkbox once anything is
 * selected, and the name button is only as wide as its content.
 */
export const grip = { position: { x: 16, y: 12 } } as const;

/*
 * Sign-up sends at most twenty verification emails an hour per client address,
 * and a full run registers more accounts than that. The dev server trusts
 * `x-forwarded-for` (TRUSTED_PROXY_HEADER, set by playwright.config.ts and the
 * example .env), so every context gets an address of its own: unique per worker
 * and per context, so parallel workers never share a bucket either.
 */
let contexts = 0;
function clientAddress() {
    const n = ++contexts;
    return `10.${test.info().workerIndex % 256}.${(n >> 8) & 255}.${n & 255}`;
}

export function newContext(browser: Browser, options: BrowserContextOptions = {}) {
    return browser.newContext({
        ...options,
        extraHTTPHeaders: { ...options.extraHTTPHeaders, 'x-forwarded-for': clientAddress() },
    });
}

export async function newPage(browser: Browser, options: BrowserContextOptions = {}) {
    return (await newContext(browser, options)).newPage();
}

type MailhogMessage = { Content: { Body: string; Headers: Record<string, string[]> } };

function decodeQuotedPrintable(text: string) {
    return text
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/* Polls MailHog for the newest verification link sent to `email`. */
export async function verificationLink(email: string, pathPrefix: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const response = await fetch(
            `${MAILHOG_URL}/api/v2/search?kind=to&query=${encodeURIComponent(email)}`,
        );
        const data = (await response.json()) as { items: MailhogMessage[] };
        for (const message of data.items ?? []) {
            const body = decodeQuotedPrintable(message.Content.Body);
            const match = body.match(new RegExp(`https?://[^\\s"'<>]*${pathPrefix}[^\\s"'<>]*`));
            if (match) return match[0].replace(/&amp;/g, '&');
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`No verification email for ${email} arrived in MailHog.`);
}

/* Registers a fresh account and leaves the page on the Drive root, unlocked. */
export async function registerAccount(
    page: Page,
    name = 'E2E Tester',
    email = `e2e-${Date.now()}-${randomBytes(3).toString('hex')}@hushos.local`,
    // `landsOn`: where the finished sign-up should arrive, when it is not an empty Drive.
    options: { viaCurrentPage?: boolean; landsOn?: RegExp } = {},
) {
    // Pages are server rendered; typing before React hydrates is typing into a
    // form that hydration then resets, so wait for the network to settle first.
    // A test that arrived at sign-up with a code in the URL stays on that page.
    if (!options.viaCurrentPage) await page.goto('/register', { waitUntil: 'networkidle' });
    const emailField = page.getByRole('textbox', { name: /email/i });
    await emailField.fill(email);
    await expect(emailField).toHaveValue(email);
    await page.getByRole('checkbox').click();
    await expect(page.getByRole('checkbox')).toBeChecked();
    await page.locator('form button[type=submit]').click();
    await page.waitForURL(/\/register\/check-email/);
    // The URL changes before the router's transition commits; leaving during it
    // (WebKit reports the commit late) reads as one navigation interrupting another,
    // so wait for the page's own title, which only the finished transition draws.
    await expect(page.getByText('Check your inbox')).toBeVisible();
    const link = await verificationLink(email, '/register/complete');
    const url = new URL(link);
    await page.goto(url.pathname + url.search + url.hash, { waitUntil: 'networkidle' });
    await page.locator('input[autocomplete=name]').fill(name);
    await expect(page.locator('input[autocomplete=name]')).toHaveValue(name);
    const passwords = page.locator('input[autocomplete=new-password]');
    await passwords.nth(0).fill(PASSWORD);
    await passwords.nth(1).fill(PASSWORD);
    // Enter submits: the button animates on press, and WebKit on a slow runner
    // never reports it stable enough to click before the hook's budget is gone.
    await passwords.nth(1).press('Enter');
    await page.waitForURL(/\/setup\/recovery-key/, { timeout: 120_000 });
    await page.getByRole('checkbox').click();
    await page.getByRole('button', { name: /continue to hushos/i }).click();
    if (options.landsOn) {
        await page.waitForURL(options.landsOn, { timeout: 60_000 });
        return { email };
    }
    await page.waitForURL(/\/app/);
    await expect(page.getByText('Nothing here yet')).toBeVisible();
    return { email };
}

/* Sample files with known content, written to a temporary directory. */
export function sampleFiles() {
    const dir = mkdtempSync(join(tmpdir(), 'hushos-e2e-'));
    const write = (name: string, bytes: Uint8Array | string) => {
        const path = join(dir, name);
        writeFileSync(path, bytes);
        return path;
    };
    const random = randomBytes(3 * 1024 * 1024 + 777);
    const files = {
        binary: write('payload.bin', random),
        markdown: write(
            'notes.md',
            '# Notes\n\nA [link](https://example.com) and `code`.\n\n```ts\nconst answer: number = 42;\n```\n\n<script>alert(1)</script>\n',
        ),
        code: write(
            'module.ts',
            'export function add(a: number, b: number): number {\n    return a + b;\n}\n',
        ),
        image: write('pixel.png', pngSquare(64, 0x3b, 0x6a, 0xcc)),
        text: write('README', 'plain text without an extension\nsecond line\n'),
        docx: write('memo.docx', minimalDocx('Quarterly memo', 'Revenue grew in every region.')),
        xlsx: write('figures.xlsx', minimalXlsx()),
        // A quoted field with a comma and an accented name, in UTF-8 without a byte-order mark.
        csv: write(
            'cities.csv',
            'city,country,population\n"Porto, Old Town",Portugal,231800\nS\u00e3o Paulo,Brazil,12325232\n',
        ),
        pptx: write('deck.pptx', minimalPptx()),
    };
    return { dir, files, hashes: { binary: sha256(random) } };
}

/* The smallest Word document mammoth accepts: a package with one heading and one paragraph. */
function minimalDocx(heading: string, paragraph: string) {
    const files: Record<string, Uint8Array> = {
        '[Content_Types].xml': strToU8(
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        '_rels/.rels': strToU8(
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ),
        'word/document.xml': strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>`,
        ),
    };
    return zipSync(files);
}

/* A workbook with two sheets, made by the same library the viewer reads it with. */
function minimalXlsx() {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
            ['Region', 'Revenue'],
            ['North', 1200],
            ['South', 3400],
        ]),
        'Figures',
    );
    XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([['Note'], ['Second sheet']]),
        'Notes',
    );
    return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

function minimalPptx() {
    const slide = (title: string, body: string) =>
        `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    return zipSync({
        '[Content_Types].xml': strToU8(
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        ),
        'ppt/slides/slide1.xml': strToU8(slide('Welcome', 'The first slide')),
        'ppt/slides/slide2.xml': strToU8(slide('Plan', 'Ship it')),
    });
}

export function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

/* A solid-colour PNG, built by hand so the suite has no image dependency. */
function pngSquare(size: number, r: number, g: number, b: number) {
    const raw = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 3 + 1)] = 0;
        for (let x = 0; x < size; x++) {
            const offset = y * (size * 3 + 1) + 1 + x * 3;
            raw[offset] = r;
            raw[offset + 1] = g;
            raw[offset + 2] = b;
        }
    }
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body) >>> 0);
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function crc32(buffer: Buffer) {
    let crc = -1;
    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc;
}

/* The subjects of every message MailHog holds for `email`, newest first. */
export async function mailSubjects(email: string) {
    const response = await fetch(
        `${MAILHOG_URL}/api/v2/search?kind=to&query=${encodeURIComponent(email)}`,
    );
    const data = (await response.json()) as { items: MailhogMessage[] };
    return (data.items ?? []).map((message) =>
        decodeHeader(message.Content.Headers.Subject?.[0] ?? ''),
    );
}

/* Mail subjects arrive RFC 2047 encoded ("=?UTF-8?Q?...?="); this undoes the Q form. */
function decodeHeader(value: string) {
    return value
        .replace(/=\?UTF-8\?Q\?([^?]*)\?=/gi, (_, word: string) => {
            const bytes: number[] = [];
            for (const part of word.replaceAll('_', ' ').split(/(=[0-9A-F]{2})/i))
                if (/^=[0-9A-F]{2}$/i.test(part)) bytes.push(parseInt(part.slice(1), 16));
                else for (const char of part) bytes.push(char.charCodeAt(0));
            return new TextDecoder().decode(Uint8Array.from(bytes));
        })
        .replace(/\s+/g, ' ')
        .trim();
}
