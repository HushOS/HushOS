import sodium from 'libsodium-wrappers';
import {
    ascending,
    bytesOf,
    digestOf,
    encodeStatement,
    integer,
    oneOf,
    parseStatement,
    requireCanonical,
    uuid,
} from './canonical';
import { requireAccepted } from './accepted';
import { CryptoError } from './errors';
import { digestHex, fingerprintWords } from './fingerprint';
import { decode, encode } from './keys';
import {
    KEM_PUBLIC_KEY_BYTES,
    ML_DSA_PUBLIC_KEY_BYTES,
    ML_DSA_SIGNATURE_BYTES,
    mlDsaKeypair,
    mlDsaPublicKeyOf,
    mlDsaSign,
    mlDsaVerify,
} from './pq';
import {
    SIGNATURE_BYTES,
    digest,
    signHybrid,
    signStatement,
    verifyHybrid,
    verifyStatement,
    type HybridPublicKey,
    type HybridSigningKey,
} from './signatures';
import {
    hybridSealBytes,
    openHybrid,
    sealHybrid,
    type GranteeKeys,
    type GranteeSecrets,
    type HybridSealKind,
} from './sealing';
import type { AcceptedRosters } from './group-trust';
import type { ServedKeys, SuccessionLink } from './identity';
import { successionPath } from './succession-path';
import { checkId } from './ids';
import { RETIRED, areaKeyCommitment, areaRootCommitment, rowsAfter } from './area-keys';

/*
 * The group core's cryptography (docs/groups-design.md 2): the group key and
 * its signatures, the group fingerprint, the roster and key succession
 * statements, and the two seals of milestone 1 (the group key to its holders,
 * an area's workspace key to a member; guardian seals come later). Every
 * statement is version 1 and hybrid from its first byte, in the canonical
 * encoding of canonical.ts; `hushos-core` (groups.rs) makes and accepts the
 * same bytes, pinned by the shared group fixtures. What a reader accepts as a
 * chain of rosters, and what it shows for a record, is group-trust.ts.
 */

/* 32 bytes of Ed25519 seed, then 32 of ML-DSA-65 key generation seed (ξ). */
export const GROUP_SEED_BYTES = 64;
/*
 * The FIPS 204 context of the group key's ML-DSA half. A person's identity
 * signs under `hushos/identity/v1`, so neither key's signature can stand in
 * for the other's.
 */
export const GROUP_SIGNATURE_CONTEXT = 'hushos/group/v1';

/* The group key's public halves, base64url as statements and the server carry them. */
export type GroupPublicKey = { ed25519PublicKey: string; mlDsaPublicKey: string };
export type GroupKeyPair = {
    publicKey: GroupPublicKey;
    /* libsodium's 64-byte Ed25519 secret key. */
    signingKey: Uint8Array;
    mlDsaSecretKey: Uint8Array;
};
/* A group signature, as the API carries it (`{ ed25519, mlDsa }`): valid only if both verify. */
export type GroupSignature = { ed25519: Uint8Array; mlDsa: Uint8Array };

/* A fresh group key seed: made once, on the creating device, and then only ever sealed. */
export function newGroupSeed() {
    return crypto.getRandomValues(new Uint8Array(GROUP_SEED_BYTES));
}

/* The group key pair a 64-byte seed expands to. */
export async function groupKeyPair(seed: Uint8Array): Promise<GroupKeyPair> {
    if (seed.length !== GROUP_SEED_BYTES) throw new CryptoError('Invalid group key.');
    await sodium.ready;
    const classical = sodium.crypto_sign_seed_keypair(seed.subarray(0, 32));
    const lattice = mlDsaKeypair(seed.subarray(32));
    return {
        publicKey: {
            ed25519PublicKey: encode(classical.publicKey),
            mlDsaPublicKey: encode(lattice.publicKey),
        },
        signingKey: classical.privateKey,
        mlDsaSecretKey: lattice.secretKey,
    };
}

/* Ed25519 and ML-DSA-65 (context `hushos/group/v1`) over the same statement. */
export async function signGroup(message: Uint8Array, key: GroupKeyPair): Promise<GroupSignature> {
    return {
        ed25519: await signStatement(message, key.signingKey),
        mlDsa: mlDsaSign(message, key.mlDsaSecretKey, GROUP_SIGNATURE_CONTEXT),
    };
}

/*
 * Whether both halves of `signature` hold under the group key `key`. A
 * classical adversary must forge the ML-DSA half too, a quantum one the
 * Ed25519 half; anything malformed is simply not valid.
 */
export async function verifyGroup(
    message: Uint8Array,
    signature: GroupSignature,
    key: GroupPublicKey,
) {
    if (
        signature.ed25519.length !== SIGNATURE_BYTES ||
        signature.mlDsa.length !== ML_DSA_SIGNATURE_BYTES
    )
        return false;
    let ed25519: Uint8Array;
    let mlDsa: Uint8Array;
    try {
        ed25519 = decode(key.ed25519PublicKey, 32);
        mlDsa = decode(key.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES);
    } catch {
        return false;
    }
    return (
        (await verifyStatement(message, signature.ed25519, ed25519)) &&
        mlDsaVerify(signature.mlDsa, message, mlDsa, GROUP_SIGNATURE_CONTEXT)
    );
}

export function sameGroupKey(a: GroupPublicKey, b: GroupPublicKey) {
    return a.ed25519PublicKey === b.ed25519PublicKey && a.mlDsaPublicKey === b.mlDsaPublicKey;
}

/*
 * SHA-256(ed25519PublicKey (32) || mlDsaPublicKey (1952)), base64url: what a
 * group pin keeps of the group key at its key version, so a device joining at
 * the pin is never handed another key there.
 */
export async function groupKeyDigest(key: GroupPublicKey) {
    const bytes = new Uint8Array(32 + ML_DSA_PUBLIC_KEY_BYTES);
    bytes.set(decode(bytesOf(key.ed25519PublicKey, 32, 'group key')));
    bytes.set(decode(bytesOf(key.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES, 'group key')), 32);
    return digest(bytes);
}

/*
 * What a newcomer and the admitting admin compare (2.3):
 *
 *   SHA-256("hushos/group/fingerprint/v1" || groupId (36 ASCII bytes) ||
 *           ed25519PublicKey (32) || mlDsaPublicKey (1952))
 *
 * shown, like a person's, as ten groups of four hex digits and read as words
 * (groupWords). Every field has a fixed length, and the prefix differs from
 * every identity fingerprint's. The words are always the version 1 key's.
 */
export async function groupFingerprint(groupId: string, key: GroupPublicKey) {
    uuid(groupId, 'group id');
    const ed25519 = bytesOf(key.ed25519PublicKey, 32, 'group key');
    const mlDsa = bytesOf(key.mlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES, 'group key');
    const prefix = new TextEncoder().encode('hushos/group/fingerprint/v1');
    const input = new Uint8Array(prefix.length + 36 + 32 + ML_DSA_PUBLIC_KEY_BYTES);
    input.set(prefix);
    input.set(new TextEncoder().encode(groupId), prefix.length);
    input.set(decode(ed25519), prefix.length + 36);
    input.set(decode(mlDsa), prefix.length + 36 + 32);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    const hex = Array.from(hash.subarray(0, 20), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
    );
    return hex.match(/.{4}/g)!.join(' ');
}

/* The group's twelve words, as fingerprintWords draws a person's. */
export async function groupWords(groupId: string, key: GroupPublicKey) {
    return fingerprintWords(await groupFingerprint(groupId, key));
}

/* The roster (2.4) ------------------------------------------------------- */

export type GroupKind = 'family' | 'org';
export type GroupRole = 'billing' | 'data_admin' | 'guardian' | 'members' | 'recovery';
export type MemberStatus = 'active' | 'left';

const GROUP_KINDS: readonly GroupKind[] = ['family', 'org'];
const STATUSES: readonly MemberStatus[] = ['active', 'left'];
/* A family's roles; companies add theirs. Byte order is the order a roster lists them in. */
const FAMILY_ROLES: readonly GroupRole[] = ['billing', 'guardian', 'members'];
const ORG_ROLES: readonly GroupRole[] = [
    'billing',
    'data_admin',
    'guardian',
    'members',
    'recovery',
];

/*
 * One entry: the member's identity as the signer checked it (X25519 and
 * Ed25519 in full, the ML-DSA and ML-KEM keys by their SHA-256), their status
 * and roles, and the roster version the entry last changed at. Entries for
 * former members stay, marked `left`.
 */
export type RosterMember = {
    userId: string;
    keyVersion: number;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKeyDigest: string;
    kemPublicKeyDigest: string;
    status: MemberStatus;
    roles: GroupRole[];
    sinceVersion: number;
};
export type Roster = {
    groupId: string;
    kind: GroupKind;
    rosterVersion: number;
    /* SHA-256 of the previous roster's statement, base64url; "" for version 1. */
    previousRosterDigest: string;
    groupKeyVersion: number;
    signerUserId: string;
    /* Sorted by userId. */
    members: RosterMember[];
    /*
     * The areas created or rotated by this roster, one row each, sorted by
     * workspace id, at most MAX_ROSTER_AREA_ROWS: each new key's version and
     * commitment (areaKeyCommitment). A new area starts at 1 and a rotation is
     * one above the area's latest version on the chain; the accepted chain
     * folds every row into AcceptedRosters.areaKeys, so it holds every
     * version's commitment. A grant opens only to a key the chain listed, so a
     * new area or a rotation needs a roster, signed by a `members` holder; in
     * a family, a roster that removes a member rotates every area. Absent
     * means none (parseRoster always gives the list).
     */
    areas?: RosterArea[];
    /*
     * The statement's format (design 2.10): 1, rows of three fields, as
     * shipped; or 2, rows that also commit to the area root's key, and
     * retirement rows. Absent means 1 (parseRoster always gives it). A chain
     * never goes back from 2 to 1.
     */
    format?: RosterFormat;
};
export type RosterFormat = 1 | 2;
export const ROSTER_FORMATS: readonly RosterFormat[] = [1, 2];
export type RosterArea = {
    workspaceId: string;
    workspaceKeyVersion: number;
    /* areaKeyCommitment of the area key at that version, base64url; "" on a retirement row. */
    commitment: string;
    /*
     * Format 2 key rows only: areaRootCommitment of the area root's node key
     * at that version (design 2.10), base64url.
     */
    rootCommitment?: string;
    /* Format 2 only: the area's tombstone, at its next version, with no key. */
    retired?: true;
};

const ROSTER_DOMAIN = 'hushos/group/roster';

/*
 * The most area rows one roster may carry (design 2.4); the Rust core holds
 * rosters to the same. As many as a family may have areas, so the roster
 * that removes someone from a family, rotating every area, always fits
 * (about 110 KB at the cap).
 */
export const MAX_ROSTER_AREA_ROWS = 1024;
/*
 * The most live areas a family's chain may list (checkAreas): a removal
 * rotates them all, so a family past this could never remove anyone. A
 * retired area (a format 2 tombstone, design 2.10) no longer counts and is
 * never rotated again.
 */
export const MAX_FAMILY_AREAS = 1024;

function areaParts(areas: readonly RosterArea[] | undefined, format: RosterFormat) {
    const list = areas ?? [];
    if (!Array.isArray(list) || list.length > MAX_ROSTER_AREA_ROWS)
        throw new CryptoError('Invalid roster areas.');
    const rows = list.map((area) => {
        if (typeof area !== 'object' || area === null)
            throw new CryptoError('Invalid roster area.');
        const head = [
            uuid(area.workspaceId, 'workspace id'),
            integer(area.workspaceKeyVersion, 'workspace key version'),
        ] as const;
        if (format === 1) {
            // Format 1 has neither root commitments nor retirement rows.
            if (area.rootCommitment !== undefined || area.retired !== undefined)
                throw new CryptoError('Invalid roster area.');
            return [...head, digestOf(area.commitment, 'area key commitment')];
        }
        if (area.retired !== undefined) {
            if (
                area.retired !== true ||
                area.commitment !== '' ||
                area.rootCommitment !== undefined
            )
                throw new CryptoError('Invalid roster area.');
            return [...head, RETIRED_ROW];
        }
        return [
            ...head,
            KEY_ROW,
            digestOf(area.commitment, 'area key commitment'),
            digestOf(area.rootCommitment, 'area root commitment'),
        ];
    });
    // One row per area, sorted by workspace id.
    ascending(
        rows.map(([id]) => id as string),
        'roster areas',
    );
    return rows;
}

/* The tags of a format 2 area row (design 2.10). */
const KEY_ROW = 'key';
const RETIRED_ROW = 'retired';

function memberParts(member: RosterMember, kind: GroupKind, rosterVersion: number) {
    if (typeof member !== 'object' || member === null || !Array.isArray(member.roles))
        throw new CryptoError('Invalid roster entry.');
    const roles = ascending(
        member.roles.map((role) =>
            oneOf(role, kind === 'family' ? FAMILY_ROLES : ORG_ROLES, 'roster role'),
        ),
        'roster roles',
    );
    const since = integer(member.sinceVersion, 'roster entry version');
    if (since > rosterVersion) throw new CryptoError('Invalid roster entry version.');
    return [
        uuid(member.userId, 'user id'),
        integer(member.keyVersion, 'key version'),
        bytesOf(member.encryptionPublicKey, 32, 'identity key'),
        bytesOf(member.signingPublicKey, 32, 'identity key'),
        digestOf(member.mlDsaPublicKeyDigest, 'key digest'),
        digestOf(member.kemPublicKeyDigest, 'key digest'),
        oneOf(member.status, STATUSES, 'member status'),
        roles,
        since,
    ];
}

/*
 * ["hushos/group/roster",1,groupId,kind,rosterVersion,previousRosterDigest,
 *  groupKeyVersion,signerUserId,members,areas]
 * members = [[userId,keyVersion,encryptionPublicKey,signingPublicKey,
 *             mlDsaPublicKeyDigest,kemPublicKeyDigest,status,roles,sinceVersion],...]
 * areas = [[workspaceId,workspaceKeyVersion,commitment],...], the areas this
 *          roster creates or rotates, one row each, sorted by workspace id
 * Format 2 (design 2.10) is ["hushos/group/roster",2,...] with
 * areas = [[workspaceId,workspaceKeyVersion,"key",commitment,rootCommitment]
 *          | [workspaceId,workspaceKeyVersion,"retired"],...]
 * Refuses anything outside the canonical encoding: unsorted or repeated
 * members or roles, a company role in a family, an entry newer than the
 * roster, a previous digest on version 1 or none after it.
 */
/* The most entries a roster may have (design 2.4); the Rust core holds rosters to the same. */
export const MAX_ROSTER_MEMBERS = 10_000;

export function rosterStatement(roster: Roster) {
    const format = rosterFormat(roster);
    const kind = oneOf(roster.kind, GROUP_KINDS, 'group kind');
    const version = integer(roster.rosterVersion, 'roster version');
    // Version 1 has no previous roster: its digest is the empty string, and only then.
    if (version === 1 && roster.previousRosterDigest !== '')
        throw new CryptoError('Invalid roster digest.');
    const previous = version === 1 ? '' : digestOf(roster.previousRosterDigest, 'roster digest');
    if (
        !Array.isArray(roster.members) ||
        roster.members.length === 0 ||
        roster.members.length > MAX_ROSTER_MEMBERS
    )
        throw new CryptoError('Invalid roster members.');
    const members = roster.members.map((member) => memberParts(member, kind, version));
    ascending(
        members.map((member) => member[0] as string),
        'roster members',
    );
    return encodeStatement([
        ROSTER_DOMAIN,
        format,
        uuid(roster.groupId, 'group id'),
        kind,
        version,
        previous,
        integer(roster.groupKeyVersion, 'group key version'),
        uuid(roster.signerUserId, 'user id'),
        members,
        areaParts(roster.areas, format),
    ]);
}

/* A roster's format: 1 when absent, else 1 or 2. */
export function rosterFormat(roster: Pick<Roster, 'format'>): RosterFormat {
    if (roster.format === undefined) return 1;
    if (!ROSTER_FORMATS.includes(roster.format)) throw new CryptoError('Invalid roster format.');
    return roster.format;
}

/* The roster a statement's bytes hold, refused unless the bytes are its canonical encoding. */
export function parseRoster(statement: Uint8Array): Roster {
    const parts = parseStatement(statement, 'roster');
    if (
        parts.length !== 10 ||
        parts[0] !== ROSTER_DOMAIN ||
        !ROSTER_FORMATS.includes(parts[1] as RosterFormat)
    )
        throw new CryptoError('Invalid roster.');
    const format = parts[1] as RosterFormat;
    if (!Array.isArray(parts[9])) throw new CryptoError('Invalid roster areas.');
    const areas = (parts[9] as unknown[]).map((row) => {
        if (!Array.isArray(row)) throw new CryptoError('Invalid roster area.');
        if (format === 1) {
            if (row.length !== 3) throw new CryptoError('Invalid roster area.');
            const [workspaceId, workspaceKeyVersion, commitment] = row;
            return { workspaceId, workspaceKeyVersion, commitment } as RosterArea;
        }
        if (row.length === 3 && row[2] === RETIRED_ROW) {
            const [workspaceId, workspaceKeyVersion] = row;
            return {
                workspaceId,
                workspaceKeyVersion,
                commitment: '',
                retired: true,
            } as RosterArea;
        }
        if (row.length !== 5 || row[2] !== KEY_ROW) throw new CryptoError('Invalid roster area.');
        const [workspaceId, workspaceKeyVersion, , commitment, rootCommitment] = row;
        return { workspaceId, workspaceKeyVersion, commitment, rootCommitment } as RosterArea;
    });
    if (!Array.isArray(parts[8]) || parts[8].length > MAX_ROSTER_MEMBERS)
        throw new CryptoError('Invalid roster members.');
    const members = (parts[8] as unknown[]).map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 9)
            throw new CryptoError('Invalid roster entry.');
        const [userId, keyVersion, enc, sig, mlDsa, kem, status, roles, since] = entry;
        return {
            userId,
            keyVersion,
            encryptionPublicKey: enc,
            signingPublicKey: sig,
            mlDsaPublicKeyDigest: mlDsa,
            kemPublicKeyDigest: kem,
            status,
            roles,
            sinceVersion: since,
        } as RosterMember;
    });
    const roster = {
        groupId: parts[2],
        kind: parts[3],
        rosterVersion: parts[4],
        previousRosterDigest: parts[5],
        groupKeyVersion: parts[6],
        signerUserId: parts[7],
        members,
        areas,
        // Format 1 rosters parse to exactly what they always did.
        ...(format === 2 ? { format } : {}),
    } as Roster;
    requireCanonical(statement, rosterStatement(roster), 'roster');
    return roster;
}

/* The member's entry on `roster`, if any. */
export function rosterEntry(roster: Roster, userId: string) {
    return roster.members.find((member) => member.userId === userId);
}

/* Whether `entry` is active, and holds `role` when one is named. */
export function activeWith(entry: RosterMember | undefined, role?: GroupRole) {
    return !!entry && entry.status === 'active' && (!role || entry.roles.includes(role));
}

const NOT_LISTED = 'This person’s keys are not the ones on the group’s member list.';

/* A member's hybrid signature keys through a roster: the entry's Ed25519 key, and the served ML-DSA key only if the entry names it. */
async function signerOnRoster(roster: Roster, userId: string, servedMlDsaPublicKey: Uint8Array) {
    const entry = rosterEntry(roster, userId);
    if (!entry) throw new CryptoError('This person is not on the group’s member list.');
    if (
        servedMlDsaPublicKey.length !== ML_DSA_PUBLIC_KEY_BYTES ||
        (await digest(servedMlDsaPublicKey)) !== entry.mlDsaPublicKeyDigest
    )
        throw new CryptoError(NOT_LISTED);
    return {
        signingPublicKey: decode(entry.signingPublicKey, 32),
        mlDsaPublicKey: servedMlDsaPublicKey,
    };
}

/*
 * The keys a member's hybrid signature is checked under through the accepted
 * roster (2.4): the Ed25519 key from their entry, and the ML-DSA key the
 * server served only if its SHA-256 is the entry's `mlDsaPublicKeyDigest`. A
 * served key the entry does not name is refused, never trusted on its own.
 */
export async function memberSigner(
    chain: AcceptedRosters,
    userId: string,
    servedMlDsaPublicKey: Uint8Array,
): Promise<HybridPublicKey> {
    requireAccepted(chain);
    return signerOnRoster(chain.roster, userId, servedMlDsaPublicKey);
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
async function signersThrough(
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
async function sealerHolds(chain: AcceptedRosters, userId: string, sealer: HybridSigningKey) {
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

/* Whether `signature` is the member's hybrid signature over `message`, checked through the accepted roster. */
export async function verifyMemberSignature(
    chain: AcceptedRosters,
    userId: string,
    servedMlDsaPublicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
) {
    requireAccepted(chain);
    try {
        return await verifyHybrid(
            message,
            signature,
            await signerOnRoster(chain.roster, userId, servedMlDsaPublicKey),
        );
    } catch {
        return false;
    }
}

/* What a seal is sealed to: the entry's X25519 key, and the served ML-KEM key only if the entry names it. */
async function memberRecipient(
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

/* SHA-256 of a roster's statement, base64url: the next roster's previous digest, and what a pin keeps. */
export async function rosterDigest(statement: Uint8Array) {
    return digest(statement);
}

/* A statement as the server stores it: its bytes, the group signature, and the signer's identity signature. */
export type SignedGroupStatement = {
    statement: Uint8Array;
    signature: GroupSignature;
    signerSignature: Uint8Array;
};

/*
 * Signs a roster with the group key at its `groupKeyVersion` and with the
 * signer's own hybrid identity signature over the same bytes, so every roster
 * says who made it. Folding in changed entries (group-trust.ts) comes first.
 */
export async function signRoster(
    roster: Roster,
    groupKey: GroupKeyPair,
    signer: HybridSigningKey,
): Promise<SignedGroupStatement> {
    const statement = rosterStatement(roster);
    return {
        statement,
        signature: await signGroup(statement, groupKey),
        signerSignature: await signHybrid(statement, signer),
    };
}

/* Key succession (2.5) --------------------------------------------------- */

export type GroupKeySuccession = {
    groupId: string;
    oldVersion: number;
    newVersion: number;
    oldEd25519PublicKey: string;
    oldMlDsaPublicKey: string;
    newEd25519PublicKey: string;
    newMlDsaPublicKey: string;
    /* The last roster under the old key, by version and digest. */
    lastRosterVersion: number;
    lastRosterDigest: string;
    signerUserId: string;
};

const SUCCESSION_DOMAIN = 'hushos/group/key-succession';

/*
 * ["hushos/group/key-succession",1,groupId,oldVersion,newVersion,
 *  oldEd25519PublicKey,oldMlDsaPublicKey,newEd25519PublicKey,newMlDsaPublicKey,
 *  lastRosterVersion,lastRosterDigest,signerUserId]
 * `newVersion` is always `oldVersion` + 1.
 */
export function groupSuccessionStatement(succession: GroupKeySuccession) {
    const oldVersion = integer(succession.oldVersion, 'group key version');
    if (integer(succession.newVersion, 'group key version') !== oldVersion + 1)
        throw new CryptoError('Invalid group key version.');
    return encodeStatement([
        SUCCESSION_DOMAIN,
        1,
        uuid(succession.groupId, 'group id'),
        oldVersion,
        succession.newVersion,
        bytesOf(succession.oldEd25519PublicKey, 32, 'group key'),
        bytesOf(succession.oldMlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES, 'group key'),
        bytesOf(succession.newEd25519PublicKey, 32, 'group key'),
        bytesOf(succession.newMlDsaPublicKey, ML_DSA_PUBLIC_KEY_BYTES, 'group key'),
        integer(succession.lastRosterVersion, 'roster version'),
        digestOf(succession.lastRosterDigest, 'roster digest'),
        uuid(succession.signerUserId, 'user id'),
    ]);
}

/* The succession a statement's bytes hold, refused unless the bytes are its canonical encoding. */
export function parseGroupSuccession(statement: Uint8Array): GroupKeySuccession {
    const parts = parseStatement(statement, 'group key succession');
    if (parts.length !== 12 || parts[0] !== SUCCESSION_DOMAIN || parts[1] !== 1)
        throw new CryptoError('Invalid group key succession.');
    const succession = {
        groupId: parts[2],
        oldVersion: parts[3],
        newVersion: parts[4],
        oldEd25519PublicKey: parts[5],
        oldMlDsaPublicKey: parts[6],
        newEd25519PublicKey: parts[7],
        newMlDsaPublicKey: parts[8],
        lastRosterVersion: parts[9],
        lastRosterDigest: parts[10],
        signerUserId: parts[11],
    } as GroupKeySuccession;
    requireCanonical(statement, groupSuccessionStatement(succession), 'group key succession');
    return succession;
}

/*
 * Signs a succession with the old group key (which must be the statement's
 * old key) and the signer's hybrid identity signature.
 */
export async function signGroupSuccession(
    succession: GroupKeySuccession,
    oldKey: GroupKeyPair,
    signer: HybridSigningKey,
): Promise<SignedGroupStatement> {
    const statement = groupSuccessionStatement(succession);
    if (
        !sameGroupKey(oldKey.publicKey, {
            ed25519PublicKey: succession.oldEd25519PublicKey,
            mlDsaPublicKey: succession.oldMlDsaPublicKey,
        })
    )
        throw new CryptoError('This is not the group key being replaced.');
    return {
        statement,
        signature: await signGroup(statement, oldKey),
        signerSignature: await signHybrid(statement, signer),
    };
}

/* Seals (2.3, 2.6; guardian seals, 2.9, are not in milestone 1) ------------ */

/*
 * Each seal is the share suite 4 construction under its own HKDF `info`, with
 * associated data equal to its statement without the final digest, so a seal
 * of one kind, version or context opens as nothing as another.
 */
const KEY_SEAL_INFO = 'hushos/group/key-seal/v1';
const AREA_GRANT_INFO = 'hushos/group/area-grant/v1';

export const GROUP_KEY_SEAL_BYTES = hybridSealBytes(GROUP_SEED_BYTES); // 4597
export const AREA_GRANT_BYTES = hybridSealBytes(32); // 4565

/*
 * `rosterVersion` and `rosterDigest` name the sealer's latest accepted roster
 * when they sealed: an opener takes the seal only if that roster is on its own
 * accepted chain, so a seal made on a branch (a device a withheld removal kept
 * on a removed holder's history) never opens on the real chain.
 */
export type GroupKeySealContext = {
    groupId: string;
    groupKeyVersion: number;
    holderUserId: string;
    holderKeyVersion: number;
    sealerUserId: string;
    rosterVersion: number;
    rosterDigest: string;
};
export type AreaGrantContext = {
    groupId: string;
    workspaceId: string;
    workspaceKeyVersion: number;
    granteeUserId: string;
    granteeKeyVersion: number;
    granterUserId: string;
    rosterVersion: number;
    rosterDigest: string;
};

function keySealParts(ctx: GroupKeySealContext) {
    return [
        'hushos/group/key-seal',
        1,
        uuid(ctx.groupId, 'group id'),
        integer(ctx.groupKeyVersion, 'group key version'),
        uuid(ctx.holderUserId, 'user id'),
        integer(ctx.holderKeyVersion, 'key version'),
        uuid(ctx.sealerUserId, 'user id'),
        integer(ctx.rosterVersion, 'roster version'),
        digestOf(ctx.rosterDigest, 'roster digest'),
    ];
}
function areaGrantParts(ctx: AreaGrantContext) {
    return [
        'hushos/group/area-grant',
        1,
        uuid(ctx.groupId, 'group id'),
        uuid(ctx.workspaceId, 'workspace id'),
        integer(ctx.workspaceKeyVersion, 'workspace key version'),
        uuid(ctx.granteeUserId, 'user id'),
        integer(ctx.granteeKeyVersion, 'key version'),
        uuid(ctx.granterUserId, 'user id'),
        integer(ctx.rosterVersion, 'roster version'),
        digestOf(ctx.rosterDigest, 'roster digest'),
    ];
}

/* ["hushos/group/key-seal",1,groupId,groupKeyVersion,holderUserId,holderKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)] */
export async function groupKeySealStatement(ctx: GroupKeySealContext, sealed: Uint8Array) {
    return encodeStatement([...keySealParts(ctx), await digest(sealed)]);
}
/* ["hushos/group/area-grant",1,groupId,workspaceId,workspaceKeyVersion,granteeUserId,granteeKeyVersion,granterUserId,rosterVersion,rosterDigest,sha256(sealed)] */
export async function areaGrantStatement(ctx: AreaGrantContext, sealed: Uint8Array) {
    return encodeStatement([...areaGrantParts(ctx), await digest(sealed)]);
}

/* Each seal's associated data: its statement without the final digest. */
export function groupKeySealContext(ctx: GroupKeySealContext) {
    return encodeStatement(keySealParts(ctx));
}
export function areaGrantContext(ctx: AreaGrantContext) {
    return encodeStatement(areaGrantParts(ctx));
}

function keySealKind(ctx: GroupKeySealContext): HybridSealKind {
    return {
        info: KEY_SEAL_INFO,
        associatedData: groupKeySealContext(ctx),
        statement: (sealed) => groupKeySealStatement(ctx, sealed),
        noun: 'group key',
        invalid: 'Invalid group key seal.',
        unsigned: 'This group key was not sealed by a member who holds it.',
    };
}
function areaGrantKind(ctx: AreaGrantContext): HybridSealKind {
    return {
        info: AREA_GRANT_INFO,
        associatedData: areaGrantContext(ctx),
        statement: (sealed) => areaGrantStatement(ctx, sealed),
        noun: 'grant',
        invalid: 'Invalid area grant.',
        unsigned: 'This grant is not signed by the member who made it.',
    };
}

function sameGroup(chain: AcceptedRosters, groupId: string) {
    requireAccepted(chain);
    if (uuid(groupId, 'group id') !== chain.groupId || chain.roster.groupId !== chain.groupId)
        throw new CryptoError('This is for another group.');
}

/* A seal is made at the sealer's latest accepted roster, named in its context. */
function sealedAtLatest(
    chain: AcceptedRosters,
    ctx: { rosterVersion: number; rosterDigest: string },
) {
    if (ctx.rosterVersion !== chain.roster.rosterVersion || ctx.rosterDigest !== chain.rosterDigest)
        throw new CryptoError('A seal names the latest member list this device accepted.');
}

/* An opener takes a seal only if the roster it was made at is on its own accepted chain. */
function sealedOnChain(
    chain: AcceptedRosters,
    ctx: { rosterVersion: number; rosterDigest: string },
) {
    if (chain.rosterDigests[integer(ctx.rosterVersion, 'roster version') - 1] !== ctx.rosterDigest)
        throw new CryptoError('This was sealed on a member list this device does not have.');
}

/*
 * An area is a workspace whose id was derived under the group (the
 * `workspace` id kind, scoped to the group id): a grant naming a group for a
 * workspace that is not its own opens nothing, so no member, with the
 * server's help, can bring someone's personal or another group's workspace
 * under this group's roster. Only areas that pass may enter the pin's areas.
 */
async function areaOf(groupId: string, workspaceId: string, areaIdSeed: string) {
    try {
        await checkId('workspace', groupId, areaIdSeed, workspaceId);
    } catch {
        throw new CryptoError('This area does not belong to the group.');
    }
}

/*
 * Seals the group key's seed to a holder: only to an entry of the accepted
 * roster that is active with `members`, at the key version the context
 * names, under the ML-KEM key the entry names by digest.
 */
export async function sealGroupKey(
    seed: Uint8Array,
    ctx: GroupKeySealContext,
    options: {
        chain: AcceptedRosters;
        holderKemPublicKey: Uint8Array;
        sealer: HybridSigningKey;
    },
) {
    if (seed.length !== GROUP_SEED_BYTES) throw new CryptoError('Invalid group key.');
    sameGroup(options.chain, ctx.groupId);
    sealedAtLatest(options.chain, ctx);
    // Only a holder seals the group key (the creator, version 1's, while active): a seal from
    // anyone else would never open.
    const sealing = rosterEntry(options.chain.roster, ctx.sealerUserId);
    const creator =
        ctx.groupKeyVersion === 1 &&
        activeWith(sealing) &&
        options.chain.creatorUserId === ctx.sealerUserId;
    if (!activeWith(sealing, 'members') && !creator)
        throw new CryptoError('The group key is sealed only by a member who holds it.');
    await sealerHolds(options.chain, ctx.sealerUserId, options.sealer);
    const holder = rosterEntry(options.chain.roster, ctx.holderUserId);
    if (!activeWith(holder, 'members') || holder!.keyVersion !== ctx.holderKeyVersion)
        throw new CryptoError('The group key is sealed only to members who hold it.');
    const recipient = await memberRecipient(holder!, options.holderKemPublicKey);
    return sealHybrid(seed, recipient, options.sealer, keySealKind(ctx));
}

/*
 * Opens a key seal: the 64-byte group seed. Refused unless the sealer is
 * active with `members` on the accepted roster (or is the group's creator, the
 * signer of roster version 1, for key version 1), its signature holds under
 * their keys through the roster, and the seed derives exactly the group key
 * the verified key chain has at `groupKeyVersion`. A holder handed a
 * substitute seed would sign rosters nobody accepts.
 */
export async function openGroupKey(
    envelope: Uint8Array,
    ctx: GroupKeySealContext,
    options: {
        chain: AcceptedRosters;
        sealerMlDsaPublicKey: Uint8Array;
        /* The sealer's served identity and links, so a seal made before a fold-in still opens. */
        sealerHistory?: SignerHistory | null;
        reader: { userId: string; keyVersion: number };
        holder: GranteeSecrets;
    },
) {
    const { chain } = options;
    sameGroup(chain, ctx.groupId);
    sealedOnChain(chain, ctx);
    if (
        ctx.holderUserId !== options.reader.userId ||
        ctx.holderKeyVersion !== options.reader.keyVersion
    )
        throw new CryptoError('This group key was not sealed to this account’s keys.');
    const groupKey = chain.groupKeys[ctx.groupKeyVersion - 1];
    if (!groupKey) throw new CryptoError('This group key is not one the group has published.');
    const sealer = rosterEntry(chain.roster, ctx.sealerUserId);
    // The creator seals version 1 before anyone else holds it, and may open only while active.
    const creator =
        ctx.groupKeyVersion === 1 && activeWith(sealer) && chain.creatorUserId === ctx.sealerUserId;
    if (!activeWith(sealer, 'members') && !creator)
        throw new CryptoError('This group key was not sealed by a member who holds it.');
    const seed = await openHybrid(
        envelope,
        GROUP_SEED_BYTES,
        await signersThrough(
            chain,
            ctx.sealerUserId,
            options.sealerMlDsaPublicKey,
            options.sealerHistory ?? null,
        ),
        options.holder,
        keySealKind(ctx),
    );
    const derived = await groupKeyPair(seed);
    derived.signingKey.fill(0);
    derived.mlDsaSecretKey.fill(0);
    if (!sameGroupKey(derived.publicKey, groupKey)) {
        seed.fill(0);
        throw new CryptoError('This group key is not the group’s published key.');
    }
    return seed;
}

/*
 * Seals an area's workspace key to a member: never for a retired area (design
 * 2.10), and only for an area derived under
 * the group, and only to an active entry of the accepted roster at the key
 * version the context names.
 */
export async function sealAreaGrant(
    workspaceKey: Uint8Array,
    ctx: AreaGrantContext,
    options: {
        chain: AcceptedRosters;
        areaIdSeed: string;
        granteeKemPublicKey: Uint8Array;
        granter: HybridSigningKey;
    },
) {
    if (workspaceKey.length !== 32) throw new CryptoError('Invalid workspace key.');
    sameGroup(options.chain, ctx.groupId);
    sealedAtLatest(options.chain, ctx);
    if (!activeWith(rosterEntry(options.chain.roster, ctx.granterUserId)))
        throw new CryptoError('Areas are granted only by active members.');
    await sealerHolds(options.chain, ctx.granterUserId, options.granter);
    await areaOf(ctx.groupId, ctx.workspaceId, options.areaIdSeed);
    // A retired area (design 2.10) is granted no more, at any version.
    if (options.chain.retiredAreas.includes(ctx.workspaceId)) throw new CryptoError(RETIRED);
    // Only a key the chain lists for that area and version: a new area or a rotation is a
    // roster first.
    if (
        listedArea(options.chain, ctx.workspaceId, ctx.workspaceKeyVersion) !==
        (await areaKeyCommitment(workspaceKey))
    )
        throw new CryptoError(NOT_LISTED_KEY);
    const grantee = rosterEntry(options.chain.roster, ctx.granteeUserId);
    if (!activeWith(grantee) || grantee!.keyVersion !== ctx.granteeKeyVersion)
        throw new CryptoError('Areas are granted only to active members.');
    const recipient = await memberRecipient(grantee!, options.granteeKemPublicKey);
    return sealHybrid(workspaceKey, recipient, options.granter, areaGrantKind(ctx));
}

const NOT_LISTED_KEY = 'This area key is not the one the group’s member list names.';

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
function areaCommitments(chain: AcceptedRosters, workspaceId: string) {
    try {
        uuid(workspaceId, 'workspace id');
    } catch {
        return null;
    }
    return Object.hasOwn(chain.areaKeys, workspaceId) ? chain.areaKeys[workspaceId]! : null;
}

function listedArea(chain: AcceptedRosters, workspaceId: string, workspaceKeyVersion: number) {
    if (!Number.isSafeInteger(workspaceKeyVersion) || workspaceKeyVersion < 1) return undefined;
    return areaCommitments(chain, workspaceId)?.[workspaceKeyVersion - 1];
}

/*
 * The key version a member writes an area under: the latest the accepted
 * chain lists for it, or null when it lists none (not an area of the
 * group's). A client holding no grant for that version writes nothing to the
 * area until it has one: the server's word that the area is at an older
 * version is no protection against the server (design 2.6).
 */
export function areaWriteVersion(chain: AcceptedRosters, workspaceId: string): number | null {
    requireAccepted(chain);
    // A retired area (design 2.10) is written no more.
    if (chain.retiredAreas.includes(workspaceId)) return null;
    return areaCommitments(chain, workspaceId)?.length ?? null;
}

/*
 * Whether an area root's key is the one the chain committed to at that area
 * version (design 2.10): what decides the root is current, beside its
 * envelope opening under the area key at that version. True when the chain
 * lists a root commitment there and the key has it; false when the version
 * was listed by a format 1 roster, which committed to no root (the caller
 * keeps the previous rule, the envelope opening). Refused when the key's
 * commitment is another, the version is not listed, or the area is retired.
 */
export async function checkAreaRoot(
    chain: AcceptedRosters,
    workspaceId: string,
    workspaceKeyVersion: number,
    rootKey: Uint8Array,
): Promise<boolean> {
    requireAccepted(chain);
    integer(workspaceKeyVersion, 'workspace key version');
    if (chain.retiredAreas.includes(workspaceId)) throw new CryptoError(RETIRED);
    if (!listedArea(chain, workspaceId, workspaceKeyVersion))
        throw new CryptoError('This area key version is not on the group’s member list.');
    // An explicit null is a version a format 1 roster listed; no entry at all is no answer.
    const roots = Object.hasOwn(chain.areaRoots, workspaceId) ? chain.areaRoots[workspaceId]! : [];
    const listed = roots[workspaceKeyVersion - 1];
    if (listed === undefined) throw new CryptoError(NOT_LISTED_ROOT);
    if (listed === null) return false;
    if ((await areaRootCommitment(rootKey)) !== listed) throw new CryptoError(NOT_LISTED_ROOT);
    return true;
}

const NOT_LISTED_ROOT = 'This folder’s key is not the one the group’s member list names.';

/*
 * The row a roster would carry for an area's next key (areaRows, for one
 * key): to preview the version a rotation or new area gets. nextRoster takes
 * the keys themselves and computes the rows.
 */
export async function nextAreaKey(
    chain: AcceptedRosters,
    workspaceId: string,
    workspaceKey: Uint8Array,
    rootKey?: Uint8Array,
): Promise<RosterArea> {
    return (
        await areaRows(chain, [{ workspaceId, workspaceKey, ...(rootKey ? { rootKey } : {}) }], {
            format: rootKey ? 2 : rosterFormat(chain.roster),
        })
    )[0]!;
}

/*
 * An area's new key, for nextRoster to turn into its row, and in format 2 the
 * node key its root folder gets at that version (design 2.10).
 */
export type AreaKey = { workspaceId: string; workspaceKey: Uint8Array; rootKey?: Uint8Array };

/*
 * The rows a roster carries for new area keys (2.4, 2.6): each at its area's
 * next version (1 for a new area), with the key's commitment, sorted by
 * workspace id. Refused when an area appears twice, or a key's commitment
 * repeats: two of the new keys alike, or any key the group had before, in any
 * area at any version (the commitment depends on the key alone, so this is
 * one HKDF per new key and a set lookup). Acceptance refuses the same
 * (checkAreas); this only says so before a holder signs. Only commitments are
 * kept, never copies of the keys.
 */
export async function areaRows(
    chain: AcceptedRosters,
    keys: AreaKey[],
    options: { format?: RosterFormat; retire?: readonly string[] } = {},
): Promise<RosterArea[]> {
    requireAccepted(chain);
    return rowsAfter(
        { keys: chain.areaKeys, roots: chain.areaRoots, retired: chain.retiredAreas },
        keys,
        options.format ?? rosterFormat(chain.roster),
        options.retire ?? [],
    );
}

/*
 * The areas the next roster must rotate for it to hold: in a family every
 * member opens every area, so a roster that marks anyone `left` rotates them
 * all (in companies, until rosters say who opens what, the removal route
 * rotates the areas the removed member held). Pass a new key for each to
 * nextAreaKey and the rows to nextRoster.
 */
export function areasToRotate(chain: AcceptedRosters, members: RosterMember[]): string[] {
    requireAccepted(chain);
    if (chain.kind !== 'family') return [];
    const leaving = members.some(
        (entry) =>
            entry.status === 'left' && rosterEntry(chain.roster, entry.userId)?.status === 'active',
    );
    // A retired area (design 2.10) is never rotated again.
    return leaving
        ? Object.keys(chain.areaKeys)
              .filter((workspaceId) => !chain.retiredAreas.includes(workspaceId))
              .sort()
        : [];
}

/*
 * Opens an area grant: the workspace key. Refused unless it names this group
 * (the accepted chain's), an area derived under it (`areaIdSeed`, 2.6), a key
 * version the accepted chain lists for that area (any listed version: there is
 * no high-water floor, 2.6), the reader's own account and key version, and a
 * granter who is
 * active on the roster and whose signature holds under their keys through it;
 * and the key it opens to must be the one the roster's commitment names. A
 * former member, with the server's help, cannot hand anyone a fake key, and an
 * honest member kept behind cannot hand on a key the real chain never listed.
 */
export async function openAreaGrant(
    envelope: Uint8Array,
    ctx: AreaGrantContext,
    options: {
        chain: AcceptedRosters;
        areaIdSeed: string;
        granterMlDsaPublicKey: Uint8Array;
        granterHistory?: SignerHistory | null;
        reader: { userId: string; keyVersion: number };
        grantee: GranteeSecrets;
    },
) {
    const { chain } = options;
    sameGroup(chain, ctx.groupId);
    sealedOnChain(chain, ctx);
    await areaOf(ctx.groupId, ctx.workspaceId, options.areaIdSeed);
    if (
        ctx.granteeUserId !== options.reader.userId ||
        ctx.granteeKeyVersion !== options.reader.keyVersion
    )
        throw new CryptoError('This grant is not for this account’s keys.');
    if (!activeWith(rosterEntry(chain.roster, ctx.granterUserId)))
        throw new CryptoError('This grant is not from an active member of the group.');
    const listed = listedArea(chain, ctx.workspaceId, ctx.workspaceKeyVersion);
    if (!listed) throw new CryptoError('This area key version is not on the group’s member list.');
    const workspaceKey = await openHybrid(
        envelope,
        32,
        await signersThrough(
            chain,
            ctx.granterUserId,
            options.granterMlDsaPublicKey,
            options.granterHistory ?? null,
        ),
        options.grantee,
        areaGrantKind(ctx),
    );
    // The key itself, not only its sealer: a granter cannot deliver another key under a listed version.
    if ((await areaKeyCommitment(workspaceKey)) !== listed) {
        workspaceKey.fill(0);
        throw new CryptoError(NOT_LISTED_KEY);
    }
    return workspaceKey;
}
