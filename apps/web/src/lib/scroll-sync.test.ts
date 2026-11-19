import { describe, expect, test } from 'vitest';
import {
    type Block,
    inSourceOrder,
    lineForOffset,
    offsetForLine,
    ScrollLink,
    type ScrollPane,
    type Scroller,
} from '@/lib/scroll-sync';

/*
 * The source and its preview scroll together through these. Fails if the preview lands on the wrong
 * block for a source line (or the reverse), if a position inside a long block or between two blocks
 * jumps instead of moving smoothly, or if the link's own scroll comes back and moves the pane the
 * person is scrolling.
 */

// A heading (line 1), a paragraph (3 to 5), a list (7 to 9) whose second item holds a nested
// paragraph, and a fence (11 to 14), in document order as the preview marks them.
const blocks: Block[] = [
    { start: 1, end: 1, top: 40, bottom: 80 },
    { start: 3, end: 5, top: 100, bottom: 160 },
    { start: 7, end: 7, top: 180, bottom: 200 },
    { start: 8, end: 9, top: 200, bottom: 240 },
    { start: 8, end: 8, top: 200, bottom: 220 },
    { start: 11, end: 14, top: 260, bottom: 400 },
];

describe('source lines and preview offsets', () => {
    test('a line maps to its block, and inside a block in proportion', () => {
        expect(offsetForLine(blocks, 1)).toBe(40);
        expect(offsetForLine(blocks, 3)).toBe(100);
        // Halfway through the paragraph's three lines is halfway down its rendering.
        expect(offsetForLine(blocks, 4.5)).toBe(130);
        expect(offsetForLine(blocks, 11)).toBe(260);
    });

    test('a nested block wins over the one holding it', () => {
        // Line 8 starts both the second item and its paragraph: the paragraph, the inner one.
        expect(offsetForLine(blocks, 8.5)).toBe(210);
    });

    test('a blank line between blocks moves through the gap, never jumping to either side', () => {
        // Line 2 lies between the heading (ends at 80) and the paragraph (starts at 100).
        expect(offsetForLine(blocks, 2)).toBe(80);
        expect(offsetForLine(blocks, 2.5)).toBe(90);
        expect(offsetForLine(blocks, 10.5)).toBe(250);
        // Past the last block: its bottom.
        expect(offsetForLine(blocks, 30)).toBe(400);
    });

    test('an offset maps back to the line it came from', () => {
        for (const line of [1, 1.5, 2.25, 3, 4.75, 7.5, 8.5, 10.5, 12, 14.9]) {
            const offset = offsetForLine(blocks, line)!;
            expect(lineForOffset(blocks, offset)).toBeCloseTo(line, 6);
        }
    });

    test('above the first block is the top of the source', () => {
        const later: Block[] = [{ start: 5, end: 5, top: 100, bottom: 120 }];
        expect(offsetForLine(later, 1)).toBe(0);
        expect(offsetForLine(later, 3)).toBe(50);
        expect(lineForOffset(later, 50)).toBe(3);
    });

    test('nothing rendered yet: no answer rather than the top', () => {
        expect(offsetForLine([], 10)).toBeNull();
        expect(lineForOffset([], 10)).toBeNull();
    });
});

/* A scroller that clamps and rounds what it is given, as a browser's does, and records each move. */
function scroller(scrollHeight: number, clientHeight: number) {
    let top = 0;
    const box = {
        scrollHeight,
        clientHeight,
        moves: 0,
        get scrollTop() {
            return top;
        },
        set scrollTop(value: number) {
            const next = Math.round(Math.min(Math.max(0, value), scrollHeight - clientHeight));
            if (next !== top) box.moves++;
            top = next;
        },
    };
    return box satisfies Scroller;
}

/*
 * A source of 20 px lines (2,000 lines: 40,000 px tall) and a preview whose last block ends well
 * before its source does: trailing lines (blank in the source) have nothing to show, so the end of
 * the preview is reached long before the end of the source.
 */
function panes() {
    const source = scroller(40_000, 800);
    const preview = scroller(10_000, 800);
    const previewBlocks: Block[] = [{ start: 1, end: 1000, top: 0, bottom: 10_000 }];
    const sourcePane: ScrollPane = {
        scroller: source,
        lineAt: (top) => 1 + top / 20,
        topOf: (line) => (line - 1) * 20,
    };
    const previewPane: ScrollPane = {
        scroller: preview,
        lineAt: (top) => lineForOffset(previewBlocks, top),
        topOf: (line) => offsetForLine(previewBlocks, line),
    };
    const link = new ScrollLink(() => ({ source: sourcePane, preview: previewPane }));
    return { source, preview, link };
}

describe('scrolling the two panes together', () => {
    test('scrolling the source moves the preview to the same line, and the other way round', () => {
        const { source, preview, link } = panes();
        source.scrollTop = 4_000; // line 201
        link.scrolled('source');
        expect(preview.scrollTop).toBe(2_000);
        link.scrolled('preview'); // its echo
        preview.scrollTop = 5_000; // the person scrolls the preview to line 501
        link.scrolled('preview');
        expect(source.scrollTop).toBe(10_000);
    });

    test('the link’s own scroll coming back never moves the pane being scrolled', () => {
        const { source, preview, link } = panes();
        // Past line 1,000 the preview is at its end; the source is far from its own.
        source.scrollTop = 30_000;
        link.scrolled('source');
        expect(preview.scrollTop).toBe(9_200);
        const moves = source.moves;
        // The preview's scroll events for that move (a browser may send two): echoes, not the person.
        link.scrolled('preview');
        link.scrolled('preview');
        expect(source.scrollTop).toBe(30_000);
        expect(source.moves).toBe(moves);
    });

    test('after the echo, the person scrolling the preview moves the source again', () => {
        const { source, preview, link } = panes();
        source.scrollTop = 4_000;
        link.scrolled('source');
        link.scrolled('preview');
        preview.scrollTop = 1_000;
        link.scrolled('preview');
        expect(source.scrollTop).toBe(2_000);
    });

    test('either pane at its top or its end takes the other there', () => {
        const { source, preview, link } = panes();
        source.scrollTop = 39_200;
        link.scrolled('source');
        expect(preview.scrollTop).toBe(9_200);
        link.scrolled('preview');
        source.scrollTop = 0;
        link.scrolled('source');
        expect(preview.scrollTop).toBe(0);
    });

    test('a narrow switch keeps the line that was at the top', () => {
        const { source, preview, link } = panes();
        source.scrollTop = 6_000;
        const line = link.lineOf('source')!;
        expect(link.show('preview', line)).toBe(true);
        expect(preview.scrollTop).toBe(3_000);
    });
});

describe('footnotes', () => {
    test('a footnote early in the source, drawn at the end, never takes a body line', () => {
        // As measured: the heading (1), body paragraphs (3, 7, 9), then the footnote section the
        // renderer moved to the end, though its definition is on line 5 of the source.
        const measured: Block[] = [
            { start: 1, end: 1, top: 0, bottom: 40 },
            { start: 3, end: 3, top: 60, bottom: 80 },
            { start: 7, end: 7, top: 100, bottom: 120 },
            { start: 9, end: 9, top: 140, bottom: 160 },
            { start: 5, end: 5, top: 200, bottom: 220 },
            { start: 5, end: 5, top: 200, bottom: 220 },
        ];
        const blocks = inSourceOrder(measured);
        // Body lines land on their own paragraphs, never in the footnotes at the bottom.
        expect(offsetForLine(blocks, 7)).toBe(100);
        expect(offsetForLine(blocks, 9)).toBe(140);
        // The footnote's line lies between paragraphs 3 and 7 in the source: the gap between them.
        const five = offsetForLine(blocks, 5)!;
        expect(five).toBeGreaterThan(80);
        expect(five).toBeLessThan(100);
        // And back: the body's offsets give the body's lines.
        expect(lineForOffset(blocks, 100)).toBe(7);
        expect(lineForOffset(blocks, 150)).toBe(9.5);
    });
});
