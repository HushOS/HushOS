import { describe, expect, test } from 'vitest';

import { contrast } from './contrast';
import { color, type ColorRole, type Role, type Scheme } from './index';

/*
 * The promise the tokens make: text reads at AA (4.5:1) in light and dark and at AAA
 * (7:1) in high contrast; control edges and focus reach 3:1, and 4.5:1 in high
 * contrast. Each pair is a foreground the design actually draws on that background.
 */

const text: [ColorRole, ColorRole][] = [
    ['ink', 'surface'],
    ['ink', 'ground'],
    ['ink', 'tint'],
    ['inkMuted', 'surface'],
    ['inkMuted', 'ground'],
    ['inkMuted', 'tint'],
    ['primary', 'surface'],
    ['primary', 'ground'],
    ['onPrimary', 'primary'],
    ['onTint', 'tint'],
    ['warning', 'surface'],
    ['warning', 'warningSoft'],
    ['success', 'surface'],
    ['success', 'successSoft'],
    ['danger', 'surface'],
    ['danger', 'dangerSoft'],
    ['onSnackbar', 'snackbar'],
    ['snackbarAction', 'snackbar'],
    ['onAvatar1', 'avatar1'],
    ['onAvatar2', 'avatar2'],
    ['onAvatar3', 'avatar3'],
    ['onAvatar4', 'avatar4'],
];

/** Edges people need to find a control, and the focus ring (primary). */
const edges: [ColorRole, ColorRole][] = [
    ['field', 'surface'],
    ['field', 'ground'],
    ['primary', 'surface'],
];

/** Folder marks carry meaning on their own only in high contrast; elsewhere a name sits beside them. */
const highContrastMarks: [ColorRole, ColorRole][] = [
    ['folderBack', 'surface'],
    ['folderFront', 'surface'],
];

const schemes: { scheme: Scheme; text: number; edge: number }[] = [
    { scheme: 'light', text: 4.5, edge: 3 },
    { scheme: 'dark', text: 4.5, edge: 3 },
    { scheme: 'lightHigh', text: 7, edge: 4.5 },
    { scheme: 'darkHigh', text: 7, edge: 4.5 },
];

describe('contrast', () => {
    test('matches the WCAG reference values', () => {
        expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
        expect(contrast('#FFFFFF', '#FFFFFF')).toBe(1);
        // #777777 on white is the classic just-fails-AA grey.
        expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
        expect(contrast('#FFFFFF', '#777777')).toBe(contrast('#777777', '#FFFFFF'));
    });

    test('refuses colours it cannot measure on their own', () => {
        expect(() => contrast('#17203A59', '#FFFFFF')).toThrow();
    });
});

describe.each(schemes)('$scheme', ({ scheme, text: minText, edge: minEdge }) => {
    test.each(text)(`%s on %s is readable text`, (fg, bg) => {
        expect(contrast(color[fg][scheme], color[bg][scheme])).toBeGreaterThanOrEqual(minText);
    });

    test.each(edges)(`%s on %s is a visible edge`, (fg, bg) => {
        expect(contrast(color[fg][scheme], color[bg][scheme])).toBeGreaterThanOrEqual(minEdge);
    });

    if (scheme === 'lightHigh' || scheme === 'darkHigh') {
        test.each(highContrastMarks)(`%s on %s is a visible mark`, (fg, bg) => {
            expect(contrast(color[fg][scheme], color[bg][scheme])).toBeGreaterThanOrEqual(4.5);
        });
    }
});

/*
 * Dark, inside an iOS sheet, popover or menu, where ground, surface and tint step up one
 * level (`darkElevated`) and every other role keeps its dark value. The rows of a sheet
 * are the raised surface, its picked rows the raised tint, and its file marks and
 * selection circles are drawn in field on both.
 */
const elevated = (role: ColorRole) => (color[role] as Role).darkElevated ?? color[role].dark;

const elevatedText: [ColorRole, ColorRole][] = [
    ['ink', 'surface'],
    ['ink', 'ground'],
    ['ink', 'tint'],
    ['inkMuted', 'surface'],
    ['inkMuted', 'ground'],
    ['inkMuted', 'tint'],
    ['onTint', 'tint'],
    ['primary', 'surface'],
    ['primary', 'ground'],
    ['danger', 'surface'],
    ['warning', 'surface'],
    ['success', 'surface'],
];

const elevatedEdges: [ColorRole, ColorRole][] = [
    ['field', 'surface'],
    ['field', 'ground'],
];

describe('dark, elevated (iOS sheets)', () => {
    test.each(elevatedText)(`%s on %s is readable text`, (fg, bg) => {
        expect(contrast(elevated(fg), elevated(bg))).toBeGreaterThanOrEqual(4.5);
    });

    test.each(elevatedEdges)(`%s on %s is a visible edge`, (fg, bg) => {
        expect(contrast(elevated(fg), elevated(bg))).toBeGreaterThanOrEqual(3);
    });
});

/*
 * On the black ground there are no shadows to speak of, so a card, menu, dialog or sheet
 * is told from what lies under it by lightness alone: the surface over the ground, and in
 * an iOS sheet the raised surface over the sheet's own ground, which is in turn the dark
 * surface over the black screen behind it. 1.2:1 is the step iOS's own dark grouped
 * colours take (#1c1c1e on #000000 is 1.23:1). Dark high contrast draws a solid edge round
 * every raised surface instead, so it is not held to this.
 */
describe('dark layers', () => {
    test('the surface lifts off the ground', () => {
        expect(contrast(color.surface.dark, color.ground.dark)).toBeGreaterThanOrEqual(1.2);
    });

    test('a sheet lifts off the screen behind it', () => {
        expect(contrast(elevated('ground'), color.ground.dark)).toBeGreaterThanOrEqual(1.2);
    });

    test('a sheet’s rows lift off the sheet', () => {
        expect(contrast(elevated('surface'), elevated('ground'))).toBeGreaterThanOrEqual(1.2);
    });
});
