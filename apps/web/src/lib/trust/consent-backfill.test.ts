import type { SuccessionLink } from '@hushos/crypto';
import type { IdentityEnvelope } from '@hushos/crypto/identity';
import { describe, expect, test } from 'vitest';
import { backfillConsent } from './consent-backfill';

/*
 * The consent backfill (F8; docs/groups-server.md 5). A link left without
 * consent leaves this person's own records unchecked in every family that
 * walks it; consent signed for the wrong pair of identities is refused by the
 * server (and by every family member's check); a link from a version 1
 * identity can never take consent (the server answers 409), so asking on every
 * open would only make noise.
 */

const keys = (version: number) => ({
    encryptionPublicKey: `x-${version}`,
    signingPublicKey: `ed-${version}`,
    mlDsaPublicKey: `ml-${version}`,
    kemPublicKey: `kem-${version}`,
});

function envelope(keyVersion: number, version: 1 | 2): IdentityEnvelope {
    const k = keys(keyVersion);
    return {
        version,
        keyVersion,
        encryptionPublicKey: k.encryptionPublicKey,
        signingPublicKey: k.signingPublicKey,
        ...(version === 2
            ? {
                  mlDsa: { publicKey: k.mlDsaPublicKey },
                  kem: { publicKey: k.kemPublicKey },
                  keysSignature: 'ks',
              }
            : {}),
    } as unknown as IdentityEnvelope;
}

function link(from: number, consent: string | null = null): SuccessionLink {
    const old = keys(from);
    const next = keys(from + 1);
    return {
        oldKeyVersion: from,
        newKeyVersion: from + 1,
        oldEncryptionPublicKey: old.encryptionPublicKey,
        oldSigningPublicKey: old.signingPublicKey,
        oldMlDsaPublicKey: old.mlDsaPublicKey,
        newEncryptionPublicKey: next.encryptionPublicKey,
        newSigningPublicKey: next.signingPublicKey,
        newMlDsaPublicKey: next.mlDsaPublicKey,
        newKemPublicKey: next.kemPublicKey,
        signature: 'sig',
        consent,
    };
}

function run(links: SuccessionLink[], own: IdentityEnvelope[]) {
    const signed: [number, number][] = [];
    const uploaded: [number, string][] = [];
    const done = backfillConsent({
        links: async () => links,
        identities: async () => ({ identity: own.at(-1)!, history: own.slice(0, -1) }),
        consent: async (_link, old, next) => {
            signed.push([old.keyVersion, next.keyVersion]);
            return `consent-${old.keyVersion}-${next.keyVersion}`;
        },
        upload: async (oldKeyVersion, consent) => {
            uploaded.push([oldKeyVersion, consent]);
            return { stored: true };
        },
    });
    return { done, signed, uploaded };
}

describe('the consent backfill', () => {
    test('signs only links without consent between two upgraded identities, and uploads each at its own key version', async () => {
        const own = [envelope(1, 1), envelope(2, 2), envelope(3, 2), envelope(4, 2)];
        const { done, signed, uploaded } = run([link(1), link(2), link(3, 'already-there')], own);
        expect(await done).toEqual({ stored: 1 });
        // 1 → 2 starts at a version 1 identity: no ML-DSA key to consent with.
        // 3 → 4 has consent: a stored one is never replaced, so it is not even asked.
        expect(signed).toEqual([[2, 3]]);
        expect(uploaded).toEqual([[2, 'consent-2-3']]);
    });

    test('never signs for a link whose keys are not this account’s own envelopes', async () => {
        const own = [envelope(2, 2), envelope(3, 2)];
        const swapped = { ...link(2), newSigningPublicKey: 'someone-else' };
        const { done, signed, uploaded } = run([swapped], own);
        expect(await done).toEqual({ stored: 0 });
        expect(signed).toEqual([]);
        expect(uploaded).toEqual([]);
    });
});
