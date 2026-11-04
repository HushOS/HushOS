import type { Pin } from '@hushos/drive/trust';
import { describe, expect, test } from 'vitest';
import { familyWord, pinName, pinOf, pinsById, vouchLine } from './family-pin';

/*
 * A pin an earlier release took on a family's word ("Trust as Lindqvist
 * family does", retired from the UI: docs/optional-verification.md 3.7): the
 * keys are the member list's, the name and address the server's (decision
 * D10). Such pins keep their meaning, and say whose word they are wherever
 * they are shown; a pin of this person's own check always wins over one.
 */
const GROUP = 'b0000000-0000-4000-8000-000000000001';
const SAM = 'a0000000-0000-4000-8000-000000000004';
const keys = (n: number) => ({
    encryptionPublicKey: `x${n}`,
    signingPublicKey: `e${n}`,
    mlDsaPublicKeyHash: `m${n}`,
    kemPublicKeyHash: `k${n}`,
    fingerprint: `f${n}`,
});
const fromFamily = (n: number) => ({
    userId: SAM,
    email: 'sam@example.com',
    name: 'Sam Lindqvist',
    pinnedAt: '2026-10-17T00:00:00.000Z',
    keyVersion: 2,
    trustedVia: GROUP,
    ...keys(n),
});
const family = { groupId: GROUP, name: 'Lindqvist family' };

describe('a pin on a family’s word', () => {
    test('says whose word it is wherever its name is shown, with the address beside it', () => {
        const pin: Pin = { ...fromFamily(1), trustedViaFamily: family.name };
        expect(familyWord(pin)).toBe('Lindqvist family');
        expect(vouchLine(pin)).toBe('The member list of Lindqvist family vouches for these keys');
        expect(pinName(pin)).toBe(
            'Sam Lindqvist (sam@example.com), whom the member list of Lindqvist family vouches for',
        );
        const own = { ...pin, trustedVia: null };
        expect(familyWord(own)).toBeNull();
        expect(vouchLine(own)).toBeNull();
        expect(pinName(own)).toBe('Sam Lindqvist');
    });
});

describe('pins of one person under ids in other case', () => {
    test('are one person, and the pin of this person’s own words check wins', () => {
        const own = { ...fromFamily(1), userId: SAM.toUpperCase(), trustedVia: null };
        const word = fromFamily(2);
        for (const contacts of [
            { [SAM]: word, [SAM.toUpperCase()]: own },
            { [SAM.toUpperCase()]: own, [SAM]: word },
        ]) {
            expect(pinsById(contacts).size).toBe(1);
            expect(pinsById(contacts).get(SAM)).toBe(own);
            // Found by any case, with the key it is stored under.
            expect(pinOf(contacts, SAM)).toEqual({ key: SAM.toUpperCase(), pin: own });
        }
        expect(pinOf({ [SAM]: word }, SAM.toUpperCase())).toEqual({ key: SAM, pin: word });
        expect(pinOf({}, SAM)).toBeNull();
    });
});
