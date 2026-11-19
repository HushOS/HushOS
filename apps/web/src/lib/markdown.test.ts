import type { Element, Root } from 'hast';
import { describe, expect, test } from 'vitest';
import { markdownToHast } from '@/lib/markdown';

/*
 * The preview scrolls with the source by the lines each rendered block came from. Fails if a block
 * names the wrong lines (the preview would sit on the wrong paragraph), if a block the preview scrolls
 * by goes unmarked, or if a document can put its own line numbers on the page.
 */

function marked(tree: Root | Element, out: [string, unknown, unknown][] = []) {
    for (const child of tree.children) {
        if (child.type !== 'element') continue;
        if (child.properties.dataSourceLine !== undefined)
            out.push([
                child.tagName,
                child.properties.dataSourceLine,
                child.properties.dataSourceEnd,
            ]);
        marked(child, out);
    }
    return out;
}

describe('source lines on the rendered blocks', () => {
    test('each block carries the first and last line it came from', () => {
        const text = [
            '# Title', // 1
            '', // 2
            'A paragraph', // 3
            'over two lines.', // 4
            '', // 5
            '- one', // 6
            '- two', // 7
            '', // 8
            '```js', // 9
            'let a = 1;', // 10
            '```', // 11
            '', // 12
            '| a | b |', // 13
            '| - | - |', // 14
            '| 1 | 2 |', // 15
            '', // 16
            '> quoted', // 17
            '', // 18
            '---', // 19
        ].join('\n');
        expect(marked(markdownToHast(text))).toEqual([
            ['h1', 1, 1],
            ['p', 3, 4],
            ['li', 6, 6],
            ['li', 7, 7],
            ['pre', 9, 11],
            ['table', 13, 15],
            ['tr', 13, 13],
            ['tr', 15, 15],
            ['blockquote', 17, 17],
            ['p', 17, 17],
            ['hr', 19, 19],
        ]);
    });

    test('a document can’t set its own line numbers', () => {
        const text = '<p data-source-line="999">raw</p>\n\n<div data-source-end="999">x</div>\n';
        const lines = marked(markdownToHast(text)).flatMap(([, start, end]) => [start, end]);
        expect(lines).not.toContain(999);
        expect(lines).not.toContain('999');
    });
});
