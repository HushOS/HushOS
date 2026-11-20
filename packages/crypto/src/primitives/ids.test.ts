import { describe, expect, test } from 'vitest';
import { deriveId, newId, type IdKind } from './ids';
import { encode } from './keys';

/*
 * A scoped id is a pure function of its kind, its workspace and its seed:
 * the server rebuilds it from the seed and refuses anything else, so a wrong
 * byte here is a create every server refuses, and a scope that does not
 * change the id is an id that can be asked about from another workspace.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const seed = (fill: number) => encode(new Uint8Array(16).fill(fill));

describe('deriveId', () => {
    test('gives the known answers', async () => {
        // Computed by a third implementation (Python's hashlib), so neither twin pins only itself.
        const counting = encode(Uint8Array.from({ length: 16 }, (_, i) => i));
        const expected: [IdKind, string][] = [
            ['node', 'a665fe70-cc80-8d51-a9ba-55846dcc512b'],
            ['version', 'd4fb4a80-b5ea-8b6f-97e3-e2e1bb90c8f0'],
            ['object', '6dde5ef0-b985-8abe-8944-97934bb8d8be'],
            ['link', 'dac762e3-30c4-848b-8683-a0e1a9f3dc03'],
            ['report', '58dfe84c-7431-807d-8130-07f8eadb43a7'],
        ];
        for (const [kind, id] of expected) expect(await deriveId(kind, WS, counting)).toBe(id);
        // The scope is lowercased like every id in a statement.
        expect(await deriveId('node', WS.toUpperCase(), counting)).toBe(expected[0]![1]);
    });

    test('sets version 8 and variant 10 whatever the digest', async () => {
        for (let fill = 0; fill < 256; fill++) {
            const id = await deriveId('object', WS, seed(fill));
            expect(id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
        }
    });

    test('changes with the scope, the kind and the seed', async () => {
        const base = await deriveId('node', WS, seed(1));
        expect(await deriveId('node', OTHER, seed(1))).not.toBe(base);
        expect(await deriveId('node', WS, seed(2))).not.toBe(base);
        const kinds: IdKind[] = ['node', 'version', 'object', 'link', 'report'];
        const ids = new Set(await Promise.all(kinds.map((kind) => deriveId(kind, WS, seed(1)))));
        expect(ids.size).toBe(kinds.length);
    });

    test('refuses a seed that is not sixteen canonical bytes, a kind it does not know, an empty scope', async () => {
        await expect(deriveId('node', WS, encode(new Uint8Array(15)))).rejects.toThrow('id seed');
        await expect(deriveId('node', WS, encode(new Uint8Array(17)))).rejects.toThrow('id seed');
        await expect(deriveId('node', WS, `${seed(1)}=`)).rejects.toThrow('id seed');
        await expect(deriveId('folder' as IdKind, WS, seed(1))).rejects.toThrow('id kind');
        await expect(deriveId('node', '', seed(1))).rejects.toThrow('scope id');
    });
});

describe('newId', () => {
    test('mints a fresh seed whose id derives again, for that kind and scope only', async () => {
        const a = await newId('link', WS);
        const b = await newId('link', WS);
        expect(a.id).not.toBe(b.id);
        expect(await deriveId('link', WS, a.seed)).toBe(a.id);
        expect(await deriveId('link', OTHER, a.seed)).not.toBe(a.id);
        expect(await deriveId('report', WS, a.seed)).not.toBe(a.id);
    });
});
