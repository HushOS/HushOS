import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/*
 * Personal keys never enter a custody package (docs/companies-design.md 2.6).
 * The sealing functions refuse a workspace the chain does not list for the
 * company (custody.test.ts). This holds the other half: the worker (the
 * session modules, where personal workspace keys live) has no call that hands
 * anything to them, and nothing outside custody.ts reaches the suite 4 sealer
 * under a company seal's `info`. When the worker gains the company flows, the
 * calls it may make are listed here with the reason each is an area's key.
 */

const source = new URL('.', import.meta.url).pathname;
const files = readdirSync(source).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('testkit.ts'),
);
const read = (name: string) => readFileSync(join(source, name), 'utf8');

const SEALERS = [
    'sealCustody',
    'sealCustodyKey',
    'sealKit',
    'sealKeyEscrow',
    'sealCustodyPrevious',
    'sealWithCoins',
];
const INFOS = [
    'hushos/group/custody-seal/v1',
    'hushos/group/custody-key-seal/v1',
    'hushos/group/kit-seal/v1',
    'hushos/group/kit-seal-proof/v1',
    'hushos/group/key-escrow/v1',
    'hushos/group/custody-previous/v1',
];

describe('who can seal to a company key', () => {
    test('the scan sees the worker and the custody module', () => {
        expect(files).toContain('custody.ts');
        expect(files.filter((name) => name.startsWith('session')).length).toBeGreaterThan(1);
        for (const name of SEALERS.slice(0, 5))
            expect(read('custody.ts')).toContain(`export async function ${name}(`);
    });

    test('no module but custody.ts calls a company sealer, the worker least of all', () => {
        const callers = files.filter(
            (name) =>
                name !== 'custody.ts' &&
                name !== 'sealing.ts' &&
                SEALERS.some((sealer) => new RegExp(`\\b${sealer}\\b`).test(read(name))),
        );
        expect(callers).toEqual([]);
    });

    test('a company seal’s info is written in custody.ts and nowhere else', () => {
        for (const info of INFOS) {
            const holders = files.filter((name) => read(name).includes(info));
            expect(holders, info).toEqual(['custody.ts']);
        }
    });

    test('the package’s index does not export the sealers past the custody entry', () => {
        const index = read('index.ts');
        for (const sealer of SEALERS) expect(index).not.toMatch(new RegExp(`\\b${sealer}\\b`));
    });
});
