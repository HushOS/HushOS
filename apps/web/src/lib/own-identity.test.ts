import { beforeEach, describe, expect, test } from 'vitest';
import { openOwnIdentity, type OpenedIdentity, type OwnIdentitySteps } from './own-identity';
import { IDENTITY_ROLLED_BACK } from './rollback-marks';

/*
 * The order a device opens its own identity in decides whether it ever signs
 * with a version 1 identity, mints a second ML-DSA key, or adopts an older
 * identity a server serves after another device won the upgrade. Each case
 * here is a server answer that would make one of those happen.
 */

type Envelope = Parameters<OwnIdentitySteps['open']>[0];
const v1 = { version: 1, keyVersion: 3 } as Envelope;
const v2 = { version: 2, keyVersion: 3, label: 'mine' } as unknown as Envelope;
const theirs = { version: 2, keyVersion: 3, label: 'other device' } as unknown as Envelope;

const openedFrom = (envelope: Envelope): OpenedIdentity => ({
    keyVersion: envelope.keyVersion,
    identityVersion: envelope.version,
    encryptionPublicKey: 'x',
    signingPublicKey: 'ed',
    mlDsaPublicKey:
        envelope.version === 2 ? `ml-dsa of ${(envelope as { label?: string }).label}` : null,
    kemPublicKey: 'kem',
});

/* `served` first, then `after` on every later read: what the server holds once another device won. */
function steps(
    served: Envelope,
    overrides: Partial<OwnIdentitySteps> = {},
    after: { identity: Envelope; history: Envelope[] } = { identity: theirs, history: [] },
) {
    const calls: string[] = [];
    let marks = { keyVersion: 0, identityVersion: 0 };
    const value: OwnIdentitySteps = {
        fetch: async () => {
            calls.push('fetch');
            return calls.filter((c) => c === 'fetch').length === 1
                ? { identity: served, history: [] }
                : after;
        },
        open: async (identity) => {
            calls.push(`open v${identity.version}`);
            return openedFrom(identity);
        },
        upgrade: async () => {
            calls.push('upgrade');
            return v2;
        },
        store: async (identity) => {
            calls.push('store');
            return identity;
        },
        seen: async () => marks,
        remember: async (keyVersion, identityVersion) => {
            marks = {
                keyVersion: Math.max(marks.keyVersion, keyVersion),
                identityVersion: Math.max(marks.identityVersion, identityVersion),
            };
        },
        ...overrides,
    };
    return { value, calls, marks: () => marks, setMarks: (m: typeof marks) => (marks = m) };
}

describe('opening this account’s identity', () => {
    let s: ReturnType<typeof steps>;
    beforeEach(() => {
        s = steps(v1);
    });

    test('a version 1 identity is upgraded, stored and reopened before it is used', async () => {
        const own = await openOwnIdentity(s.value);
        expect(s.calls).toEqual(['fetch', 'open v1', 'upgrade', 'store', 'open v2']);
        expect(own.identityVersion).toBe(2);
        expect(own.mlDsaPublicKey).toBe('ml-dsa of mine');
        expect(own.envelope).toBe(v2);
        expect(s.marks()).toEqual({ keyVersion: 3, identityVersion: 2 });
    });

    test('losing the race adopts the identity another device stored, never a second ML-DSA key', async () => {
        const lost = steps(v1, {
            store: async () => {
                throw Object.assign(new Error('upgraded elsewhere'), { status: 409 });
            },
        });
        const own = await openOwnIdentity(lost.value);
        expect(lost.calls).toEqual(['fetch', 'open v1', 'upgrade', 'fetch', 'open v2']);
        expect(own.mlDsaPublicKey).toBe('ml-dsa of other device');
    });

    test('the identity adopted after the race opens with the history read beside it', async () => {
        // The winner also replaced its keys since: the adopted identity is at the next key
        // version, and shares sealed to the one it replaced open only with that one.
        const replaced = { ...theirs, keyVersion: 3 } as Envelope;
        const opened: number[] = [];
        const lost = steps(
            v1,
            {
                store: async () => {
                    throw Object.assign(new Error('upgraded elsewhere'), { status: 409 });
                },
                open: async (identity, history) => {
                    opened.push(history.length);
                    return openedFrom(identity);
                },
            },
            { identity: { ...theirs, keyVersion: 4 } as Envelope, history: [replaced] },
        );
        const own = await openOwnIdentity(lost.value);
        expect(own.keyVersion).toBe(4);
        expect(opened).toEqual([0, 1]);
    });

    test('any other failure to store the upgrade stops without adopting anything', async () => {
        const failed = steps(v1, {
            store: async () => {
                throw Object.assign(new Error('server error'), { status: 500 });
            },
        });
        await expect(openOwnIdentity(failed.value)).rejects.toThrow('server error');
        expect(failed.calls.filter((c) => c === 'fetch')).toHaveLength(1);
        expect(failed.calls).not.toContain('open v2');
        expect(failed.marks()).toEqual({ keyVersion: 0, identityVersion: 0 });
    });

    test('once version 2 was seen, the version 1 form is refused and not upgraded again', async () => {
        s.setMarks({ keyVersion: 3, identityVersion: 2 });
        await expect(openOwnIdentity(s.value)).rejects.toThrow(IDENTITY_ROLLED_BACK);
        expect(s.calls).not.toContain('upgrade');
    });

    test('an identity the account replaced is never opened, so the worker never signs with it', async () => {
        // Still sealed under this account's root, it would open, and opening it makes it the
        // worker's identity whatever is thrown afterwards.
        const replaced = steps({ ...v2, keyVersion: 2 } as Envelope);
        replaced.setMarks({ keyVersion: 3, identityVersion: 2 });
        await expect(openOwnIdentity(replaced.value)).rejects.toThrow(IDENTITY_ROLLED_BACK);
        expect(replaced.calls).toEqual(['fetch']);
    });

    test('the identity adopted after the race is checked against the marks too', async () => {
        // This device had already seen version 2 at a later key version; the server then
        // serves the version 1 form as current and, after the 409, an older identity.
        const raced = steps(
            { ...v1, keyVersion: 4 } as Envelope,
            {
                store: async () => {
                    throw Object.assign(new Error('upgraded elsewhere'), { status: 409 });
                },
            },
            { identity: { ...theirs, keyVersion: 2 } as Envelope, history: [] },
        );
        raced.setMarks({ keyVersion: 3, identityVersion: 1 });
        await expect(openOwnIdentity(raced.value)).rejects.toThrow(IDENTITY_ROLLED_BACK);
        expect(raced.marks().identityVersion).toBe(1);
        // Refused before the worker opened it.
        expect(raced.calls).not.toContain('open v2');
    });

    test('a version 2 identity is opened as it is, with nothing upgraded', async () => {
        const already = steps(v2);
        const own = await openOwnIdentity(already.value);
        expect(already.calls).toEqual(['fetch', 'open v2']);
        expect(own.keyVersion).toBe(3);
    });

    test('a server that answers the upgrade with a version 1 identity gets no identity used', async () => {
        const stubborn = steps(v1, { store: async () => v1 });
        await expect(openOwnIdentity(stubborn.value)).rejects.toThrow(/could not be upgraded/);
        expect(stubborn.marks().identityVersion).toBe(0);
    });
});
