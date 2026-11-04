import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { generateKey, openMetadata, sealMetadata, wellFormed } from './drive';
import { CryptoError } from './errors';

/*
 * Whatever sealMetadata takes, a reader opens: every string it seals (the
 * name, mime, modified, attribute values) either comes back or is refused at
 * seal with a CryptoError. Never sealed and then refused at open, which would
 * leave a node that opens as damaged. Strings are drawn as UTF-16 code units,
 * lone surrogates and pairs included, the way a DOMString such as File.name
 * can hold them.
 */
const unit = fc.oneof(
    fc.integer({ min: 0xd800, max: 0xdfff }),
    fc.integer({ min: 0x20, max: 0x7e }),
    fc.integer({ min: 0, max: 0xffff }),
);
const text = fc
    .array(unit, { minLength: 1, maxLength: 12 })
    .map((units) => String.fromCharCode(...units));
const ctx = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    nodeId: '22222222-2222-4222-8222-222222222222',
    metadataVersion: 1,
};

describe('metadata strings', () => {
    test('round-trip or are refused at seal, never sealed and then refused at open', async () => {
        const key = generateKey();
        await fc.assert(
            fc.asyncProperty(
                text,
                fc.option(text),
                fc.option(text),
                fc.option(text),
                async (name, mime, modified, colour) => {
                    const metadata = {
                        name,
                        mime,
                        size: null,
                        modified,
                        ...(colour === null ? {} : { attributes: { colour } }),
                    };
                    let envelope: Uint8Array;
                    try {
                        envelope = await sealMetadata(metadata, key, ctx);
                    } catch (error) {
                        expect(error).toBeInstanceOf(CryptoError);
                        return;
                    }
                    const opened = await openMetadata(envelope, key, ctx);
                    expect(opened).toEqual(metadata);
                },
            ),
            { numRuns: 400 },
        );
    });

    test('a lone surrogate in any of them is refused at seal; a pair is kept', async () => {
        const key = generateKey();
        const base = { name: 'P', mime: null, size: null, modified: null };
        for (const metadata of [
            { ...base, name: 'x\ud800' },
            { ...base, mime: 'text/\udc00' },
            { ...base, modified: '2026\ud800' },
            { ...base, attributes: { colour: '\ud800' } },
        ])
            await expect(sealMetadata(metadata, key, ctx)).rejects.toThrow(CryptoError);
        const paired = { ...base, name: 'P\u{1F600}', attributes: { colour: '\u{1F600}' } };
        expect(await openMetadata(await sealMetadata(paired, key, ctx), key, ctx)).toEqual(paired);
    });

    test('a platform name made well formed seals and opens, its pairs kept and only lone halves replaced', async () => {
        expect(wellFormed('a\ud800b\u{1F600}\udc00')).toBe('a\ufffdb\u{1F600}\ufffd');
        const key = generateKey();
        await fc.assert(
            fc.asyncProperty(text, async (raw) => {
                const name = wellFormed(raw);
                const metadata = { name, mime: null, size: null, modified: null };
                try {
                    await sealMetadata(metadata, key, ctx);
                } catch (error) {
                    // Refused only for what a name never holds (a slash, a control character), never a surrogate.
                    expect(error).toBeInstanceOf(CryptoError);
                    expect((error as Error).message).not.toContain('can’t be saved');
                }
            }),
            { numRuns: 300 },
        );
    });
});
