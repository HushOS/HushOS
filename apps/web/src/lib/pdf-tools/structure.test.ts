// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFName } from '@cantoo/pdf-lib';
import { describe, expect, test } from 'vitest';
import expected from '../../../../../e2e/fixtures/pdfs/expected.json';
import { buildPdf, PdfRefused, readPdf, rotationOf, type SourcePdf } from './structure';
import { pdfPages } from './pdf-reader.testkit';
import type { Rotation } from './protocol';

/*
 * The web's PDF engine (pdf-lib) against e2e/fixtures/pdfs, whose expected.json make.py worked out
 * from what it wrote, not from either engine; the core's lopdf twin is held to the same file. Every
 * output is read back three ways: by this engine, by pdf.js (what a reader shows), and by qpdf's
 * structure check where qpdf is installed.
 */

const FIXTURES = join(__dirname, '../../../../../e2e/fixtures/pdfs');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const text = (value: string) => new TextEncoder().encode(value);
function contains(haystack: Uint8Array, needle: Uint8Array) {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
        return true;
    }
    return false;
}

async function outcome(name: string) {
    try {
        return { ok: true as const, pdf: await readPdf(fixture(name)) };
    } catch (error) {
        if (error instanceof PdfRefused) return { ok: false as const, reason: error.reason };
        throw error;
    }
}

const pageList = (pdf: SourcePdf) => pdf.pages.map((page) => page.info);

/* What pdf.js shows of a PDF: each page's MediaBox size and rotation. */
async function pdfjsPages(bytes: Uint8Array) {
    return (await pdfPages(bytes)).map(({ width, height, rotate }) => ({ width, height, rotate }));
}

const qpdf = (() => {
    try {
        execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

/* qpdf --check over the bytes: exit 0 is clean, 3 is warnings, 2 is errors. */
function qpdfCheck(bytes: Uint8Array) {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-tools-'));
    const file = join(dir, 'out.pdf');
    try {
        writeFileSync(file, bytes);
        execFileSync('qpdf', ['--check', file], { stdio: 'pipe' });
        return 'clean';
    } catch (error) {
        return `qpdf: ${String((error as { stdout?: Buffer }).stdout ?? error)}`;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('reading each fixture as expected.json says', () => {
    for (const file of expected.files) {
        test(file.file, async () => {
            const result = await outcome(file.file);
            if (file.outcome !== 'ok') {
                expect(result).toEqual({ ok: false, reason: file.outcome });
                return;
            }
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(pageList(result.pdf)).toEqual(file.pages);
            expect(result.pdf.flags).toEqual({
                signed: file.signed,
                outline: file.outline,
                form: file.form,
            });
        });
    }
});

describe('building every operation in expected.json', () => {
    for (const operation of expected.operations) {
        test(operation.name, async () => {
            const names = [
                ...new Set(operation.outputs.flatMap((output) => output.pages.map((p) => p.file))),
            ];
            const sources = await Promise.all(names.map((name) => readPdf(fixture(name))));
            for (const output of operation.outputs) {
                const made = await buildPdf(
                    sources,
                    output.pages.map((page) => ({
                        source: names.indexOf(page.file),
                        page: page.page,
                        rotate: page.rotate as Rotation,
                    })),
                );
                // This engine, then pdf.js, read the same pages back.
                expect(pageList(await readPdf(made))).toEqual(output.expected);
                expect(await pdfjsPages(made)).toEqual(output.expected);
                // No document information: neither the source's (its canary) nor pdf-lib's own.
                expect(contains(made, text(expected.infoCanary))).toBe(false);
                for (const key of ['/Info', '/Producer', '/Creator', '/CreationDate', '/ModDate'])
                    expect(contains(made, text(key)), key).toBe(false);
                // Nothing of the source's catalog: no outline, no form, no object streams.
                const flags = (await readPdf(made)).flags;
                expect(flags).toEqual({ signed: false, outline: false, form: false });
                expect(contains(made, text('/ObjStm'))).toBe(false);
                if (qpdf) expect(qpdfCheck(made)).toBe('clean');
            }
        });
    }
});

test('a page copied alone brings no other page of its source with it', async () => {
    // The signed page's widget points back at its page (/P) and the form's field at its parent:
    // copied, those links land on the copy or on nothing, never on a second copy of the source.
    const signed = await readPdf(fixture('signed.pdf'));
    const plain = await readPdf(fixture('plain.pdf'));
    const made = await buildPdf([plain], [{ source: 0, page: 1, rotate: 0 }]);
    // One page's content stream: the other pages' "Page 1" and "Page 3" are not inside.
    expect(contains(made, text('(Page 2)'))).toBe(true);
    expect(contains(made, text('(Page 1)'))).toBe(false);
    expect(contains(made, text('(Page 3)'))).toBe(false);
    const alone = await buildPdf([signed], [{ source: 0, page: 0, rotate: 0 }]);
    expect((await pdfjsPages(alone)).length).toBe(1);
    expect(alone.byteLength).toBeLessThan(fixture('signed.pdf').byteLength * 2);
});

test('a link from one copied page to another lands on the copy of that page', async () => {
    // outline-form's widget on page 1 has /P pointing at page 1 itself.
    const source = await readPdf(fixture('outline-form.pdf'));
    const made = await buildPdf(
        [source],
        [
            { source: 0, page: 1, rotate: 0 },
            { source: 0, page: 0, rotate: 0 },
        ],
    );
    const copy = await readPdf(made);
    const second = copy.pages[1]!;
    const annots = copy.context.lookup(second.leaf.get(PDFName.of('Annots')), PDFArray);
    const widget = annots.lookup(0, PDFDict);
    const target = widget.get(PDFName.of('P'));
    expect(String(target)).toBe(String(second.ref));
});

test('the walk refuses before it parses past the page cap, and too-many-pages is its own refusal', async () => {
    await expect(readPdf(fixture('plain.pdf'), { maxPages: 2 })).rejects.toEqual(
        new PdfRefused('too-many-pages'),
    );
    await expect(readPdf(fixture('plain.pdf'), { maxPages: 3 })).resolves.toBeTruthy();
});

test('an output past the size limit is refused, never handed back', async () => {
    const source = await readPdf(fixture('plain.pdf'));
    await expect(
        buildPdf([source], [{ source: 0, page: 0, rotate: 0 }], { maxBytes: 100 }),
    ).rejects.toEqual(new PdfRefused('too-large'));
});

test('a rotation that is not a whole quarter turn reads as none; negative turns count round', () => {
    expect([90, -90, 450, 180.0, 45, 0.5, Number.NaN, null].map(rotationOf)).toEqual([
        90, 270, 90, 180, 0, 0, 0, 0,
    ]);
});

test('every fixture read carries the canary the end-to-end plaintext checks look for', () => {
    // A fixture that stopped carrying it would make every plaintext check pass over nothing.
    for (const file of expected.files.filter((f) => f.outcome === 'ok'))
        expect(contains(fixture(file.file), text(expected.canary)), file.file).toBe(true);
});
