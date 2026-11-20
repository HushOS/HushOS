// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { usedNames, type Category } from './content';
import { describe, expect, test, vi } from 'vitest';
import expected from '../../../../../e2e/fixtures/pdfs/expected.json';
import { buildPdf, PdfRefused, readPdf, rotationOf, type SourcePdf } from './structure';
import { pdfLayers, pdfPages } from './pdf-reader.testkit';
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
const layerCount = (pdf: SourcePdf) => ({
    layers: pdf.layers?.groups.length ?? 0,
    hiddenLayers: pdf.layers?.off.size ?? 0,
});

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
            expect(layerCount(result.pdf)).toEqual({
                layers: file.layers,
                hiddenLayers: file.hiddenLayers,
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
                // The image bytes of the pages kept are there; those of the pages left out are not.
                for (const canary of output.present)
                    expect(contains(made, text(canary)), `${canary} missing`).toBe(true);
                for (const canary of output.absent)
                    expect(contains(made, text(canary)), `${canary} carried`).toBe(false);
                // Layers come along, those off still off: by this engine and by pdf.js.
                const layers = { layers: output.layers, hiddenLayers: output.hiddenLayers };
                expect(layerCount(await readPdf(made))).toEqual(layers);
                expect(await pdfLayers(made)).toEqual(layers);
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

test('an output past the size limit is refused as it is copied, before it is ever saved whole', async () => {
    const source = await readPdf(fixture('scans.pdf'));
    const save = vi.spyOn(PDFDocument.prototype, 'save');
    // The first scan's image alone is 20 bytes: a limit below it stops the copy.
    await expect(
        buildPdf([source], [{ source: 0, page: 0, rotate: 0 }], { maxBytes: 100 }),
    ).rejects.toEqual(new PdfRefused('too-large'));
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
});

test('a page whose content can’t be decoded is refused, never copied with every shared resource', async () => {
    const pdf = new TextEncoder().encode(
        [
            '%PDF-1.7',
            '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
            '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 5 0 R /Im2 6 0 R >> >> >> endobj',
            '3 0 obj << /Type /Page /Parent 2 0 R /Contents 7 0 R >> endobj',
            '4 0 obj << /Type /Page /Parent 2 0 R /Contents 8 0 R >> endobj',
            '5 0 obj << /Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\nONE!\nendstream endobj',
            '6 0 obj << /Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\nTWO!\nendstream endobj',
            '7 0 obj << /Filter /JBIG2Decode /Length 7 >>\nstream\n/Im1 Do\nendstream endobj',
            '8 0 obj << /Length 7 >>\nstream\n/Im2 Do\nendstream endobj',
            'trailer << /Root 1 0 R >>',
            '%%EOF',
        ].join('\n'),
    );
    const source = await readPdf(pdf);
    await expect(buildPdf([source], [{ source: 0, page: 0, rotate: 0 }])).rejects.toEqual(
        new PdfRefused('damaged'),
    );
    const made = await buildPdf([source], [{ source: 0, page: 1, rotate: 0 }]);
    expect(contains(made, text('TWO!'))).toBe(true);
    expect(contains(made, text('ONE!'))).toBe(false);
});

test('a content stream names only what it draws, never a name inside a string, array, dictionary or image', () => {
    const used = usedNames(
        text(
            '/F1 12 Tf (not /Im9 Do) Tj [/Im8] TJ /OC << /Im7 1 >> BDC /P1 scn /Sh1 sh /GS1 gs /CS1 cs /DeviceRGB CS ' +
                'q /Im1 Do Q BI /W 1 /H 1 /CS /CS2 /BPC 8 ID \u0000/Im6 Do EI /MC0 BDC EMC',
        ),
    );
    const names = (category: Category) => [...(used.get(category) ?? [])].sort();
    expect(names('XObject')).toEqual(['Im1']);
    expect(names('Font')).toEqual(['F1']);
    expect(names('Pattern')).toEqual(['P1']);
    expect(names('Shading')).toEqual(['Sh1']);
    expect(names('ExtGState')).toEqual(['GS1']);
    expect(names('ColorSpace')).toEqual(['CS1', 'CS2']);
    expect(names('Properties')).toEqual([]);
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
