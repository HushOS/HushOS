import { fingerprint, hexBytes, publicKeyBytes } from '@hushos/crypto/fingerprint';
import type { Pin } from '@hushos/drive/trust';
import { describe, expect, test } from 'vitest';
import type { GroupContext } from './context';
import { groupWriters } from './writers';

/*
 * The writers a family folder's verdicts are judged by (design 2.8). The worker
 * reads a pin's origin as part of the pin: `trustedVia: null` is this person's
 * own words check, a group id is that family's word, and a missing origin is
 * no verdict at all. A pin that is not version 3 vouches for nothing and must
 * never reach the worker as one.
 */
const GROUP = 'b0000000-0000-4000-8000-000000000001';
const SAM = 'a0000000-0000-4000-8000-000000000004';
const ANA = 'a0000000-0000-4000-8000-000000000005';
const OUTSIDER = 'a0000000-0000-4000-8000-000000000006';

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const digest = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

/* A version 3 pin whose fingerprint holds, as comparing words writes it. */
async function v3Pin(userId: string, extra: Partial<Pin> = {}): Promise<Pin> {
    const encryptionPublicKey = key();
    const signingPublicKey = key();
    const mlDsaPublicKeyHash = digest();
    const kemPublicKeyHash = digest();
    return {
        userId,
        email: `${userId}@example.com`,
        name: userId,
        pinnedAt: '2026-10-17T00:00:00.000Z',
        keyVersion: 2,
        encryptionPublicKey,
        signingPublicKey,
        mlDsaPublicKeyHash,
        kemPublicKeyHash,
        fingerprint: await fingerprint(
            publicKeyBytes(encryptionPublicKey),
            publicKeyBytes(signingPublicKey),
            hexBytes(mlDsaPublicKeyHash),
            hexBytes(kemPublicKeyHash),
        ),
        ...extra,
    };
}

/* Route 6 serving these members (an identity of null: an account that is gone). */
function context(members: { userId: string; identity: boolean }[], fails = false) {
    return {
        api: {
            identities: async () => {
                if (fails) throw new Error('unavailable');
                return {
                    identities: members.map(({ userId, identity }) => ({
                        userId,
                        identity: identity
                            ? {
                                  keyVersion: 2,
                                  encryptionPublicKey: key(),
                                  signingPublicKey: key(),
                                  mlDsaPublicKey: 'ml-dsa',
                                  kemPublicKey: 'ml-kem',
                                  keysSignature: 'sig',
                              }
                            : null,
                        links: [],
                    })),
                    next: null,
                };
            },
        },
    } as unknown as GroupContext;
}

describe('family folder writers', () => {
    test('a pin from this person’s own words check reaches the worker with its origin as null, never missing', async () => {
        // Comparing words deletes the field (pinContact): the pin has no `trustedVia` at all.
        const pin = await v3Pin(SAM);
        const [sam] = await groupWriters(context([{ userId: SAM, identity: true }]), GROUP, {
            [SAM]: pin,
        });
        expect(sam!.pinned).not.toBeNull();
        expect(sam!.pinned!.trustedVia).toBeNull();
        expect(sam!.pinned).toEqual({
            keyVersion: 2,
            encryptionPublicKey: pin.encryptionPublicKey,
            signingPublicKey: pin.signingPublicKey,
            mlDsaPublicKeyHash: pin.mlDsaPublicKeyHash,
            trustedVia: null,
        });
        // The personal keys go too, for records the member list does not speak for.
        expect(sam!.personal).toEqual({ current: pin.signingPublicKey, retired: [] });
    });

    test('a server serving a member’s id in other letters never loses the pin that would raise a key conflict', async () => {
        const pin = await v3Pin(SAM);
        for (const served of [SAM.toUpperCase(), SAM]) {
            const contacts =
                served === SAM
                    ? { [SAM.toUpperCase()]: { ...pin, userId: SAM.toUpperCase() } }
                    : { [SAM]: pin };
            const writers = await groupWriters(
                context([{ userId: served, identity: true }]),
                GROUP,
                contacts,
            );
            // One writer, carrying the pin and the personal keys, whichever side the case is on.
            expect(writers, served).toHaveLength(1);
            expect(writers[0]!.pinned?.signingPublicKey, served).toBe(pin.signingPublicKey);
            expect(writers[0]!.personal?.current, served).toBe(pin.signingPublicKey);
            expect(writers[0]!.served, served).not.toBeNull();
        }
    });

    test('two pins of one member in different case: their own words check wins over a family’s word', async () => {
        const own = await v3Pin(SAM);
        const word = await v3Pin(SAM, { trustedVia: GROUP });
        for (const contacts of [
            { [SAM]: own, [SAM.toUpperCase()]: { ...word, userId: SAM.toUpperCase() } },
            { [SAM.toUpperCase()]: { ...word, userId: SAM.toUpperCase() }, [SAM]: own },
        ]) {
            const writers = await groupWriters(
                context([{ userId: SAM, identity: true }]),
                GROUP,
                contacts,
            );
            expect(writers).toHaveLength(1);
            expect(writers[0]!.pinned).toMatchObject({
                signingPublicKey: own.signingPublicKey,
                trustedVia: null,
            });
            expect(writers[0]!.personal?.current).toBe(own.signingPublicKey);
        }
    });

    test('a pin taken on a family’s word keeps that family as its origin', async () => {
        const [sam] = await groupWriters(context([{ userId: SAM, identity: true }]), GROUP, {
            [SAM]: await v3Pin(SAM, { trustedVia: GROUP }),
        });
        expect(sam!.pinned!.trustedVia).toBe(GROUP);
    });

    test('a first-seen pin (let in without words) reaches the worker as the family’s word, so other keys in their entry are a key conflict', async () => {
        const seen = { ...(await v3Pin(SAM)), fingerprint: '' };
        const [sam] = await groupWriters(context([{ userId: SAM, identity: true }]), GROUP, {
            [SAM]: seen,
        });
        expect(sam!.pinned).toEqual({
            keyVersion: seen.keyVersion,
            encryptionPublicKey: seen.encryptionPublicKey,
            signingPublicKey: seen.signingPublicKey,
            mlDsaPublicKeyHash: seen.mlDsaPublicKeyHash,
            trustedVia: GROUP,
        });
    });

    test('a pin older than version 3, or one whose fingerprint does not hold, is never passed', async () => {
        const v3 = await v3Pin(SAM);
        const older: Pin = {
            ...v3,
            mlDsaPublicKeyHash: null,
            kemPublicKeyHash: null,
            fingerprint: 'an older fingerprint',
        };
        const forged = await v3Pin(ANA, { fingerprint: v3.fingerprint });
        const writers = await groupWriters(
            context([
                { userId: SAM, identity: true },
                { userId: ANA, identity: true },
            ]),
            GROUP,
            { [SAM]: older, [ANA]: forged },
        );
        for (const writer of writers) {
            expect(writer.pinned, writer.userId).toBeNull();
            expect(writer.personal, writer.userId).toBeNull();
        }
    });

    test('what route 6 did not serve reads as not loaded, and contacts outside the family keep their personal keys', async () => {
        const outsider = await v3Pin(OUTSIDER);
        const gone = await groupWriters(context([{ userId: ANA, identity: false }]), GROUP, {
            [OUTSIDER]: outsider,
        });
        const ana = gone.find((writer) => writer.userId === ANA)!;
        expect(ana.served).toBeNull();
        expect(ana.links).toBeNull();
        const other = gone.find((writer) => writer.userId === OUTSIDER)!;
        expect(other).toMatchObject({ served: null, links: null });
        expect(other.pinned!.trustedVia).toBeNull();
        expect(other.personal).toEqual({ current: outsider.signingPublicKey, retired: [] });
        // Route 6 down: no member is served, so none of their keys can be vouched for or retired.
        const down = await groupWriters(context([], true), GROUP, { [SAM]: await v3Pin(SAM) });
        expect(down).toHaveLength(1);
        expect(down[0]).toMatchObject({ userId: SAM, served: null, links: null });
    });
});
