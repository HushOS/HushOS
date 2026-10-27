import type { Pin } from '@hushos/drive/trust';
import { describe, expect, test } from 'vitest';
import {
    familyPin,
    familyWord,
    OWN_CHECK_STAYS,
    pinName,
    pinOf,
    pinsById,
    vouchLine,
} from './family-pin';

/*
 * A pin taken on a family's word ("Trust as Lindqvist family does"): the keys
 * are the member list's, the name and address the server's (decision D10).
 * It must never replace a pin from this person's own words check, and must
 * say whose word it is wherever it is shown.
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
    test('never replaces a pin from this person’s own words check', () => {
        const own: Pin = { ...fromFamily(1), trustedVia: undefined, name: 'Sam' };
        delete own.trustedVia;
        expect(() => familyPin(own, fromFamily(2), family)).toThrow(OWN_CHECK_STAYS);
        // Nor one whose origin was written as null by an older client's own check.
        expect(() => familyPin({ ...own, trustedVia: null }, fromFamily(2), family)).toThrow(
            OWN_CHECK_STAYS,
        );
        // A pin that is not this family's word is refused outright.
        expect(() =>
            familyPin(undefined, { ...fromFamily(2), trustedVia: 'other' }, family),
        ).toThrow();
    });

    test('keeps the address and the family, and seals what was shared again when the keys move', () => {
        const fresh = familyPin(undefined, fromFamily(1), family);
        expect(fresh).toMatchObject({
            email: 'sam@example.com',
            trustedVia: GROUP,
            trustedViaFamily: 'Lindqvist family',
        });
        expect(fresh.resealShares).toBeUndefined();
        // An earlier family pin of other keys: the keys a followed succession left behind go,
        // and shares to them wait to be sealed to the new keys.
        const before: Pin = { ...fresh, previousSigningKeys: ['old'], keysReplacedAt: 'then' };
        const moved = familyPin(before, fromFamily(2), family);
        expect(moved).toMatchObject({ ...keys(2), resealShares: true });
        expect(moved.previousSigningKeys).toBeUndefined();
        expect(moved.keysReplacedAt).toBeUndefined();
        // The same keys again: nothing to seal anew.
        expect(familyPin(fresh, fromFamily(1), family).resealShares).toBeUndefined();
    });

    test('says whose word it is wherever its name is shown, with the address beside it', () => {
        const pin = familyPin(undefined, fromFamily(1), family);
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
            // And so never replaced by a family's word.
            expect(() => familyPin(pinOf(contacts, SAM)!.pin, fromFamily(3), family)).toThrow(
                OWN_CHECK_STAYS,
            );
        }
        expect(pinOf({ [SAM]: word }, SAM.toUpperCase())).toEqual({ key: SAM, pin: word });
        expect(pinOf({}, SAM)).toBeNull();
    });
});
