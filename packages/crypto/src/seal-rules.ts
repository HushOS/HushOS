import sodium from 'libsodium-wrappers';
import { requireAccepted } from './accepted';
import { integer, uuid } from './canonical';
import { CryptoError } from './errors';
import { digestHex } from './fingerprint';
import type { AcceptedRosters } from './group-trust';
import type { Roster, RosterMember } from './groups';
import type { ServedKeys, SuccessionLink } from './identity';
import { decode, encode } from './keys';
import { KEM_PUBLIC_KEY_BYTES, ML_DSA_PUBLIC_KEY_BYTES, mlDsaPublicKeyOf } from './pq';
import type { GranteeKeys } from './sealing';
import { digest, type HybridPublicKey, type HybridSigningKey } from './signatures';
import { successionPath } from './succession-path';

/*
 * The rules every group seal keeps, whatever it seals (docs/groups-design.md
 * 2.3, 2.6; docs/companies-design.md 2.2): which group and roster it names,
 * whose keys sign it and whose it is sealed to, and which area keys the chain
 * lists. Shared by the group key seal and area grants (groups.ts) and the
 * company's seals (custody.ts). Internal: not in the package's exports.
 */

export const NOT_LISTED = 'This person’s keys are not the ones on the group’s member list.';

/* The member's entry on `roster`, if any (rosterEntry, without importing groups.ts back). */
function rosterEntry(roster: Roster, userId: string) {
    return roster.members.find((member) => member.userId === userId);
}

/* A member's served identity and every succession link they signed, as the server serves them. */
export type SignerHistory = { served: ServedKeys; links: SuccessionLink[] };

/*
 * Every key a seal's or grant's signer may have signed it with, checked
 * through the accepted chain: the keys their entry names now (the served
 * ML-DSA key only if the entry names it), and, with their history, the
 * keys on their own verified succession path (succession-path.ts; every link
 * before the entry's keys carrying the successor's consent) from the first set
 * of keys their entries named on the chain (the one a words check admitted) up
 * to and including the keys their entry names now, so a seal
 * made before a fold-in, or under the entry's keys after the member moved on,
 * still opens. Keys after the entry's (an identity no roster has folded in
 * yet) never count: a member seals only with the keys their entry names. Keys
 * a holder wrote into an entry later never start a path, and an identity fork
 * of the signer lends nothing.
 */
export async function signersThrough(
    chain: AcceptedRosters,
    userId: string,
    servedMlDsaPublicKey: Uint8Array | null,
    history: SignerHistory | null,
) {
    const entry = rosterEntry(chain.roster, userId);
    if (!entry) throw new CryptoError('This person is not on the group’s member list.');
    const signers: HybridPublicKey[] = [];
    if (
        servedMlDsaPublicKey &&
        servedMlDsaPublicKey.length === ML_DSA_PUBLIC_KEY_BYTES &&
        (await digest(servedMlDsaPublicKey)) === entry.mlDsaPublicKeyDigest
    )
        signers.push({
            signingPublicKey: decode(entry.signingPublicKey, 32),
            mlDsaPublicKey: servedMlDsaPublicKey,
        });
    if (history) {
        const own = signers.length;
        const first = chain.keyHistory[userId]?.[0] ?? entry;
        const found = await successionPath(
            userId,
            {
                keyVersion: null,
                encryptionPublicKey: first.encryptionPublicKey,
                signingPublicKey: first.signingPublicKey,
                mlDsaPublicKeyHash: digestHex(first.mlDsaPublicKeyDigest),
            },
            history.served,
            history.links,
            {
                // Up to the entry's keys, only links the successor consented to: keys planted as
                // the member's first entry never bridge to the real identity.
                consentUntil: {
                    keyVersion: null,
                    encryptionPublicKey: entry.encryptionPublicKey,
                    signingPublicKey: entry.signingPublicKey,
                    mlDsaPublicKeyHash: digestHex(entry.mlDsaPublicKeyDigest),
                },
            },
        );
        const isEntry = async (keys: { enc: string; signing: string; mlDsa: string }) =>
            keys.enc === entry.encryptionPublicKey &&
            keys.signing === entry.signingPublicKey &&
            (await digest(decode(keys.mlDsa, ML_DSA_PUBLIC_KEY_BYTES))) ===
                entry.mlDsaPublicKeyDigest;
        let reached = false;
        if (found.status === 'path') {
            for (const link of found.links) {
                signers.push({
                    signingPublicKey: decode(link.oldSigningPublicKey, 32),
                    mlDsaPublicKey: decode(link.oldMlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES),
                });
                // Up to the entry's own keys, never past them.
                reached = await isEntry({
                    enc: link.oldEncryptionPublicKey,
                    signing: link.oldSigningPublicKey,
                    mlDsa: link.oldMlDsaPublicKey,
                });
                if (reached) break;
            }
            reached ||= await isEntry({
                enc: history.served.encryptionPublicKey,
                signing: history.served.signingPublicKey,
                mlDsa: history.served.mlDsaPublicKey,
            });
        }
        // A path that never reaches the entry's keys vouches for none of its keys.
        if (!reached) signers.length = own;
    }
    return signers.length ? signers : refuse();
}
function refuse(): never {
    throw new CryptoError(NOT_LISTED);
}

/*
 * Refuses to seal with keys other than the ones the sealer's entry names
 * (Ed25519, and ML-DSA by digest): a member seals only once their current
 * identity is folded into the roster, so every seal opens under the entry.
 */
export async function sealerHolds(
    chain: AcceptedRosters,
    userId: string,
    sealer: HybridSigningKey,
) {
    await sodium.ready;
    const refused = () =>
        new CryptoError('These are not the sealer’s keys on the group’s member list.');
    // Ed25519 from the seed, as the Rust core derives it; a libsodium secret key whose public
    // half is not the seed's would sign nothing that verifies.
    if (sealer.signingKey.length !== 64) throw refused();
    const derived = sodium.crypto_sign_seed_keypair(sealer.signingKey.subarray(0, 32)).publicKey;
    if (!sodium.memcmp(sealer.signingKey.subarray(32), derived)) throw refused();
    const ed25519 = encode(derived);
    let mlDsa: Uint8Array;
    try {
        mlDsa = mlDsaPublicKeyOf(sealer.mlDsaSecretKey);
    } catch {
        throw refused();
    }
    const entry = rosterEntry(chain.roster, userId);
    if (
        !entry ||
        entry.signingPublicKey !== ed25519 ||
        entry.mlDsaPublicKeyDigest !== (await digest(mlDsa))
    )
        throw refused();
}

/* What a seal is sealed to: the entry's X25519 key, and the served ML-KEM key only if the entry names it. */
export async function memberRecipient(
    entry: RosterMember,
    kemPublicKey: Uint8Array,
): Promise<GranteeKeys> {
    if (
        kemPublicKey.length !== KEM_PUBLIC_KEY_BYTES ||
        (await digest(kemPublicKey)) !== entry.kemPublicKeyDigest
    )
        throw new CryptoError(NOT_LISTED);
    return { encryptionPublicKey: decode(entry.encryptionPublicKey, 32), kemPublicKey };
}

export function sameGroup(chain: AcceptedRosters, groupId: string) {
    requireAccepted(chain);
    if (uuid(groupId, 'group id') !== chain.groupId || chain.roster.groupId !== chain.groupId)
        throw new CryptoError('This is for another group.');
}

/* A seal is made at the sealer's latest accepted roster, named in its context. */
export function sealedAtLatest(
    chain: AcceptedRosters,
    ctx: { rosterVersion: number; rosterDigest: string },
) {
    if (ctx.rosterVersion !== chain.roster.rosterVersion || ctx.rosterDigest !== chain.rosterDigest)
        throw new CryptoError('A seal names the latest member list this device accepted.');
}

/* An opener takes a seal only if the roster it was made at is on its own accepted chain. */
export function sealedOnChain(
    chain: AcceptedRosters,
    ctx: { rosterVersion: number; rosterDigest: string },
) {
    if (chain.rosterDigests[integer(ctx.rosterVersion, 'roster version') - 1] !== ctx.rosterDigest)
        throw new CryptoError('This was sealed on a member list this device does not have.');
}

export const NOT_LISTED_KEY = 'This area key is not the one the group’s member list names.';

/*
 * The commitment the chain listed for an area at a key version: the current
 * key, or an earlier one a reader needs for older files. Never a version no
 * roster on the chain listed.
 */
/*
 * Every commitment the chain lists for an area, version 1 first, or null:
 * only for a canonical workspace id the chain holds as its own property, so
 * no inherited name ('constructor', 'toString') reads as an area.
 */
export function areaCommitments(chain: AcceptedRosters, workspaceId: string) {
    try {
        uuid(workspaceId, 'workspace id');
    } catch {
        return null;
    }
    return Object.hasOwn(chain.areaKeys, workspaceId) ? chain.areaKeys[workspaceId]! : null;
}

export function listedArea(
    chain: AcceptedRosters,
    workspaceId: string,
    workspaceKeyVersion: number,
) {
    if (!Number.isSafeInteger(workspaceKeyVersion) || workspaceKeyVersion < 1) return undefined;
    return areaCommitments(chain, workspaceId)?.[workspaceKeyVersion - 1];
}
