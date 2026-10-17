import { isDeepStrictEqual } from 'node:util';
import { encodeStatement, parseStatement } from '../src/canonical';
import { deviceSessionStatement } from '../src/device-identity';
import { CryptoError } from '../src/errors';
import {
    digestBase64url,
    digestHex,
    fingerprint,
    fingerprintOfKeys,
    sameKeyDigest,
} from '../src/fingerprint';
import type { GroupChainCache, ServedIdentity } from '../src/group-trust';
import { GROUP, verdictOf, type RecordProbe } from '../src/group-testkit';
import {
    areaGrantStatement,
    groupFingerprint,
    groupKeyPair,
    groupKeySealStatement,
    groupSuccessionStatement,
    openAreaGrant,
    openGroupKey,
    parseGroupSuccession,
    parseRoster,
    rosterDigest,
    rosterStatement,
    sameGroupKey,
    type AreaGrantContext,
    type GroupKeySealContext,
    type GroupPublicKey,
    type Roster,
} from '../src/groups';
import {
    publicIdentity,
    verifyIdentityKeys,
    verifyOwnIdentity,
    verifySuccessionChain,
    verifySuccessionConsent,
    verifySuccessionLink,
    type IdentityEnvelope,
    type PinnedKeys,
    type ServedKeys,
    type SuccessionLink,
} from '../src/identity';
import { decode, encode } from '../src/keys';
import { checkGroupPin, pinVerified, type GroupPin } from '../src/pins';
import { openShareKey, type ShareContext } from '../src/shares';
import {
    keysStatement,
    metadataRekeyedStatement,
    metadataStatementAs,
    shareStatement,
    successionConsentStatement,
    successionStatement,
    versionRekeyedStatement,
    versionStatementAs,
    type MetadataStatement,
    type RecordOrigin,
    type RekeyedRecord,
    type VersionStatement,
} from '../src/signatures';
import {
    contentKeyContext,
    metadataContext,
    openEnvelopeBytes,
    openOriginKey,
    openWithOriginKey,
} from '../src/drive';
import { judgeRekeyed, readRekeyed } from '../src/rekeyed-testkit';
import { chain, core, groups, people, shareGrantee, signed, web, type Json } from './fixtures';

/*
 * Every target as one function from the input bytes to a verdict, the same
 * verdict crates/hushos-core/fuzz/src/targets.rs gives for the same bytes:
 * {ok: true, out} when this twin accepts (with what it produced), {ok: false}
 * when it refuses with a CryptoError, {skip: true} when the input is not the
 * target's shape (read exactly as shape.rs reads it, so both twins skip the
 * same inputs). Anything else thrown, and every broken invariant, escapes as
 * a finding:
 * - nothing but a CryptoError, whatever the bytes;
 * - what a parser accepts re-encodes to exactly its bytes;
 * - a verify (or an open) that returns true implies its statement parses or builds.
 */

export const TARGETS = [
    'canonical',
    'roster',
    'group_succession',
    'roster_build',
    'statements',
    'identity',
    'succession',
    'share_open',
    'key_seal_open',
    'area_grant_open',
    'key_seal_context',
    'pins',
    'accept',
    'record_integrity',
    'origin_open',
] as const;
export type Target = (typeof TARGETS)[number];

export type Verdict = { ok: true; out: unknown } | { ok: false } | { skip: true };

/* A broken invariant: never a refusal, always a finding. */
export class InvariantError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvariantError';
    }
}

function invariant(holds: boolean, message: string): asserts holds {
    if (!holds) throw new InvariantError(message);
}

const ok = (out: unknown): Verdict => ({ ok: true, out });
const refused: Verdict = { ok: false };
const skip: Verdict = { skip: true };

/* A refusal is a CryptoError; anything else thrown is a finding and escapes. */
async function either<T>(run: () => T | Promise<T>, out: (value: T) => unknown) {
    let value: T;
    try {
        value = await run();
    } catch (error) {
        if (error instanceof CryptoError) return refused;
        throw error;
    }
    return ok(await out(value));
}

/* Whether a call throws only a CryptoError (false), or returns (true). */
async function holds(run: () => unknown) {
    try {
        await run();
        return true;
    } catch (error) {
        if (error instanceof CryptoError) return false;
        throw error;
    }
}

/* Shapes, as crates/hushos-core/fuzz/src/shape.rs reads them: undefined does not fit. */
type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: Doc, key: string) =>
    typeof value[key] === 'string' ? (value[key] as string) : undefined;
const optionalText = (value: Doc, key: string): string | null | undefined =>
    value[key] === undefined || value[key] === null ? null : text(value, key);
/* A number a u64 holds: a non-negative integer below 2^64 (JSON.parse reads 1.0 and 1e0 as 1). */
const unsigned = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64
        ? value
        : undefined;
const number = (value: Doc, key: string) => unsigned(value[key]);
const small = (value: Doc, key: string) => {
    const n = number(value, key);
    return n !== undefined && n <= 0xffff_ffff ? n : undefined;
};
const optionalNumber = (value: Doc, key: string): number | null | undefined =>
    value[key] === undefined || value[key] === null ? null : unsigned(value[key]);
function bytesOfText(value: unknown) {
    if (typeof value !== 'string') return undefined;
    if (value === '') return new Uint8Array();
    try {
        return decode(value);
    } catch {
        return undefined;
    }
}
const bytes = (value: Doc, key: string) => bytesOfText(value[key]);
function nullable<T>(value: Doc, key: string, read: (inner: unknown) => T | undefined) {
    if (value[key] === undefined || value[key] === null) return null;
    return read(value[key]);
}
/* Every field read, or undefined when one does not fit. */
function all<T extends Record<string, unknown>>(fields: T) {
    return Object.values(fields).some((field) => field === undefined)
        ? undefined
        : (fields as { [K in keyof T]: Exclude<T[K], undefined> });
}

const KINDS = ['family', 'org'];
const ROLES = ['billing', 'data_admin', 'guardian', 'members', 'recovery'];
const STATUSES = ['active', 'left'];

function rosterOf(value: unknown): Roster | undefined {
    if (!isObject(value) || !KINDS.includes(text(value, 'kind') ?? '')) return undefined;
    if (!Array.isArray(value.members)) return undefined;
    const members = value.members.map((m: unknown) => {
        if (!isObject(m) || !STATUSES.includes(text(m, 'status') ?? '')) return undefined;
        if (!Array.isArray(m.roles) || !m.roles.every((r) => ROLES.includes(r as string)))
            return undefined;
        return all({
            userId: text(m, 'userId'),
            keyVersion: number(m, 'keyVersion'),
            encryptionPublicKey: text(m, 'encryptionPublicKey'),
            signingPublicKey: text(m, 'signingPublicKey'),
            mlDsaPublicKeyDigest: text(m, 'mlDsaPublicKeyDigest'),
            kemPublicKeyDigest: text(m, 'kemPublicKeyDigest'),
            status: text(m, 'status') as 'active' | 'left',
            roles: [...m.roles] as Roster['members'][number]['roles'],
            sinceVersion: number(m, 'sinceVersion'),
        });
    });
    let areas: unknown[] = [];
    if (value.areas !== undefined && value.areas !== null) {
        if (!Array.isArray(value.areas)) return undefined;
        areas = value.areas.map((a: unknown) =>
            isObject(a)
                ? all({
                      workspaceId: text(a, 'workspaceId'),
                      workspaceKeyVersion: number(a, 'workspaceKeyVersion'),
                      commitment: text(a, 'commitment'),
                  })
                : undefined,
        );
    }
    if (members.includes(undefined) || areas.includes(undefined)) return undefined;
    return all({
        groupId: text(value, 'groupId'),
        kind: text(value, 'kind') as Roster['kind'],
        rosterVersion: number(value, 'rosterVersion'),
        previousRosterDigest: text(value, 'previousRosterDigest'),
        groupKeyVersion: number(value, 'groupKeyVersion'),
        signerUserId: text(value, 'signerUserId'),
        members: members as Roster['members'],
        areas: areas as NonNullable<Roster['areas']>,
    });
}

const shareContextOf = (value: unknown): ShareContext | undefined =>
    isObject(value)
        ? all({
              workspaceId: text(value, 'workspaceId'),
              nodeId: text(value, 'nodeId'),
              keyEpoch: number(value, 'keyEpoch'),
              granteeUserId: text(value, 'granteeUserId'),
              granterUserId: text(value, 'granterUserId'),
          })
        : undefined;

const keySealContextOf = (value: unknown): GroupKeySealContext | undefined =>
    isObject(value)
        ? all({
              groupId: text(value, 'groupId'),
              groupKeyVersion: number(value, 'groupKeyVersion'),
              holderUserId: text(value, 'holderUserId'),
              holderKeyVersion: number(value, 'holderKeyVersion'),
              sealerUserId: text(value, 'sealerUserId'),
              rosterVersion: number(value, 'rosterVersion'),
              rosterDigest: text(value, 'rosterDigest'),
          })
        : undefined;

const areaGrantContextOf = (value: unknown): AreaGrantContext | undefined =>
    isObject(value)
        ? all({
              groupId: text(value, 'groupId'),
              workspaceId: text(value, 'workspaceId'),
              workspaceKeyVersion: number(value, 'workspaceKeyVersion'),
              granteeUserId: text(value, 'granteeUserId'),
              granteeKeyVersion: number(value, 'granteeKeyVersion'),
              granterUserId: text(value, 'granterUserId'),
              rosterVersion: number(value, 'rosterVersion'),
              rosterDigest: text(value, 'rosterDigest'),
          })
        : undefined;

function linkOf(value: unknown): SuccessionLink | undefined {
    if (!isObject(value)) return undefined;
    const consent = optionalText(value, 'consent');
    if (consent === undefined) return undefined;
    const link = all({
        oldKeyVersion: number(value, 'oldKeyVersion'),
        newKeyVersion: number(value, 'newKeyVersion'),
        oldEncryptionPublicKey: text(value, 'oldEncryptionPublicKey'),
        oldSigningPublicKey: text(value, 'oldSigningPublicKey'),
        oldMlDsaPublicKey: text(value, 'oldMlDsaPublicKey'),
        newEncryptionPublicKey: text(value, 'newEncryptionPublicKey'),
        newSigningPublicKey: text(value, 'newSigningPublicKey'),
        newMlDsaPublicKey: text(value, 'newMlDsaPublicKey'),
        newKemPublicKey: text(value, 'newKemPublicKey'),
        signature: text(value, 'signature'),
    });
    return link && { ...link, consent };
}

const signerOf = (value: unknown) =>
    isObject(value)
        ? all({
              signingPublicKey: text(value, 'signingPublicKey'),
              mlDsaPublicKey: text(value, 'mlDsaPublicKey'),
          })
        : undefined;

function pinnedOf(value: unknown): PinnedKeys | undefined {
    if (!isObject(value)) return undefined;
    const keyVersion = optionalNumber(value, 'keyVersion');
    if (keyVersion === undefined) return undefined;
    const pinned = all({
        encryptionPublicKey: text(value, 'encryptionPublicKey'),
        signingPublicKey: text(value, 'signingPublicKey'),
        mlDsaPublicKeyHash: text(value, 'mlDsaPublicKeyHash'),
    });
    return pinned && { ...pinned, keyVersion };
}

const servedOf = (value: unknown): ServedKeys | undefined =>
    isObject(value)
        ? all({
              keyVersion: number(value, 'keyVersion'),
              encryptionPublicKey: text(value, 'encryptionPublicKey'),
              signingPublicKey: text(value, 'signingPublicKey'),
              mlDsaPublicKey: text(value, 'mlDsaPublicKey'),
              kemPublicKey: text(value, 'kemPublicKey'),
          })
        : undefined;

const publicIdentityOf = (value: unknown) =>
    isObject(value)
        ? all({
              keyVersion: number(value, 'keyVersion'),
              encryptionPublicKey: text(value, 'encryptionPublicKey'),
              signingPublicKey: text(value, 'signingPublicKey'),
              mlDsaPublicKey: text(value, 'mlDsaPublicKey'),
              kemPublicKey: text(value, 'kemPublicKey'),
              keysSignature: text(value, 'keysSignature'),
          })
        : undefined;

function envelopeOf(value: unknown): IdentityEnvelope | undefined {
    if (!isObject(value)) return undefined;
    const kem = nullable(value, 'kem', (kem) => {
        if (!isObject(kem)) return undefined;
        const signature = optionalText(kem, 'signature');
        if (signature === undefined) return undefined;
        const fields = all({
            publicKey: text(kem, 'publicKey'),
            seedNonce: text(kem, 'seedNonce'),
            encryptedSeed: text(kem, 'encryptedSeed'),
        });
        return fields && { ...fields, signature };
    });
    const mlDsa = nullable(value, 'mlDsa', (mlDsa) =>
        isObject(mlDsa)
            ? all({
                  publicKey: text(mlDsa, 'publicKey'),
                  seedNonce: text(mlDsa, 'seedNonce'),
                  encryptedSeed: text(mlDsa, 'encryptedSeed'),
              })
            : undefined,
    );
    const keysSignature = optionalText(value, 'keysSignature');
    if (kem === undefined || mlDsa === undefined || keysSignature === undefined) return undefined;
    const common = all({
        version: small(value, 'version'),
        keyVersion: number(value, 'keyVersion'),
        wrappingSalt: text(value, 'wrappingSalt'),
        encryptionPublicKey: text(value, 'encryptionPublicKey'),
        encryptionPrivateKeyNonce: text(value, 'encryptionPrivateKeyNonce'),
        encryptedEncryptionPrivateKey: text(value, 'encryptedEncryptionPrivateKey'),
        signingPublicKey: text(value, 'signingPublicKey'),
        signingSeedNonce: text(value, 'signingSeedNonce'),
        encryptedSigningSeed: text(value, 'encryptedSigningSeed'),
    });
    // An envelope of any version reaches the core as the record it is; its checks decide.
    return common && ({ ...common, kem, mlDsa, keysSignature } as unknown as IdentityEnvelope);
}

function groupPinOf(value: unknown): GroupPin | undefined {
    if (!isObject(value) || !isObject(value.areas)) return undefined;
    const areas: Record<string, number> = {};
    for (const [id, version] of Object.entries(value.areas)) {
        const n = unsigned(version);
        if (n === undefined) return undefined;
        areas[id] = n;
    }
    const pin = all({
        firstEd25519PublicKey: text(value, 'firstEd25519PublicKey'),
        firstMlDsaPublicKeyDigest: text(value, 'firstMlDsaPublicKeyDigest'),
        checkedAt: text(value, 'checkedAt'),
        keyVersion: number(value, 'keyVersion'),
        groupKeyDigest: text(value, 'groupKeyDigest'),
        rosterVersion: number(value, 'rosterVersion'),
        rosterDigest: text(value, 'rosterDigest'),
    });
    return pin && { ...pin, areas };
}

const groupKeyOf = (value: unknown): GroupPublicKey | undefined =>
    isObject(value)
        ? all({
              ed25519PublicKey: text(value, 'ed25519PublicKey'),
              mlDsaPublicKey: text(value, 'mlDsaPublicKey'),
          })
        : undefined;

/* A JSON target: bytes that are not JSON (or not UTF-8), or not its shape, are skipped. */
async function withJson(data: Uint8Array, target: (value: Doc) => Promise<Verdict | undefined>) {
    let value: unknown;
    try {
        // A byte-order mark is kept, so JSON.parse refuses it as serde_json does.
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data));
    } catch {
        return skip;
    }
    return (isObject(value) && (await target(value))) || skip;
}

const HYBRID_SIGNATURE_BYTES = 3373;
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    isDeepStrictEqual(Buffer.from(a), Buffer.from(b));

async function canonical(data: Uint8Array) {
    return either(
        () => parseStatement(data, 'statement'),
        (parts) => {
            const again = encodeStatement(parts);
            invariant(sameBytes(again, data), 'an accepted statement re-encodes to its own bytes');
            return null;
        },
    );
}

async function roster(data: Uint8Array) {
    return either(
        () => parseRoster(data),
        async (parsed) => {
            invariant(
                sameBytes(rosterStatement(parsed), data),
                'a roster re-encodes to its own bytes',
            );
            invariant(isDeepStrictEqual(parseRoster(data), parsed), 'a roster parses alike twice');
            await rosterDigest(data);
            return parsed;
        },
    );
}

async function groupSuccession(data: Uint8Array) {
    return either(
        () => parseGroupSuccession(data),
        (parsed) => {
            invariant(
                sameBytes(groupSuccessionStatement(parsed), data),
                'a succession re-encodes to its own bytes',
            );
            invariant(
                parsed.newVersion === parsed.oldVersion + 1,
                'a succession steps one key version',
            );
            return parsed;
        },
    );
}

async function rosterBuild(value: Doc) {
    const built = rosterOf(value);
    if (!built) return undefined;
    return either(
        () => rosterStatement(built),
        (statement) => {
            invariant(
                isDeepStrictEqual(parseRoster(statement), built),
                'a roster parses back to what was encoded',
            );
            return encode(statement);
        },
    );
}

async function statements(value: Doc): Promise<Verdict | undefined> {
    const out = (statement: Uint8Array) => encode(statement);
    switch (text(value, 'kind')) {
        case 'share': {
            const ctx = shareContextOf(value.ctx);
            const sealed = bytes(value, 'sealed');
            if (!ctx || !sealed) return undefined;
            return either(() => shareStatement(ctx, sealed), out);
        }
        case 'keys': {
            const keys = all({
                userId: text(value, 'userId'),
                keyVersion: number(value, 'keyVersion'),
                encryptionPublicKey: text(value, 'encryptionPublicKey'),
                signingPublicKey: text(value, 'signingPublicKey'),
                mlDsaPublicKey: text(value, 'mlDsaPublicKey'),
                kemPublicKey: text(value, 'kemPublicKey'),
            });
            return keys && either(() => keysStatement(keys), out);
        }
        case 'succession': {
            const link = linkOf(value.link);
            const userId = text(value, 'userId');
            if (!link || userId === undefined) return undefined;
            return either(() => successionStatement({ ...link, userId }), out);
        }
        case 'consent': {
            const link = linkOf(value.link);
            const userId = text(value, 'userId');
            const role = text(value, 'role');
            if (!link || userId === undefined || role === undefined) return undefined;
            return either(
                () => successionConsentStatement({ ...link, userId }, role as 'old' | 'new'),
                out,
            );
        }
        case 'device': {
            const fields = all({
                userId: text(value, 'userId'),
                deviceId: text(value, 'deviceId'),
                attemptToken: text(value, 'attemptToken'),
            });
            return fields && either(() => deviceSessionStatement(fields), out);
        }
        case 'keySeal': {
            const ctx = keySealContextOf(value.ctx);
            const sealed = bytes(value, 'sealed');
            if (!ctx || !sealed) return undefined;
            return either(() => groupKeySealStatement(ctx, sealed), out);
        }
        case 'areaGrant': {
            const ctx = areaGrantContextOf(value.ctx);
            const sealed = bytes(value, 'sealed');
            if (!ctx || !sealed) return undefined;
            return either(() => areaGrantStatement(ctx, sealed), out);
        }
        case 'metadata':
        case 'version':
            return recordStatement(text(value, 'kind') as 'metadata' | 'version', value);
        default:
            return undefined;
    }
}

function metadataStatementOf(value: unknown): MetadataStatement | undefined {
    if (!isObject(value)) return undefined;
    const fields = all({
        workspaceId: text(value, 'workspaceId'),
        nodeId: text(value, 'nodeId'),
        metadataVersion: number(value, 'metadataVersion'),
        kind: text(value, 'kind'),
    });
    if (!fields || (fields.kind !== 'folder' && fields.kind !== 'file')) return undefined;
    return fields as MetadataStatement;
}
function versionStatementOf(value: unknown): VersionStatement | undefined {
    if (!isObject(value)) return undefined;
    return all({
        workspaceId: text(value, 'workspaceId'),
        nodeId: text(value, 'nodeId'),
        versionId: text(value, 'versionId'),
        objectId: text(value, 'objectId'),
        contentSuite: small(value, 'contentSuite'),
    });
}
function recordOriginOf(value: unknown): RecordOrigin | undefined {
    if (!isObject(value)) return undefined;
    return all({
        envelope: bytes(value, 'envelope'),
        signerId: text(value, 'signerId'),
        signature: bytes(value, 'signature'),
    });
}

/*
 * A drive record statement in any of its four forms, read as shape.rs reads
 * it: every field before the form is judged, then the rekeyed form's
 * `keyEpoch` and `origin`; an unknown form is refused by name.
 */
async function recordStatement(kind: 'metadata' | 'version', value: Doc) {
    const statement =
        kind === 'metadata'
            ? metadataStatementOf(value.statement)
            : versionStatementOf(value.statement);
    const envelope = bytes(value, 'envelope');
    const form = text(value, 'form');
    if (!statement || !envelope || form === undefined) return undefined;
    const out = (bytes: Uint8Array) => encode(bytes);
    if (form === 'rekeyed') {
        const keyEpoch = number(value, 'keyEpoch');
        const origin = recordOriginOf(value.origin);
        if (keyEpoch === undefined || !origin) return undefined;
        return either(
            () =>
                kind === 'metadata'
                    ? metadataRekeyedStatement(
                          { ...(statement as MetadataStatement), keyEpoch },
                          envelope,
                          origin,
                      )
                    : versionRekeyedStatement(
                          { ...(statement as VersionStatement), keyEpoch },
                          envelope,
                          origin,
                      ),
            out,
        );
    }
    return either(
        () =>
            kind === 'metadata'
                ? metadataStatementAs(form as 'ordinary', statement as MetadataStatement, envelope)
                : versionStatementAs(form as 'ordinary', statement as VersionStatement, envelope),
        out,
    );
}

async function keysHold(
    userId: string,
    identity: NonNullable<ReturnType<typeof publicIdentityOf>>,
) {
    const verified = await verifyIdentityKeys(userId, identity);
    if (verified)
        invariant(
            await holds(() => keysStatement({ ...identity, userId })),
            'a keys statement held that does not build',
        );
    return verified;
}

async function identity(value: Doc): Promise<Verdict | undefined> {
    const userId = text(value, 'userId');
    if (userId === undefined) return undefined;
    if (value.public !== undefined) {
        const served = publicIdentityOf(value.public);
        return served && ok({ keysHold: await keysHold(userId, served) });
    }
    const envelope = envelopeOf(value.envelope);
    const root =
        value.accountKey === undefined || value.accountKey === null
            ? decode(core().identity.accountKey)
            : bytes(value, 'accountKey');
    if (!envelope || !root) return undefined;
    let served: ReturnType<typeof publicIdentity> | null = null;
    try {
        served = publicIdentity(envelope);
    } catch (error) {
        if (!(error instanceof CryptoError)) throw error;
    }
    const verified = served ? await keysHold(userId, served) : false;
    const opened = await holds(() =>
        verifyOwnIdentity(root as Uint8Array<ArrayBuffer>, userId, envelope),
    );
    if (opened && envelope.version === 2)
        invariant(verified, 'a version 2 identity opened whose keys statement does not hold');
    return ok({ public: served, keysHold: verified, opened });
}

async function succession(value: Doc): Promise<Verdict | undefined> {
    const userId = text(value, 'userId');
    const link = linkOf(value.link);
    const signer = nullable(value, 'signer', signerOf);
    const pinned = nullable(value, 'pinned', pinnedOf);
    const served = nullable(value, 'served', servedOf);
    const links = nullable(value, 'links', (links) => {
        if (!Array.isArray(links)) return undefined;
        const read = links.map(linkOf);
        return read.includes(undefined) ? undefined : (read as SuccessionLink[]);
    });
    if (userId === undefined || !link) return undefined;
    if (signer === undefined || pinned === undefined || served === undefined) return undefined;
    if (links === undefined) return undefined;
    const builds = async (l: SuccessionLink) => holds(() => successionStatement({ ...l, userId }));
    let statement: string | null = null;
    try {
        statement = encode(await successionStatement({ ...link, userId }));
    } catch (error) {
        if (!(error instanceof CryptoError)) throw error;
    }
    const verified = signer ? await verifySuccessionLink(userId, link, signer) : null;
    if (verified) invariant(statement !== null, 'a link verified whose statement does not build');
    const consent = await verifySuccessionConsent(userId, link);
    if (consent)
        for (const role of ['old', 'new'] as const)
            invariant(
                await holds(() => successionConsentStatement({ ...link, userId }, role)),
                'a consent verified whose statement does not build',
            );
    let chainHolds: boolean | null = null;
    if (pinned && served && links) {
        chainHolds = await verifySuccessionChain(userId, pinned, served, links);
        if (chainHolds) {
            invariant(links.length > 0, 'an empty chain held');
            let any = false;
            for (const l of links) any ||= await builds(l);
            invariant(any, 'a chain held with no link whose statement builds');
        }
    }
    return ok({ statement, verified, consent, chain: chainHolds });
}

async function share(data: Uint8Array) {
    const fixture = core().share;
    const granter = {
        signingPublicKey: decode(fixture.granterSigningPublicKey, 32),
        mlDsaPublicKey: decode(fixture.granterMlDsaPublicKey, 1952),
    };
    const grantee = await shareGrantee();
    return either(
        () => openShareKey(data, granter, grantee, fixture.ctx),
        async (key) => {
            invariant(key.length === 32, 'a node key is 32 bytes');
            invariant(
                await holds(() =>
                    shareStatement(
                        fixture.ctx,
                        data.subarray(0, data.length - HYBRID_SIGNATURE_BYTES),
                    ),
                ),
                'a share opened whose statement does not build',
            );
            return encode(key);
        },
    );
}

async function keySeal(data: Uint8Array) {
    const fixture = groups().seals.keySeal;
    const [organizer] = await people();
    const accepted = await chain();
    return either(
        () =>
            openGroupKey(data, fixture.ctx, {
                chain: accepted,
                sealerMlDsaPublicKey: organizer!.mlDsaPublicKey,
                reader: { userId: organizer!.userId, keyVersion: 1 },
                holder: organizer!.secrets,
            }),
        async (seed) => {
            invariant(
                await holds(() =>
                    groupKeySealStatement(
                        fixture.ctx,
                        data.subarray(0, data.length - HYBRID_SIGNATURE_BYTES),
                    ),
                ),
                'a key seal opened whose statement does not build',
            );
            const key = (await groupKeyPair(seed)).publicKey;
            invariant(
                accepted.groupKeys.some((k) => sameGroupKey(k, key)),
                'a key seal opened to a key the chain does not have',
            );
            return encode(seed);
        },
    );
}

/*
 * The key seal in core-groups.json under another context, opened by one of
 * the four fixture people (`reader`, 0 to 3): it opens only under its own
 * context and only for its holder, the organizer.
 */
async function keySealContext(value: Doc): Promise<Verdict | undefined> {
    const ctx = keySealContextOf(value.ctx);
    const reader = small(value, 'reader');
    if (!ctx || reader === undefined || reader > 3) return undefined;
    const fixture = groups().seals.keySeal;
    const all = await people();
    const who = all[reader]!;
    const accepted = await chain();
    return either(
        () =>
            openGroupKey(decode(fixture.envelope), ctx, {
                chain: accepted,
                sealerMlDsaPublicKey: all[0]!.mlDsaPublicKey,
                reader: { userId: who.userId, keyVersion: who.keyVersion },
                holder: who.secrets,
            }),
        (seed) => {
            invariant(
                isDeepStrictEqual(ctx, fixture.ctx),
                'a key seal opened under a context it was not sealed for',
            );
            invariant(reader === 0, 'a key seal opened for someone other than its holder');
            return encode(seed);
        },
    );
}

async function areaGrant(data: Uint8Array) {
    const fixture = groups().seals.areaGrant;
    const [organizer, adult] = await people();
    return either(
        async () =>
            openAreaGrant(data, fixture.ctx, {
                chain: await chain(),
                areaIdSeed: fixture.areaIdSeed,
                granterMlDsaPublicKey: organizer!.mlDsaPublicKey,
                reader: { userId: adult!.userId, keyVersion: 1 },
                grantee: adult!.secrets,
            }),
        async (key) => {
            invariant(
                await holds(() =>
                    areaGrantStatement(
                        fixture.ctx,
                        data.subarray(0, data.length - HYBRID_SIGNATURE_BYTES),
                    ),
                ),
                'a grant opened whose statement does not build',
            );
            return encode(key);
        },
    );
}

async function pins(value: Doc): Promise<Verdict | undefined> {
    const kind = text(value, 'kind');
    switch (kind) {
        case 'pin': {
            const mlDsaPublicKeyHash = optionalText(value, 'mlDsaPublicKeyHash');
            const kemPublicKeyHash = optionalText(value, 'kemPublicKeyHash');
            const fields = all({
                encryptionPublicKey: text(value, 'encryptionPublicKey'),
                signingPublicKey: text(value, 'signingPublicKey'),
                fingerprint: text(value, 'fingerprint'),
            });
            if (!fields || mlDsaPublicKeyHash === undefined || kemPublicKeyHash === undefined)
                return undefined;
            const verified = await pinVerified({ ...fields, mlDsaPublicKeyHash, kemPublicKeyHash });
            if (verified)
                for (const hash of [mlDsaPublicKeyHash, kemPublicKeyHash])
                    invariant(
                        await holds(() => digestBase64url(hash!)),
                        'a pin verified with a digest that is not one',
                    );
            return ok(verified);
        }
        case 'groupPin': {
            const pin = groupPinOf(value.pin);
            const groupId = text(value, 'groupId');
            if (!pin || groupId === undefined) return undefined;
            return either(
                () => checkGroupPin(groupId, pin),
                (checked) => checked,
            );
        }
        case 'digestHex': {
            const base64url = text(value, 'value');
            if (base64url === undefined) return undefined;
            return either(
                () => digestHex(base64url),
                (hex) => {
                    invariant(digestBase64url(hex) === base64url, 'hex round trip');
                    return hex;
                },
            );
        }
        case 'digestBase64url': {
            const hex = text(value, 'value');
            if (hex === undefined) return undefined;
            return either(
                () => digestBase64url(hex),
                (base64url) => {
                    invariant(digestHex(base64url) === hex, 'base64url round trip');
                    return base64url;
                },
            );
        }
        case 'sameKeyDigest': {
            const hex = optionalText(value, 'hex');
            const base64url = text(value, 'base64url');
            if (hex === undefined || base64url === undefined) return undefined;
            const same = sameKeyDigest(hex, base64url);
            if (same) invariant(digestHex(base64url) === hex, 'the same digest, read two ways');
            return ok(same);
        }
        case 'fingerprint':
        case 'fingerprintOfKeys': {
            if (!Array.isArray(value.keys) || value.keys.length !== 4) return undefined;
            const keys = value.keys.map(bytesOfText);
            if (keys.includes(undefined)) return undefined;
            const [a, b, c, d] = keys as Uint8Array[];
            return either(
                () =>
                    kind === 'fingerprint'
                        ? fingerprint(a!, b!, c!, d!)
                        : fingerprintOfKeys(a!, b!, c!, d!),
                (print) => {
                    invariant(print.length === 49, 'ten groups of four hex digits');
                    return print;
                },
            );
        }
        case 'groupFingerprint': {
            const key = groupKeyOf(value.key);
            const groupId = text(value, 'groupId');
            if (!key || groupId === undefined) return undefined;
            return either(
                () => groupFingerprint(groupId, key),
                (print) => print,
            );
        }
        default:
            return undefined;
    }
}

/*
 * A served history, as a shared case's `input` carries it (group-fixtures.test.ts
 * reads cases the same way): the full verdict of acceptance, and of the
 * record and next statement when the case asks.
 */
async function accept(input: Json): Promise<Verdict> {
    const verdict = await verdictOf(
        {
            groupId: GROUP,
            firstKeys: input.firstKeys,
            pins: input.pins,
            rosters: input.rosters.map(signed),
            successions: input.successions.map(signed),
            mlDsaKeys: input.mlDsaKeys,
            me: input.me,
            cache: input.cache as GroupChainCache | null,
            firstKeysChecked: input.firstKeysChecked,
            joinMark: input.joinMark ?? null,
        },
        (input.record as RecordProbe | null) ?? undefined,
        input.next
            ? {
                  roster: input.next.roster ? signed(input.next.roster) : null,
                  succession: input.next.succession ? signed(input.next.succession) : null,
                  identities: input.next.identities as Record<string, ServedIdentity[]> | null,
              }
            : undefined,
    );
    if (verdict.status === 'accepted') {
        const cache = verdict.cache as { statement: string };
        const parsed = parseRoster(decode(cache.statement));
        invariant(
            parsed.rosterVersion === verdict.rosterVersion,
            'an accepted chain caches its latest roster',
        );
    }
    return ok(verdict);
}

/* An origin the shared fixtures sealed, with the record it was sealed for. */
function knownOrigin(envelope: Uint8Array): Doc | undefined {
    const encoded = encode(envelope);
    for (const fixture of [core(), web()])
        for (const origin of (fixture.rekeyed?.origins ?? []) as Doc[])
            if (origin.envelope === encoded) return origin;
    return undefined;
}

function namedRecord(record: RekeyedRecord): Doc {
    const s = record.statement;
    return record.record === 'metadata'
        ? {
              record: 'metadata',
              workspaceId: s.workspaceId,
              nodeId: s.nodeId,
              metadataVersion: (s as MetadataStatement).metadataVersion,
          }
        : {
              record: 'version',
              workspaceId: s.workspaceId,
              nodeId: s.nodeId,
              versionId: (s as VersionStatement).versionId,
          };
}

/* The origin's bytes under its wrapped key and the current envelope's under the node key, when both open. */
async function plaintexts(nodeKey: Uint8Array, record: RekeyedRecord) {
    try {
        const s = record.statement;
        const aad =
            record.record === 'metadata'
                ? metadataContext({
                      workspaceId: s.workspaceId,
                      nodeId: s.nodeId,
                      metadataVersion: record.statement.metadataVersion,
                  })
                : contentKeyContext({
                      workspaceId: s.workspaceId,
                      nodeId: s.nodeId,
                      versionId: record.statement.versionId,
                      objectId: record.statement.objectId,
                      suite: record.statement.contentSuite,
                  });
        const key = await openOriginKey(record.origin.keyEnvelope, nodeKey, {
            workspaceId: s.workspaceId,
            nodeId: s.nodeId,
            keyEpoch: record.keyEpoch,
            record:
                record.record === 'metadata'
                    ? { kind: 'metadata', metadataVersion: record.statement.metadataVersion }
                    : { kind: 'version', versionId: record.statement.versionId },
            originEnvelope: record.origin.envelope,
        });
        return [
            await openWithOriginKey(record.origin.envelope, key, aad),
            await openEnvelopeBytes(record.envelope, nodeKey, aad),
        ] as const;
    } catch (error) {
        if (error instanceof CryptoError) return undefined;
        throw error;
    }
}

/*
 * A re-keyed record's verdict, personal or in a group's area, with the
 * invariants of targets.rs: no mismatch for a record the reader can check
 * means the origin holds the current envelope's bytes, verified means the
 * statements build, and an origin sealed for another record never passes.
 */
async function recordIntegrity(value: Doc): Promise<Verdict | undefined> {
    const input = readRekeyed(value);
    if (!input) return undefined;
    const verdict = (await judgeRekeyed(input)) as Json;
    const checkable = input.trust.kind === 'group' || input.trust.trust !== null;
    if (verdict.mismatch === false && checkable && input.nodeKey) {
        const both = await plaintexts(input.nodeKey, input.record);
        invariant(both !== undefined, 'a record that is no mismatch opens both ways');
        invariant(
            sameBytes(both[0], both[1]),
            'a record that is no mismatch holds other bytes than its origin',
        );
        const known = knownOrigin(input.record.origin.envelope);
        if (known) {
            const { envelope: _, ...sealedFor } = known;
            invariant(
                isDeepStrictEqual(sealedFor, namedRecord(input.record)),
                'an origin sealed for another record passed',
            );
        }
    }
    const verified = verdict.origin === 'verified' || verdict.origin?.integrity === 'verified';
    if (verified && verdict.mismatch === false) {
        const r = input.record;
        const signer = r.origin.signerId;
        const origin = {
            envelope: r.origin.envelope,
            signerId: signer ?? '',
            signature: r.origin.signature ?? new Uint8Array(),
        };
        // The rekeyed statement names the origin's signer; with them gone only the plaintext binds it.
        const built =
            (await holds(() =>
                r.record === 'metadata'
                    ? metadataStatementAs('ordinary', r.statement, r.origin.envelope)
                    : versionStatementAs('ordinary', r.statement, r.origin.envelope),
            )) &&
            (signer === null ||
                (await holds(() =>
                    r.record === 'metadata'
                        ? metadataRekeyedStatement(
                              { ...r.statement, keyEpoch: r.keyEpoch },
                              r.envelope,
                              origin,
                          )
                        : versionRekeyedStatement(
                              { ...r.statement, keyEpoch: r.keyEpoch },
                              r.envelope,
                              origin,
                          ),
                )));
        invariant(built, 'a verified re-keyed record whose statements do not build');
    }
    return ok(verdict);
}

const KEY_ENVELOPE_BYTES = 72;

/* The rekeyed metadata in core.json with its origin key and origin replaced by these bytes (targets.rs). */
async function originOpen(data: Uint8Array): Promise<Verdict> {
    const fixture = core().rekeyed;
    const record = fixture.metadata;
    const s = record.statement;
    const nodeKey = decode(fixture.nodeKey);
    if (data.length < KEY_ENVELOPE_BYTES) return refused;
    const keyEnvelope = data.subarray(0, KEY_ENVELOPE_BYTES);
    const origin = data.subarray(KEY_ENVELOPE_BYTES);
    let key: Uint8Array;
    try {
        key = await openOriginKey(keyEnvelope, nodeKey, {
            workspaceId: s.workspaceId,
            nodeId: s.nodeId,
            keyEpoch: record.keyEpoch,
            record: { kind: 'metadata', metadataVersion: s.metadataVersion },
            originEnvelope: origin,
        });
    } catch (error) {
        if (error instanceof CryptoError) return refused;
        throw error;
    }
    invariant(
        encode(key) === fixture.metadataOriginKey,
        'an origin key opened that was not sealed',
    );
    if (origin.length > 24 + 4096 + 16) return refused;
    const aad = metadataContext({
        workspaceId: s.workspaceId,
        nodeId: s.nodeId,
        metadataVersion: s.metadataVersion,
    });
    return either(
        () => openWithOriginKey(origin, key, aad),
        async (plaintext) => {
            const current = await openEnvelopeBytes(decode(record.envelope), nodeKey, aad);
            invariant(
                sameBytes(plaintext, current),
                'an origin opened to other bytes than the record holds',
            );
            return encode(plaintext);
        },
    );
}

/* The verdict of `target` on `data`, with every invariant asserted. */
export async function verdict(target: Target, data: Uint8Array): Promise<Verdict> {
    switch (target) {
        case 'canonical':
            return canonical(data);
        case 'roster':
            return roster(data);
        case 'group_succession':
            return groupSuccession(data);
        case 'roster_build':
            return withJson(data, rosterBuild);
        case 'statements':
            return withJson(data, statements);
        case 'identity':
            return withJson(data, identity);
        case 'succession':
            return withJson(data, succession);
        case 'share_open':
            return share(data);
        case 'key_seal_open':
            return keySeal(data);
        case 'area_grant_open':
            return areaGrant(data);
        case 'key_seal_context':
            return withJson(data, keySealContext);
        case 'pins':
            return withJson(data, pins);
        case 'accept':
            return withJson(data, accept);
        case 'record_integrity':
            return withJson(data, recordIntegrity);
        case 'origin_open':
            return originOpen(data);
    }
}
