// @vitest-environment node
import { expect, test } from 'vitest';
import geometry from '../../../../../e2e/fixtures/images/geometry.json';
import { defaultPageSize, pageLayout, type PageSize } from './geometry';

/* Page sizes and matrices against geometry.json, computed by make.py from the definitions; the core is held to it too. */
test('every layout matches geometry.json', () => {
    expect(geometry.cases.length).toBeGreaterThan(100);
    for (const c of geometry.cases) {
        const layout = pageLayout(c.width, c.height, c.orientation, c.size as PageSize, c.margin);
        expect(layout.width).toBeCloseTo(c.page[0]!, 6);
        expect(layout.height).toBeCloseTo(c.page[1]!, 6);
        layout.matrix.forEach((value, i) =>
            expect(value, JSON.stringify(c)).toBeCloseTo(c.matrix[i]!, 6),
        );
    }
});

test('Letter for a US or Canadian region, A4 for every other', () => {
    expect(defaultPageSize(['en-US'])).toBe('letter');
    expect(defaultPageSize(['fr-CA', 'fr'])).toBe('letter');
    expect(defaultPageSize(['en-GB'])).toBe('a4');
    expect(defaultPageSize(['de-DE', 'en-US'])).toBe('a4');
    expect(defaultPageSize(['es-MX'])).toBe('a4');
    // A language alone takes its likeliest region: English's is the US, German's Germany.
    expect(defaultPageSize(['en'])).toBe('letter');
    expect(defaultPageSize(['de'])).toBe('a4');
    expect(defaultPageSize(['not a tag', 'en-CA'])).toBe('letter');
    expect(defaultPageSize([])).toBe('a4');
});
