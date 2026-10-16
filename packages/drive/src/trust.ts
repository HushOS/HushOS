import type { DriveSigners, GroupIntegrity } from '@hushos/crypto';
import type { ContactPin } from '@hushos/crypto/contacts';
import { fingerprintOfKeys, keyDigest, publicKeyBytes } from '@hushos/crypto/fingerprint';
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
 * A record's verdict wherever it is read: a personal one, or inside a
 * family's folders one of the two only a member list gives (design 2.8):
 * `key-conflict`, the writer's keys are not the ones this person checked and
 * no signed chain joins them, worse than Unverified; `former-member`, a valid
 * signature by someone the member list marks as having left, drawn as
 * Unverified.
 */
export type RecordIntegrity = GroupIntegrity;

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
    prior: RecordIntegrity | null | undefined,
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
    /*
     * The web's own, beside `trustedVia`: the name of the family whose member
     * list the pin was taken from ("Trust as Lindqvist family does"), so it is
     * shown as that family's word wherever the pin appears.
     */
    trustedViaFamily?: string;
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
 * What a pin says about the keys the server serves for that person now
 * (docs/identity-pq-design.md 2):
 * - same: a version 3 pin, and the served X25519 and Ed25519 keys are the
 *   pinned ones and the served ML-DSA and ML-KEM keys match its digests;
 * - recheck: a pin from before the release (no ML-DSA digest) over the same
 *   X25519 and Ed25519 keys: the person upgraded, and only comparing words
 *   again trusts them ("Check words again"); until then, nothing is trusted;
 * - succession: other keys at a higher key version, so a signed chain from a
 *   version 3 pin may explain it;
 * - changed: anything else, including a served identity with no ML-DSA key, or
 *   one whose ML-DSA or ML-KEM key differs, beside the pinned classical keys.
 */
export type PinComparison = 'same' | 'recheck' | 'succession' | 'changed';
export type ServedKeys = Pick<
    ServedIdentity,
    'keyVersion' | 'encryptionPublicKey' | 'signingPublicKey' | 'mlDsaPublicKey' | 'kemPublicKey'
>;
export async function comparePin(pin: Pin, served: ServedKeys): Promise<PinComparison> {
    const sameKeys =
        pin.encryptionPublicKey === served.encryptionPublicKey &&
        pin.signingPublicKey === served.signingPublicKey;
    const verified = await pinVerified(pin);
    if (sameKeys) {
        if (!verified) return 'recheck';
        if (!served.mlDsaPublicKey || !served.kemPublicKey) return 'changed';
        const [mlDsa, kem] = await Promise.all([
            digestOf(served.mlDsaPublicKey),
            digestOf(served.kemPublicKey),
        ]);
        return mlDsa === pin.mlDsaPublicKeyHash && kem === pin.kemPublicKeyHash
            ? 'same'
            : 'changed';
    }
    // A succession is always to a version 2 identity, and only a version 3 pin passes trust on.
    if (!served.mlDsaPublicKey || !served.kemPublicKey) return 'changed';
    // A pin with no version: the chain is then looked for from 1.
    if (served.keyVersion > (pin.keyVersion ?? 1) && verified) return 'succession';
    return 'changed';
}

/* SHA-256 (hex) of a base64url public key, or null when it does not decode. */
async function digestOf(publicKey: string) {
    try {
        return await keyDigest(publicKeyBytes(publicKey));
    } catch {
        return null;
    }
}

/*
 * A version 3 pin of the served keys, as comparing words writes it: the
 * X25519 and Ed25519 keys, the digests of the ML-DSA and ML-KEM keys, and the
 * version 3 fingerprint over all four (docs/identity-pq-design.md 2).
 */
export async function pinOfServed(
    served: ServedKeys & { mlDsaPublicKey: string; kemPublicKey: string },
) {
    return {
        encryptionPublicKey: served.encryptionPublicKey,
        signingPublicKey: served.signingPublicKey,
        mlDsaPublicKeyHash: await keyDigest(publicKeyBytes(served.mlDsaPublicKey)),
        kemPublicKeyHash: await keyDigest(publicKeyBytes(served.kemPublicKey)),
        fingerprint: await fingerprintOfKeys(
            publicKeyBytes(served.encryptionPublicKey),
            publicKeyBytes(served.signingPublicKey),
            publicKeyBytes(served.mlDsaPublicKey),
            publicKeyBytes(served.kemPublicKey),
        ),
        keyVersion: served.keyVersion,
    };
}

/*
 * The Ed25519 keys a verified succession chain passed through, oldest first:
 * the old signing key of every link from where the chain starts. It starts as
 * the core's verifySuccessionChain does, at the first link whose old X25519,
 * Ed25519 and ML-DSA keys (by digest) are the pin's, so a decoy link served in
 * front of the real chain adds nothing. Only call it with a chain that held.
 */
export async function keysPassedThrough(
    pin: Pin,
    links: {
        oldEncryptionPublicKey: string;
        oldSigningPublicKey: string;
        oldMlDsaPublicKey: string;
    }[],
) {
    for (let index = 0; index < links.length; index++) {
        const link = links[index]!;
        if (
            link.oldEncryptionPublicKey === pin.encryptionPublicKey &&
            link.oldSigningPublicKey === pin.signingPublicKey &&
            (await digestOf(link.oldMlDsaPublicKey)) === pin.mlDsaPublicKeyHash
        )
            return links.slice(index).map((each) => each.oldSigningPublicKey);
    }
    return [];
}

/*
 * The pin after a succession chain from it to the served keys verified: the
 * served keys as a version 3 pin, and every signing key it held or the chain
 * passed through kept beside them (`passed`, from keysPassedThrough), but
 * never the served one, which is current, not previous. The pinned key is
 * kept whatever `passed` holds, so a start keysPassedThrough failed to find
 * cannot drop it. Only call it with a chain that held.
 */
export async function pinAfterSuccession(
    pin: Pin,
    served: ServedKeys & { mlDsaPublicKey: string; kemPublicKey: string },
    now: Date,
    passed: string[],
): Promise<Pin> {
    const previous = (pin.previousSigningKeys ?? []).filter(
        (key) => key !== served.signingPublicKey,
    );
    for (const key of [pin.signingPublicKey, ...passed])
        if (key !== served.signingPublicKey && !previous.includes(key)) previous.push(key);
    return {
        ...pin,
        ...(await pinOfServed(served)),
        previousSigningKeys: previous,
        keysReplacedAt: now.toISOString(),
        resealShares: true,
    };
}

/*
 * The keys a granter's share must be signed with: the pin's current Ed25519
 * key, and the served ML-DSA key only if its digest is the pin's. Keys the pin
 * followed a succession from were replaced because they may be exposed, so a
 * share signed with one waits for the granter to seal it again ("Ask them to
 * share it again"). Null when the served ML-DSA key is not the pinned one.
 */
export async function granterKeysOf(pin: Pin, served: Pick<ServedIdentity, 'mlDsaPublicKey'>) {
    if (!pin.mlDsaPublicKeyHash || !served.mlDsaPublicKey) return null;
    if ((await digestOf(served.mlDsaPublicKey)) !== pin.mlDsaPublicKeyHash) return null;
    return { signingPublicKey: pin.signingPublicKey, mlDsaPublicKey: served.mlDsaPublicKey };
}

/*
 * An item's checks: its metadata, and its current version when it has one;
 * null when not checked. `via`, only inside a family's folders: the group
 * whose member list vouched for each verified record ("Verified by Lindqvist
 * family"), null for one this person's own words check vouched for.
 */
export type NodeIntegrity = {
    metadata: RecordIntegrity;
    version: RecordIntegrity | null;
    via?: { metadata: string | null; version: string | null };
};

/* One record that did not verify, who the server says wrote it, and what it is. */
export type IntegrityIssue = {
    record: 'metadata' | 'version';
    integrity: Exclude<RecordIntegrity, 'verified' | 'saved-from-link'>;
    signer: Signer | null;
};

/*
 * Why an item is shown as Unverified, worst first: keys that conflict with
 * this person's own check (family folders only), a bad signature, then a
 * retired key, a former member's record (family folders only), an unknown
 * signer, no signature, a re-sealed record, and a check that could not run. `unsigned` is an issue like any other (a stripped
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
        'key-conflict': 0,
        'bad-signature': 1,
        'retired-key': 2,
        'former-member': 3,
        'unknown-signer': 4,
        unsigned: 5,
        resealed: 6,
        unchecked: 7,
    };
    return issues.sort((a, b) => rank[a.integrity] - rank[b.integrity]);
}
