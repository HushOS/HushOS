import { describe, expect, test } from 'vitest';
import { guardRowId, openGuardRow, sealGuardRow } from './contact-guard';
import { decode, encode } from './keys';

/*
 * The contact guard at rest (docs/optional-verification.md 2.8): a row opens
 * only under the settings key it was sealed with, for the account, id and
 * kind it was sealed for, and its id never says whom it is about.
 */
const ME = 'a1a1a1a1-0000-4000-8000-000000000001';
const MAYA = 'a1a1a1a1-0000-4000-8000-000000000002';
const SAM = 'a1a1a1a1-0000-4000-8000-000000000003';
const key = () => crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
const entry = { revision: 1, signingPublicKey: 'ed25519-maya', verified: true };

describe('the sealed contact guard', () => {
    test('a row opens back to the person and value it was sealed with, and only there', async () => {
        const settingsKey = key();
        const row = await sealGuardRow(settingsKey, ME, MAYA, 'entry', entry);
        expect(row.envelope).not.toContain('ed25519-maya');
        expect(row.id).not.toContain(MAYA.slice(0, 8));
        expect(await openGuardRow(settingsKey, ME, 'entry', row.id, row.envelope)).toEqual({
            contactId: MAYA,
            value: entry,
        });
        const refused = 'This saved contact record could not be opened.';
        // Another settings key (another account, or a browser that never unlocked this one).
        await expect(openGuardRow(key(), ME, 'entry', row.id, row.envelope)).rejects.toThrow(
            refused,
        );
        // Another account, kind or id: a row moved anywhere else does not open.
        await expect(openGuardRow(settingsKey, SAM, 'entry', row.id, row.envelope)).rejects.toThrow(
            refused,
        );
        await expect(
            openGuardRow(settingsKey, ME, 'pending', row.id, row.envelope),
        ).rejects.toThrow(refused);
        const sams = await guardRowId(settingsKey, ME, SAM);
        await expect(openGuardRow(settingsKey, ME, 'entry', sams, row.envelope)).rejects.toThrow(
            refused,
        );
        // One byte changed anywhere in it.
        const bytes = decode(row.envelope);
        bytes[bytes.length - 1]! ^= 1;
        await expect(openGuardRow(settingsKey, ME, 'entry', row.id, encode(bytes))).rejects.toThrow(
            refused,
        );
    });

    test('ids are per settings key, account and person, in any letter case', async () => {
        const settingsKey = key();
        const id = await guardRowId(settingsKey, ME, MAYA);
        expect(id).toMatch(/^[0-9a-f]{64}$/);
        expect(await guardRowId(settingsKey, ME.toUpperCase(), MAYA.toUpperCase())).toBe(id);
        expect(await guardRowId(settingsKey, ME, SAM)).not.toBe(id);
        expect(await guardRowId(settingsKey, SAM, MAYA)).not.toBe(id);
        expect(await guardRowId(key(), ME, MAYA)).not.toBe(id);
    });
});
