import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { readOutboxEntry } from '@hushos/crypto';
import { guardAgrees } from '@hushos/crypto/first-seen';
import { keyCommitment, pinKeysOfServed, pinTrust, pinVerified } from '@hushos/crypto/pins';
import { comparePin } from './trust';

/*
 * The shared pin cases (crates/hushos-core/fixtures/pin-cases.json, written by
 * packages/crypto/scripts/pin-cases.ts with every outcome stated by hand),
 * as this twin decides them; crates/hushos-core/tests/pin_cases.rs holds the
 * core to the same. A case one twin decides otherwise is a pin the web and
 * the phones would trust differently.
 */

type Json = any;
const cases: Json = JSON.parse(
    readFileSync(
        new URL('../../../crates/hushos-core/fixtures/pin-cases.json', import.meta.url),
        'utf8',
    ),
);

const named = (list: Json[]) => list.map((c) => [c.name as string, c] as [string, Json]);

describe('the shared pin cases', () => {
    test.each(named(cases.trust))('trust: %s', async (_, c: Json) => {
        expect(await pinTrust(c.pin)).toBe(c.trust);
        expect(await keyCommitment(c.pin)).toBe(c.commitment);
    });

    test.each(named(cases.comparisons))('comparison: %s', async (_, c: Json) => {
        expect(await comparePin(c.pin, c.served)).toBe(c.expected);
    });

    test.each(named(cases.servedPins))('pin of served keys: %s', async (_, c: Json) => {
        if (c.expected === null) await expect(pinKeysOfServed(c.served, c.form)).rejects.toThrow();
        else expect(await pinKeysOfServed(c.served, c.form)).toEqual(c.expected);
    });

    test.each(named(cases.guards))('guard: %s', async (_, c: Json) => {
        expect(await guardAgrees(c.pin?.userId ?? 'user', c.guard, c.pin)).toBe(c.expected);
    });

    test.each(named(cases.admissions))('kept admission: %s', (_, c: Json) => {
        const read = readOutboxEntry(c.entry, cases.groupId, c.pin);
        expect(read?.status === 'hold' ? 'hold' : read?.status).toBe(c.expected);
        if (c.expected === 'hold') expect(read).toMatchObject({ reason: 'other-keys' });
    });
});

/*
 * How the 0.10.0 apps read a pin, from their JSON shapes: iOS decodes each
 * pin with JSONDecoder and skips one that fails; Android reads every field
 * leniently. Both then ask the core's pin_verified.
 */
const typeHolds = (kind: string, value: unknown) => {
    switch (kind) {
        case 'string':
            return typeof value === 'string';
        case 'bool':
            return typeof value === 'boolean';
        case 'u64':
            return typeof value === 'number' && Number.isInteger(value) && value >= 0;
        case 'string[]':
            return Array.isArray(value) && value.every((at) => typeof at === 'string');
        case 'present':
            return true;
        default:
            throw new Error(kind);
    }
};
function decodes(shape: Json, pin: Json) {
    for (const [key, kind] of Object.entries(shape.required) as [string, string][])
        if (
            !(key in pin) ||
            (kind !== 'present' && pin[key] === null) ||
            !typeHolds(kind, pin[key])
        )
            return false;
    for (const [key, kind] of Object.entries(shape.optional) as [string, string][])
        if (key in pin && pin[key] !== null && !typeHolds(kind, pin[key])) return false;
    return true;
}
const optional = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

describe('the 0.10.0 apps read a first-seen pin', () => {
    test.each(named(cases.readers.cases))('%s', async (_, c: Json) => {
        const ios = cases.readers.shapes['ios-0.10.0'];
        const android = cases.readers.shapes['android-0.10.0'];
        const iosDecodes = decodes(ios, c.pin);
        expect(iosDecodes).toBe(c.ios.decodes);
        if (iosDecodes) expect(await pinVerified(c.pin)).toBe(c.ios.verified);
        expect(decodes(android, c.pin)).toBe(c.android.decodes);
        expect(
            await pinVerified({
                encryptionPublicKey: c.pin.encryptionPublicKey,
                signingPublicKey: c.pin.signingPublicKey ?? '',
                mlDsaPublicKeyHash: optional(c.pin.mlDsaPublicKeyHash),
                kemPublicKeyHash: optional(c.pin.kemPublicKeyHash),
                fingerprint: c.pin.fingerprint ?? '',
            }),
        ).toBe(c.android.verified);
    });
});
