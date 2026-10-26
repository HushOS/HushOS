import { writeFile } from 'node:fs/promises';
import { keyCommitment, pinKeysOfServed } from '../src/pins';

/*
 * Writes crates/hushos-core/fixtures/pin-cases.json: the pin rules of
 * docs/optional-verification.md 2 (first-seen pins, key commitments, a pin
 * compared with served keys, the guard's rule without a chain, a kept
 * admission told by its keys, and how the 0.10.0 apps read a first-seen pin),
 * as cases both twins must decide alike: packages/drive/src/pin-cases.test.ts
 * and crates/hushos-core/tests/pin_cases.rs. Every expected outcome is stated
 * here by hand; only the keys, their digests and their commitments are
 * computed. Run with `bun packages/crypto/scripts/pin-cases.ts`.
 */

const fixture = new URL('../../../crates/hushos-core/fixtures/pin-cases.json', import.meta.url);
const b64 = (length: number, fill: number) =>
    Buffer.from(new Uint8Array(length).fill(fill)).toString('base64url');
const USER = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
const ADMIN = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const GROUP = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

/* The keys the server serves, made of four fill bytes. */
const served = (
    [x, ed, mlDsa, kem]: [number, number, number, number],
    keyVersion = 1,
): {
    keyVersion: number;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKey: string | null;
    kemPublicKey: string | null;
} => ({
    keyVersion,
    encryptionPublicKey: b64(32, x),
    signingPublicKey: b64(32, ed),
    mlDsaPublicKey: b64(1952, mlDsa),
    kemPublicKey: b64(1184, kem),
});
const pin = async (
    fills: [number, number, number, number],
    form: 'verified' | 'seen',
    keyVersion = 1,
) => pinKeysOfServed(served(fills, keyVersion) as never, form);
const commitment = async (fills: [number, number, number, number]) =>
    (await keyCommitment(await pin(fills, 'seen')))!;

const K1: [number, number, number, number] = [1, 2, 3, 4];
const K2: [number, number, number, number] = [9, 10, 11, 12];
const C1 = await commitment(K1);
const C2 = await commitment(K2);
const seen1 = await pin(K1, 'seen');
const verified1 = await pin(K1, 'verified');
const { mlDsaPublicKeyHash: _ml, kemPublicKeyHash: _kem, ...classical1 } = seen1;

const trust = [
    { name: 'verified', pin: verified1, trust: 'verified', commitment: C1 },
    { name: 'first-seen', pin: seen1, trust: 'seen', commitment: C1 },
    {
        name: 'first-seen with a fingerprint over other keys written in',
        pin: { ...seen1, fingerprint: (await pin(K2, 'verified')).fingerprint },
        trust: 'invalid',
        commitment: C1,
    },
    {
        name: 'first-seen with a blank that is not empty',
        pin: { ...seen1, fingerprint: ' ' },
        trust: 'invalid',
        commitment: C1,
    },
    {
        name: 'legacy: no lattice digests',
        pin: { ...classical1, fingerprint: verified1.fingerprint },
        trust: 'legacy',
        commitment: null,
    },
    {
        name: 'legacy: an empty ML-DSA digest',
        pin: { ...seen1, mlDsaPublicKeyHash: '' },
        trust: 'legacy',
        commitment: null,
    },
    {
        name: 'no ML-KEM digest',
        pin: { ...seen1, kemPublicKeyHash: null },
        trust: 'invalid',
        commitment: null,
    },
    {
        name: 'an upper-case digest',
        pin: { ...(await pin([1, 2, 3, 0xab], 'seen')), kemPublicKeyHash: 'AB'.repeat(32) },
        trust: 'invalid',
        commitment: null,
    },
    {
        name: 'a padded key',
        pin: { ...seen1, signingPublicKey: `${seen1.signingPublicKey}=` },
        trust: 'invalid',
        commitment: null,
    },
];

const comparisons = [
    { name: 'first-seen, the same keys', pin: seen1, served: served(K1), expected: 'same' },
    { name: 'verified, the same keys', pin: verified1, served: served(K1), expected: 'same' },
    {
        name: 'first-seen, another ML-DSA key',
        pin: seen1,
        served: { ...served(K1), mlDsaPublicKey: b64(1952, 7) },
        expected: 'changed',
    },
    {
        name: 'first-seen, another ML-KEM key',
        pin: seen1,
        served: { ...served(K1), kemPublicKey: b64(1184, 7) },
        expected: 'changed',
    },
    {
        name: 'first-seen, no ML-DSA key',
        pin: seen1,
        served: { ...served(K1), mlDsaPublicKey: null },
        expected: 'changed',
    },
    {
        name: 'first-seen, other keys at a higher version',
        pin: seen1,
        served: served(K2, 2),
        expected: 'succession',
    },
    {
        name: 'first-seen, other keys at the same version',
        pin: seen1,
        served: served(K2, 1),
        expected: 'changed',
    },
    {
        name: 'first-seen, other keys at a higher version without an ML-KEM key',
        pin: seen1,
        served: { ...served(K2, 2), kemPublicKey: null },
        expected: 'changed',
    },
    {
        name: 'legacy, the same classical keys',
        pin: { ...classical1, fingerprint: verified1.fingerprint },
        served: served(K1),
        expected: 'recheck',
    },
    {
        name: 'legacy, other keys at a higher version',
        pin: { ...classical1, fingerprint: verified1.fingerprint },
        served: served(K2, 2),
        expected: 'changed',
    },
    {
        name: 'invalid, other keys at a higher version: never followed',
        pin: { ...seen1, fingerprint: (await pin(K2, 'verified')).fingerprint },
        served: served(K2, 2),
        expected: 'changed',
    },
];

/*
 * A canonical base64url key written another way that a lenient decoder reads as the same bytes:
 * with padding, or with the last character's spare bits set (Codex review of #206, P2).
 */
const padded = (key: string) => `${key}=`;
const spareBits = (key: string) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(key.at(-1)!);
    return key.slice(0, -1) + alphabet[last + 1];
};
for (const [what, change] of [
    ['padded', padded],
    ['with spare bits set', spareBits],
] as const) {
    comparisons.push(
        {
            name: `first-seen, the same ML-DSA key ${what}: never the same keys`,
            pin: seen1,
            served: { ...served(K1), mlDsaPublicKey: change(served(K1).mlDsaPublicKey!) },
            expected: 'changed',
        },
        {
            name: `first-seen, the same ML-KEM key ${what}: never the same keys`,
            pin: seen1,
            served: { ...served(K1), kemPublicKey: change(served(K1).kemPublicKey!) },
            expected: 'changed',
        },
        {
            name: `verified, the same ML-DSA key ${what}: never the same keys`,
            pin: verified1,
            served: { ...served(K1), mlDsaPublicKey: change(served(K1).mlDsaPublicKey!) },
            expected: 'changed',
        },
    );
}

const servedPins = [
    { name: 'first-seen', served: served(K1, 3), form: 'seen', expected: await pin(K1, 'seen', 3) },
    {
        name: 'verified',
        served: served(K1, 3),
        form: 'verified',
        expected: await pin(K1, 'verified', 3),
    },
    {
        name: 'a padded key',
        served: { ...served(K1), signingPublicKey: `${b64(32, 2)}=` },
        form: 'seen',
        expected: null,
    },
    {
        name: 'an ML-KEM key one byte short',
        served: { ...served(K1), kemPublicKey: b64(1183, 4) },
        form: 'seen',
        expected: null,
    },
    {
        name: 'an ML-DSA key with its spare bits set',
        served: { ...served(K1), mlDsaPublicKey: spareBits(b64(1952, 3)) },
        form: 'seen',
        expected: null,
    },
    {
        name: 'a padded ML-KEM key',
        served: { ...served(K1), kemPublicKey: padded(b64(1184, 4)) },
        form: 'seen',
        expected: null,
    },
    {
        name: 'key version 0',
        served: served(K1, 0),
        form: 'seen',
        expected: null,
    },
];

/* This device's guard entry for the person: the keys of K1, as it last acted on them. */
const guard = {
    revision: 3,
    keyVersion: 1,
    encryptionPublicKey: seen1.encryptionPublicKey,
    signingPublicKey: seen1.signingPublicKey,
    mlDsaPublicKeyHash: seen1.mlDsaPublicKeyHash,
    kemPublicKeyHash: seen1.kemPublicKeyHash,
    previousSigningKeys: [],
    verified: false,
};
const guards = [
    { name: 'no entry: first use', guard: null, pin: seen1, expected: 'first-use' },
    { name: 'no entry and no pin: first use', guard: null, pin: null, expected: 'first-use' },
    { name: 'unreadable: never first use', guard: 'unreadable', pin: seen1, expected: 'unchecked' },
    { name: 'the guard’s keys, first-seen', guard, pin: seen1, expected: 'agrees' },
    { name: 'the guard’s keys, verified', guard, pin: verified1, expected: 'agrees' },
    {
        name: 'a stale verified pin of other keys',
        guard,
        pin: await pin(K2, 'verified'),
        expected: 'changed',
    },
    { name: 'other keys, first-seen', guard, pin: await pin(K2, 'seen'), expected: 'changed' },
    {
        name: 'only the ML-KEM key moved',
        guard,
        pin: await pin([1, 2, 3, 12], 'seen'),
        expected: 'changed',
    },
    { name: 'the pin dropped from the settings', guard, pin: null, expected: 'changed' },
    {
        name: 'a legacy pin of the guard’s classical keys',
        guard,
        pin: { ...classical1, fingerprint: verified1.fingerprint },
        expected: 'changed',
    },
    {
        name: 'the guard’s keys under a forged fingerprint',
        guard,
        pin: { ...seen1, fingerprint: (await pin(K2, 'verified')).fingerprint },
        expected: 'changed',
    },
];

const entry = (admits: unknown) => ({
    v: 1,
    id: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
    groupId: GROUP,
    route: { kind: 'admit', userId: USER },
    body: { expectedRevision: 3 },
    stagedEnvelope: '',
    state: 'ready',
    attempts: 0,
    joinCode: null,
    ...(admits === undefined ? {} : { admits }),
});
const admissions = [
    {
        name: 'staged over the pin’s keys',
        entry: entry({ userId: USER, keys: C1 }),
        pin: { userId: USER, keys: C1 },
        expected: 'send',
    },
    {
        name: 'the pin moved to other keys',
        entry: entry({ userId: USER, keys: C1 }),
        pin: { userId: USER, keys: C2 },
        expected: 'hold',
    },
    {
        name: 'from before: a fingerprint that is the pin’s key commitment',
        entry: entry({ userId: USER, fingerprint: C1 }),
        pin: { userId: USER, keys: C1 },
        expected: 'send',
    },
    {
        name: 'from before: a fingerprint over other keys',
        entry: entry({ userId: USER, fingerprint: C2 }),
        pin: { userId: USER, keys: C1 },
        expected: 'hold',
    },
    {
        name: 'a first-seen fingerprint against a first-seen fingerprint',
        entry: entry({ userId: USER, fingerprint: '' }),
        pin: { userId: USER, keys: '' },
        expected: 'hold',
    },
    {
        name: 'a first-seen fingerprint against keys',
        entry: entry({ userId: USER, fingerprint: '' }),
        pin: { userId: USER, keys: C1 },
        expected: 'hold',
    },
    {
        name: 'both fields: keys decide, against the fingerprint’s keys',
        entry: entry({ userId: USER, keys: C2, fingerprint: C1 }),
        pin: { userId: USER, keys: C1 },
        expected: 'hold',
    },
    {
        name: 'both fields: keys decide, against their own',
        entry: entry({ userId: USER, keys: C2, fingerprint: C1 }),
        pin: { userId: USER, keys: C2 },
        expected: 'send',
    },
    {
        name: 'keys that are not a string: no fall back to the fingerprint',
        entry: entry({ userId: USER, keys: null, fingerprint: C1 }),
        pin: { userId: USER, keys: C1 },
        expected: 'hold',
    },
    {
        name: 'no admits at all',
        entry: entry(undefined),
        pin: { userId: USER, keys: C1 },
        expected: 'hold',
    },
    {
        name: 'no pin of them',
        entry: entry({ userId: USER, keys: C1 }),
        pin: null,
        expected: 'hold',
    },
    {
        name: 'admits names someone else',
        entry: entry({ userId: ADMIN, keys: C1 }),
        pin: { userId: USER, keys: C1 },
        expected: 'hold',
    },
];

const app = {
    userId: USER,
    email: 'maya@example.com',
    name: 'Maya',
    pinnedAt: '2026-10-26T10:00:00.000Z',
};
const { fingerprint: _print, ...unprinted } = seen1;
const readers = {
    shapes: {
        'ios-0.10.0': {
            source: 'apps/ios/Packages/HushOSKit/Sources/HushOSKit/Contacts.swift at v0.10.0: ContactPin, Codable, decoded per pin by JSONDecoder in Settings.swift (a pin that fails is skipped); verified is the core’s pin_verified over the decoded fields',
            required: {
                userId: 'string',
                email: 'string',
                name: 'string',
                encryptionPublicKey: 'string',
                signingPublicKey: 'string',
                fingerprint: 'string',
                pinnedAt: 'string',
            },
            optional: {
                kemPublicKeyHash: 'string',
                mlDsaPublicKeyHash: 'string',
                keyVersion: 'u64',
                previousSigningKeys: 'string[]',
                keysReplacedAt: 'string',
                resealShares: 'bool',
                trustedVia: 'string',
            },
        },
        'android-0.10.0': {
            source: 'apps/android/app/src/main/kotlin/com/hushos/app/data/Contacts.kt at v0.10.0: ContactPin.from, getString for userId and encryptionPublicKey (present), optString for the rest ("" when absent; the digests null when absent, null or ""); verified is the core’s pinVerified over them',
            required: { userId: 'present', encryptionPublicKey: 'present' },
            optional: {},
        },
    },
    cases: [
        {
            name: 'a first-seen pin as adding someone writes it',
            pin: { ...app, ...seen1, firstSeen: 'added' },
            ios: { decodes: true, verified: false },
            android: { decodes: true, verified: false },
        },
        {
            name: 'a verified pin over the same keys',
            pin: { ...app, ...verified1 },
            ios: { decodes: true, verified: true },
            android: { decodes: true, verified: true },
        },
        {
            name: 'a first-seen pin without its fingerprint field, as no client writes it',
            pin: { ...app, ...unprinted, firstSeen: 'added' },
            ios: { decodes: false, verified: false },
            android: { decodes: true, verified: false },
        },
    ],
};

await writeFile(
    fixture,
    `${JSON.stringify(
        {
            about: 'First-seen pins (docs/optional-verification.md 2): pinTrust/pin_trust and keyCommitment/key_commitment (`trust`), comparePin/compare_pin (`comparisons`), pinOfServed/pin_of_served (`servedPins`), guardAgrees/guard_agrees without a chain (`guards`), a kept admission read by readOutboxEntry/outbox_entry_read with the admin’s pin by its key commitment (`admissions`), and the 0.10.0 apps’ pin readers (`readers`). Written by packages/crypto/scripts/pin-cases.ts, outcomes stated by hand; read by packages/drive/src/pin-cases.test.ts and crates/hushos-core/tests/pin_cases.rs.',
            groupId: GROUP,
            trust,
            comparisons,
            servedPins,
            guards,
            admissions,
            readers,
        },
        null,
        4,
    )}\n`,
);
console.log('wrote', fixture.pathname);
