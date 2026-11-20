import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeStatement, parseStatement } from './canonical';
import { CryptoError } from './errors';

/*
 * The statement grammar every group statement keeps (docs/groups-design.md
 * 2.1), over inputs nobody wrote by hand: it refuses with a CryptoError and
 * nothing else, what it accepts is exactly the compact encoding of what it
 * holds, and no other spelling of an accepted statement is accepted. The Rust
 * twin is held to the same by crates/hushos-core/fuzz (cargo-fuzz) and to
 * this one by `bun run fuzz:diff`.
 */

/* What a call returns, or null for a CryptoError; any other throw fails the property. */
function refusedOrValue<T>(run: () => T): T | null {
    try {
        return run();
    } catch (error) {
        if (error instanceof CryptoError) return null;
        throw error;
    }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/* Values in and around the grammar: plain and other strings, safe and unsafe numbers, nested lists. */
const part: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    part: fc.oneof(
        { depthSize: 'small' },
        fc.string({ unit: 'grapheme-ascii', maxLength: 8 }),
        fc.string({ unit: 'binary', maxLength: 4 }),
        fc.constantFrom(0, 1, 2 ** 53 - 1, 2 ** 53, -1, -0, 1.5, 1e21, Number.NaN),
        fc.nat(),
        fc.array(tie('part'), { maxLength: 3 }),
    ),
})).part;

/* Only plain strings and safe integers, at most four lists deep: always grammatical. */
const grammatical: fc.Arbitrary<unknown[]> = fc
    .letrec((tie) => ({
        list: fc.array(tie('item'), { maxLength: 4 }),
        item: fc.oneof(
            { depthSize: 'small' },
            fc.stringMatching(/^[\x20\x21\x23-\x5b\x5d-\x7e]{0,8}$/),
            fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
            tie('list'),
        ),
    }))
    .list.filter((list) => depth(list) <= 4);

/* The compact encoding, but with the first number written by `as`. */
function spell(parts: unknown[], as: (n: number) => string) {
    let done = false;
    const write = (value: unknown): string => {
        if (Array.isArray(value)) return `[${value.map(write).join(',')}]`;
        if (typeof value === 'number' && !done) {
            done = true;
            return as(value);
        }
        return JSON.stringify(value);
    };
    return write(parts);
}

function depth(value: unknown): number {
    return Array.isArray(value) ? 1 + Math.max(0, ...value.map(depth)) : 0;
}

describe('the statement grammar, over generated input', () => {
    it('refuses arbitrary bytes with a CryptoError, and re-encodes whatever it accepts to the same bytes', () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
                const parts = refusedOrValue(() => parseStatement(bytes, 'statement'));
                if (parts) expect(encodeStatement(parts)).toEqual(bytes);
            }),
            { numRuns: 2000 },
        );
    });

    it('encodes only grammatical values, and parses what it encoded back to the same values', () => {
        fc.assert(
            fc.property(fc.array(part, { maxLength: 5 }), (parts) => {
                const bytes = refusedOrValue(() => encodeStatement(parts));
                if (bytes) expect(parseStatement(bytes, 'statement')).toEqual(parts);
            }),
            { numRuns: 1000 },
        );
    });

    it('accepts the compact encoding of a grammatical statement and no other spelling of it', () => {
        // Another spelling of the same values: spacing, a BOM, an escape, or another form of the first number.
        const respell = fc.constantFrom<(parts: unknown[]) => string>(
            (p) => ` ${JSON.stringify(p)}`,
            (p) => `${JSON.stringify(p)}\n`,
            (p) => `\ufeff${JSON.stringify(p)}`,
            (p) => JSON.stringify(p).replace('[', '[ '),
            // The first string's first character as a \u escape: the same value, spelled otherwise.
            (p) =>
                JSON.stringify(p).replace(
                    /"([^"])/,
                    (_, c: string) => `"\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
                ),
            (p) => spell(p, (n) => `${n}.0`),
            (p) => spell(p, (n) => `${n}e0`),
            (p) => spell(p, (n) => `0${n}`),
        );
        fc.assert(
            fc.property(grammatical, respell, (parts, change) => {
                const compact = JSON.stringify(parts);
                expect(parseStatement(utf8(compact), 'statement')).toEqual(parts);
                const other = change(parts);
                if (other !== compact)
                    expect(() => parseStatement(utf8(other), 'statement')).toThrow(CryptoError);
            }),
            { numRuns: 1000 },
        );
    });
});
