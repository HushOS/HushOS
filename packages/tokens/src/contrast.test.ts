import { describe, expect, test } from 'vitest';

import { contrast } from './contrast';
import { color, type ColorRole, type Scheme } from './index';

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
