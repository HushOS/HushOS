import { describe, expect, test } from 'vitest';
import { madeFor, scopedId, type GroupIdKind, type IdKind } from './ids';

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

    test("give the group core's known answers for groups (scoped to their creator) and areas (to their group)", () => {
        // From the group crypto core's shared fixtures (web-groups.json, "ids"), which both
        // twins derive; a server that drifted would refuse every group and area it is sent.
        const expected: [GroupIdKind, string, string, string][] = [
            [
                'group',
                '00000001-abcd-4abc-8abc-abcdefabcdef',
                'GDxghKjM8BQ4XICkyOwQNA',
                '3bac3135-fa25-8e3b-93e8-c06d036a8396',
            ],
            [
                'group',
                '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
                'H0Nni6_T9xtAZIis0PQYPA',
                'c6f18e72-6010-809e-812b-bacacdbc8a41',
            ],
            [
                'workspace',
                '00000001-abcd-4abc-8abc-abcdefabcdef',
                'Jkpukrfb_yNIbJC02f0hRQ',
                '9a9a33c0-b7b0-854a-8b40-45d1b1fdbaa9',
            ],
            [
                'workspace',
                '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
                'LVF1mr7iBytQdJi94QUqTg',
                'f9309cef-c4c9-81c6-ad48-7097df6a0b21',
            ],
        ];
        for (const [kind, scope, seed, id] of expected) {
            expect(scopedId(kind, scope, seed)).toBe(id);
            expect(madeFor(kind, scope, id, seed)).toBe(true);
        }
        // A group id is not an area id, and an area made for one group is not another's.
        const [, scope, seed, id] = expected[2]!;
        expect(madeFor('group', scope, id, seed)).toBe(false);
        expect(madeFor('workspace', '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', id, seed)).toBe(false);
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
