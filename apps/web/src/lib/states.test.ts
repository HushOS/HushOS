import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { color, contrast, type ColorRole, type Scheme } from '@hushos/tokens';
import { describe, expect, test } from 'vitest';

/*
 * The web's state tones (styles.css): the focus ring is the accent at part strength, and hover
 * and the highlighted item are ink laid over whatever is beneath. Laid over, not one grey, so
 * they must be checked on every surface they sit on, in both themes: a ring that can't be
 * found, a hover that equals its ground, or words that fade on a highlighted row are the
 * defects. The strengths are read from styles.css, so the numbers checked are the ones shipped.
 */
const css = readFileSync(join(import.meta.dirname, '../styles.css'), 'utf8');

/* `--name: color-mix(in oklab, var(--of) N%, transparent)` inside the rule that starts at `from`. */
function strength(name: string, from: string) {
    const rule = css.slice(css.indexOf(from));
    const found = new RegExp(
        `--${name}: color-mix\\(in oklab, var\\(--(\\w+)\\) (\\d+)%, transparent\\)`,
    ).exec(rule.slice(0, rule.indexOf('\n}')));
    if (!found) throw new Error(`--${name} is not a part-strength mix in ${from}`);
    return { of: found[1] as ColorRole, alpha: Number(found[2]) / 100 };
}

const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
/* A colour at part strength over a ground, as the browser composites it. */
function over(top: string, alpha: number, ground: string) {
    const [t, g] = [channels(top), channels(ground)];
    return `#${t
        .map((value, at) =>
            Math.round(value * alpha + g[at]! * (1 - alpha))
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`;
}

const themes: { scheme: Scheme; from: string }[] = [
    { scheme: 'light', from: ':root {\n    --radius' },
    { scheme: 'dark', from: ':root.dark {' },
];
/* What a state can sit on: the sidebar and the dark panel, cards, menus and dialogs. */
const grounds: ColorRole[] = ['ground', 'surface'];

describe.each(themes)('$scheme', ({ scheme, from }) => {
    const of = (role: ColorRole) => color[role][scheme];
    // The ring is set once, for both themes.
    const ring = strength('ring', themes[0]!.from);
    const hover = strength('hover', from);
    const highlight = strength('highlight', from);

    test('the focus ring is found on every ground: 3:1 against it', () => {
        expect(ring.of).toBe('primary');
        // Less than whole, or it is the old ring again.
        expect(ring.alpha).toBeLessThan(1);
        for (const ground of grounds)
            expect(
                contrast(over(of('primary'), ring.alpha, of(ground)), of(ground)),
                `ring on ${ground}`,
            ).toBeGreaterThanOrEqual(3);
    });

    test('hover and the highlighted item differ from every ground they sit on, the highlight more', () => {
        expect(highlight.alpha).toBeGreaterThan(hover.alpha);
        for (const ground of grounds)
            for (const tone of [hover, highlight]) {
                const drawn = over(of(tone.of), tone.alpha, of(ground));
                expect(drawn, `on ${ground}`).not.toBe(of(ground));
                // Seen, not guessed at: a step of at least 1.07:1, the dark theme's old lift.
                expect(contrast(drawn, of(ground)), `on ${ground}`).toBeGreaterThanOrEqual(1.07);
            }
    });

    test('words stay readable on a hovered or highlighted row: 4.5:1, the quiet ink too', () => {
        for (const ground of grounds)
            for (const tone of [hover, highlight]) {
                const drawn = over(of(tone.of), tone.alpha, of(ground));
                for (const ink of ['ink', 'inkMuted', 'primary'] as const)
                    expect(contrast(of(ink), drawn), `${ink} on ${ground}`).toBeGreaterThanOrEqual(
                        4.5,
                    );
            }
    });
});

test.each(['light', 'dark', 'lightHigh', 'darkHigh'] as const)(
    'the keyboard’s highlight is found by more than its fill, and a tile’s hover keeps its words: %s',
    (scheme) => {
        const of = (role: ColorRole) => color[role][scheme];
        const rule = css.slice(css.indexOf(themes[0]!.from));
        const block = rule.slice(0, rule.indexOf('\n}'));
        // The bar is the accent whole.
        expect(block).toContain('--cue: var(--primary);');
        const dark = scheme.startsWith('dark');
        const highlight = strength('highlight', themes[dark ? 1 : 0]!.from);
        for (const ground of grounds) {
            const filled = over(of(highlight.of), highlight.alpha, of(ground));
            // Against the item's own fill and against the menu around it: 3:1 (WCAG 1.4.11).
            expect(contrast(of('primary'), filled), `bar on ${ground}`).toBeGreaterThanOrEqual(3);
            expect(contrast(of('primary'), of(ground)), `bar by ${ground}`).toBeGreaterThanOrEqual(
                3,
            );
        }
        // The opaque hover: ink mixed into the panel (the surface, or the ground in the dark).
        const solid =
            /--hover-solid: color-mix\(in oklab, var\(--ink\) (\d+)%, var\(--panel\)\)/.exec(block);
        expect(solid).not.toBeNull();
        const panel = of(dark ? 'ground' : 'surface');
        const hovered = over(of('ink'), Number(solid![1]) / 100, panel);
        expect(hovered).not.toBe(panel);
        for (const ink of ['ink', 'inkMuted'] as const)
            expect(contrast(of(ink), hovered), `${ink} on a hovered tile`).toBeGreaterThanOrEqual(
                4.5,
            );
    },
);

test('high contrast draws the ring whole', () => {
    const rule = css.slice(css.indexOf(':root.hc,'));
    expect(rule.slice(0, rule.indexOf('\n}'))).toContain('--ring: var(--primary);');
});
