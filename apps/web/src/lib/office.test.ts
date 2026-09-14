import { zipSync, strToU8 } from 'fflate';
import { describe, expect, test } from 'vitest';
import { clipSheet, officeKind, sheetSource, slideOutline } from './office';

/*
 * The outline must come out in presentation order with titles told apart from
 * body text, whatever order the zip stores the slides in; the sheet clip must
 * say what it dropped. Detection prefers the declared type over the name.
 */

const slide = (title: string | null, ...body: string[]) =>
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${
        title
            ? `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`
            : ''
    }${body
        .map(
            (line) =>
                `<p:sp><p:txBody><a:p><a:r><a:t>${line.slice(0, 3)}</a:t></a:r><a:r><a:t>${line.slice(3)}</a:t></a:r></a:p></p:txBody></p:sp>`,
        )
        .join('')}</p:spTree></p:cSld></p:sld>`;

describe('office', () => {
    test('slides come out in presentation order, titles apart, runs joined', () => {
        const bytes = zipSync({
            'ppt/slides/slide10.xml': strToU8(slide('Ten', 'tenth body')),
            'ppt/slides/slide2.xml': strToU8(slide(null, 'no title here', 'second line')),
            'ppt/slides/slide1.xml': strToU8(slide('Agenda', 'first point')),
            'ppt/notesSlides/notesSlide1.xml': strToU8(
                slide('Notes', 'speaker notes are not shown'),
            ),
            'ppt/slides/_rels/slide1.xml.rels': strToU8('<Relationships/>'),
        });
        const outline = slideOutline(bytes);
        expect(outline.map((s) => s.number)).toEqual([1, 2, 10]);
        expect(outline[0]).toEqual({ number: 1, title: 'Agenda', paragraphs: ['first point'] });
        expect(outline[1]).toEqual({
            number: 2,
            title: null,
            paragraphs: ['no title here', 'second line'],
        });
        expect(outline[2]!.title).toBe('Ten');
        expect(JSON.stringify(outline)).not.toContain('speaker notes');
    });

    test('a sheet is clipped to the page and says how much was left out', () => {
        const rows: unknown[][] = Array.from({ length: 700 }, (_, r) =>
            Array.from({ length: 60 }, (_, c) => (r === 0 ? `h${c}` : r * 100 + c)),
        );
        rows[3] = [null, undefined, new Date(Date.UTC(2026, 8, 14)), 1.5];
        const clipped = clipSheet(rows);
        expect(clipped.cells).toHaveLength(500);
        expect(clipped.width).toBe(50);
        expect(clipped.moreRows).toBe(200);
        expect(clipped.moreCols).toBe(10);
        expect(clipped.cells[3]!.slice(0, 5)).toEqual(['', '', '2026-09-14', '1.5', '']);
        expect(clipSheet([])).toEqual({ cells: [], width: 0, moreRows: 0, moreCols: 0 });
    });

    test('detection prefers the declared type and falls back to the extension', () => {
        expect(officeKind('report.docx', null)).toBe('docx');
        expect(
            officeKind(
                'report.bin',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ),
        ).toBe('sheet');
        expect(officeKind('deck.PPTX', 'application/octet-stream')).toBe('slides');
        expect(officeKind('cities.csv', 'text/csv')).toBe('sheet');
        expect(officeKind('cities.tsv', null)).toBe('sheet');
        expect(officeKind('cities.txt', 'text/csv')).toBe('sheet');
        expect(officeKind('notes.md', 'text/markdown')).toBeNull();
        expect(officeKind('docx', null)).toBeNull();
    });

    test('a packaged workbook is read as bytes, delimited text as UTF-8', () => {
        const csv = new TextEncoder().encode('city,n\nS\u00e3o Paulo,1\n');
        expect(sheetSource(csv)).toEqual({ type: 'string', data: 'city,n\nS\u00e3o Paulo,1\n' });
        const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
        expect(sheetSource(zip)).toEqual({ type: 'array', data: zip });
        const compound = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
        expect(sheetSource(compound).type).toBe('array');
    });
});
