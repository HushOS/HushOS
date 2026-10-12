import type { ContactPin } from '@hushos/crypto/contacts';
import { fingerprint, keyDigest, publicKeyBytes } from '@hushos/crypto/fingerprint';
import { pinVerified } from '@hushos/crypto/pins';
import type { Integrity } from '@hushos/crypto/signatures';
import type { NodeView, ServedIdentity, Signer, VersionView } from './api';

/*
 * What a person trusts, as the Drive client needs it: who may have written a
 * record (the signers driveVerify checks against), how a pin follows a
 * contact's signed succession, and what an item's checks come to on screen.
 * Pure, Web Crypto only, so it runs on the main thread and in tests alike.
 */

export type { Integrity };

/*
 * A pin after a followed succession, as every client keeps it:
 * `previousSigningKeys`, the signing keys it held before, oldest first
 * (records signed before the succession stay signed by them, and a share
 * signed then opens only with them), and `keysReplacedAt`, when it followed.
 * Both survive every rewrite of the pin but a words check of brand-new keys.
 * The web adds two fields of its own: `replacementSeen`, the `keysReplacedAt`
 * the person dismissed or compared words after, and `resealShares`, set while
 * what this person shared with the contact waits to be sealed to the new
 * keys. Every client keeps fields it does not know when it saves.
 */
export type Pin = ContactPin & {
    previousSigningKeys?: string[];
    keysReplacedAt?: string | null;
    replacementSeen?: string | null;
    resealShares?: boolean;
};

/* Whether People should still say this contact replaced their keys. */
export function replacementUnseen(pin: Pin) {
    return Boolean(pin.keysReplacedAt) && pin.keysReplacedAt !== pin.replacementSeen;
}

/*
 * The signing keys driveVerify may accept for each account other than this
 * one: a verified pin's current key and the earlier ones it followed a chain
 * from. A pin made before the words covered both keys vouches for nothing.
 */
export async function signersFromPins(contacts: Record<string, Pin>) {
    const signers: Record<string, string[]> = {};
    for (const pin of Object.values(contacts)) {
        if (!(await pinVerified(pin))) continue;
        signers[pin.userId] = [pin.signingPublicKey, ...(pin.previousSigningKeys ?? [])];
    }
    return signers;
}

/*
 * What a pin says about the keys the server serves for that person now:
 * - same: the pinned keys, KEM key included once one is pinned;
 * - succession: other keys at a higher key version, so a signed chain from
 *   the pinned ones may explain it (only from a verified pin: an unchecked
 *   pin cannot pass its trust on);
 * - changed: anything else, which only a fresh words check can accept.
 */
export type PinComparison = 'same' | 'succession' | 'changed';
/*
 * Keys as the server serves them. `kem` is undefined where the server does not
 * serve it (a share's granter), and then only the chain can vouch for one.
 */
export type ServedKeys = Pick<
    ServedIdentity,
    'keyVersion' | 'encryptionPublicKey' | 'signingPublicKey'
> & { kem?: ServedIdentity['kem'] };
export async function comparePin(pin: Pin, served: ServedKeys): Promise<PinComparison> {
    const sameKeys =
        pin.encryptionPublicKey === served.encryptionPublicKey &&
        pin.signingPublicKey === served.signingPublicKey;
    if (sameKeys) {
        if (!pin.kemPublicKeyHash || served.kem === undefined) return 'same';
        if (!served.kem) return 'changed';
        return (await keyDigest(publicKeyBytes(served.kem.publicKey))) === pin.kemPublicKeyHash
            ? 'same'
            : 'changed';
    }
    // A succession always mints a KEM key, so a served identity without one is no successor.
    if (served.kem === null) return 'changed';
    // A pin made before successions records no version: the chain is then looked for from 1.
    if (served.keyVersion > (pin.keyVersion ?? 1) && (await pinVerified(pin))) return 'succession';
    return 'changed';
}

/*
 * The pin after a succession chain from it to the served keys verified: the
 * served keys, their fingerprint and KEM digest, the key version, and the
 * keys it held before kept beside them. Only call it with a chain that held.
 */
export async function pinAfterSuccession(
    pin: Pin,
    served: Pick<ServedIdentity, 'keyVersion' | 'encryptionPublicKey' | 'signingPublicKey'>,
    /* The new KEM key: as served, or as the chain's last link names it (its digest is signed). */
    kemPublicKey: string,
    now: Date,
): Promise<Pin> {
    return {
        ...pin,
        encryptionPublicKey: served.encryptionPublicKey,
        signingPublicKey: served.signingPublicKey,
        fingerprint: await fingerprint(
            publicKeyBytes(served.encryptionPublicKey),
            publicKeyBytes(served.signingPublicKey),
        ),
        kemPublicKeyHash: await keyDigest(publicKeyBytes(kemPublicKey)),
        keyVersion: served.keyVersion,
        previousSigningKeys: [...(pin.previousSigningKeys ?? []), pin.signingPublicKey],
        keysReplacedAt: now.toISOString(),
        resealShares: true,
    };
}

/*
 * The keys a granter's share may have been signed with, newest first: the
 * pin's, then the ones it followed a succession from, so a suite 3 share
 * signed before the granter's succession and not yet sealed again still
 * opens. Only the current X25519 key is kept, which is all suite 3 needs; a
 * suite 1 or 2 share from before a succession waits for the granter to seal
 * it again.
 */
export function granterKeysOf(pin: Pin) {
    return [pin.signingPublicKey, ...[...(pin.previousSigningKeys ?? [])].reverse()].map(
        (signingPublicKey) => ({ encryptionPublicKey: pin.encryptionPublicKey, signingPublicKey }),
    );
}

/* An item's checks: its metadata, and its current version when it has one; null when not checked. */
export type NodeIntegrity = { metadata: Integrity; version: Integrity | null };

/* One record that did not verify, who the server says wrote it, and what it is. */
export type IntegrityIssue = {
    record: 'metadata' | 'version';
    integrity: Exclude<Integrity, 'verified'>;
    signer: Signer | null;
};

/*
 * Why an item is shown as Unverified, worst first (a bad signature, then an
 * unknown signer, then no signature at all); empty when everything verified or
 * nothing was checked. One mark per item, however many records failed.
 */
export function integrityIssues(
    node: Pick<NodeView, 'metadataSigner'> & {
        currentVersion: Pick<VersionView, 'signer'> | null;
        integrity: NodeIntegrity | null;
    },
): IntegrityIssue[] {
    if (!node.integrity) return [];
    const issues: IntegrityIssue[] = [];
    if (node.integrity.metadata !== 'verified')
        issues.push({
            record: 'metadata',
            integrity: node.integrity.metadata,
            signer: node.metadataSigner ?? null,
        });
    if (node.integrity.version !== null && node.integrity.version !== 'verified')
        issues.push({
            record: 'version',
            integrity: node.integrity.version,
            signer: node.currentVersion?.signer ?? null,
        });
    const rank = { 'bad-signature': 0, 'unknown-signer': 1, unsigned: 2 } as const;
    return issues.sort((a, b) => rank[a.integrity] - rank[b.integrity]);
}
