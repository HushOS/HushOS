import sodium from 'libsodium-wrappers';
import { decryptKey, encryptKey } from './aead';
import { areaKeyCommitment } from './area-keys';
import {
    digestOf,
    encodeStatement,
    integer,
    parseStatement,
    requireCanonical,
    sameBytes,
    uuid,
} from './canonical';
import { CryptoError } from './errors';
import { fingerprintWords } from './fingerprint';
import type {
    AcceptedRosters,
    CustodyKeyAt,
    CustodyPublicKey,
    KitKeysAt,
    KitPublicKeys,
    OrgChain,
} from './group-trust';
import {
    GROUP_SEED_BYTES,
    activeWith,
    groupKeyPair,
    rosterEntry,
    sameGroupKey,
    type SignerHistory,
} from './groups';
import { decode, encode } from './keys';
import { checkTime } from './pins';
import { KEM_PUBLIC_KEY_BYTES, ML_DSA_PUBLIC_KEY_BYTES, kemKeypair, mlDsaKeypair } from './pq';
import {
    NOT_LISTED,
    NOT_LISTED_KEY,
    listedArea,
    memberRecipient,
    sameGroup,
    sealedAtLatest,
    sealedOnChain,
    sealerHolds,
    signersThrough,
} from './seal-rules';
import {
    SEAL_COINS_BYTES,
    hybridSealBytes,
    hybridSealedBytes,
    openHybrid,
    requireSealedBy,
    sealHybrid,
    sealWithCoins,
    sealedWithCoins,
    type GranteeKeys,
    type GranteeSecrets,
    type HybridSealKind,
} from './sealing';
import {
    HYBRID_SIGNATURE_BYTES,
    digest,
    signHybrid,
    verifyHybrid,
    type HybridPublicKey,
    type HybridSigningKey,
} from './signatures';

/*
 * The company key (docs/companies-design.md 2.2): the key pair a company
 * holds, the recovery kit, and every seal around them, each the share suite 4
 * construction (sealing.ts) under its own HKDF `info`, with its statement
 * without the final digest as associated data. Also the request to use the
 * kit, and a folder's notice keys (3.7). `hushos-core` (custody.rs) makes and
 * opens the same bytes, pinned by the shared company fixtures. What a roster
 * says of the company key and the kit, and who may change it, is
 * group-trust.ts (checkRosterOrg).
 *
 * Who made a seal is judged by the chain's own record of the roster the seal
 * names: who signed the roster that introduced a key, and who held
 * `data_admin` there. A seal its sealer signed that does not open, or opens
 * to something other than what the chain commits to, is the sealer's doing
 * and is reported with their id (SealCheck), never thrown away silently.
 */

/* 32 bytes of X25519 secret, then 64 of ML-KEM-768 key generation seed. It encrypts only. */
export const CUSTODY_SEED_BYTES = 96;
/* The recovery kit's secret, shown as 24 words and saved as a file. */
export const KIT_SECRET_BYTES = 32;
/* X25519 (32), ML-KEM-768 (64), Ed25519 (32) and ML-DSA-65 (32) seeds, in that order. */
export const KIT_SEED_BYTES = 160;

export const CUSTODY_SEAL_BYTES = hybridSealBytes(32); // 4565
export const CUSTODY_KEY_SEAL_BYTES = hybridSealBytes(CUSTODY_SEED_BYTES); // 4629
export const KIT_SEAL_BYTES = hybridSealBytes(CUSTODY_SEED_BYTES); // 4629
export const KIT_SEAL_PROOF_BYTES = hybridSealBytes(SEAL_COINS_BYTES); // 4621
export const KEY_ESCROW_BYTES = hybridSealBytes(GROUP_SEED_BYTES); // 4597
export const CUSTODY_PREVIOUS_BYTES = hybridSealBytes(CUSTODY_SEED_BYTES); // 4629
/* A folder's notice seed: 32 bytes of X25519 secret, then 64 of ML-KEM-768 seed. */
export const NOTICE_SEED_BYTES = 96;
/* The previous notice seed, wrapped: a 24-byte nonce, the seed and a 16-byte tag. */
export const PREVIOUS_NOTICE_SEED_BYTES = 24 + NOTICE_SEED_BYTES + 16; // 136

/* A fresh company key seed: made once, on the device that makes or replaces the key, and then only ever sealed. */
export function newCustodySeed() {
    return crypto.getRandomValues(new Uint8Array(CUSTODY_SEED_BYTES));
}

/* A fresh recovery kit secret. */
export function newKitSecret() {
    return crypto.getRandomValues(new Uint8Array(KIT_SECRET_BYTES));
}

/* An X25519 key pair whose secret is the 32 bytes given, as the Rust core's StaticSecret takes them. */
async function encryptionKeyPair(secret: Uint8Array) {
    await sodium.ready;
    return { privateKey: secret.slice(), publicKey: sodium.crypto_scalarmult_base(secret) };
}

/* The X25519 and ML-KEM-768 key pairs a 96-byte seed expands to: a company key's, or a folder's notice keys'. */
async function sealingKeyPair(seed: Uint8Array, what: string) {
    if (!(seed instanceof Uint8Array) || seed.length !== CUSTODY_SEED_BYTES)
        throw new CryptoError(`Invalid ${what}.`);
    const encryption = await encryptionKeyPair(seed.subarray(0, 32));
    const kem = kemKeypair(seed.subarray(32));
    return {
        publicKey: {
            encryptionPublicKey: encode(encryption.publicKey),
            kemPublicKey: encode(kem.publicKey),
        } satisfies CustodyPublicKey,
        secrets: {
            privateKey: encryption.privateKey,
            kemSecretKey: kem.secretKey,
        } satisfies GranteeSecrets,
    };
}

/* The company key pair a 96-byte seed expands to: its public halves, and what opens what is sealed to it. */
export async function custodyKeyPair(seed: Uint8Array) {
    return sealingKeyPair(seed, 'company key');
}

async function hkdf(ikm: Uint8Array, info: Uint8Array, length: number) {
    const material = await crypto.subtle.importKey('raw', Uint8Array.from(ikm), 'HKDF', false, [
        'deriveBits',
    ]);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: Uint8Array.from(info),
            },
            material,
            length * 8,
        ),
    );
}

const text = (value: string) => new TextEncoder().encode(value);

/*
 * The recovery kit's key pairs (companies-design 2.2):
 *
 *   kitSeed (160) = HKDF-SHA-256(ikm = kitSecret, salt = 32 zero bytes,
 *                   info = "hushos/group/recovery-kit/v1" || groupId, 160)
 *                 = X25519 (32) || ML-KEM-768 (64) || Ed25519 (32) || ML-DSA-65 (32)
 *
 * The first two open kit seals; the last two sign one thing only, a recovery
 * roster. Bound to the company by its id (36 ASCII bytes): the same secret
 * under another company is another kit.
 */
export async function kitKeys(kitSecret: Uint8Array, groupId: string) {
    if (!(kitSecret instanceof Uint8Array) || kitSecret.length !== KIT_SECRET_BYTES)
        throw new CryptoError('Invalid recovery kit.');
    await sodium.ready;
    const seed = await hkdf(
        kitSecret,
        text(`hushos/group/recovery-kit/v1${uuid(groupId, 'group id')}`),
        KIT_SEED_BYTES,
    );
    try {
        const sealing = await sealingKeyPair(seed.subarray(0, 96), 'recovery kit');
        const classical = sodium.crypto_sign_seed_keypair(seed.subarray(96, 128));
        const lattice = mlDsaKeypair(seed.subarray(128));
        return {
            publicKeys: {
                ...sealing.publicKey,
                signingPublicKey: encode(classical.publicKey),
                mlDsaPublicKey: encode(lattice.publicKey),
            } satisfies KitPublicKeys,
            secrets: sealing.secrets,
            signer: {
                signingKey: classical.privateKey,
                mlDsaSecretKey: lattice.secretKey,
            } satisfies HybridSigningKey,
        };
    } finally {
        seed.fill(0);
    }
}

/*
 * What the creator and the kit show of a company key (companies-design 2.2):
 *
 *   SHA-256("hushos/group/custody/fingerprint/v1" || groupId (36 ASCII bytes) ||
 *           u64be(custodyKeyVersion) || custodyEncryptionPublicKey (32) ||
 *           custodyKemPublicKey (1184))
 *
 * as ten groups of four hex digits, read as twelve words (custodyWords).
 */
export async function custodyFingerprint(
    groupId: string,
    custodyKeyVersion: number,
    key: CustodyPublicKey,
) {
    const prefix = text('hushos/group/custody/fingerprint/v1');
    const input = new Uint8Array(prefix.length + 36 + 8 + 32 + KEM_PUBLIC_KEY_BYTES);
    input.set(prefix);
    input.set(text(uuid(groupId, 'group id')), prefix.length);
    new DataView(input.buffer).setBigUint64(
        prefix.length + 36,
        BigInt(integer(custodyKeyVersion, 'company key version')),
    );
    try {
        input.set(decode(key.encryptionPublicKey, 32), prefix.length + 44);
        input.set(decode(key.kemPublicKey, KEM_PUBLIC_KEY_BYTES), prefix.length + 76);
    } catch {
        throw new CryptoError('Invalid company key.');
    }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    const hex = Array.from(hash.subarray(0, 20), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
    );
    return hex.match(/.{4}/g)!.join(' ');
}

/* A company key's twelve words. */
export async function custodyWords(
    groupId: string,
    custodyKeyVersion: number,
    key: CustodyPublicKey,
) {
    return fingerprintWords(await custodyFingerprint(groupId, custodyKeyVersion, key));
}

/* What the chain says of its company -------------------------------------- */

/*
 * What a check of a seal says:
 * - opened, with what it held: its sealer signed it under keys their entry
 *   still names;
 * - unattributed, with what it held: it holds what the chain commits to, and
 *   was signed under the keys its sealer's entry named at the roster it
 *   names, which the entry has since left (a new identity folded in, or keys
 *   written over). It still opens: a `previousEnvelope` or a folder's seal is
 *   never remade for its sealer's sake. It says nothing of who holds that
 *   entry now;
 * - bad: its signature holds under those keys and yet it does not open, or
 *   holds something other than what the chain commits to. It names the
 *   sealer, under their own signature, unless their keys have since been
 *   replaced (then nobody the list names now is answerable for it: null).
 * A seal nobody entitled signed is refused instead: it says nothing of anyone.
 */
export type SealCheck<T> =
    | { status: 'opened'; value: T }
    | { status: 'unattributed'; value: T }
    | { status: 'bad'; sealerUserId: string | null };

const NOT_A_COMPANY = 'This is not a company.';
const NOT_PUBLISHED = 'This company key is not one the company has published.';
const NOT_THE_KEY = 'This is not the company’s published key.';
const NOT_THE_KIT = 'This is not the company’s recovery kit.';
const NOT_LATEST = 'A seal is made to the company’s latest key.';

function companyOf(chain: AcceptedRosters, groupId: string): OrgChain {
    sameGroup(chain, groupId);
    if (chain.kind !== 'org' || !chain.org) throw new CryptoError(NOT_A_COMPANY);
    return chain.org;
}

/* The company key at `version`, as the roster that introduced it named it. */
function custodyAt(org: OrgChain, version: number): CustodyKeyAt {
    const at = org.custodyKeys[integer(version, 'company key version') - 1];
    if (!at) throw new CryptoError(NOT_PUBLISHED);
    return at;
}

function kitAt(org: OrgChain, version: number): KitKeysAt {
    const at = org.kitKeys[integer(version, 'recovery kit version') - 1];
    if (!at) throw new CryptoError(NOT_THE_KIT);
    return at;
}

/* The version of a key in force at the roster `rosterVersion`: the latest one a roster up to it introduced. */
function versionAt(history: readonly { rosterVersion: number }[], rosterVersion: number) {
    return history.filter((at) => at.rosterVersion <= rosterVersion).length;
}

/* Whether `userId` held `data_admin` on the roster at `rosterVersion`. */
function wasDataAdmin(org: OrgChain, userId: string, rosterVersion: number) {
    const spans = Object.hasOwn(org.dataAdmins, userId) ? org.dataAdmins[userId]! : [];
    return spans.some(
        (span) => span.from <= rosterVersion && (span.until === null || rosterVersion < span.until),
    );
}

/* What a seal to a company key or a kit is sealed to: its X25519 key, and the served ML-KEM key only if the chain names it. */
async function listedRecipient(
    at: { encryptionPublicKey: string; kemPublicKeyDigest: string },
    kemPublicKey: Uint8Array,
): Promise<GranteeKeys> {
    if (
        kemPublicKey.length !== KEM_PUBLIC_KEY_BYTES ||
        (await digest(kemPublicKey)) !== at.kemPublicKeyDigest
    )
        throw new CryptoError(NOT_LISTED);
    return { encryptionPublicKey: decode(at.encryptionPublicKey, 32), kemPublicKey };
}

/* Whether a seed's public keys are the ones the chain names at a version. */
async function seedIs(seed: Uint8Array, at: CustodyKeyAt) {
    const derived = await custodyKeyPair(seed);
    derived.secrets.privateKey.fill(0);
    derived.secrets.kemSecretKey.fill(0);
    return (
        derived.publicKey.encryptionPublicKey === at.encryptionPublicKey &&
        (await digest(decode(derived.publicKey.kemPublicKey))) === at.kemPublicKeyDigest
    );
}

/* The opener's company key secrets at `version`, from the seed it holds: refused unless the seed is the chain's. */
async function custodySecrets(org: OrgChain, version: number, seed: Uint8Array) {
    const at = custodyAt(org, version);
    if (seed.length !== CUSTODY_SEED_BYTES || !(await seedIs(seed, at)))
        throw new CryptoError(NOT_THE_KEY);
    return (await custodyKeyPair(seed)).secrets;
}

type Sealed = { sealerUserId: string; rosterVersion: number; rosterDigest: string };

/* The seal kind of a statement: `parts` is the statement without its final digest, and the associated data. */
function kindOf(parts: unknown[], info: string, noun: string): HybridSealKind {
    const associatedData = encodeStatement(parts);
    return {
        info,
        associatedData,
        statement: async (sealed) => encodeStatement([...parts, await digest(sealed)]),
        noun,
        invalid: `Invalid ${noun} seal.`,
        unsigned: `This ${noun} was not sealed by someone the company’s member list entitles.`,
    };
}

type Opening = {
    chain: AcceptedRosters;
    /* The sealer's served ML-DSA key: taken only if it is the one their entry named at the roster the seal names. */
    sealerMlDsaPublicKey: Uint8Array;
};

/*
 * The keys a seal that names a roster is checked under: the ones its sealer's
 * entry named at that roster (the chain's own record, OrgChain.signerKeys),
 * whatever the entry names now, and whether it still names them. Family seals
 * are remade when their sealer's keys change; a `previousEnvelope` and a
 * folder's seal to the company key are not, so they are never judged by the
 * sealer's latest keys or by a succession path that may not exist (an Owner
 * who started over, a `left` entry written over). A served ML-DSA key the
 * entry did not name there is refused, as is a sealer not yet on the list.
 */
async function signerAt(org: OrgChain, ctx: Sealed, servedMlDsaPublicKey: Uint8Array) {
    const spans = Object.hasOwn(org.signerKeys, ctx.sealerUserId)
        ? org.signerKeys[ctx.sealerUserId]!
        : [];
    const at = spans.filter((span) => span.from <= ctx.rosterVersion).length - 1;
    const named = spans[at];
    if (
        !named ||
        servedMlDsaPublicKey.length !== ML_DSA_PUBLIC_KEY_BYTES ||
        (await digest(servedMlDsaPublicKey)) !== named.mlDsaPublicKeyDigest
    )
        throw new CryptoError(NOT_LISTED);
    return {
        signer: {
            signingPublicKey: decode(named.signingPublicKey, 32),
            mlDsaPublicKey: servedMlDsaPublicKey,
        } satisfies HybridPublicKey,
        // Still the entry's keys: no later span names other signing keys (a key version
        // alone moving on keeps them).
        current: spans
            .slice(at)
            .every(
                (span) =>
                    span.signingPublicKey === named.signingPublicKey &&
                    span.mlDsaPublicKeyDigest === named.mlDsaPublicKeyDigest,
            ),
    };
}

/*
 * Opens a seal to a company key and judges what it holds: refused unless the
 * keys its sealer's entry named at the roster it names signed it; then `bad`
 * when it does not open under `secrets` or `holds` says the payload is not
 * what the chain commits to; else what it held, attributed to its sealer only
 * while their entry still names those keys.
 */
async function openChecked(
    envelope: Uint8Array,
    payloadBytes: number,
    ctx: Sealed,
    kind: HybridSealKind,
    org: OrgChain,
    options: Opening,
    secrets: GranteeSecrets,
    holds: (payload: Uint8Array) => Promise<boolean>,
): Promise<SealCheck<Uint8Array>> {
    let payload: Uint8Array;
    let current: boolean;
    try {
        const at = await signerAt(org, ctx, options.sealerMlDsaPublicKey);
        current = at.current;
        await requireSealedBy(envelope, payloadBytes, [at.signer], kind);
        const bad = { status: 'bad' as const, sealerUserId: current ? ctx.sealerUserId : null };
        try {
            payload = await openHybrid(envelope, payloadBytes, [at.signer], secrets, kind);
        } catch (error) {
            if (error instanceof CryptoError) return bad;
            throw error;
        }
        if (!(await holds(payload))) {
            payload.fill(0);
            return bad;
        }
    } finally {
        secrets.privateKey.fill(0);
        secrets.kemSecretKey?.fill(0);
    }
    return { status: current ? 'opened' : 'unattributed', value: payload };
}

/* Folder keys sealed to the company key (2.2) ----------------------------- */

const CUSTODY_SEAL_INFO = 'hushos/group/custody-seal/v1';

export type CustodySealContext = {
    groupId: string;
    workspaceId: string;
    workspaceKeyVersion: number;
    custodyKeyVersion: number;
    sealerUserId: string;
    rosterVersion: number;
    rosterDigest: string;
};

function custodySealParts(ctx: CustodySealContext) {
    return [
        'hushos/group/custody-seal',
        1,
        uuid(ctx.groupId, 'group id'),
        uuid(ctx.workspaceId, 'workspace id'),
        integer(ctx.workspaceKeyVersion, 'workspace key version'),
        integer(ctx.custodyKeyVersion, 'company key version'),
        uuid(ctx.sealerUserId, 'user id'),
        integer(ctx.rosterVersion, 'roster version'),
        digestOf(ctx.rosterDigest, 'roster digest'),
    ];
}

/* ["hushos/group/custody-seal",1,groupId,workspaceId,workspaceKeyVersion,custodyKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)] */
export async function custodySealStatement(ctx: CustodySealContext, sealed: Uint8Array) {
    return encodeStatement([...custodySealParts(ctx), await digest(sealed)]);
}
/* A custody seal's associated data: its statement without the final digest. */
export function custodySealContext(ctx: CustodySealContext) {
    return encodeStatement(custodySealParts(ctx));
}

/*
 * Who may have sealed an area key at the roster a custody seal names: the
 * signer of the roster that listed that key version, on that roster (the
 * seal rides on it); or, for a re-seal after the company key was replaced,
 * anyone who held `data_admin` on the roster named.
 */
function custodySealer(org: OrgChain, ctx: CustodySealContext) {
    const listedAt = Object.hasOwn(org.areaRosters, ctx.workspaceId)
        ? org.areaRosters[ctx.workspaceId]![ctx.workspaceKeyVersion - 1]
        : undefined;
    // Never before the roster that listed the key.
    if (!listedAt || listedAt.rosterVersion > ctx.rosterVersion) return false;
    return (
        (listedAt.rosterVersion === ctx.rosterVersion &&
            listedAt.signerUserId === ctx.sealerUserId) ||
        wasDataAdmin(org, ctx.sealerUserId, ctx.rosterVersion)
    );
}

/*
 * Seals an area's key to the company key: only a key the accepted chain lists
 * for that company, at the version it lists (so no personal workspace's key
 * can enter, 2.6), never for a retired area, to the latest company key and no
 * other, by the signer of the roster that listed the key or by a data admin
 * re-sealing after a replacement, at their latest accepted roster.
 */
export async function sealCustody(
    workspaceKey: Uint8Array,
    ctx: CustodySealContext,
    options: { chain: AcceptedRosters; custodyKemPublicKey: Uint8Array; sealer: HybridSigningKey },
) {
    if (!(workspaceKey instanceof Uint8Array) || workspaceKey.length !== 32)
        throw new CryptoError('Invalid workspace key.');
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedAtLatest(chain, ctx);
    if (ctx.custodyKeyVersion !== org.custodyKeys.length) throw new CryptoError(NOT_LATEST);
    if (chain.retiredAreas.includes(ctx.workspaceId))
        throw new CryptoError('This folder was deleted: it cannot be used again.');
    if (
        listedArea(chain, ctx.workspaceId, ctx.workspaceKeyVersion) !==
        (await areaKeyCommitment(workspaceKey))
    )
        throw new CryptoError(NOT_LISTED_KEY);
    if (!custodySealer(org, ctx) || !activeWith(rosterEntry(chain.roster, ctx.sealerUserId)))
        throw new CryptoError(
            'A folder’s key is sealed to the company by whoever made it, or by a data admin.',
        );
    await sealerHolds(chain, ctx.sealerUserId, options.sealer);
    const recipient = await listedRecipient(
        custodyAt(org, ctx.custodyKeyVersion),
        options.custodyKemPublicKey,
    );
    return sealHybrid(
        workspaceKey,
        recipient,
        options.sealer,
        kindOf(custodySealParts(ctx), CUSTODY_SEAL_INFO, 'folder key'),
    );
}

/*
 * A data admin's check of a custody seal (2.2, "Checking a seal"), and the
 * way the admin browser reaches a folder's key: refused unless it names this
 * company, a roster on the chain, the company key in force at that roster, an
 * area key version the chain listed by then, and a sealer entitled there
 * whose signature holds; `custodySeed` must be the chain's company key at the
 * version named. Then the folder's key, or `bad` with the sealer when the
 * seal does not open or opens to a key other than the one the roster commits
 * to.
 */
export async function openCustodySeal(
    envelope: Uint8Array,
    ctx: CustodySealContext,
    options: Opening & { custodySeed: Uint8Array },
): Promise<SealCheck<Uint8Array>> {
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedOnChain(chain, ctx);
    if (ctx.custodyKeyVersion !== versionAt(org.custodyKeys, ctx.rosterVersion))
        throw new CryptoError(NOT_PUBLISHED);
    const listed = listedArea(chain, ctx.workspaceId, ctx.workspaceKeyVersion);
    if (!listed) throw new CryptoError('This area key version is not on the group’s member list.');
    if (!custodySealer(org, ctx))
        throw new CryptoError(
            'This folder key was not sealed by whoever made it, or by a data admin.',
        );
    const secrets = await custodySecrets(org, ctx.custodyKeyVersion, options.custodySeed);
    return openChecked(
        envelope,
        32,
        ctx,
        kindOf(custodySealParts(ctx), CUSTODY_SEAL_INFO, 'folder key'),
        org,
        options,
        secrets,
        async (key) => (await areaKeyCommitment(key)) === listed,
    );
}

/* The seed, sealed to data admins (2.2) ----------------------------------- */

const CUSTODY_KEY_SEAL_INFO = 'hushos/group/custody-key-seal/v1';

export type CustodyKeySealContext = {
    groupId: string;
    custodyKeyVersion: number;
    holderUserId: string;
    holderKeyVersion: number;
    sealerUserId: string;
    rosterVersion: number;
    rosterDigest: string;
};

function custodyKeySealParts(ctx: CustodyKeySealContext) {
    return [
        'hushos/group/custody-key-seal',
        1,
        uuid(ctx.groupId, 'group id'),
        integer(ctx.custodyKeyVersion, 'company key version'),
        uuid(ctx.holderUserId, 'user id'),
        integer(ctx.holderKeyVersion, 'key version'),
        uuid(ctx.sealerUserId, 'user id'),
        integer(ctx.rosterVersion, 'roster version'),
        digestOf(ctx.rosterDigest, 'roster digest'),
    ];
}

/* ["hushos/group/custody-key-seal",1,groupId,custodyKeyVersion,holderUserId,holderKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)] */
export async function custodyKeySealStatement(ctx: CustodyKeySealContext, sealed: Uint8Array) {
    return encodeStatement([...custodyKeySealParts(ctx), await digest(sealed)]);
}
export function custodyKeySealContext(ctx: CustodyKeySealContext) {
    return encodeStatement(custodyKeySealParts(ctx));
}

/* An active data admin on the latest roster, or the creator for version 1 while active: who seals and whose seal opens. */
function sealsCustodyKey(chain: AcceptedRosters, userId: string, custodyKeyVersion: number) {
    const entry = rosterEntry(chain.roster, userId);
    return (
        activeWith(entry, 'data_admin') ||
        (custodyKeyVersion === 1 && activeWith(entry) && chain.creatorUserId === userId)
    );
}

/*
 * Seals the company key's seed to a data admin: the latest company key only,
 * and only the seed whose public keys the chain names; by an active data
 * admin (the creator, for version 1), to an entry active with `data_admin` at
 * the exact key version it names, under the ML-KEM key it names by digest.
 */
export async function sealCustodyKey(
    seed: Uint8Array,
    ctx: CustodyKeySealContext,
    options: { chain: AcceptedRosters; holderKemPublicKey: Uint8Array; sealer: HybridSigningKey },
) {
    if (!(seed instanceof Uint8Array) || seed.length !== CUSTODY_SEED_BYTES)
        throw new CryptoError('Invalid company key.');
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedAtLatest(chain, ctx);
    if (ctx.custodyKeyVersion !== org.custodyKeys.length) throw new CryptoError(NOT_LATEST);
    if (!(await seedIs(seed, custodyAt(org, ctx.custodyKeyVersion))))
        throw new CryptoError(NOT_THE_KEY);
    if (!sealsCustodyKey(chain, ctx.sealerUserId, ctx.custodyKeyVersion))
        throw new CryptoError('The company key is sealed only by a data admin.');
    await sealerHolds(chain, ctx.sealerUserId, options.sealer);
    const holder = rosterEntry(chain.roster, ctx.holderUserId);
    if (!activeWith(holder, 'data_admin') || holder!.keyVersion !== ctx.holderKeyVersion)
        throw new CryptoError('The company key is sealed only to data admins.');
    return sealHybrid(
        seed,
        await memberRecipient(holder!, options.holderKemPublicKey),
        options.sealer,
        kindOf(custodyKeySealParts(ctx), CUSTODY_KEY_SEAL_INFO, 'company key'),
    );
}

/*
 * Opens a data admin's seal: the 96-byte company seed. Refused unless it is
 * for this account at this key version, names a roster on the chain and a
 * company key version the chain published, its sealer is an active data
 * admin on the accepted roster (or the creator, for version 1) whose
 * signature holds under their keys through it, and the seed derives exactly
 * the company key the chain names at that version.
 */
export async function openCustodyKey(
    envelope: Uint8Array,
    ctx: CustodyKeySealContext,
    options: Opening & {
        /* The sealer's served identity and links, so a seal made before a fold-in still opens. */
        sealerHistory?: SignerHistory | null;
        reader: { userId: string; keyVersion: number };
        holder: GranteeSecrets;
    },
) {
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedOnChain(chain, ctx);
    if (
        ctx.holderUserId !== options.reader.userId ||
        ctx.holderKeyVersion !== options.reader.keyVersion
    )
        throw new CryptoError('This company key was not sealed to this account’s keys.');
    const at = custodyAt(org, ctx.custodyKeyVersion);
    if (!sealsCustodyKey(chain, ctx.sealerUserId, ctx.custodyKeyVersion))
        throw new CryptoError('This company key was not sealed by a data admin.');
    const seed = await openHybrid(
        envelope,
        CUSTODY_SEED_BYTES,
        await signersThrough(
            chain,
            ctx.sealerUserId,
            options.sealerMlDsaPublicKey,
            options.sealerHistory ?? null,
        ),
        options.holder,
        kindOf(custodyKeySealParts(ctx), CUSTODY_KEY_SEAL_INFO, 'company key'),
    );
    if (!(await seedIs(seed, at))) {
        seed.fill(0);
        throw new CryptoError(NOT_THE_KEY);
    }
    return seed;
}

/* The seed, sealed to the kit, and the seal's proof (2.2) -------------------- */

const KIT_SEAL_INFO = 'hushos/group/kit-seal/v1';
const KIT_SEAL_PROOF_INFO = 'hushos/group/kit-seal-proof/v1';

export type KitSealContext = {
    groupId: string;
    custodyKeyVersion: number;
    kitVersion: number;
    sealerUserId: string;
    rosterVersion: number;
    rosterDigest: string;
};

function kitSealParts(ctx: KitSealContext, domain = 'hushos/group/kit-seal') {
    return [
        domain,
        1,
        uuid(ctx.groupId, 'group id'),
        integer(ctx.custodyKeyVersion, 'company key version'),
        integer(ctx.kitVersion, 'recovery kit version'),
        uuid(ctx.sealerUserId, 'user id'),
        integer(ctx.rosterVersion, 'roster version'),
        digestOf(ctx.rosterDigest, 'roster digest'),
    ];
}
async function kitSealProofParts(ctx: KitSealContext, kitSeal: Uint8Array) {
    return [...kitSealParts(ctx, 'hushos/group/kit-seal-proof'), await digest(kitSeal)];
}

/* ["hushos/group/kit-seal",1,groupId,custodyKeyVersion,kitVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)] */
export async function kitSealStatement(ctx: KitSealContext, sealed: Uint8Array) {
    return encodeStatement([...kitSealParts(ctx), await digest(sealed)]);
}
/* ["hushos/group/kit-seal-proof",1,groupId,custodyKeyVersion,kitVersion,sealerUserId,rosterVersion,rosterDigest,sha256(kitSeal),sha256(sealed)] */
export async function kitSealProofStatement(
    ctx: KitSealContext,
    kitSeal: Uint8Array,
    sealed: Uint8Array,
) {
    return encodeStatement([...(await kitSealProofParts(ctx, kitSeal)), await digest(sealed)]);
}

/*
 * A kit seal is made on the roster that introduced its company key, by that
 * roster's signer (an Owner: rules 8 and 12), to the kit in force there. A
 * new kit always comes with a new company key (rule 7), so there is no other
 * moment one is made.
 */
function kitSealer(org: OrgChain, ctx: KitSealContext) {
    const key = custodyAt(org, ctx.custodyKeyVersion);
    kitAt(org, ctx.kitVersion);
    return (
        key.rosterVersion === ctx.rosterVersion &&
        key.signerUserId === ctx.sealerUserId &&
        versionAt(org.kitKeys, key.rosterVersion) === ctx.kitVersion
    );
}

const NOT_KIT_SEALER =
    'The company key is sealed to the recovery kit by the owner who made the key, on the member list that introduced it.';

/*
 * Seals the company key's seed to the recovery kit's public keys, and makes
 * the seal's proof: the three values the seal drew (the ephemeral X25519
 * secret, the ML-KEM encapsulation randomness, the nonce), sealed to the
 * company key itself, so every data admin can run the seal again and see
 * that the kit will open to the real seed (checkKitSeal). The kit need not be
 * present. Only the seed the chain names, at the latest company key and kit,
 * by the signer of the roster that introduced that key.
 */
export async function sealKit(
    seed: Uint8Array,
    ctx: KitSealContext,
    options: {
        chain: AcceptedRosters;
        kitKemPublicKey: Uint8Array;
        custodyKemPublicKey: Uint8Array;
        sealer: HybridSigningKey;
    },
) {
    if (!(seed instanceof Uint8Array) || seed.length !== CUSTODY_SEED_BYTES)
        throw new CryptoError('Invalid company key.');
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedAtLatest(chain, ctx);
    if (ctx.custodyKeyVersion !== org.custodyKeys.length || ctx.kitVersion !== org.kitKeys.length)
        throw new CryptoError(NOT_LATEST);
    const key = custodyAt(org, ctx.custodyKeyVersion);
    if (!(await seedIs(seed, key))) throw new CryptoError(NOT_THE_KEY);
    if (!kitSealer(org, ctx)) throw new CryptoError(NOT_KIT_SEALER);
    await sealerHolds(chain, ctx.sealerUserId, options.sealer);
    const toKit = await listedRecipient(kitAt(org, ctx.kitVersion), options.kitKemPublicKey);
    const toCompany = await listedRecipient(key, options.custodyKemPublicKey);
    const coins = crypto.getRandomValues(new Uint8Array(SEAL_COINS_BYTES));
    try {
        const kitSeal = await sealWithCoins(
            seed,
            toKit,
            options.sealer,
            kindOf(kitSealParts(ctx), KIT_SEAL_INFO, 'recovery kit'),
            coins,
        );
        const proof = await sealHybrid(
            coins,
            toCompany,
            options.sealer,
            kindOf(
                await kitSealProofParts(ctx, kitSeal),
                KIT_SEAL_PROOF_INFO,
                'recovery kit proof',
            ),
        );
        return { kitSeal, proof };
    } finally {
        coins.fill(0);
    }
}

/* What a kit seal's context must say on any chain that holds it. */
function kitSealOnChain(chain: AcceptedRosters, ctx: KitSealContext) {
    const org = companyOf(chain, ctx.groupId);
    sealedOnChain(chain, ctx);
    if (!kitSealer(org, ctx)) throw new CryptoError(NOT_KIT_SEALER);
    return org;
}

/*
 * A data admin's check that the kit will open to the company key (2.2,
 * "Proving a kit seal"): nobody can open a kit seal without the kit, so the
 * device opens the proof with the company seed it holds, runs the kit seal
 * again with the three values inside and that seed as the plaintext, and
 * compares everything before the signature (1,256 bytes) with the stored
 * seal. Refused unless both the seal and its proof are signed by the Owner
 * the chain entitles and `custodySeed` is the chain's key at the version
 * named; then `opened`, or `bad` with the sealer when the proof does not
 * open or the seal is not the one those values make: the fix is a new kit.
 */
export async function checkKitSeal(
    kitSeal: Uint8Array,
    proof: Uint8Array,
    ctx: KitSealContext,
    options: Opening & { kitKemPublicKey: Uint8Array; custodySeed: Uint8Array },
): Promise<SealCheck<true>> {
    const org = kitSealOnChain(options.chain, ctx);
    const kind = kindOf(kitSealParts(ctx), KIT_SEAL_INFO, 'recovery kit');
    const { signer, current } = await signerAt(org, ctx, options.sealerMlDsaPublicKey);
    await requireSealedBy(kitSeal, CUSTODY_SEED_BYTES, [signer], kind);
    const toKit = await listedRecipient(kitAt(org, ctx.kitVersion), options.kitKemPublicKey);
    const secrets = await custodySecrets(org, ctx.custodyKeyVersion, options.custodySeed);
    const coins = await openChecked(
        proof,
        SEAL_COINS_BYTES,
        ctx,
        kindOf(await kitSealProofParts(ctx, kitSeal), KIT_SEAL_PROOF_INFO, 'recovery kit proof'),
        org,
        options,
        secrets,
        async () => true,
    );
    if (coins.status === 'bad') return coins;
    try {
        // (The proof was signed under the same keys as the seal: `current` is one answer for both.)
        const again = await sealedWithCoins(options.custodySeed, toKit, kind, coins.value);
        const sealed = kitSeal.subarray(0, hybridSealedBytes(CUSTODY_SEED_BYTES));
        if (!sameBytes(again, sealed))
            return { status: 'bad', sealerUserId: current ? ctx.sealerUserId : null };
        return { status: current ? 'opened' : 'unattributed', value: true };
    } finally {
        coins.value.fill(0);
    }
}

/*
 * Opens the kit seal with the recovery kit: the company seed. Refused unless
 * the kit's secret derives exactly the kit the chain names at the version the
 * seal names (another company's kit, or one a later roster replaced, opens
 * nothing), the seal is the entitled Owner's, and the seed derives the
 * company key the chain names at its version.
 */
export async function openKitSeal(
    kitSeal: Uint8Array,
    ctx: KitSealContext,
    options: Opening & { kitSecret: Uint8Array },
) {
    const org = kitSealOnChain(options.chain, ctx);
    const kit = await kitKeys(options.kitSecret, ctx.groupId);
    kit.signer.signingKey.fill(0);
    kit.signer.mlDsaSecretKey.fill(0);
    // Every path out wipes the kit's secrets, a refusal included.
    try {
        const listed = kitAt(org, ctx.kitVersion);
        if (
            kit.publicKeys.encryptionPublicKey !== listed.encryptionPublicKey ||
            (await digest(decode(kit.publicKeys.kemPublicKey))) !== listed.kemPublicKeyDigest
        )
            throw new CryptoError(NOT_THE_KIT);
        const { signer } = await signerAt(org, ctx, options.sealerMlDsaPublicKey);
        const seed = await openHybrid(
            kitSeal,
            CUSTODY_SEED_BYTES,
            [signer],
            kit.secrets,
            kindOf(kitSealParts(ctx), KIT_SEAL_INFO, 'recovery kit'),
        );
        if (!(await seedIs(seed, custodyAt(org, ctx.custodyKeyVersion)))) {
            seed.fill(0);
            throw new CryptoError(NOT_THE_KEY);
        }
        return seed;
    } finally {
        kit.secrets.privateKey.fill(0);
        kit.secrets.kemSecretKey.fill(0);
    }
}

/* The group key's escrow (2.2) --------------------------------------------- */

const KEY_ESCROW_INFO = 'hushos/group/key-escrow/v1';

export type KeyEscrowContext = {
    groupId: string;
    groupKeyVersion: number;
    custodyKeyVersion: number;
    sealerUserId: string;
    rosterVersion: number;
    rosterDigest: string;
};

function keyEscrowParts(ctx: KeyEscrowContext) {
    return [
        'hushos/group/key-escrow',
        1,
        uuid(ctx.groupId, 'group id'),
        integer(ctx.groupKeyVersion, 'group key version'),
        integer(ctx.custodyKeyVersion, 'company key version'),
        uuid(ctx.sealerUserId, 'user id'),
        integer(ctx.rosterVersion, 'roster version'),
        digestOf(ctx.rosterDigest, 'roster digest'),
    ];
}

/* ["hushos/group/key-escrow",1,groupId,groupKeyVersion,custodyKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)] */
export async function keyEscrowStatement(ctx: KeyEscrowContext, sealed: Uint8Array) {
    return encodeStatement([...keyEscrowParts(ctx), await digest(sealed)]);
}

/*
 * Who makes an escrow (2.2): the signer of the call that made the group key
 * or the company key it joins. The creator for the first of each; the signer
 * of the succession into that group key; the signer of the roster that
 * introduced that company key. Each is an Owner (rule 12), and must have held
 * `data_admin` on the roster the escrow names: the chain guards the keys of
 * an entry only while it holds a role, so "who made the key" alone would let
 * keys written later into an entry its Owner left sign an escrow in that
 * Owner's name.
 */
function escrowSealer(chain: AcceptedRosters, org: OrgChain, ctx: KeyEscrowContext) {
    const key = custodyAt(org, ctx.custodyKeyVersion);
    integer(ctx.groupKeyVersion, 'group key version');
    if (!chain.groupKeys[ctx.groupKeyVersion - 1])
        throw new CryptoError('This group key is not one the group has published.');
    const into = chain.cache.successions[ctx.groupKeyVersion - 2];
    const made =
        (ctx.groupKeyVersion === 1 &&
            ctx.custodyKeyVersion === 1 &&
            ctx.sealerUserId === chain.creatorUserId) ||
        (into !== undefined && into.signerUserId === ctx.sealerUserId) ||
        (ctx.custodyKeyVersion > 1 && key.signerUserId === ctx.sealerUserId);
    return made && wasDataAdmin(org, ctx.sealerUserId, ctx.rosterVersion);
}

const NOT_ESCROW_SEALER =
    'The group key is sealed to the company key by the owner who made either.';

/*
 * Seals the group key's seed to the company key, so the kit restores
 * management as well as files: the current group key (the seed must be the
 * chain's) to the latest company key, by the signer of the call that made
 * either.
 */
export async function sealKeyEscrow(
    groupSeed: Uint8Array,
    ctx: KeyEscrowContext,
    options: { chain: AcceptedRosters; custodyKemPublicKey: Uint8Array; sealer: HybridSigningKey },
) {
    if (!(groupSeed instanceof Uint8Array) || groupSeed.length !== GROUP_SEED_BYTES)
        throw new CryptoError('Invalid group key.');
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedAtLatest(chain, ctx);
    if (
        ctx.custodyKeyVersion !== org.custodyKeys.length ||
        ctx.groupKeyVersion !== chain.groupKeyVersion
    )
        throw new CryptoError(NOT_LATEST);
    if (!escrowSealer(chain, org, ctx) || !activeWith(rosterEntry(chain.roster, ctx.sealerUserId)))
        throw new CryptoError(NOT_ESCROW_SEALER);
    if (!(await groupSeedIs(groupSeed, chain, ctx.groupKeyVersion)))
        throw new CryptoError('This group key is not the group’s published key.');
    await sealerHolds(chain, ctx.sealerUserId, options.sealer);
    return sealHybrid(
        groupSeed,
        await listedRecipient(custodyAt(org, ctx.custodyKeyVersion), options.custodyKemPublicKey),
        options.sealer,
        kindOf(keyEscrowParts(ctx), KEY_ESCROW_INFO, 'group key escrow'),
    );
}

async function groupSeedIs(seed: Uint8Array, chain: AcceptedRosters, groupKeyVersion: number) {
    const derived = await groupKeyPair(seed);
    derived.signingKey.fill(0);
    derived.mlDsaSecretKey.fill(0);
    return sameGroupKey(derived.publicKey, chain.groupKeys[groupKeyVersion - 1]!);
}

/*
 * Opens the escrow with the company key: the group seed. Refused unless it
 * names this company, a roster on the chain, versions the chain published and
 * a sealer who made one of them and held `data_admin` on the roster named,
 * signed under the keys their entry named there; `custodySeed` must
 * be the chain's company key at the version named. Then the seed, or `bad`
 * with the sealer when it does not open or its public keys are not the
 * chain's group key at that version.
 */
export async function openKeyEscrow(
    envelope: Uint8Array,
    ctx: KeyEscrowContext,
    options: Opening & { custodySeed: Uint8Array },
): Promise<SealCheck<Uint8Array>> {
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedOnChain(chain, ctx);
    if (!escrowSealer(chain, org, ctx)) throw new CryptoError(NOT_ESCROW_SEALER);
    const secrets = await custodySecrets(org, ctx.custodyKeyVersion, options.custodySeed);
    return openChecked(
        envelope,
        GROUP_SEED_BYTES,
        ctx,
        kindOf(keyEscrowParts(ctx), KEY_ESCROW_INFO, 'group key escrow'),
        org,
        options,
        secrets,
        (seed) => groupSeedIs(seed, chain, ctx.groupKeyVersion),
    );
}

/* previousEnvelope: the old seed, sealed to the new company key (2.2) ------- */

const CUSTODY_PREVIOUS_INFO = 'hushos/group/custody-previous/v1';

export type CustodyPreviousContext = {
    groupId: string;
    custodyKeyVersion: number;
    previousVersion: number;
    sealerUserId: string;
    rosterVersion: number;
    rosterDigest: string;
};

function custodyPreviousParts(ctx: CustodyPreviousContext) {
    const version = integer(ctx.custodyKeyVersion, 'company key version');
    // Always the version before: each replacement wraps the one it replaces.
    if (integer(ctx.previousVersion, 'company key version') !== version - 1)
        throw new CryptoError('Invalid company key version.');
    return [
        'hushos/group/custody-previous',
        1,
        uuid(ctx.groupId, 'group id'),
        version,
        ctx.previousVersion,
        uuid(ctx.sealerUserId, 'user id'),
        integer(ctx.rosterVersion, 'roster version'),
        digestOf(ctx.rosterDigest, 'roster digest'),
    ];
}

/* ["hushos/group/custody-previous",1,groupId,custodyKeyVersion,previousVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)] */
export async function custodyPreviousStatement(ctx: CustodyPreviousContext, sealed: Uint8Array) {
    return encodeStatement([...custodyPreviousParts(ctx), await digest(sealed)]);
}

/* previousEnvelope is made on the roster that introduced the new company key, by its signer. */
function previousSealer(org: OrgChain, ctx: CustodyPreviousContext) {
    const key = custodyAt(org, ctx.custodyKeyVersion);
    return key.rosterVersion === ctx.rosterVersion && key.signerUserId === ctx.sealerUserId;
}

const NOT_PREVIOUS_SEALER =
    'The earlier company key is sealed to the new one by the owner who replaced it.';

/*
 * Seals the previous company seed to the new company key, on the roster that
 * replaces it, so later data admins still open earlier seals: only the seed
 * the chain names at the version before, to the latest key, by that roster's
 * signer.
 */
export async function sealCustodyPrevious(
    previousSeed: Uint8Array,
    ctx: CustodyPreviousContext,
    options: { chain: AcceptedRosters; custodyKemPublicKey: Uint8Array; sealer: HybridSigningKey },
) {
    if (!(previousSeed instanceof Uint8Array) || previousSeed.length !== CUSTODY_SEED_BYTES)
        throw new CryptoError('Invalid company key.');
    const parts = custodyPreviousParts(ctx);
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedAtLatest(chain, ctx);
    if (ctx.custodyKeyVersion !== org.custodyKeys.length) throw new CryptoError(NOT_LATEST);
    if (!previousSealer(org, ctx)) throw new CryptoError(NOT_PREVIOUS_SEALER);
    if (!(await seedIs(previousSeed, custodyAt(org, ctx.previousVersion))))
        throw new CryptoError(NOT_THE_KEY);
    await sealerHolds(chain, ctx.sealerUserId, options.sealer);
    return sealHybrid(
        previousSeed,
        await listedRecipient(custodyAt(org, ctx.custodyKeyVersion), options.custodyKemPublicKey),
        options.sealer,
        kindOf(parts, CUSTODY_PREVIOUS_INFO, 'earlier company key'),
    );
}

/*
 * Opens previousEnvelope with the company key it is sealed to: the seed of
 * the version before, so a data admin walks back from the key they hold.
 * Refused unless it is the replacing Owner's, on the roster that introduced
 * the key; then the seed, or `bad` with the sealer when it does not open or
 * its public keys are not the chain's company key at the previous version.
 */
export async function openCustodyPrevious(
    envelope: Uint8Array,
    ctx: CustodyPreviousContext,
    options: Opening & { custodySeed: Uint8Array },
): Promise<SealCheck<Uint8Array>> {
    const parts = custodyPreviousParts(ctx);
    const { chain } = options;
    const org = companyOf(chain, ctx.groupId);
    sealedOnChain(chain, ctx);
    if (!previousSealer(org, ctx)) throw new CryptoError(NOT_PREVIOUS_SEALER);
    const before = custodyAt(org, ctx.previousVersion);
    const secrets = await custodySecrets(org, ctx.custodyKeyVersion, options.custodySeed);
    return openChecked(
        envelope,
        CUSTODY_SEED_BYTES,
        ctx,
        kindOf(parts, CUSTODY_PREVIOUS_INFO, 'earlier company key'),
        org,
        options,
        secrets,
        (seed) => seedIs(seed, before),
    );
}

/* Using the kit: the request (2.2) ----------------------------------------- */

export type RecoveryRequest = {
    groupId: string;
    requesterUserId: string;
    requesterKeyVersion: number;
    kitVersion: number;
    custodyKeyVersion: number;
    rosterVersion: number;
    rosterDigest: string;
    /* A 24-character UTC time, as a pin's `checkedAt`. */
    requestedAt: string;
};

const RECOVERY_REQUEST_DOMAIN = 'hushos/group/recovery-request';

/* ["hushos/group/recovery-request",1,groupId,requesterUserId,requesterKeyVersion,kitVersion,custodyKeyVersion,rosterVersion,rosterDigest,requestedAt] */
export function recoveryRequestStatement(request: RecoveryRequest) {
    let requestedAt: string;
    try {
        requestedAt = checkTime(request.requestedAt);
    } catch {
        throw new CryptoError('Invalid recovery request.');
    }
    return encodeStatement([
        RECOVERY_REQUEST_DOMAIN,
        1,
        uuid(request.groupId, 'group id'),
        uuid(request.requesterUserId, 'user id'),
        integer(request.requesterKeyVersion, 'key version'),
        integer(request.kitVersion, 'recovery kit version'),
        integer(request.custodyKeyVersion, 'company key version'),
        integer(request.rosterVersion, 'roster version'),
        digestOf(request.rosterDigest, 'roster digest'),
        requestedAt,
    ]);
}

/* The request a statement's bytes hold, refused unless the bytes are its canonical encoding. */
export function parseRecoveryRequest(statement: Uint8Array): RecoveryRequest {
    const parts = parseStatement(statement, 'recovery request');
    if (parts.length !== 10 || parts[0] !== RECOVERY_REQUEST_DOMAIN || parts[1] !== 1)
        throw new CryptoError('Invalid recovery request.');
    const request = {
        groupId: parts[2],
        requesterUserId: parts[3],
        requesterKeyVersion: parts[4],
        kitVersion: parts[5],
        custodyKeyVersion: parts[6],
        rosterVersion: parts[7],
        rosterDigest: parts[8],
        requestedAt: parts[9],
    } as RecoveryRequest;
    requireCanonical(statement, recoveryRequestStatement(request), 'recovery request');
    return request;
}

const NOT_A_HOLDER = 'Only someone who can use the recovery kit asks to use it.';

/* What a request must say on a chain: an active `recovery` holder's own keys, and the kit and company key now. */
function requestHolds(chain: AcceptedRosters, org: OrgChain, request: RecoveryRequest) {
    const entry = rosterEntry(chain.roster, request.requesterUserId);
    return (
        activeWith(entry, 'recovery') &&
        entry!.keyVersion === request.requesterKeyVersion &&
        request.kitVersion === org.kitKeys.length &&
        request.custodyKeyVersion === org.custodyKeys.length
    );
}

/*
 * Signs a request to use the recovery kit with the requester's hybrid
 * identity signature: only for an active `recovery` holder, at the keys
 * their entry names, for the kit and company key the chain has now, naming
 * their latest accepted roster.
 */
export async function signRecoveryRequest(
    request: RecoveryRequest,
    options: { chain: AcceptedRosters; signer: HybridSigningKey },
) {
    const statement = recoveryRequestStatement(request);
    const org = companyOf(options.chain, request.groupId);
    sealedAtLatest(options.chain, request);
    if (!requestHolds(options.chain, org, request)) throw new CryptoError(NOT_A_HOLDER);
    await sealerHolds(options.chain, request.requesterUserId, options.signer);
    return { statement, signature: await signHybrid(statement, options.signer) };
}

/*
 * A request as every member's device and the server take it: the bytes
 * canonical, for this company, naming a roster on the chain, from an entry
 * that holds `recovery` at the key version named, for the kit and company
 * key the chain has now, and signed under that entry's keys (the served
 * ML-DSA key only if the entry names it). Anything else is refused.
 */
export async function verifyRecoveryRequest(
    statement: Uint8Array,
    signature: Uint8Array,
    options: { chain: AcceptedRosters; requesterMlDsaPublicKey: Uint8Array },
): Promise<RecoveryRequest> {
    const request = parseRecoveryRequest(statement);
    const { chain } = options;
    const org = companyOf(chain, request.groupId);
    sealedOnChain(chain, request);
    if (!requestHolds(chain, org, request)) throw new CryptoError(NOT_A_HOLDER);
    const entry = rosterEntry(chain.roster, request.requesterUserId)!;
    const key = options.requesterMlDsaPublicKey;
    if (
        signature.length !== HYBRID_SIGNATURE_BYTES ||
        key.length !== ML_DSA_PUBLIC_KEY_BYTES ||
        (await digest(key)) !== entry.mlDsaPublicKeyDigest ||
        !(await verifyHybrid(statement, signature, {
            signingPublicKey: decode(entry.signingPublicKey, 32),
            mlDsaPublicKey: key,
        }))
    )
        throw new CryptoError('This request is not signed by the member it names.');
    return request;
}

/* A folder's notice keys (3.7) --------------------------------------------- */

/*
 * noticeSeed(v) = HKDF-SHA-256(ikm = areaKey(v), salt = 32 zero bytes,
 *                 info = "hushos/group/browse-notice/v2" || groupId || workspaceId, 96)
 *               = X25519 (32) || ML-KEM-768 (64)
 *
 * The seed of a folder's notice keys at a key version: everyone who holds the
 * folder key derives the same pair, and nobody else does.
 */
export async function noticeSeed(areaKey: Uint8Array, groupId: string, workspaceId: string) {
    if (!(areaKey instanceof Uint8Array) || areaKey.length !== 32)
        throw new CryptoError('Invalid workspace key.');
    return hkdf(
        areaKey,
        text(
            `hushos/group/browse-notice/v2${uuid(groupId, 'group id')}${uuid(workspaceId, 'workspace id')}`,
        ),
        NOTICE_SEED_BYTES,
    );
}

/*
 * A folder's notice keys from its seed: the two public keys whoever makes a
 * folder key sends with it, and every holder compares; and what opens a
 * notice the server sealed to them.
 */
export async function noticeKeys(seed: Uint8Array) {
    return sealingKeyPair(seed, 'notice seed');
}

/* ["hushos/group/browse-notice-key",2,groupId,workspaceId,toVersion,fromVersion]: fromVersion is the one before. */
function previousNoticeContext(ctx: PreviousNoticeSeedContext) {
    const to = integer(ctx.toVersion, 'workspace key version');
    if (integer(ctx.fromVersion, 'workspace key version') !== to - 1)
        throw new CryptoError('Invalid workspace key version.');
    return encodeStatement([
        'hushos/group/browse-notice-key',
        2,
        uuid(ctx.groupId, 'group id'),
        uuid(ctx.workspaceId, 'workspace id'),
        to,
        ctx.fromVersion,
    ]);
}

export type PreviousNoticeSeedContext = {
    groupId: string;
    workspaceId: string;
    toVersion: number;
    fromVersion: number;
};

/* HKDF-SHA-256(ikm = noticeSeed(toVersion), salt = 32 zero bytes, info = "hushos/group/browse-notice-key/v2", 32) */
async function previousNoticeKey(seed: Uint8Array) {
    if (!(seed instanceof Uint8Array) || seed.length !== NOTICE_SEED_BYTES)
        throw new CryptoError('Invalid notice seed.');
    return hkdf(seed, text('hushos/group/browse-notice-key/v2'), 32);
}

/*
 * `previousNoticeSeed` (3.7, "Through a key change"): the notice seed of the
 * version before, wrapped under a key derived from the new one, so someone
 * who holds only the current folder key reads earlier notices by walking
 * back. 136 bytes: a 24-byte nonce, then XChaCha20-Poly1305 of the seed with
 * the context above as associated data.
 */
export async function wrapPreviousNoticeSeed(
    previousSeed: Uint8Array,
    seed: Uint8Array,
    ctx: PreviousNoticeSeedContext,
) {
    if (!(previousSeed instanceof Uint8Array) || previousSeed.length !== NOTICE_SEED_BYTES)
        throw new CryptoError('Invalid notice seed.');
    const context = previousNoticeContext(ctx);
    const key = await previousNoticeKey(seed);
    try {
        const nonce = crypto.getRandomValues(new Uint8Array(24));
        const wrapped = new Uint8Array(PREVIOUS_NOTICE_SEED_BYTES);
        wrapped.set(nonce);
        wrapped.set(await encryptKey(previousSeed, key, nonce, context), 24);
        return wrapped;
    } finally {
        key.fill(0);
    }
}

/* Opens `previousNoticeSeed` with the notice seed of the version it was wrapped under. */
export async function openPreviousNoticeSeed(
    wrapped: Uint8Array,
    seed: Uint8Array,
    ctx: PreviousNoticeSeedContext,
) {
    const context = previousNoticeContext(ctx);
    if (!(wrapped instanceof Uint8Array) || wrapped.length !== PREVIOUS_NOTICE_SEED_BYTES)
        throw new CryptoError('Invalid notice seed.');
    const key = await previousNoticeKey(seed);
    try {
        return await decryptKey(wrapped.subarray(24), key, wrapped.subarray(0, 24), context);
    } finally {
        key.fill(0);
    }
}
