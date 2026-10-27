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
import {
    checkPairMark,
    pairCodeOf,
    type GroupAnchor,
    type GroupChainCache,
    type PairMark,
    type ServedIdentity,
} from '../src/group-trust';
import { GROUP, verdictOf, type RecordProbe, type RootProbe } from '../src/group-testkit';
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
    type RosterFormat,
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
    verifyStatement,
} from '../src/signatures';
import {
    contentKeyContext,
    metadataContext,
    openEnvelopeBytes,
    openOriginKey,
    openWithOriginKey,
} from '../src/drive';
import { opensAsMade, readSteps, runSteps } from '../src/area-ledger-testkit';
import {
    ROOT as DEVICE_ROOT,
    family as deviceFamily,
    run as runDeviceCase,
} from '../src/device-record-testkit';
import {
    createGroupSession,
    sealDeviceRecord,
    type GroupHost,
    type GroupMessage,
    type GroupResults,
} from '../src/session-groups';
import { createAreaLedger } from '../src/area-ledger';
import { linksNeedingConsent } from '../src/consent-due';
import { joinCheck } from '../src/join-check';
import {
    CONSENT_ROOT,
    CONSENT_USER,
    family as joinFamily,
    linkBetween,
    runPreview,
    runPreviewFlow,
    runSession,
} from '../src/join-testkit';
import { drawPositions } from '../src/join-session';
import { carriedRekeyed, judgeRekeyed, readRekeyed } from '../src/rekeyed-testkit';
import { readOutboxEntry } from '../src/outbox';
import { readSettingsDocument } from '../src/contacts';
import { contactPinOf, familyCheckOf, settingsMarks, settingsPinOf } from '../src/settings-marks';
import { runArea } from '../src/settings-areas-testkit';
import {
    JUNK,
    committedSession,
    familyJson,
    family as rosterFamily,
    joinCodeWith,
    pairRunOver,
    run as runRosterCall,
    sessionRun,
    sessionStep as rosterSessionStep,
    verdict as rosterVerdict,
} from '../src/roster-calls-testkit';
import {
    chain,
    core,
    coreJoin,
    coreLedger,
    coreRosterCalls,
    groups,
    people,
    shareGrantee,
    signed,
    web,
    type Json,
} from './fixtures';

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
    'area_ledger',
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
        areas = value.areas.map((a: unknown) => {
            if (!isObject(a)) return undefined;
            const row = all({
                workspaceId: text(a, 'workspaceId'),
                workspaceKeyVersion: number(a, 'workspaceKeyVersion'),
                commitment: text(a, 'commitment'),
            });
            // Format 2 (design 2.10): a root commitment on a key row, or a tombstone. Left out
            // when absent (or false), as parseRoster leaves them out; anything else is no input.
            if (!row) return undefined;
            const extra: { rootCommitment?: string; retired?: true } = {};
            if (a.rootCommitment !== undefined && a.rootCommitment !== null) {
                if (typeof a.rootCommitment !== 'string') return undefined;
                extra.rootCommitment = a.rootCommitment;
            }
            if (a.retired !== undefined && a.retired !== null) {
                if (typeof a.retired !== 'boolean') return undefined;
                if (a.retired) extra.retired = true;
            }
            return { ...row, ...extra };
        });
    }
    if (members.includes(undefined) || areas.includes(undefined)) return undefined;
    // The format: absent or 1 is format 1 (left out, as parseRoster leaves it out); any other
    // byte is passed on for the encoder to judge.
    let format: number | undefined;
    if (value.format !== undefined && value.format !== null) {
        if (
            !Number.isInteger(value.format) ||
            (value.format as number) < 0 ||
            (value.format as number) > 255
        )
            return undefined;
        if (value.format !== 1) format = value.format as number;
    }
    const roster = all({
        groupId: text(value, 'groupId'),
        kind: text(value, 'kind') as Roster['kind'],
        rosterVersion: number(value, 'rosterVersion'),
        previousRosterDigest: text(value, 'previousRosterDigest'),
        groupKeyVersion: number(value, 'groupKeyVersion'),
        signerUserId: text(value, 'signerUserId'),
        members: members as Roster['members'],
        areas: areas as NonNullable<Roster['areas']>,
    });
    return (
        roster && (format === undefined ? roster : { ...roster, format: format as RosterFormat })
    );
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
        keyEnvelope: bytes(value, 'keyEnvelope'),
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
    if (typeof value.kind === 'string') {
        if (value.kind === 'consent_due') return consentDue(value);
        if (value.kind === 'consent_sign') return consentSign(value);
        return undefined;
    }
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

/* Key versions both twins read exactly: JavaScript's numbers are exact only to 2^53 - 1. */
const exact = (keyVersion: number) => keyVersion <= Number.MAX_SAFE_INTEGER;
/* Whether `text` is base64url of exactly `length` bytes, as the core decodes it. */
const holdsBytes = (text: string, length: number) => {
    try {
        decode(text, length);
        return true;
    } catch (error) {
        if (error instanceof CryptoError) return false;
        throw error;
    }
};

function listOf<T>(value: unknown, read: (item: unknown) => T | undefined) {
    if (!Array.isArray(value)) return undefined;
    const out = value.map(read);
    return out.includes(undefined) ? undefined : (out as T[]);
}

/*
 * The links among `links` that need consent, with `identities` as the
 * account's: each offered link's old key version and the places of its two
 * identities, which the core's links_needing_consent must give. Invariant: an
 * offered link has no consent and joins two version 2 identities at its own
 * key versions.
 */
async function consentDue(value: Doc): Promise<Verdict | undefined> {
    const links = listOf(value.links, linkOf);
    const identities = listOf(value.identities, envelopeOf);
    if (!links || !identities) return undefined;
    if (!links.every((l) => exact(l.oldKeyVersion) && exact(l.newKeyVersion))) return undefined;
    if (!identities.every((e) => exact(e.keyVersion))) return undefined;
    const due = linksNeedingConsent(links, identities);
    for (const d of due) {
        invariant(!d.link.consent, 'a link with consent offered');
        invariant(d.old.version === 2 && d.next.version === 2, 'a version 1 identity offered');
        invariant(d.old.keyVersion === d.link.oldKeyVersion, 'the old identity at its key version');
        invariant(
            d.next.keyVersion === d.link.newKeyVersion,
            'the next identity at its key version',
        );
    }
    return ok(
        due.map((d) => ({
            oldKeyVersion: d.link.oldKeyVersion,
            old: identities.indexOf(d.old),
            next: identities.indexOf(d.next),
        })),
    );
}

/*
 * Consent for `link` from `old` to `next` by the join fixtures' consent
 * account, unlocked with the first of `me` open and the rest its history:
 * signed or refused, as the core's succession_consent_sign decides.
 * Invariant: what is signed holds for the link between the two envelopes,
 * and the link is one the old identity signed.
 */
async function consentSign(value: Doc): Promise<Verdict | undefined> {
    const old = envelopeOf(value.old);
    const next = envelopeOf(value.next);
    const link = linkOf(value.link);
    const me = listOf(value.me, servedOf);
    // An app always holds at least its current identity, the one the account opened.
    if (!old || !next || !link || !me || me.length === 0) return undefined;
    if (
        !exact(old.keyVersion) ||
        !exact(next.keyVersion) ||
        !exact(link.oldKeyVersion) ||
        !exact(link.newKeyVersion) ||
        !me.every((k) => exact(k.keyVersion))
    )
        return undefined;
    // The core's ledger opens only with a 32-byte signing key.
    if (!holdsBytes(me[0]!.signingPublicKey, 32)) return undefined;
    const host = {
        unlocked: () => ({ userId: CONSENT_USER, root: CONSENT_ROOT.slice(), keyVersion: 1 }),
        identity: () => ({ userId: CONSENT_USER, served: me[0], history: me.slice(1) }),
        ledger: createAreaLedger(),
    } as unknown as GroupHost;
    return either(
        async () =>
            (await createGroupSession(host).handle({
                id: 1,
                operation: 'identityConsent',
                input: { userId: CONSENT_USER, link, old, next },
            } as GroupMessage)) as GroupResults['identityConsent'],
        async ({ consent }) => {
            invariant(
                await verifySuccessionConsent(CONSENT_USER, linkBetween(old, next, '', consent)),
                'a consent signed that does not hold',
            );
            invariant(
                await verifySuccessionLink(CONSENT_USER, link, {
                    signingPublicKey: old.signingPublicKey,
                    mlDsaPublicKey: old.mlDsa?.publicKey ?? '',
                }),
                'a consent for a link the account never made',
            );
            return 'signed';
        },
    );
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
        case 'device_record':
            return deviceRecord(value);
        case 'join_check':
            return joinCheckKind(value);
        case 'join_preview':
            return joinPreviewKind(value);
        case 'join_draws':
            return joinDrawsKind(value);
        case 'join_session':
            return joinSessionKind(value);
        case 'outbox_entry':
            return outboxEntryKind(value);
        case 'member_join_code':
            return memberJoinCodeKind(value);
        case 'roster_call':
            return rosterCallKind(value);
        case 'roster_call_session':
            return rosterCallSessionKind(value);
        case 'settings':
            return settingsKind(value);
        case 'area_open':
            return areaOpenKind(value);
        case 'pair_code':
            return pairCodeKind(value);
        case 'joins_record':
            return joinsRecordKind(value);
        default:
            return undefined;
    }
}

/* A list of strings; anything else does not fit. */
function stringsOf(value: Doc, key: string) {
    const list = value[key];
    return Array.isArray(list) && list.every((item) => typeof item === 'string')
        ? (list as string[])
        : undefined;
}

/*
 * The typed words of a join code (`code`, `hidden`, `typed`): joinCheck's
 * answer, which the core's join_check must give. Invariant: a match depends
 * on the order of the two words, unless the code has the same word at both
 * positions.
 */
async function joinCheckKind(value: Doc): Promise<Verdict | undefined> {
    const code = stringsOf(value, 'code');
    const typed = stringsOf(value, 'typed');
    const list = value.hidden;
    if (!code || !typed || !Array.isArray(list)) return undefined;
    const hidden = list.map((at) => {
        const n = unsigned(at);
        return n !== undefined && n <= 0xffff_ffff ? n : undefined;
    });
    if (hidden.includes(undefined)) return undefined;
    const at = hidden as number[];
    return either(
        () => joinCheck(code, at, typed),
        (result) => {
            if (result === 'match' && code[at[0]!] !== code[at[1]!])
                invariant(
                    joinCheck(code, at, [typed[1]!, typed[0]!]) === 'no-match',
                    'the order of the two words',
                );
            return result;
        },
    );
}

/* A showing is twelve words at a roster no later than the head served, with two ascending positions in 0..=11. */
function shownWell(outcome: Json, through: number) {
    if (outcome.status !== 'code' && outcome.status !== 'changed') return;
    const code = outcome.code as string[];
    const hidden = outcome.hidden as number[];
    invariant(
        joinCheck(code, [0, 11], [code[0]!, code[11]!]) === 'match',
        'a code is twelve words',
    );
    invariant(
        hidden.length === 2 && hidden[0]! < hidden[1]! && hidden[1]! <= 11,
        'hidden positions',
    );
    invariant(outcome.rosterVersion <= through, 'a code past the head served');
}

/*
 * A join preview by person 2 of the join fixtures over one of the core's
 * histories (`history`, rosters `after` to `through`), with `settings`,
 * `held`, `cut` and `record` (any JSON, sealed as person 2's chain record),
 * positions from the fixtures' draws; with `words` "They match" on the same
 * served chain and record, and with `join` the join: the full outcome, which
 * the core must match. Invariants: every showing is twelve words and two
 * positions at a roster no later than the head served; a join commits only a
 * code the check matched.
 */
async function joinPreviewKind(value: Doc): Promise<Verdict | undefined> {
    const base = coreJoin().joinPreviews;
    const history = text(value, 'history');
    if (history === undefined || !['main', 'other', 'succ', 'madeUp'].includes(history))
        return undefined;
    const length = base.histories[history].rosters.length as number;
    const through = number(value, 'through');
    const after = optionalNumber(value, 'after');
    const settings = text(value, 'settings');
    const held = optionalText(value, 'held');
    const cut = optionalText(value, 'cut');
    const words = optionalText(value, 'words');
    const joinToo =
        value.join === undefined || value.join === null
            ? false
            : typeof value.join === 'boolean'
              ? value.join
              : undefined;
    if (
        through === undefined ||
        after === undefined ||
        settings === undefined ||
        held === undefined ||
        cut === undefined ||
        words === undefined ||
        joinToo === undefined
    )
        return undefined;
    const from = after ?? 0;
    const fits =
        through >= 1 &&
        through <= length &&
        from <= through &&
        ['none', 'pin-main-2', 'not-open'].includes(settings) &&
        (held === null || ['chain', 'fork'].includes(held)) &&
        (cut === null ||
            (cut === 'beside' && from <= 2 && through >= 2) ||
            (cut === 'bad-signature' && through > from)) &&
        (words === null || (['right', 'misheard', 'blank'].includes(words) && held === null)) &&
        (!joinToo || words !== null);
    if (!fits) return undefined;
    const doc = structuredClone(base);
    const f = await joinFamily();
    const record =
        value.record === undefined
            ? null
            : await sealDeviceRecord(
                  DEVICE_ROOT.slice(),
                  f.p2.userId,
                  GROUP,
                  'chains',
                  value.record,
              );
    doc.records.fuzz = record;
    const c = {
        name: 'fuzz',
        settings,
        record: record === null ? null : 'fuzz',
        held,
        served: { history, after: from, through, cut },
        words,
        join: joinToo,
    };
    if (words === null) {
        const outcome = await runPreview(doc, c);
        shownWell(outcome, through);
        return ok(outcome);
    }
    const flow = await runPreviewFlow(doc, c);
    shownWell(flow.preview, through);
    if (flow.check?.status === 'changed') shownWell(flow.check, through);
    // A join commits only a code the check matched, and never below the roster that let them in.
    if (flow.join?.status === 'accepted') {
        invariant(flow.check.status === 'matched', 'a join without a match');
        invariant(flow.join.rosterVersion >= flow.preview.rosterVersion, 'a join below the code');
    }
    return ok(flow);
}

/*
 * Hidden positions from `draws` (up to 64 values a u32 holds), as a session
 * drawing them would take them: the two positions, or null when the draws ran
 * out first. Invariant: two ascending positions in 0..=11, and only draws
 * below the last whole run of twelve count.
 */
async function joinDrawsKind(value: Doc): Promise<Verdict | undefined> {
    const list = value.draws;
    if (!Array.isArray(list) || list.length > 64) return undefined;
    const draws = list.map((draw) => {
        const n = unsigned(draw);
        return n !== undefined && n <= 0xffff_ffff ? n : undefined;
    });
    if (draws.includes(undefined)) return undefined;
    const positions = drawPositions(draws as number[]);
    if (positions) {
        invariant(
            positions[0] < positions[1] && positions[1] <= 11 && positions[0] >= 0,
            'hidden positions',
        );
        const fair = (draws as number[]).filter((draw) => draw < 0xffff_ffff - 3);
        invariant(
            isDeepStrictEqual(drawPositions(fair), positions),
            'a draw past the last whole run counted',
        );
    }
    return ok(positions);
}

const SESSION_HISTORIES = [
    'main',
    'other',
    'succ',
    'madeUp',
    'removal',
    'removalFork',
    'removalBare',
    'succOther',
];
const SESSION_SETTINGS = ['none', 'pin-main-2', 'not-open', 'checked-before', 'checked-malformed'];
const GUARDS = ['none', 'pin-main-2', 'unreadable', 'held'];
const FORGED = ['outbox', 'other-family', 'earlier-version', 'newer-version'];

/* One step of a `join_session` input, with only the fields its op reads; undefined when it does not fit. */
function sessionStep(step: unknown, at: number, lengths: number[]): Doc | undefined {
    if (!isObject(step)) return undefined;
    const served = () => {
        const served = step.served;
        if (!isObject(served)) return undefined;
        const history = text(served, 'history');
        const which = history === undefined ? -1 : SESSION_HISTORIES.indexOf(history);
        const through = number(served, 'through');
        const cut = optionalText(served, 'cut');
        if (which < 0 || through === undefined || cut === undefined) return undefined;
        const fits =
            through >= 1 &&
            through <= lengths[which]! &&
            (cut === null || cut === 'bad-signature' || (cut === 'beside' && through >= 2));
        return fits ? { history, through, cut } : undefined;
    };
    const earlier = (key: string) => {
        const n = number(step, key);
        return n !== undefined && n < at ? n : undefined;
    };
    // The family guard a step hands the worker (none when absent); one of GUARDS, else no fit.
    // `stored: false`: the guard write after this step failed (none kept); a boolean, else no fit.
    const stored = (): Doc | undefined => {
        if (step.stored === undefined || step.stored === true) return {};
        return step.stored === false ? { stored: false } : undefined;
    };
    const guard = (): Doc | undefined => {
        const keeps = stored();
        if (keeps === undefined) return undefined;
        if (step.guard === undefined) return keeps;
        return typeof step.guard === 'string' && GUARDS.includes(step.guard)
            ? { guard: step.guard, ...keeps }
            : undefined;
    };
    const op = text(step, 'op');
    const need = (...parts: unknown[]) => parts.every((part) => part !== undefined);
    switch (op) {
        case 'show': {
            const where = served();
            return need(where) ? { op, served: where } : undefined;
        }
        case 'sync':
        case 'first-use': {
            const where = served();
            const held = guard();
            return need(where, held) ? { op, served: where, ...held } : undefined;
        }
        case 'check': {
            const words = text(step, 'words');
            const where = served();
            const session = earlier('session');
            if (words === undefined || !['right', 'misheard', 'blank'].includes(words))
                return undefined;
            return need(where, session) ? { op, session, words, served: where } : undefined;
        }
        case 'accept': {
            const record = text(step, 'record');
            const where = served();
            const held = guard();
            if (step.matched !== undefined && record === undefined) {
                const matched = earlier('matched');
                return need(where, matched, held)
                    ? { op, matched, served: where, ...held }
                    : undefined;
            }
            if (step.matched !== undefined || record === undefined) return undefined;
            const own = /^own:(0|[1-9][0-9]*)$/.exec(record);
            const fits = own ? Number(own[1]) < at : FORGED.includes(record);
            return fits && need(where, held) ? { op, record, served: where, ...held } : undefined;
        }
        case 'relaunch':
        case 'lock':
            // No `restore` restores nothing, as the shared scenarios write it.
            if (step.restore === undefined) return { op, restore: false };
            return typeof step.restore === 'boolean' ? { op, restore: step.restore } : undefined;
        case 'restore': {
            const from = earlier('from');
            return from === undefined ? undefined : { op, from };
        }
        case 'forget': {
            const held = guard();
            return held === undefined ? undefined : { op, ...held };
        }
        case 'holds':
        case 'guard':
            return { op };
        default:
            return undefined;
    }
}

/*
 * A session of joining as the web drives it: `settings` (SESSION_SETTINGS)
 * and up to sixteen `steps` (the shared session scenarios' ops, first use and
 * the guard op too, a `guard` on each sync, first use and accept) over the
 * core's join histories, positions from the fixtures' draws: every step's
 * outcome, which the core must match. Invariants (sessionRules): held
 * positions never move until a match, after a restore too, which only ever
 * holds more; the first wrong pair is calm and every later one the alarm
 * until a match; a check of a showing from before a lock is refused; the
 * escalation is kept exactly while something is held; nothing joins without
 * a match or a first use, and each joins once per unlock; a first use only
 * with no mark at all; an unreadable guard never accepts; a first use
 * commits only through its record's rosters; the guard handed back never
 * falls below the one held.
 */
async function joinSessionKind(value: Doc): Promise<Verdict | undefined> {
    const base = coreJoin().joinPreviews;
    const settings = text(value, 'settings');
    if (settings === undefined || !SESSION_SETTINGS.includes(settings)) return undefined;
    const lengths = SESSION_HISTORIES.map((h) => base.histories[h].rosters.length as number);
    const list = value.steps;
    if (!Array.isArray(list) || list.length === 0 || list.length > 16) return undefined;
    const steps = list.map((step, at) => sessionStep(step, at, lengths));
    if (steps.includes(undefined)) return undefined;
    const run = await runSession(base, { name: 'fuzz', settings, steps });
    sessionRules(base, settings, steps as Json[], run.outcomes);
    return ok(run.outcomes);
}

/*
 * The group key version a pin at roster `version` of history `history` is
 * under: one above every succession tied at or below that roster (a roster that
 * drops a holder ties its succession to itself, and a pin there records the
 * new key). Worked out from the history, never from what an acceptance said.
 */
export function sessionKeyVersion(history: Json, version: number) {
    const tied = (history.successions as Json[]).filter(
        (succession) =>
            parseGroupSuccession(decode(succession.statement)).lastRosterVersion <= version,
    );
    return 1 + tied.length;
}

/*
 * Whether a chain served (`history`, `through`, `cut`) of the join histories
 * `base` holds a mark (`served` it came from, `version` it reaches): through
 * it, over the same first keys, the same roster statements through its
 * version and the same succession statements into every key up to the one
 * the mark's roster is under (sessionKeyVersion of the mark's own history);
 * later successions are the served chain's to add (a cut chain is not
 * compared). Statements, not signatures: ML-DSA signs at random, so one
 * roster re-signed is the same roster to acceptance. The oracle sessionRules
 * holds every acceptance to; the core's session_holds_mark.
 */
export function sessionHoldsMark(
    base: Json,
    served: Json,
    mark: { served: Json; version: number },
) {
    if (served.cut !== null || mark.served.cut !== null) return true;
    const at = mark.version;
    const key = sessionKeyVersion(base.histories[mark.served.history], at);
    const of = (history: Json) => ({
        firstKeys: history.firstKeys,
        rosters: (history.rosters as Json[]).slice(0, at).map((roster) => roster.statement),
        successions: (history.successions as Json[])
            .map((succession) => succession.statement as string)
            .filter((statement) => parseGroupSuccession(decode(statement)).newVersion <= key)
            .sort(),
    });
    return (
        served.through >= at &&
        isDeepStrictEqual(
            of(base.histories[served.history]),
            of(base.histories[mark.served.history]),
        )
    );
}

/* Whether guard `next` holds at least what `held` holds: roster, group key, every folder's floor. */
function guardCovers(next: Json, held: Json) {
    return (
        next.rosterVersion >= held.rosterVersion &&
        next.keyVersion >= held.keyVersion &&
        Object.entries(held.areas as Record<string, number>).every(
            ([area, floor]) => (next.areas[area] ?? 0) >= floor,
        )
    );
}

/*
 * The rules every join session keeps, checked over its steps and their
 * outcomes (joinSessionKind). `book` is what the session holds now, `kept`
 * what the page last stored (each check's escalation), which a lock or a
 * relaunch restores, and `after` what was stored after each step.
 */
function sessionRules(base: Json, settings: string, steps: Json[], outcomes: Json[]) {
    type Book = { held: Map<string, string>; tried: boolean };
    const empty = (): Book => ({ held: new Map(), tried: false });
    const copy = (b: Book): Book => ({ held: new Map(b.held), tried: b.tried });
    const key = (o: Json) => `${o.rosterVersion}:${JSON.stringify(o.code)}`;
    const showing = (status: unknown) => status === 'code' || status === 'changed';
    let book = empty();
    let kept = empty();
    const after: Book[] = [];
    let pending: Book | null = null;
    let life = 0;
    const shownIn = new Map<number, number>();
    let joined = false;
    const used = new Set<number>();
    // The marks with keys this device holds, each a history and the roster it reaches: the
    // settings pin, a guard handed (pin-main-2, or the held one from the step that handed it
    // back), the chain committed in this unlock, a first use's joins record.
    type Mark = { served: Json; version: number };
    const main2: Mark = { served: { history: 'main', cut: null }, version: 2 };
    let guard: Json = null;
    let guardFrom: Mark | null = null;
    let committed: Mark | null = null;
    const holdsMark = (served: Json, mark: Mark) => sessionHoldsMark(base, served, mark);
    for (const [at, step] of steps.entries()) {
        const outcome = outcomes[at]!;
        const status = outcome.status;
        const handed =
            step.guard === 'held'
                ? guard
                : step.guard === undefined || step.guard === 'none'
                  ? null
                  : step.guard;
        const from =
            step.op !== 'accept'
                ? undefined
                : typeof step.matched === 'number'
                  ? step.matched
                  : step.record.startsWith('own:')
                    ? Number(step.record.slice(4))
                    : undefined;
        const marks: Mark[] = [];
        if (settings === 'pin-main-2') marks.push(main2);
        if (step.guard === 'pin-main-2') marks.push(main2);
        if (step.guard === 'held' && guardFrom) marks.push(guardFrom);
        if (committed) marks.push(committed);
        if (from !== undefined && outcomes[from]!.status === 'first-use')
            marks.push({ served: steps[from]!.served, version: outcomes[from]!.rosterVersion });
        if (step.guard === 'unreadable')
            invariant(
                status !== 'accepted' && status !== 'first-use',
                `step ${at}: an unreadable guard accepted`,
            );
        if (status === 'accepted' || status === 'first-use') {
            for (const mark of marks)
                invariant(holdsMark(step.served, mark), `step ${at}: accepted past a mark`);
        }
        if (step.op === 'first-use' && status === 'first-use') {
            invariant(
                settings !== 'not-open' && settings !== 'checked-malformed',
                `step ${at}: a first use without settings that hold`,
            );
            // A family check fixes no keys: with nothing else, it leaves no first use either.
            if (settings === 'checked-before')
                invariant(marks.length > 0, `step ${at}: a first use over a family check`);
        }
        // A wipe drops nothing while the guard held does not hold what this session accepted:
        // it hands back the guard to store, which does; only once it is held does it forget.
        // (A cut chain is not compared: whether it holds the other is not the oracle's to say.)
        const uncut = (mark: Mark | null) => mark === null || mark.served.cut === null;
        if (step.op === 'forget' && status !== 'refused' && uncut(committed) && uncut(guardFrom)) {
            const blind = step.guard === 'unreadable';
            const covered =
                !blind &&
                committed !== null &&
                guard !== null &&
                guardFrom !== null &&
                sessionHoldsMark(
                    base,
                    { ...guardFrom.served, through: guardFrom.version },
                    committed,
                );
            if (committed === null || covered)
                invariant(status === 'forgotten', `step ${at}: a wipe held up by nothing to store`);
            else {
                invariant(
                    status === 'store-first' &&
                        outcome.unreadable === blind &&
                        outcome.guard.rosterVersion >= committed.version,
                    `step ${at}: a wipe that would lose an acceptance whose guard was not stored`,
                );
            }
        }
        if (outcome.guard) {
            const from = step.op === 'forget' ? committed!.served : step.served;
            // The pin it records is under the key its roster is under, as the history says.
            if (from.cut === null)
                invariant(
                    outcome.guard.keyVersion ===
                        sessionKeyVersion(
                            base.histories[from.history],
                            outcome.guard.rosterVersion,
                        ),
                    `step ${at}: a guard under another key than its roster's`,
                );
            if (
                (step.guard === 'held' || (step.op === 'forget' && step.guard !== 'unreadable')) &&
                guard
            )
                invariant(guardCovers(outcome.guard, guard), `step ${at}: the guard went back`);
            if (step.stored !== false) {
                guard = outcome.guard;
                guardFrom = { served: from, version: outcome.guard.rosterVersion };
            }
        }
        if ((step.op === 'accept' || step.op === 'sync') && status === 'accepted')
            committed = { served: step.served, version: outcome.rosterVersion };
        // A restore folds in only what is not held here: only ever more held.
        if (step.op === 'show' || (step.op === 'check' && status !== 'skipped')) {
            if (pending) {
                for (const [k, positions] of pending.held)
                    if (!book.held.has(k)) book.held.set(k, positions);
                book.tried ||= pending.tried;
                pending = null;
            }
        }
        if (showing(status)) {
            const held = book.held.get(key(outcome));
            if (held !== undefined)
                invariant(
                    JSON.stringify(outcome.hidden) === held,
                    `step ${at}: held positions moved`,
                );
            shownIn.set(at, life);
        }
        if (step.op === 'check' && status !== 'skipped') {
            const shown = outcomes[step.session]!;
            if (shownIn.get(step.session) !== life)
                invariant(
                    status === 'refused',
                    `step ${at}: a showing from before a lock was checked`,
                );
            if (status === 'wrong-words' || status === 'mismatch') {
                const alarm = book.tried || book.held.has(key(shown));
                invariant(
                    (status === 'mismatch') === alarm,
                    `step ${at}: the calm try and the alarm`,
                );
                book.held.set(key(shown), JSON.stringify(shown.hidden));
                book.tried = true;
            } else if (status === 'matched') {
                book.held.delete(key(shown));
                book.tried = false;
            }
            if ('kept' in outcome) {
                invariant(outcome.kept === book.held.size > 0, `step ${at}: kept while held`);
                kept = copy(book);
            }
        } else if (step.op === 'accept' && status === 'accepted') {
            invariant(
                typeof step.matched === 'number' || step.record.startsWith('own:'),
                `step ${at}: a forged joins record joined`,
            );
            const joinedFrom = outcomes[from!]!;
            invariant(
                joinedFrom.status === 'matched' || joinedFrom.status === 'first-use',
                `step ${at}: a join without a match`,
            );
            invariant(!used.has(from!), `step ${at}: a match joined twice in one unlock`);
            used.add(from!);
            joined = true;
        } else if (
            step.op === 'sync' &&
            status === 'accepted' &&
            settings !== 'pin-main-2' &&
            handed === null
        ) {
            // Without a settings pin or a guard, only a join gives this device a mark.
            invariant(joined, `step ${at}: a family accepted before any join`);
        } else if (step.op === 'relaunch' || step.op === 'lock') {
            life += 1;
            pending = step.restore === true ? copy(kept) : null;
            book = empty();
            joined = false;
            committed = null;
            used.clear();
        } else if (step.op === 'restore' && status !== 'skipped') {
            pending = copy(after[step.from]!);
        } else if (step.op === 'forget' && status === 'forgotten') {
            joined = false;
            committed = null;
            used.clear();
        }
        after.push(copy(kept));
    }
}

/*
 * A chain record holding `record` (any JSON; none when absent), sealed for
 * person 1 of the device record fixtures and accepted in the web's order
 * (record-acceptance.ts driving the worker's groupAccept) against the fixture
 * family's served chain, from `start` (0 to 3), with the settings pin at
 * roster 1 when `settings`: the full outcome, which the core's
 * accept_served must match. Invariant: an accepted chain's pin is at its
 * roster version and is a pin.
 */
async function deviceRecord(value: Doc): Promise<Verdict | undefined> {
    const start = number(value, 'start');
    // How far the server serves (1 to 3, all of it when absent) and the chain committed first (0 for none).
    const through = optionalNumber(value, 'through');
    const held = optionalNumber(value, 'held');
    if (
        start === undefined ||
        through === undefined ||
        held === undefined ||
        typeof value.settings !== 'boolean'
    )
        return undefined;
    const upTo = through ?? 3;
    const heldThrough = held ?? 0;
    if (start > upTo || upTo < 1 || upTo > 3 || heldThrough > 3) return undefined;
    const cases = coreLedger().deviceRecords.cases as Json[];
    const named = (name: string) => cases.find((c) => c.name === name);
    const whole = named('continuation-refused-then-from-version-1').served.find(
        (s: Json) => s.after === 0,
    );
    const prefix = (n: number) => ({
        after: 0,
        rosters: whole.rosters.slice(0, n),
        successions: [],
    });
    const full = prefix(upTo);
    const settingsAt1 = named('record-after-a-master-key-rotation').settingsPin;
    const f = await deviceFamily();
    const record =
        value.record === undefined
            ? null
            : await sealDeviceRecord(
                  DEVICE_ROOT.slice(),
                  f.p1.userId,
                  GROUP,
                  'chains',
                  value.record,
              );
    const served = [full];
    if (start > 0)
        served.unshift({ after: start, rosters: full.rosters.slice(start), successions: [] });
    const { outcome } = await runDeviceCase({
        name: 'fuzz',
        record,
        recordVersion: null,
        settingsPin: value.settings ? settingsAt1 : null,
        held: heldThrough > 0 ? prefix(heldThrough) : null,
        heldSettingsPin: settingsAt1,
        start,
        served,
        firstKeys: cases[0].firstKeys,
        signerKeys: cases[0].signerKeys,
        expected: { status: 'refused' },
    });
    if (outcome.status === 'accepted') {
        invariant(
            outcome.pin.rosterVersion === outcome.rosterVersion,
            'the pin is at the chain’s roster',
        );
        invariant(await holds(() => checkGroupPin(GROUP, outcome.pin)), 'an accepted pin is a pin');
        // The record's own pin, whenever it is a pin, is a mark the accepted chain reaches and passes through.
        const record = value.record;
        let marked: ReturnType<typeof checkGroupPin> | null = null;
        try {
            marked = isObject(record) ? checkGroupPin(GROUP, record.pin) : null;
        } catch {
            marked = null;
        }
        // The chain committed first is a floor: never accepted below it.
        invariant(
            outcome.rosterVersion >= heldThrough,
            'accepted below the chain this session committed',
        );
        if (marked) {
            invariant(
                outcome.rosterVersion >= marked.rosterVersion,
                'accepted below the record’s pin',
            );
            const statement = whole.rosters[marked.rosterVersion - 1].statement as string;
            invariant(
                (await rosterDigest(decode(statement))) === marked.rosterDigest,
                'accepted through another roster than the record’s pin',
            );
        }
    }
    return ok(outcome);
}

/* A case's area root probe (design 2.10), when it is one the Rust core can hold too. */
function rootProbeOf(value: unknown): RootProbe | undefined {
    if (!isObject(value)) return undefined;
    const probe = all({
        workspaceId: text(value, 'workspaceId'),
        workspaceKeyVersion: number(value, 'workspaceKeyVersion'),
        rootKey: text(value, 'rootKey'),
    });
    if (!probe) return undefined;
    try {
        decode(probe.rootKey);
    } catch {
        return undefined;
    }
    return probe;
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
            anchor: (input.anchor ?? null) as GroupAnchor | null,
            joinMark: input.joinMark ?? null,
            pairMarks: (input.pairMarks ?? []) as PairMark[],
        },
        (input.record as RecordProbe | null) ?? undefined,
        input.next
            ? {
                  roster: input.next.roster ? signed(input.next.roster) : null,
                  succession: input.next.succession ? signed(input.next.succession) : null,
                  identities: input.next.identities as Record<string, ServedIdentity[]> | null,
              }
            : undefined,
        rootProbeOf(input.root),
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

/* The current key the input names for the re-keyer: personal trust, or the group's (its personal one outside the roster). */
function rekeyerCurrent(input: NonNullable<ReturnType<typeof readRekeyed>>) {
    if (input.trust.kind === 'personal') return input.trust.trust?.rekeyer?.current ?? null;
    const trust = input.trust.rekeyer;
    if (trust.trust === 'roster' || trust.trust === 'former-member') return trust.signer.current;
    if (trust.trust === 'outside') return input.trust.rekeyerPersonal?.current ?? null;
    return null;
}

/* Whether the re-key signature verifies under that key over the record as served. */
async function rekeyAttested(input: NonNullable<ReturnType<typeof readRekeyed>>) {
    const key = rekeyerCurrent(input);
    const r = input.record;
    if (!key || !r.rekeySignature || r.origin.signerId === null || !r.origin.signature)
        return false;
    const origin = {
        envelope: r.origin.envelope,
        signerId: r.origin.signerId,
        signature: r.origin.signature,
        keyEnvelope: r.origin.keyEnvelope,
    };
    let statement: Uint8Array;
    try {
        statement =
            r.record === 'metadata'
                ? await metadataRekeyedStatement(
                      { ...r.statement, keyEpoch: r.keyEpoch },
                      r.envelope,
                      origin,
                  )
                : await versionRekeyedStatement(
                      { ...r.statement, keyEpoch: r.keyEpoch },
                      r.envelope,
                      origin,
                  );
    } catch (error) {
        if (error instanceof CryptoError) return false;
        throw error;
    }
    return verifyStatement(statement, r.rekeySignature, key);
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
 * A re-keyed record's verdict, personal or in a group's area, and whether the
 * next rotation carries its origin, with the invariants of targets.rs:
 * - bound true means the origin holds the current envelope's bytes, and an
 *   origin sealed for another record never gets there;
 * - bound false means the reader opened both envelopes to different bytes,
 *   or the re-key signature verifies under the re-keyer's current key;
 * - the next rotation carries the origin exactly when both open to equal bytes;
 * - verified means the origin's statement builds.
 */
async function recordIntegrity(value: Doc): Promise<Verdict | undefined> {
    const input = readRekeyed(value);
    if (!input) return undefined;
    const verdict = (await judgeRekeyed(input)) as Json;
    const carried = await carriedRekeyed(input);
    const both = input.nodeKey ? await plaintexts(input.nodeKey, input.record) : undefined;
    const equal = both !== undefined && sameBytes(both[0], both[1]);
    if (verdict.bound === true) {
        invariant(equal, 'a bound record holds other bytes than its origin');
        const known = knownOrigin(input.record.origin.envelope);
        if (known) {
            const { envelope: _, ...sealedFor } = known;
            invariant(
                isDeepStrictEqual(sealedFor, namedRecord(input.record)),
                'an origin sealed for another record passed',
            );
        }
    }
    if (verdict.bound === false) {
        // Not bound is the re-keyer's word or the reader's own sight: both envelopes opened to
        // different bytes, or the re-key signature verifies under the re-keyer's current key.
        const differ = both !== undefined && !sameBytes(both[0], both[1]);
        invariant(
            differ || (await rekeyAttested(input)),
            "a record read as not bound with neither different bytes nor the re-keyer's word",
        );
    }
    if (input.nodeKey)
        invariant(
            carried === equal,
            'the next rotation carried an origin it should not, or dropped a bound one',
        );
    else invariant(carried === null, 'a rotation without the node key carried something');
    // A missing or bad re-key signature no longer touches the origin's verdict (it is a mark of its
    // own), so only the origin's statement must build for it to verify.
    const verified = verdict.origin === 'verified' || verdict.origin?.integrity === 'verified';
    if (verified) {
        const r = input.record;
        const built = await holds(() =>
            r.record === 'metadata'
                ? metadataStatementAs('ordinary', r.statement, r.origin.envelope)
                : versionStatementAs('ordinary', r.statement, r.origin.envelope),
        );
        invariant(built, 'a verified re-keyed record whose origin statement does not build');
    }
    return ok({ ...verdict, carried });
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
        case 'area_ledger':
            return withJson(data, areaLedger);
    }
}

/*
 * The family write rules on any sequence of steps (area-ledger-testkit.ts):
 * every step's outcome, which the core's AreaLedger must match. Invariant:
 * every key envelope the ledger made opens, under the key its parent holds,
 * to the key the ledger handed back.
 */
async function areaLedger(value: Doc): Promise<Verdict | undefined> {
    const steps = readSteps(value.steps);
    if (!steps) return undefined;
    const { outcomes, made, violations } = await runSteps(steps);
    invariant(violations.length === 0, violations.join('; '));
    for (const envelope of made)
        if (envelope.parentKey)
            invariant(
                await opensAsMade(envelope),
                'a key envelope the ledger made opens to its key',
            );
    return { ok: true, out: { outcomes } };
}

/*
 * An outbox entry's JSON (`entry`, any value) read for the roster-call
 * family, kept under `id`, with the admin's pin of an admission's person and
 * the committed head's roster digests (the core's outbox_entry kind).
 */
function outboxEntryKind(value: Doc): Verdict | undefined {
    if (value.entry === undefined) return undefined;
    // The pin by its key commitment (`keys`); seeds from before name it `fingerprint`.
    let pin: { userId: string; keys: string } | null = null;
    if (value.pin !== undefined && value.pin !== null) {
        if (!isObject(value.pin)) return undefined;
        const userId = text(value.pin, 'userId');
        const keys = text(value.pin, 'keys') ?? text(value.pin, 'fingerprint');
        if (userId === undefined || keys === undefined) return undefined;
        pin = { userId, keys };
    }
    const id = optionalText(value, 'id');
    if (id === undefined) return undefined;
    let head: string[] | null = null;
    if (value.head !== undefined && value.head !== null) {
        if (!Array.isArray(value.head) || !value.head.every((at) => typeof at === 'string'))
            return undefined;
        head = value.head as string[];
    }
    const read = readOutboxEntry(value.entry, coreRosterCalls().family.groupId, pin, {
        ...(id === null ? {} : { id }),
        head,
    });
    if (read === null) return ok({ status: 'lost' });
    if (read.status === 'hold')
        return ok({ status: 'hold', route: read.route, reason: read.reason });
    if (read.status === 'landed' || read.status === 'superseded')
        return ok({ status: read.status, route: read.route });
    const kept = (value.entry as Doc).body;
    if (typeof kept === 'string')
        invariant(read.body === kept, 'a resend of other bytes than the ones kept');
    return ok({ status: 'send', route: read.route });
}

/* The admin's join code over the core's roster-call family (the core's member_join_code kind). */
async function memberJoinCodeKind(value: Doc): Promise<Verdict | undefined> {
    const doc = coreRosterCalls();
    const who = number(value, 'who');
    if (who === undefined || who < 1 || who > 6) return undefined;
    let keys: number | null = null;
    if (value.keys !== undefined && value.keys !== null) {
        const at = unsigned(value.keys);
        if (at === undefined || at < 1 || at > 5) return undefined;
        keys = at;
    }
    const picks = value.rosters;
    if (!Array.isArray(picks) || picks.length > 16) return undefined;
    const rosters = [];
    for (const pick of picks) {
        const at = unsigned(pick);
        if (at === undefined || at > 7) return undefined;
        rosters.push(at === 7 ? JUNK : doc.family.rosters[at]);
    }
    const filed: [number, number][] = who <= 5 && keys !== null ? [[who, keys]] : [];
    const outcome = (await joinCodeWith(
        await committedSession(doc, filed),
        doc,
        who,
        rosters,
    )) as Json;
    if (outcome.status === 'code') {
        invariant(outcome.rosterVersion >= 1 && outcome.rosterVersion <= 7, 'a code past the head');
        invariant(keys === who, 'a code for keys someone else pinned');
    }
    if (outcome.status === 'refused') return refused;
    return ok(outcome);
}

const ROSTER_CALL_KINDS = ['admit', 'grant', 'take', 'handover', 'stepDown'];
const SERVED_FIELDS = [
    'encryptionPublicKey',
    'signingPublicKey',
    'mlDsaPublicKey',
    'kemPublicKey',
    'keysSignature',
];

/* One roster call by person 1 of the roster-call family (the core's roster_call kind). */
async function rosterCallKind(value: Doc): Promise<Verdict | undefined> {
    const op = value.op;
    if (!isObject(op)) return undefined;
    const kind = text(op, 'kind');
    if (kind === undefined || !ROSTER_CALL_KINDS.includes(kind)) return undefined;
    const person = (key: string) => {
        const n = number(op, key);
        return n !== undefined && n >= 1 && n <= 5 ? n : undefined;
    };
    const clean: Json = { kind };
    if (kind !== 'stepDown') {
        const who = person('who');
        if (who === undefined) return undefined;
        clean.who = who;
    }
    if (kind === 'admit') {
        const roles = op.roles;
        if (!Array.isArray(roles) || roles.length > 3) return undefined;
        if (!roles.every((role) => ['members', 'billing', 'guardian'].includes(role as string)))
            return undefined;
        clean.roles = roles;
        if (op.served !== undefined && op.served !== null) {
            if (!isObject(op.served)) return undefined;
            for (const [key, field] of Object.entries(op.served)) {
                const fits =
                    key === 'keyVersion'
                        ? unsigned(field) !== undefined
                        : SERVED_FIELDS.includes(key) && typeof field === 'string';
                if (!fits) return undefined;
            }
            clean.served = op.served;
        }
    }
    const result = await runRosterCall(clean);
    if ('refused' in result) return refused;
    const doc = { family: familyJson(await rosterFamily()) };
    return ok(await rosterVerdict(doc, result.route, result.body));
}

/* A manager's device over time (the core's roster_call_session kind). */
async function rosterCallSessionKind(value: Doc): Promise<Verdict | undefined> {
    const steps = value.steps;
    if (!Array.isArray(steps) || steps.length > 12) return undefined;
    const clean = steps.map((step) => rosterSessionStep(step as Json));
    if (clean.some((step) => step === null)) return undefined;
    return ok(await sessionRun(clean as Json[]));
}

/*
 * Text both JSON parsers read alike (the core's settings_fits): numbers of at
 * most 200 digits with an exponent of at most two, at most 64 brackets
 * (escaped lone surrogates are repaired alike before parsing).
 */
export function settingsFits(text: string) {
    const numberOk = (token: string) => {
        const at = token.search(/[eE]/);
        const mantissa = at < 0 ? token : token.slice(0, at);
        const exponent = at < 0 ? '' : token.slice(at + 1);
        return (
            (mantissa.match(/[0-9]/g) ?? []).length <= 200 &&
            (exponent.match(/[0-9]/g) ?? []).length <= 2
        );
    };
    let [inString, escape, brackets, token] = [false, false, 0, ''];
    for (const c of text) {
        if (inString) {
            if (escape) escape = false;
            else if (c === '\\') escape = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (/[0-9]/.test(c) || '+-.eE'.includes(c)) {
            token += c;
            continue;
        }
        if (!numberOk(token)) return false;
        token = '';
        if (c === '"') inString = true;
        else if (c === '{' || c === '[') brackets++;
    }
    return numberOk(token) && brackets <= 64;
}

const PROBE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* A settings document's plaintext read as the worker reads it, probed for contact pins, group pins and family check records (the core's settings kind). */
async function settingsKind(value: Doc): Promise<Verdict | undefined> {
    const text = value.text;
    const users = stringsOf(value, 'users');
    const groups = stringsOf(value, 'groups');
    if (typeof text !== 'string' || !users || !groups) return undefined;
    if (users.length > 8 || groups.length > 8 || new TextEncoder().encode(text).length > 65_536)
        return undefined;
    // Probes are account and family ids as the apps hold them: canonical lowercase UUIDs.
    if (![...users, ...groups].every((id) => PROBE_ID.test(id))) return undefined;
    if (!settingsFits(text)) return undefined;
    let settings;
    try {
        settings = readSettingsDocument(new TextEncoder().encode(text));
    } catch (error) {
        if (error instanceof CryptoError) return refused;
        throw error;
    }
    const account = '00000000-0000-4000-8000-000000000000';
    const marks = settingsMarks(null, account, settings);
    const contacts: Json = {};
    for (const user of users) {
        const pin: Json = contactPinOf(marks, account, user);
        if (!pin) {
            contacts[user] = null;
            continue;
        }
        const str = (v: unknown) => (typeof v === 'string' ? v : null);
        const keys = [
            str(pin.encryptionPublicKey),
            str(pin.signingPublicKey),
            str(pin.mlDsaPublicKeyHash),
            str(pin.kemPublicKeyHash),
        ];
        const wordsChecked = pin.trustedVia === undefined || pin.trustedVia === null;
        const checked =
            wordsChecked &&
            keys.every((key) => key !== null) &&
            typeof pin.fingerprint === 'string' &&
            (await pinVerified(pin));
        invariant(
            pin.userId.toLowerCase() === user.toLowerCase(),
            'a pin found under another person',
        );
        contacts[user] = { userId: pin.userId, keys, fingerprint: str(pin.fingerprint), checked };
    }
    const groupVerdicts: Json = {};
    for (const group of groups) {
        const raw = settingsPinOf(marks, group);
        if (raw === null) {
            groupVerdicts[group] = null;
            continue;
        }
        try {
            groupVerdicts[group] = { pin: checkGroupPin(group, raw) };
        } catch (error) {
            if (!(error instanceof CryptoError)) throw error;
            groupVerdicts[group] = { refused: true };
        }
    }
    // Each family's check record as acceptance would hold it: none, a mark, a pair mark, or refused.
    const checks: Json = {};
    for (const group of groups) {
        const check = familyCheckOf(marks, group);
        if (!check.checked) checks[group] = null;
        else if (check.pairMarks.length === 0) checks[group] = { pairMark: null };
        else
            try {
                checks[group] = { pairMark: checkPairMark(check.pairMarks[0]!) };
            } catch (error) {
                if (!(error instanceof CryptoError)) throw error;
                checks[group] = { refused: true };
            }
    }
    return ok({ status: 'read', contacts, groups: groupVerdicts, checks });
}

/* A family folder of the roster-call family opened by person 2 (the core's area_open kind). */
async function areaOpenKind(value: Doc): Promise<Verdict | undefined> {
    const area = text(value, 'area');
    if (area === undefined || !['A1', 'A2', 'A3', 'foreign'].includes(area)) return undefined;
    const served = number(value, 'served');
    if (served === undefined || served < 1 || served > 4) return undefined;
    let grant: Json = null;
    if (value.grant !== undefined && value.grant !== null) {
        if (!isObject(value.grant) || !Array.isArray(value.grant.key)) return undefined;
        const key = value.grant.key as unknown[];
        const index = unsigned(key[0]);
        const version = unsigned(key[1]);
        if (key.length !== 2 || (index !== 0 && index !== 2) || version === undefined)
            return undefined;
        if (version < 1 || version > 2 || (index === 0 && version !== 1)) return undefined;
        const granterKey = value.grant.granterKey;
        if (granterKey !== undefined && granterKey !== null && typeof granterKey !== 'boolean')
            return undefined;
        grant = { key: [index, version], granterKey: granterKey ?? true };
    }
    let selfGrant: Json = null;
    if (value.selfGrant !== undefined && value.selfGrant !== null) {
        const own = value.selfGrant;
        if (!isObject(own)) return undefined;
        const fields = {
            version: small(own, 'version'),
            workspaceId: text(own, 'workspaceId'),
            keyVersion: number(own, 'keyVersion'),
            workspaceKeyVersion: number(own, 'workspaceKeyVersion'),
            wrappingSalt: text(own, 'wrappingSalt'),
            wrappingNonce: text(own, 'wrappingNonce'),
            encryptedKey: text(own, 'encryptedKey'),
        };
        if (Object.values(fields).some((field) => field === undefined)) return undefined;
        selfGrant = fields;
    }
    const { outcome, stored } = await runArea({ area, served, grant }, selfGrant);
    if ('refused' in outcome) return refused;
    const latest = area === 'A3' ? 2 : 1;
    if (outcome.from === 'self-grant') {
        const v = selfGrant.workspaceKeyVersion as number;
        invariant(
            v >= latest && v >= served && v <= latest,
            'a self-grant taken off the latest version',
        );
    }
    if (stored) {
        invariant(outcome.from === 'grant', 'a self-grant made from a self-grant');
        invariant(
            stored.workspaceKeyVersion === latest && served === latest,
            'a self-grant of a key not current',
        );
    }
    return ok(outcome);
}

/*
 * A pair code (docs/optional-verification.md 3.4): with `rosterDigest`, as
 * pairCodeOf works it out over any `rosterDigest`, `groupKey`,
 * `groupKeyVersion`, `userId` and `otherUserId`; else as person `me` (1 to 5)
 * of the roster-call family works it out with person `other` over the
 * family's chain, holding the keys of person `as` (`me` when absent).
 * Invariants: two equal ids are refused; the code is the same with the ids
 * swapped (over the chain: the same code and roster when the other person
 * works it out); a device holding keys other than its own entry's gets no
 * code.
 */
async function pairCodeKind(value: Doc): Promise<Verdict | undefined> {
    if (value.rosterDigest !== undefined) {
        const rosterDigest = text(value, 'rosterDigest');
        const groupKey = groupKeyOf(value.groupKey);
        const groupKeyVersion = number(value, 'groupKeyVersion');
        const userId = text(value, 'userId');
        const otherUserId = text(value, 'otherUserId');
        if (
            rosterDigest === undefined ||
            !groupKey ||
            groupKeyVersion === undefined ||
            userId === undefined ||
            otherUserId === undefined
        )
            return undefined;
        return either(
            () => pairCodeOf(rosterDigest, groupKey, groupKeyVersion, userId, otherUserId),
            async (code) => {
                invariant(userId !== otherUserId, 'a pair code of one member with themselves');
                const swapped = await pairCodeOf(
                    rosterDigest,
                    groupKey,
                    groupKeyVersion,
                    otherUserId,
                    userId,
                );
                invariant(isDeepStrictEqual(code, swapped), 'a pair code that hangs on the order');
                return code;
            },
        );
    }
    const person = (key: string) => {
        const n = unsigned(key === 'as' && value.as === undefined ? value.me : value[key]);
        return n !== undefined && n >= 1 && n <= 5 ? n : undefined;
    };
    const spec = { me: person('me'), other: person('other'), as: person('as') };
    if (Object.values(spec).includes(undefined)) return undefined;
    const doc = coreRosterCalls();
    const outcome = await pairRunOver(doc, spec);
    if (outcome.status === 'refused') return refused;
    invariant(spec.me !== spec.other, 'a pair code of one member with themselves');
    if (spec.as !== spec.me)
        invariant(outcome.status !== 'code', 'a pair code over keys this device does not hold');
    if (outcome.status === 'code' && spec.as === spec.me) {
        const theirs = await pairRunOver(doc, { me: spec.other, other: spec.me, as: spec.other });
        invariant(
            theirs.status === 'code' &&
                theirs.rosterVersion === outcome.rosterVersion &&
                isDeepStrictEqual(theirs.code, outcome.code),
            'two members shown different pair codes',
        );
    }
    return ok(outcome);
}

/*
 * Any JSON `record`, sealed as person 2's joins record of the join family
 * through the fixtures-only sealer and read back by an acceptance joining
 * over `served` (`history`, `through`), settings none, no guard: the
 * outcome, which the core must match. Invariants: only a record of this
 * family at version 3 or 4 joins, with a join mark or (at 4) a first-use pin;
 * a first use joins only over the roster and first keys its pin names, at or
 * above its roster, and is never reported checked; a join mark always is.
 */
async function joinsRecordKind(value: Doc): Promise<Verdict | undefined> {
    const base = coreJoin().joinPreviews;
    const record = value.record;
    const served = value.served;
    if (record === undefined || !isObject(served)) return undefined;
    const history = text(served, 'history');
    const through = number(served, 'through');
    if (history === undefined || !SESSION_HISTORIES.includes(history) || through === undefined)
        return undefined;
    const rosters = base.histories[history].rosters as Json[];
    if (through < 1 || through > rosters.length) return undefined;
    const where = { history, through, cut: null };
    const run = await runSession(base, {
        name: 'fuzz',
        settings: 'none',
        steps: [{ op: 'accept', record: 'value', value: record, served: where }],
    });
    const outcome = run.outcomes[0]!;
    if (outcome.status === 'refused') return refused;
    if (outcome.status === 'accepted') {
        invariant(
            isObject(record) && (record.v === 3 || record.v === 4) && record.groupId === GROUP,
            'a joins record of no version or family joined',
        );
        const first = record.v === 4 && isObject(record.firstUse) ? record.firstUse : null;
        if (first) {
            invariant(!('joinMark' in record), 'a record with a join mark and a first use joined');
            invariant(outcome.checked === null, 'a first use reported checked');
            const at = first.rosterVersion as number;
            invariant(outcome.rosterVersion >= at, 'a first use joined short of its pin');
            invariant(
                first.keyVersion === sessionKeyVersion(base.histories[history], at),
                'a first use joined under another key than its pin’s roster is under',
            );
            invariant(
                (await rosterDigest(decode(rosters[at - 1]!.statement))) === first.rosterDigest &&
                    base.histories[history].firstKeys.ed25519PublicKey ===
                        first.firstEd25519PublicKey,
                'a first use joined over another history than its pin’s',
            );
        } else invariant(outcome.checked !== null, 'a join mark joined unchecked');
    }
    return ok(outcome);
}
