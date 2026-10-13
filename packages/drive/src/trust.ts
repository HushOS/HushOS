import type { DriveSigners } from '@hushos/crypto';
import type { ContactPin } from '@hushos/crypto/contacts';
import { fingerprint, keyDigest, publicKeyBytes } from '@hushos/crypto/fingerprint';
import { pinVerified } from '@hushos/crypto/pins';
import type { Integrity, SignatureForm } from '@hushos/crypto/signatures';
import type { NodeView, ServedIdentity, Signer, VersionView } from './api';

/*
 * What a person trusts, as the Drive client needs it: who may have written a
 * record (the signers driveVerify checks against), how a pin follows a
 * contact's signed succession, and what an item's checks come to on screen.
 * Pure, Web Crypto only, so it runs on the main thread and in tests alike.
 */

export type { Integrity, SignatureForm };

/*
 * The statement a record written again is signed with, from what the original
 * checked as (docs/integrity-design.md, "Saved copies, by where they came
 * from"). A copy saved from a link is `saved`, whatever the original was: a
 * visitor has nothing to check it against. Otherwise, for a copy, a rename or
 * a folder recreated by a copy: a verified original stays ordinary, one that
 * verified as saved from a link stays saved, and anything else (Unverified,
 * Couldn't check, re-sealed, retired keys, never checked) is re-sealed, so
 * writing it again never turns it into a record this person vouches for.
 */
export function signatureFormFor(
    prior: Integrity | null | undefined,
    source: 'link' | 'drive' = 'drive',
): SignatureForm {
    if (source === 'link') return 'saved';
    if (prior === 'verified') return 'ordinary';
    if (prior === 'saved-from-link') return 'saved';
    return 'resealed';
}

/* Both records of a file written again from `node` (see signatureFormFor): its metadata and its current version. */
export function copySignatureForms(
    node: { kind: 'folder' | 'file'; integrity: NodeIntegrity | null },
    source: 'link' | 'drive',
): { metadata: SignatureForm; version: SignatureForm } {
    return {
        metadata: signatureFormFor(node.integrity?.metadata, source),
        version: signatureFormFor(
            node.kind === 'file' ? node.integrity?.version : node.integrity?.metadata,
            source,
        ),
    };
}

/*
 * A pin after a followed succession, as every client keeps it:
 * `previousSigningKeys`, the signing keys it held before, oldest first
 * (records signed with them read as `retired-key`, never verified, and a
 * share signed with them does not open), and `keysReplacedAt`, when it followed.
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
 * one: a verified pin's current key, which alone can verify a record, and the
 * earlier ones it followed a chain from, which only say `retired-key`. A pin
 * made before the words covered both keys vouches for nothing.
 */
export type { DriveSigners };
export async function signersFromPins(contacts: Record<string, Pin>): Promise<DriveSigners> {
    const signers: DriveSigners = {};
    for (const pin of Object.values(contacts)) {
        if (!(await pinVerified(pin))) continue;
        signers[pin.userId] = {
            current: pin.signingPublicKey,
            retired: [...(pin.previousSigningKeys ?? [])],
        };
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
 * The key a granter's share must be signed with: the pin's current signing
 * key and nothing else. Keys the pin followed a succession from were replaced
 * because they may be exposed, so a share signed with one waits for the
 * granter to seal it again ("Ask them to share it again").
 */
export function granterKeysOf(pin: Pin) {
    return { signingPublicKey: pin.signingPublicKey };
}

/* An item's checks: its metadata, and its current version when it has one; null when not checked. */
export type NodeIntegrity = { metadata: Integrity; version: Integrity | null };

/* One record that did not verify, who the server says wrote it, and what it is. */
export type IntegrityIssue = {
    record: 'metadata' | 'version';
    integrity: Exclude<Integrity, 'verified' | 'saved-from-link'>;
    signer: Signer | null;
};

/*
 * Why an item is shown as Unverified, worst first: a bad signature, then a
 * retired key, an unknown signer, no signature, a re-sealed record, and a
 * check that could not run. `unsigned` is an issue like any other (a stripped
 * signature and one never made read the same). A copy saved from a link
 * (`saved-from-link`) is no issue: it carries no mark, only a neutral line in
 * Info. Empty only when everything verified or was saved, or when there was nothing to check (null integrity: a link view,
 * an item that would not open). One mark per item, however many records failed.
 */
export function integrityIssues(
    node: Pick<NodeView, 'metadataSigner'> & {
        currentVersion: Pick<VersionView, 'signer'> | null;
        integrity: NodeIntegrity | null;
    },
): IntegrityIssue[] {
    if (!node.integrity) return [];
    const issues: IntegrityIssue[] = [];
    const metadata = node.integrity.metadata;
    if (metadata !== 'verified' && metadata !== 'saved-from-link')
        issues.push({
            record: 'metadata',
            integrity: metadata,
            signer: node.metadataSigner ?? null,
        });
    const version = node.integrity.version;
    if (version !== null && version !== 'verified' && version !== 'saved-from-link')
        issues.push({
            record: 'version',
            integrity: version,
            signer: node.currentVersion?.signer ?? null,
        });
    const rank: Record<IntegrityIssue['integrity'], number> = {
        'bad-signature': 0,
        'retired-key': 1,
        'unknown-signer': 2,
        unsigned: 3,
        resealed: 4,
        unchecked: 5,
    };
    return issues.sort((a, b) => rank[a.integrity] - rank[b.integrity]);
}
