import { describe, expect, test } from 'vitest';
import { madeFor, scopedId, type IdKind } from './ids';

/*
 * The server derives every client-made id again from its seed and the
 * workspace of the request. The known answers come from the shared fixtures'
 * third implementation (Python's hashlib) and match @hushos/crypto and
 * hushos-core, so a server that drifted would refuse every create.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const COUNTING = Buffer.from(Array.from({ length: 16 }, (_, i) => i)).toString('base64url');

describe('scoped ids', () => {
    test('give the known answers, the scope lowercased', () => {
        const expected: [IdKind, string][] = [
            ['node', 'a665fe70-cc80-8d51-a9ba-55846dcc512b'],
            ['version', 'd4fb4a80-b5ea-8b6f-97e3-e2e1bb90c8f0'],
            ['object', '6dde5ef0-b985-8abe-8944-97934bb8d8be'],
            ['link', 'dac762e3-30c4-848b-8683-a0e1a9f3dc03'],
            ['report', '58dfe84c-7431-807d-8130-07f8eadb43a7'],
        ];
        for (const [kind, id] of expected) {
            expect(scopedId(kind, WS, COUNTING)).toBe(id);
            expect(scopedId(kind, WS.toUpperCase(), COUNTING)).toBe(id);
        }
    });

    test('an id is made for one kind and one workspace only', () => {
        const id = scopedId('node', WS, COUNTING)!;
        expect(madeFor('node', WS, id, COUNTING)).toBe(true);
        expect(madeFor('node', '22222222-2222-4222-8222-222222222222', id, COUNTING)).toBe(false);
        expect(madeFor('version', WS, id, COUNTING)).toBe(false);
        expect(madeFor('node', WS, id, Buffer.alloc(16, 1).toString('base64url'))).toBe(false);
    });

    test('a seed that is missing, not 16 bytes or not canonical derives nothing', () => {
        const id = scopedId('node', WS, COUNTING)!;
        expect(madeFor('node', WS, id, undefined)).toBe(false);
        expect(madeFor('node', WS, id, null)).toBe(false);
        expect(scopedId('node', WS, Buffer.alloc(15).toString('base64url'))).toBeNull();
        expect(scopedId('node', WS, Buffer.alloc(17).toString('base64url'))).toBeNull();
        expect(scopedId('node', WS, `${COUNTING}==`)).toBeNull();
        // The last character carries bits a 16-byte value cannot hold: decodes, but not canonically.
        expect(scopedId('node', WS, `${COUNTING.slice(0, 21)}x`)).toBeNull();
    });
});
