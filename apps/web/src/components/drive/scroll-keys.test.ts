import { describe, expect, test } from 'vitest';
import { scrollsByKey } from '@/components/drive/scroll-keys';

/* A detached element from markup: the classifier reads only the element and its ancestors. */
function element(html: string) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.querySelector('[data-target]') ?? host.firstElementChild!;
}

const PAGING = ['PageUp', 'PageDown', 'Home', 'End'];
const ARROWS = ['ArrowUp', 'ArrowDown'];

describe('which keys scroll the list', () => {
    test('with nothing focused, every scrolling key scrolls and nothing else does', () => {
        for (const key of [...PAGING, ...ARROWS, ' '])
            expect(scrollsByKey(key, document.body)).toBe(true);
        for (const key of ['Enter', 'i', 'Tab', 'Escape', 'ArrowLeft'])
            expect(scrollsByKey(key, document.body)).toBe(false);
    });

    test('Space on a link pages the list; Enter is what follows the link', () => {
        const link = element('<a href="/drive">Docs</a>');
        expect(scrollsByKey(' ', link)).toBe(true);
        expect(scrollsByKey('Enter', link)).toBe(false);
    });

    test('Space presses a button, a summary or a checkbox, and their other keys still scroll', () => {
        for (const html of [
            '<button>Close details</button>',
            '<details><summary data-target>More</summary></details>',
            '<input type="checkbox">',
            '<div role="checkbox" tabindex="0"></div>',
            '<div role="switch" tabindex="0"></div>',
            '<div role="menuitem" tabindex="0"></div>',
        ]) {
            const control = element(html);
            expect(scrollsByKey(' ', control), html).toBe(false);
            for (const key of [...PAGING, ...ARROWS])
                expect(scrollsByKey(key, control), `${key} ${html}`).toBe(true);
        }
    });

    test('a row checkbox that kept the focus still lets Page Down page the list', () => {
        const check = element(
            '<tr><td><input type="checkbox" tabindex="-1" data-target></td></tr>',
        );
        expect(scrollsByKey('PageDown', check)).toBe(true);
        expect(scrollsByKey('PageUp', check)).toBe(true);
    });

    test('a text field takes every scrolling key, whatever its type', () => {
        for (const html of [
            '<input>',
            '<input type="search">',
            '<input type="number">',
            '<input type="range">',
            '<textarea></textarea>',
            '<div contenteditable="true"><p data-target>Note</p></div>',
            '<div role="textbox" tabindex="0"></div>',
        ]) {
            const field = element(html);
            for (const key of [...PAGING, ...ARROWS, ' '])
                expect(scrollsByKey(key, field), `${key} ${html}`).toBe(false);
        }
    });

    test('contenteditable="false" is not a field', () => {
        expect(scrollsByKey('PageDown', element('<div contenteditable="false"></div>'))).toBe(true);
    });

    test('a select and a radio take the arrows and Space, and Page Down still scrolls', () => {
        for (const html of [
            '<select><option>A</option></select>',
            '<input type="radio">',
            '<div role="combobox" tabindex="0"></div>',
        ]) {
            const control = element(html);
            for (const key of [...ARROWS, ' '])
                expect(scrollsByKey(key, control), `${key} ${html}`).toBe(false);
            expect(scrollsByKey('PageDown', control), html).toBe(true);
        }
    });
});
