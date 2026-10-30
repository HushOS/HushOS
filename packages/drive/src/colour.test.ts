import { describe, expect, test } from 'vitest';
import {
    colourHue,
    defaultFolderColour,
    FOLDER_COLOURS,
    folderColour,
    randomFolderColour,
    toColour,
} from './colour';

/*
 * The default is what every device shows for a folder with no colour, so it must
 * match the Rust core's twin exactly: the same ids are pinned in
 * crates/hushos-core/src/colour.rs (checked against an independent FNV-1a).
 */
const PINNED: [string, string][] = [
    ['00000000-0000-4000-8000-000000000000', '#e488be'],
    ['11111111-1111-4111-8111-111111111111', '#aa9cf7'],
    ['0195f3a2-7c4e-7b1a-9d2e-3f4a5b6c7d8e', '#f28881'],
    ['root', '#e488be'],
    ['é-ünïcode-✓', '#8fbb5f'],
];

describe('a folder’s colour', () => {
    test.each(PINNED)('the default for %s is the one the Rust core shows', (id, colour) => {
        expect(defaultFolderColour(id)).toBe(colour);
    });

    test('defaults spread over every swatch, not a few', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 400; i++) seen.add(defaultFolderColour(crypto.randomUUID()));
        expect([...seen].sort()).toEqual([...FOLDER_COLOURS].sort());
    });

    test('its own colour wins over the default', () => {
        const id = PINNED[0]![0];
        expect(folderColour({ id, metadata: { attributes: { colour: '#123456' } } })).toBe(
            '#123456',
        );
    });

    test.each([
        ['a preset’s name', 'blue'],
        ['three digits', '#fff'],
        ['upper case', '#ABCDEF'],
        ['a space', ' #123456'],
        ['seven digits', '#1234567'],
        ['an OKLCH string', 'oklch(0.7 0.1 250)'],
    ])('a colour it cannot read (%s) shows the default', (_, colour) => {
        const [id, fallback] = PINNED[1]!;
        expect(folderColour({ id, metadata: { attributes: { colour } } })).toBe(fallback);
    });

    test('a folder whose metadata did not open shows the default', () => {
        const [id, fallback] = PINNED[2]!;
        expect(folderColour({ id, metadata: null })).toBe(fallback);
    });

    test('what a person types is stored lower case, or refused', () => {
        expect(toColour(' #7C5CBF ')).toBe('#7c5cbf');
        expect(toColour('#7c5cb')).toBeNull();
        expect(toColour('purple')).toBeNull();
    });

    test('a new folder’s colour is always a swatch, at both ends of the range', () => {
        expect(randomFolderColour(() => 0)).toBe(FOLDER_COLOURS[0]);
        expect(randomFolderColour(() => 0.999_999)).toBe(FOLDER_COLOURS.at(-1));
        // Math.random never returns 1, but a bad source must not index past the end.
        expect(randomFolderColour(() => 1)).toBe(FOLDER_COLOURS.at(-1));
    });

    test('every swatch keeps its hue and full strength when drawn', () => {
        const hues = [255, 160, 25, 290, 200, 345, 130, 55];
        FOLDER_COLOURS.forEach((colour, index) => {
            const { hue, strength } = colourHue(colour);
            expect(Math.abs(hue - hues[index]!)).toBeLessThan(1.5);
            expect(strength).toBe(1);
        });
    });

    test('a grey stays grey, however it is drawn', () => {
        expect(colourHue('#808080').strength).toBeLessThan(0.01);
        expect(colourHue('#ffffff').strength).toBeLessThan(0.01);
    });
});
