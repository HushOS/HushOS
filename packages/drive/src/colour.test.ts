import { describe, expect, test } from 'vitest';
import { colourHue, FOLDER_COLOURS, folderColour, toColour } from './colour';

describe('a folder’s colour', () => {
    test('its own colour is the one it is drawn in', () => {
        expect(folderColour({ metadata: { attributes: { colour: '#123456' } } })).toBe('#123456');
    });

    test.each([
        ['a preset’s name', 'blue'],
        ['three digits', '#fff'],
        ['upper case', '#ABCDEF'],
        ['a space', ' #123456'],
        ['seven digits', '#1234567'],
        ['an OKLCH string', 'oklch(0.7 0.1 250)'],
    ])('a colour it cannot read (%s) draws the plain folder colour', (_, colour) => {
        expect(folderColour({ metadata: { attributes: { colour } } })).toBeNull();
    });

    test('a folder with no colour, or whose metadata did not open, draws the plain folder colour', () => {
        expect(folderColour({ metadata: { attributes: { other: '#123456' } } })).toBeNull();
        expect(folderColour({ metadata: {} })).toBeNull();
        expect(folderColour({ metadata: null })).toBeNull();
    });

    test('what a person types is stored lower case, or refused', () => {
        expect(toColour(' #7C5CBF ')).toBe('#7c5cbf');
        expect(toColour('#7c5cb')).toBeNull();
        expect(toColour('purple')).toBeNull();
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
