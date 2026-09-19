import { unzipSync } from 'fflate';

/*
 * Office documents, rendered on the device from the decrypted bytes: Word as
 * a sanitised document, spreadsheets as tables, presentations as a text
 * outline, since nothing lays out a slide faithfully in a browser without
 * the fonts and the software that made it. Everything here is pure and works
 * on bytes; the viewer decides what to show.
 */

export type OfficeKind = 'docx' | 'sheet' | 'slides';

const DOCX = new Set(['docx', 'docm', 'dotx']);
const SHEET = new Set(['xlsx', 'xlsm', 'xls', 'ods', 'numbers', 'csv', 'tsv']);
const SLIDES = new Set(['pptx', 'pptm', 'potx']);
const MIME: Record<string, OfficeKind> = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'sheet',
    'application/vnd.ms-excel': 'sheet',
    'application/vnd.oasis.opendocument.spreadsheet': 'sheet',
    'text/csv': 'sheet',
    'text/tab-separated-values': 'sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'slides',
};

export function officeKind(name: string, mime: string | null): OfficeKind | null {
    const lower = (mime ?? '').toLowerCase();
    if (MIME[lower]) return MIME[lower];
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (DOCX.has(ext)) return 'docx';
    if (SHEET.has(ext)) return 'sheet';
    if (SLIDES.has(ext)) return 'slides';
    return null;
}

export const OFFICE_LIMIT = 32 * 1024 * 1024;

export type Slide = { number: number; title: string | null; paragraphs: string[] };

/*
 * A presentation's text, slide by slide in presentation order: the text runs
 * of each shape joined into paragraphs, the first title-placeholder shape as
 * the title. Layout, images and speaker notes are not part of it.
 */
export function slideOutline(bytes: Uint8Array): Slide[] {
    const files = unzipSync(bytes, {
        filter: (file) => /^ppt\/slides\/slide\d+\.xml$/.test(file.name),
    });
    const order = Object.keys(files)
        .map((name) => ({ name, number: Number(/slide(\d+)\.xml$/.exec(name)![1]) }))
        .sort((a, b) => a.number - b.number);
    const parser = new DOMParser();
    return order.map(({ name, number }) => {
        const xml = parser.parseFromString(
            new TextDecoder().decode(files[name]!),
            'application/xml',
        );
        const shapes = Array.from(xml.getElementsByTagNameNS('*', 'sp'));
        let title: string | null = null;
        const paragraphs: string[] = [];
        for (const shape of shapes) {
            const placeholder = shape.getElementsByTagNameNS('*', 'ph')[0]?.getAttribute('type');
            const lines = Array.from(shape.getElementsByTagNameNS('*', 'p'))
                .map((p) =>
                    Array.from(p.getElementsByTagNameNS('*', 't'))
                        .map((t) => t.textContent ?? '')
                        .join('')
                        .trim(),
                )
                .filter(Boolean);
            if (!lines.length) continue;
            if (title === null && (placeholder === 'title' || placeholder === 'ctrTitle'))
                title = lines.join(' ');
            else paragraphs.push(...lines);
        }
        return { number, title, paragraphs };
    });
}

/*
 * What SheetJS should read: a packaged workbook (zip or compound file) as
 * bytes, anything else as text decoded here as UTF-8, so a CSV with accents
 * comes out right rather than as whatever code page the reader guesses.
 */
export function sheetSource(
    bytes: Uint8Array,
): { type: 'array'; data: Uint8Array } | { type: 'string'; data: string } {
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const compound = bytes[0] === 0xd0 && bytes[1] === 0xcf;
    if (zip || compound) return { type: 'array', data: bytes };
    return { type: 'string', data: new TextDecoder().decode(bytes) };
}

export const SHEET_ROWS = 500;
export const SHEET_COLS = 50;

/* A sheet's cells as strings, cut to what a page can show, with what was left out counted. */
export function clipSheet(rows: unknown[][]) {
    const height = rows.length;
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const cells = rows.slice(0, SHEET_ROWS).map((row) => {
        const out: string[] = [];
        for (let c = 0; c < Math.min(width, SHEET_COLS); c++) {
            const value = row[c];
            out.push(
                value === null || value === undefined
                    ? ''
                    : value instanceof Date
                      ? value.toISOString().slice(0, 10)
                      : typeof value === 'object'
                        ? JSON.stringify(value)
                        : String(value as string | number | boolean | bigint),
            );
        }
        return out;
    });
    return {
        cells,
        width: Math.min(width, SHEET_COLS),
        moreRows: Math.max(0, height - SHEET_ROWS),
        moreCols: Math.max(0, width - SHEET_COLS),
    };
}
