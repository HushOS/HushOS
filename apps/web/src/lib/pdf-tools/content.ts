import {
    decodePDFRawStream,
    PDFArray,
    PDFDict,
    PDFName,
    PDFRawStream,
    PDFRef,
    type PDFContext,
    type PDFObject,
} from '@cantoo/pdf-lib';

/*
 * The resources a page's drawing names (docs/file-tools-design.md, feature (c), "After the second
 * review"), so a copied page carries only those: a page that shares one /Resources with pages left
 * out never brings their scans along. The core's twin is `scan_content` and `pruned_resources` in
 * crates/hushos-core/src/tools/pdf_tools.rs; both are held to the same fixture (`scans.pdf`) and the
 * same rules.
 */

/* Resource categories a content stream names. */
export const CATEGORIES = [
    'Font',
    'XObject',
    'ExtGState',
    'ColorSpace',
    'Pattern',
    'Shading',
    'Properties',
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Used = Map<Category, Set<string>>;

/* Content streams scanned for one page, forms and glyphs included, before it is damage; and their bytes. */
const SCANNED_STREAMS_MAX = 4_096;
const SCANNED_BYTES_MAX = 64 * 1024 * 1024;

/* A content stream that can't be decoded: the page is refused rather than copied with everything. */
export class Unreadable extends Error {}

const space = (byte: number) =>
    byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a || byte === 0x0c || byte === 0;
const delimiter = (byte: number) => '()<>[]{}/%'.includes(String.fromCharCode(byte));
const DEVICE = new Set([
    'DeviceGray',
    'DeviceRGB',
    'DeviceCMYK',
    'Pattern',
    'G',
    'RGB',
    'CMYK',
    'I',
    'Indexed',
]);

/* A name's text, its #xx escapes decoded, bytes as code points; `at` is just past the slash. */
function readName(data: Uint8Array, start: number): [string, number] {
    let name = '';
    let at = start;
    while (at < data.length && !space(data[at]!) && !delimiter(data[at]!)) {
        if (data[at] === 0x23 && at + 2 < data.length) {
            const value = parseInt(String.fromCharCode(data[at + 1]!, data[at + 2]!), 16);
            if (!Number.isNaN(value)) {
                name += String.fromCharCode(value);
                at += 3;
                continue;
            }
        }
        name += String.fromCharCode(data[at]!);
        at++;
    }
    return [name, at];
}

/*
 * Every resource name a content stream uses: Do (XObject), Tf (Font), gs (ExtGState), sh (Shading),
 * cs/CS (ColorSpace), scn/SCN with a name (Pattern), BDC/DP with a named property list (Properties),
 * and an inline image's /CS. Strings, arrays, dictionaries and inline image data are skipped whole.
 */
export function usedNames(data: Uint8Array, used: Used = new Map()) {
    const add = (category: Category, name: string) => {
        let names = used.get(category);
        if (!names) used.set(category, (names = new Set()));
        names.add(name);
    };
    type Operand = { name: string } | null;
    let operands: Operand[] = [];
    let depth = 0;
    let at = 0;
    const lastName = (back: number) => operands[operands.length - back]?.name ?? null;
    const push = (operand: Operand) => {
        if (depth === 0) operands.push(operand);
    };
    while (at < data.length) {
        const byte = data[at]!;
        if (space(byte)) {
            at++;
            continue;
        }
        if (byte === 0x25) {
            while (at < data.length && data[at] !== 0x0a && data[at] !== 0x0d) at++;
        } else if (byte === 0x2f) {
            const [name, end] = readName(data, at + 1);
            at = end;
            push({ name });
        } else if (byte === 0x28) {
            let nesting = 0;
            while (at < data.length) {
                const c = data[at]!;
                if (c === 0x5c) at++;
                else if (c === 0x28) nesting++;
                else if (c === 0x29 && --nesting === 0) {
                    at++;
                    break;
                }
                at++;
            }
            push(null);
        } else if (byte === 0x3c && data[at + 1] === 0x3c) {
            depth++;
            at += 2;
        } else if (byte === 0x3e && data[at + 1] === 0x3e) {
            depth = Math.max(0, depth - 1);
            at += 2;
            push(null);
        } else if (byte === 0x3c) {
            while (at < data.length && data[at] !== 0x3e) at++;
            at++;
            push(null);
        } else if (byte === 0x5b) {
            depth++;
            at++;
        } else if (byte === 0x5d) {
            depth = Math.max(0, depth - 1);
            at++;
            push(null);
        } else if (delimiter(byte)) {
            at++;
        } else {
            const start = at;
            while (at < data.length && !space(data[at]!) && !delimiter(data[at]!)) at++;
            if (depth > 0) continue;
            const word = String.fromCharCode(...data.subarray(start, at));
            if (/^[0-9+\-.]/.test(word) || word === 'true' || word === 'false' || word === 'null') {
                operands.push(null);
                continue;
            }
            const last = lastName(1);
            switch (word) {
                case 'Do':
                    if (last) add('XObject', last);
                    break;
                case 'Tf': {
                    const font = lastName(2);
                    if (font) add('Font', font);
                    break;
                }
                case 'gs':
                    if (last) add('ExtGState', last);
                    break;
                case 'sh':
                    if (last) add('Shading', last);
                    break;
                case 'cs':
                case 'CS':
                    if (last && !DEVICE.has(last)) add('ColorSpace', last);
                    break;
                case 'scn':
                case 'SCN':
                    if (last) add('Pattern', last);
                    break;
                case 'BDC':
                case 'DP':
                    // A tag, then a property list: named when it is a resource.
                    if (operands.length >= 2 && last) add('Properties', last);
                    break;
                case 'BI':
                    at = inlineImage(data, at, (name) => add('ColorSpace', name));
                    break;
            }
            operands = [];
        }
    }
    return used;
}

/* An inline image from just after BI: its colour space when named, and where its data ends (after EI). */
function inlineImage(data: Uint8Array, start: number, colourSpace: (name: string) => void) {
    let at = start;
    let key: string | null = null;
    for (;;) {
        while (at < data.length && space(data[at]!)) at++;
        if (at >= data.length) return at;
        if (data[at] === 0x2f) {
            const [name, end] = readName(data, at + 1);
            at = end;
            if (key === null) key = name;
            else {
                if ((key === 'CS' || key === 'ColorSpace') && !DEVICE.has(name)) colourSpace(name);
                key = null;
            }
            continue;
        }
        const begin = at;
        while (at < data.length && !space(data[at]!) && !delimiter(data[at]!)) at++;
        if (at === begin) at++;
        if (String.fromCharCode(...data.subarray(begin, at)) === 'ID') break;
        key = null;
    }
    at++;
    while (at + 2 <= data.length) {
        if (
            data[at] === 0x45 &&
            data[at + 1] === 0x49 &&
            at > 0 &&
            space(data[at - 1]!) &&
            (at + 2 === data.length || space(data[at + 2]!))
        )
            return at + 2;
        at++;
    }
    return data.length;
}

/*
 * The page's resources cut down to what its drawing names: its content streams, the forms and tiling
 * patterns they draw that have no resources of their own, and the glyphs of Type 3 fonts without their
 * own. Throws Unreadable when a content stream can't be decoded: copying everything would carry pages
 * left out, so the page is refused instead.
 */
export function prunedResources(
    context: PDFContext,
    resources: PDFObject,
    contents: PDFObject | undefined,
): PDFObject {
    const dict = resources instanceof PDFRef ? context.lookup(resources) : resources;
    if (!(dict instanceof PDFDict)) return resources;
    const used: Used = new Map();
    const seen = new Set<string>();
    let left = SCANNED_BYTES_MAX;
    let scanned = 0;
    const scan = (stream: PDFObject | undefined) => {
        if (!(stream instanceof PDFRawStream)) throw new Unreadable();
        if (++scanned > SCANNED_STREAMS_MAX) throw new Unreadable();
        let data: Uint8Array;
        try {
            data = decodePDFRawStream(stream).decode();
        } catch {
            throw new Unreadable();
        }
        left -= data.length;
        if (left < 0) throw new Unreadable();
        usedNames(data, used);
    };
    const queue: PDFObject[] = [];
    const items = contents instanceof PDFRef ? context.lookup(contents) : contents;
    if (contents instanceof PDFRef && !(items instanceof PDFArray)) queue.push(contents);
    else if (items instanceof PDFArray) queue.push(...items.asArray());
    else if (items) queue.push(items);
    const lookup = (category: Category) => {
        const value = dict.get(PDFName.of(category));
        const resolved = value instanceof PDFRef ? context.lookup(value) : value;
        return resolved instanceof PDFDict ? resolved : null;
    };
    for (;;) {
        while (queue.length) {
            const next = queue.pop()!;
            if (next instanceof PDFRef) {
                const key = `${next.objectNumber} ${next.generationNumber}`;
                if (seen.has(key)) continue;
                seen.add(key);
                scan(context.lookup(next));
            } else scan(next);
        }
        for (const category of ['XObject', 'Pattern', 'Font'] as const) {
            const entries = lookup(category);
            for (const name of used.get(category) ?? []) {
                const ref = entries?.get(PDFName.of(name));
                if (
                    !(ref instanceof PDFRef) ||
                    seen.has(`${ref.objectNumber} ${ref.generationNumber}`)
                )
                    continue;
                const target = context.lookup(ref);
                if (target instanceof PDFRawStream && !target.dict.has(PDFName.of('Resources')))
                    queue.push(ref);
                else if (
                    target instanceof PDFDict &&
                    target.get(PDFName.of('Subtype')) === PDFName.of('Type3') &&
                    !target.has(PDFName.of('Resources'))
                ) {
                    const procs = target.get(PDFName.of('CharProcs'));
                    const glyphs = procs instanceof PDFRef ? context.lookup(procs) : procs;
                    if (glyphs instanceof PDFDict)
                        for (const [, glyph] of glyphs.entries())
                            if (glyph instanceof PDFRef) queue.push(glyph);
                    seen.add(`${ref.objectNumber} ${ref.generationNumber}`);
                }
            }
        }
        if (!queue.length) break;
    }
    const kept = PDFDict.withContext(context);
    for (const [key, value] of dict.entries()) {
        const category = CATEGORIES.find((each) => key === PDFName.of(each));
        if (!category) {
            kept.set(key, value);
            continue;
        }
        const entries = lookup(category);
        if (!entries) continue;
        const only = PDFDict.withContext(context);
        for (const [name, entry] of entries.entries())
            if (used.get(category)?.has(name.decodeText())) only.set(name, entry);
        if (only.entries().length) kept.set(key, only);
    }
    return kept;
}
