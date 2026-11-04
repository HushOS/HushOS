import type { DriveSigners, GroupIntegrity } from '@hushos/crypto';
import type { ContactPin } from '@hushos/crypto/contacts';
import { pinKeysOfServed, pinTrust, servedKeyDigest } from '@hushos/crypto/pins';
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
 * A verdict on the person a share would be sealed to (their account changed, they're not in Contacts, they can't be
 * sealed to yet, a succession nobody followed): the one refusal that may leave them out of a rotation, which makes the
 * server revoke their share. Anything else a check throws (a guard that can't be read or written, settings refused, no
 * network) says nothing about them and stops the rotation before it sends anything.
 */
export class GranteeRefusedError extends Error {
    override name = 'GranteeRefusedError';
}

/*
 * The statement a record written again is signed with, from what the original
 * checked as (docs/integrity-design.md, "Saved copies, by where they came
 * from"). A copy saved from a link is `saved`, whatever the original was: a
 * visitor has nothing to check it against. Otherwise, for a copy, a rename or
 * a folder recreated by a copy: a verified original stays ordinary, one that
 * verified as saved from a link stays saved, and anything else (Unverified,
 * Couldn't check, re-sealed, retired keys, never checked) is re-sealed, so
 * writing it again never turns it into a record this person vouches for. A
 * first-seen writer's record (`seen`) is written again as the copier's own,
 * as uploading a file they downloaded would be
 * (docs/optional-verification.md 2.6).
 */
export function signatureFormFor(
    prior: RecordIntegrity | null | undefined,
    source: 'link' | 'drive' = 'drive',
): SignatureForm {
    if (source === 'link') return 'saved';
    if (prior === 'verified' || prior === 'seen') return 'ordinary';
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
 * one: a pin's current key, which alone can make a record `verified` (a
 * verified pin) or `seen` (a first-seen pin, marked `seen`), and the earlier
 * ones it followed a chain from, which only say `retired-key`. A pin from
 * before post-quantum identities, or a malformed one, vouches for nothing.
 */
export type { DriveSigners };
export async function signersFromPins(contacts: Record<string, Pin>): Promise<DriveSigners> {
    const signers: DriveSigners = {};
    for (const pin of Object.values(contacts)) {
        const trust = await pinTrust(pin);
        if (trust !== 'verified' && trust !== 'seen') continue;
        signers[pin.userId] = {
            current: pin.signingPublicKey,
            retired: [...(pin.previousSigningKeys ?? [])],
            ...(trust === 'seen' ? { seen: true } : {}),
        };
    }
    return signers;
}

/*
 * What a pin says about the keys the server serves for that person now
 * (docs/identity-pq-design.md 2):
 * - same: a verified or first-seen pin (pinTrust), and the served X25519 and
 *   Ed25519 keys are the pinned ones and the served ML-DSA and ML-KEM keys
 *   match its digests;
 * - recheck: a pin from before the release (no ML-DSA digest), or a malformed
 *   one, over the same X25519 and Ed25519 keys: nothing is trusted through it
 *   until it is pinned again (firstSeenOfLegacy, or a words check);
 * - succession: other keys at a higher key version, so a signed chain from a
 *   verified or first-seen pin may explain it (a followed first-seen pin stays
 *   first-seen, pinAfterSuccession);
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
    const trust = await pinTrust(pin);
    const held = trust === 'verified' || trust === 'seen';
    if (sameKeys) {
        if (!held) return 'recheck';
        if (!served.mlDsaPublicKey || !served.kemPublicKey) return 'changed';
        const [mlDsa, kem] = await Promise.all([
            digestOf(served.mlDsaPublicKey),
            digestOf(served.kemPublicKey),
        ]);
        return mlDsa === pin.mlDsaPublicKeyHash && kem === pin.kemPublicKeyHash
            ? 'same'
            : 'changed';
    }
    // A succession is always to a version 2 identity, and only a verified or first-seen pin is
    // followed along one.
    if (!served.mlDsaPublicKey || !served.kemPublicKey) return 'changed';
    // A pin with no version: the chain is then looked for from 1.
    if (served.keyVersion > (pin.keyVersion ?? 1) && held) return 'succession';
    return 'changed';
}

/* SHA-256 (hex) of a canonical base64url public key, or null for anything else (servedKeyDigest). */
function digestOf(publicKey: string) {
    return servedKeyDigest(publicKey);
}

/*
 * A version 3 pin of the served keys: the X25519 and Ed25519 keys, the
 * digests of the ML-DSA and ML-KEM keys, and the fingerprint. `verified`, as
 * comparing words writes it, holds the version 3 fingerprint over all four
 * (docs/identity-pq-design.md 2); `seen`, a first-seen pin, holds `""`
 * (docs/optional-verification.md 2.2). Only call it with an identity whose
 * keys statement holds.
 */
export async function pinOfServed(
    served: ServedKeys & { mlDsaPublicKey: string; kemPublicKey: string },
    form: 'verified' | 'seen' = 'verified',
) {
    return pinKeysOfServed(served, form);
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
 * served keys as a version 3 pin of the same kind (a verified pin stays
 * verified, a first-seen one stays first-seen: following a chain signed by
 * keys nobody checked checks nothing), and every signing key it held or the
 * chain passed through kept beside them (`passed`, from keysPassedThrough),
 * but never the served one, which is current, not previous. The pinned key is
 * kept whatever `passed` holds, so a start keysPassedThrough failed to find
 * cannot drop it. Only call it with a chain that held, from a pin comparePin
 * said `succession` of.
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
    const trust = await pinTrust(pin);
    if (trust !== 'verified' && trust !== 'seen')
        throw new Error('Only a verified or first-seen pin follows a succession.');
    return {
        ...pin,
        ...(await pinOfServed(served, trust === 'verified' ? 'verified' : 'seen')),
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
 * A re-keyed record's second verdict (docs/integrity-design.md, "Re-keyed
 * records"): the record's own verdict is its origin's, named after `writer`,
 * the origin's signer; `by` is the re-keyer (the record's signer) and
 * `integrity` their verdict over the re-key; `bound` what the plaintexts
 * showed: true when they match, false when they differ (or the re-keyer's own
 * verified signature covers what failed to open), null when it could not be
 * confirmed. `via` as on NodeIntegrity, for the re-keyer.
 */
export type RekeyNote = {
    writer: Signer | null;
    by: Signer | null;
    integrity: RecordIntegrity;
    via?: string | null;
    bound: boolean | null;
};

/*
 * An item's checks: its metadata, and its current version when it has one;
 * null when not checked. `via`, only inside a family's folders: the group
 * whose member list vouched for each verified record ("Verified by Lindqvist
 * family"), null for one this person's own words check vouched for.
 * `rekeyed`, per record a rotation re-keyed: who wrote it and who locked it
 * again (RekeyNote); absent or null for a record no rotation kept.
 */
export type NodeIntegrity = {
    metadata: RecordIntegrity;
    version: RecordIntegrity | null;
    via?: { metadata: string | null; version: string | null };
    rekeyed?: { metadata: RekeyNote | null; version: RekeyNote | null };
};

/*
 * Why a re-keyed record carries a mark of its own making: `mismatch`, what was
 * locked again does not match what was written (`bound` false, said as the
 * re-keyer's fault only when their verified signature covers it); `unconfirmed`,
 * that could not be confirmed (`bound` null: a server can cause it alone);
 * `unattested`, the bytes match but the re-key is unsigned, badly signed, or
 * by someone whose keys conflict ("HushOS can't confirm who replaced the keys").
 */
export type RekeyCause = 'mismatch' | 'unconfirmed' | 'unattested';

/*
 * One record that did not verify, who the server says wrote it, and what it
 * is. A re-keyed record's issue names its writer (the origin's signer); one
 * with a re-key cause (`rekey`, saying why and how the re-keyer checked) names
 * the re-keyer only for a mismatch their verified signature covers, and
 * nobody (null) otherwise.
 */
export type IntegrityIssue = {
    record: 'metadata' | 'version';
    integrity: Exclude<RecordIntegrity, 'verified' | 'seen' | 'saved-from-link'>;
    signer: Signer | null;
    rekey?: { cause: RekeyCause; rekeyer: RecordIntegrity };
};

/*
 * The verdicts that are no issue at all: a verified record, a first-seen
 * writer's (no row mark; Info says "Added by Maya" and "Not verified",
 * docs/optional-verification.md 2.6), and a copy saved from a link.
 */
const UNMARKED: RecordIntegrity[] = ['verified', 'seen', 'saved-from-link'];

/* The re-keyer verdicts that leave the record unmarked: said in Info, never as a mark (decision D5). */
const INFO_ONLY: RecordIntegrity[] = [
    'verified',
    'seen',
    'saved-from-link',
    'retired-key',
    'unknown-signer',
    'unchecked',
    'former-member',
    'resealed',
];

/*
 * One record's issues: its own verdict, named after whoever it is about (the
 * origin's writer for a re-keyed record whose bytes bound, the re-keyer when
 * they did not), and for a re-keyed record whose bytes bound but whose re-key
 * is not attested, a mark of its own.
 */
export function recordIssues(
    record: 'metadata' | 'version',
    integrity: RecordIntegrity,
    signer: Signer | null,
    note?: RekeyNote | null,
): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    if (note) {
        const rekeyer = note.integrity;
        // A re-key cause names someone only when their own verified signature covers what failed:
        // a mismatch under the re-keyer's verified re-key. Anything else a server could cause alone.
        if (note.bound === false)
            issues.push({
                record,
                integrity: 'bad-signature',
                signer: rekeyer === 'verified' ? note.by : null,
                rekey: { cause: 'mismatch', rekeyer },
            });
        else if (note.bound === null)
            issues.push({
                record,
                integrity: 'unchecked',
                signer: null,
                rekey: { cause: 'unconfirmed', rekeyer },
            });
        else {
            if (!UNMARKED.includes(integrity))
                issues.push({
                    record,
                    integrity: integrity as IntegrityIssue['integrity'],
                    signer: note.writer,
                });
            if (!INFO_ONLY.includes(rekeyer))
                issues.push({
                    record,
                    integrity: rekeyer as IntegrityIssue['integrity'],
                    signer: null,
                    rekey: { cause: 'unattested', rekeyer },
                });
        }
        return issues;
    }
    if (!UNMARKED.includes(integrity))
        issues.push({ record, integrity: integrity as IntegrityIssue['integrity'], signer });
    return issues;
}

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
    const issues: IntegrityIssue[] = [
        ...recordIssues(
            'metadata',
            node.integrity.metadata,
            node.metadataSigner ?? null,
            node.integrity.rekeyed?.metadata,
        ),
        ...(node.integrity.version === null
            ? []
            : recordIssues(
                  'version',
                  node.integrity.version,
                  node.currentVersion?.signer ?? null,
                  node.integrity.rekeyed?.version,
              )),
    ];
    return sortIssues(issues);
}

/* Worst first (see integrityIssues); a re-key that is not attested ranks with a re-sealed record. */
export function sortIssues(issues: IntegrityIssue[]): IntegrityIssue[] {
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
    const of = (issue: IntegrityIssue) =>
        issue.rekey?.cause === 'unattested' ? rank.resealed : rank[issue.integrity];
    return [...issues].sort((a, b) => of(a) - of(b));
}
