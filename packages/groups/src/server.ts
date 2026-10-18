import { createHash, randomBytes } from 'node:crypto';
import {
    checkNextRoster,
    checkNextSuccession,
    type ServedIdentity,
    type StoredChain,
} from '@hushos/crypto/group-trust';
import {
    acceptStoredChain,
    storedRecord,
    type StoredChainCache,
} from '@hushos/crypto/group-trust/server';
import {
    AREA_GRANT_BYTES,
    GROUP_KEY_SEAL_BYTES,
    activeWith,
    areaGrantStatement,
    groupKeySealStatement,
    parseGroupSuccession,
    parseRoster,
    rosterEntry,
    type Roster,
    type RosterMember,
    type SignedGroupStatement,
} from '@hushos/crypto/groups';
import { verifyHybrid } from '@hushos/crypto/signatures';
import { UNPAID_GROUP_SEATS } from '@hushos/billing/protocol';
import {
    billingEnabled,
    ensureGroupSeat,
    familyHasPlan,
    paysForGroup,
    type SeatResult,
} from '@hushos/billing/server';
import { authRepository, groupsRepository, madeFor } from '@hushos/db';
import {
    nodeEnvelopesInput,
    nodeView,
    rotatedDocumentInput,
    rotatedNodeInput,
    rotationWorkView,
} from '@hushos/drive/server';
import { WORKSPACE_DOCUMENT_BYTES, WORKSPACE_DOCUMENT_KINDS } from '@hushos/drive/protocol';
import { sendGroupInvitation } from '@hushos/emails/server';
import { appEnv } from '@hushos/env/app';
import { groupsEnv } from '@hushos/env/groups';
import type {
    AreaWire,
    CreateGroupBody,
    GrantWire,
    GroupRoleWire,
    Head,
    RosterCall,
    RotationWire,
    SealWire,
    SelfGrantWire,
    SignedStatementWire,
} from './api';
import {
    IDENTITY_PAGE,
    INVITATION_DAYS,
    MAX_GRANTS_PER_CALL,
    MAX_ROTATIONS_PER_CALL,
    MAX_SEALS_PER_CALL,
    ROSTER_PAGE,
    ROSTER_PAGE_BYTES,
    type GroupErrorCode,
    type GroupErrorStatus,
} from './protocol';

/*
 * The group domain (docs/groups-server.md): every roster, succession, seal
 * and grant is checked here, with the crypto core, before the repository
 * stores it under the group's lock. The routes call these functions with the
 * signed-in account's id; nothing here reads a request.
 *
 * The order of every write: membership and role, then the stored chain (the
 * server's own acceptance, continued from its record), then the statement
 * against it (checkNextRoster / checkNextSuccession, F3), the area rows
 * against the call, every seal and grant statement against the sealer's
 * entry at the roster it names, and only then the repository, which checks
 * the route's policy against its own memberships under the lock. A refusal
 * says only which rule; the core's own message never leaves the server.
 */

export class GroupError extends Error {
    constructor(
        readonly code: GroupErrorCode,
        message: string,
        readonly status: GroupErrorStatus = 400,
        readonly data?: unknown,
    ) {
        super(message);
        this.name = 'GroupError';
    }
}

const REFUSED = 'This change does not follow from the group as it is. Reload and try again.';
const invalid = (reason: string) => new GroupError('invalid', REFUSED, 400, { reason });
const notMember = () => new GroupError('not-member', 'This group does not exist.', 404);
const forbidden = (message = 'Only someone who manages the group can do that.') =>
    new GroupError('forbidden', message, 403);
const unavailable = () =>
    new GroupError('unavailable', 'Groups are temporarily unavailable. Please try again.', 503);

/*
 * One family per account (docs/families-shared-pool.md 3.2). The caller's own
 * family is named to the caller; a newcomer's never is, to the family letting
 * them in. `data.reason` tells the web which sentence to show.
 */
const inYourFamily = (family: { groupId: string; name: string }, invitedTo?: string) =>
    new GroupError(
        'in-family',
        invitedTo
            ? `You’re in ${family.name}. To join ${invitedTo}, leave yours first.`
            : `You’re in ${family.name}. Leave it before you create another.`,
        409,
        { reason: 'self', family },
    );
const newcomerInFamily = () =>
    new GroupError(
        'in-family',
        'They’ve joined another family since they accepted. They can join yours once they leave it.',
        409,
        { reason: 'newcomer' },
    );

const FAMILY_ROLES: readonly GroupRoleWire[] = ['billing', 'guardian', 'members'];
const DAY = 24 * 60 * 60 * 1000;

function b64(bytes: Uint8Array) {
    return Buffer.from(bytes).toString('base64url');
}
function sha(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('base64url');
}
function hashBucket(value: string) {
    return createHash('sha256').update(value).digest();
}
/* Canonical base64url of exactly `length` bytes, or refused. */
function bytes(value: string, length: number | null, reason: string) {
    if (typeof value !== 'string') throw invalid(reason);
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value || (length !== null && decoded.length !== length))
        throw invalid(reason);
    return decoded;
}

async function limit(bucket: string, count: number, windowMs: number) {
    if (!(await authRepository.consumeRateLimit(hashBucket(bucket), count, windowMs)))
        throw new GroupError(
            'rate-limited',
            'Too many changes to groups just now. Please try again shortly.',
            429,
        );
}

/* ------------------------------------------------------------------------- */
/* Statements on the wire                                                     */
/* ------------------------------------------------------------------------- */

function signedOf(wire: SignedStatementWire): SignedGroupStatement {
    return {
        statement: bytes(wire.statement, null, 'statement'),
        signature: {
            ed25519: bytes(wire.signature.ed25519, 64, 'signature'),
            mlDsa: bytes(wire.signature.mlDsa, 3309, 'signature'),
        },
        signerSignature: bytes(wire.signerSignature, 3373, 'signature'),
    };
}
function statementRow(signed: SignedGroupStatement) {
    return {
        statement: Buffer.from(signed.statement),
        ed25519Signature: Buffer.from(signed.signature.ed25519),
        mlDsaSignature: Buffer.from(signed.signature.mlDsa),
        signerSignature: Buffer.from(signed.signerSignature),
    };
}
function storedSigned(row: {
    statement: Buffer;
    ed25519Signature: Buffer;
    mlDsaSignature: Buffer;
    signerSignature: Buffer;
}): SignedGroupStatement {
    return {
        statement: row.statement,
        signature: { ed25519: row.ed25519Signature, mlDsa: row.mlDsaSignature },
        signerSignature: row.signerSignature,
    };
}
function statementWire(row: {
    statement: Buffer;
    ed25519Signature: Buffer;
    mlDsaSignature: Buffer;
    signerSignature: Buffer;
}): SignedStatementWire {
    return {
        statement: b64(row.statement),
        signature: { ed25519: b64(row.ed25519Signature), mlDsa: b64(row.mlDsaSignature) },
        signerSignature: b64(row.signerSignature),
    };
}
function selfGrantInput(wire: SelfGrantWire, workspaceId: string) {
    if (wire.version !== 1 || wire.workspaceId !== workspaceId) throw invalid('self-grant');
    return {
        keyVersion: wire.keyVersion,
        workspaceKeyVersion: wire.workspaceKeyVersion,
        wrappingSalt: bytes(wire.wrappingSalt, 32, 'self-grant'),
        wrappingNonce: bytes(wire.wrappingNonce, 24, 'self-grant'),
        encryptedKey: bytes(wire.encryptedKey, 48, 'self-grant'),
    };
}

/* ------------------------------------------------------------------------- */
/* Membership                                                                 */
/* ------------------------------------------------------------------------- */

type Need = 'accepted' | 'active' | 'members';
/*
 * The caller's place in the group: accepted (reads the chain), active, or an
 * active `members` holder. Strangers and former members get the same 404
 * (`not-member`), the only answer a client may wipe its copy of the group on.
 */
async function membershipOf(groupId: string, userId: string, need: Need) {
    const found = await groupsRepository.getGroupFor(groupId, userId);
    if (!found) throw notMember();
    // Someone accepted but not admitted is in the group's queue, never told they are not in it.
    if (need !== 'accepted' && found.membership.state !== 'active')
        throw forbidden('You have not been admitted to this group yet.');
    if (need === 'members' && !found.membership.roles.includes('members')) throw forbidden();
    return found;
}

/* ------------------------------------------------------------------------- */
/* The stored chain                                                           */
/* ------------------------------------------------------------------------- */

type GroupRow = NonNullable<Awaited<ReturnType<typeof groupsRepository.getGroupRow>>>;
const firstKeysOf = (group: GroupRow) => ({
    ed25519PublicKey: b64(group.firstEd25519PublicKey),
    mlDsaPublicKey: b64(group.firstMlDsaPublicKey),
});

/*
 * The server's acceptance of what it stores, at the group's current
 * revision: continued from its own record, or rebuilt from version 1 when
 * the record is missing, behind, or refused because it does not continue its
 * own chain (a record a bug wrote would otherwise wedge every write). Every
 * signer's ML-DSA key is stored with the statement, so a rebuild needs no
 * account that may since have gone.
 */
/*
 * Whether a chain ends at the group's head: its roster (by version and digest,
 * so another validly signed roster at that version is not it) and its key. A
 * history cut short, or a record a bug stored short, verifies as a shorter
 * chain, which every write would then be refused against as the caller's fault.
 */
function atHead(
    chain: StoredChain,
    head: { rosterVersion: number; rosterDigest: Uint8Array; groupKeyVersion: number },
) {
    return (
        chain.roster.rosterVersion === head.rosterVersion &&
        chain.rosterDigest === b64(head.rosterDigest) &&
        chain.groupKeyVersion === head.groupKeyVersion
    );
}

async function storedChain(group: GroupRow): Promise<{ chain: StoredChain; revision: number }> {
    const record = await groupsRepository.getChainCache(group.id);
    if (record?.cache)
        try {
            const chain = await acceptStoredChain({
                groupId: group.id,
                firstKeys: firstKeysOf(group),
                rosters: [],
                successions: [],
                mlDsaKeys: {},
                cache: record.cache as StoredChainCache,
            });
            // A record at the current revision but short of the head is rebuilt below (and the
            // rebuild's record replaces it), never trusted.
            if (atHead(chain, record.head)) return { chain, revision: record.revision };
        } catch {
            // Rebuilt below.
        }
    const fresh = await groupsRepository.getGroupRow(group.id);
    if (!fresh) throw notMember();
    // Only what the row read above names: a write landing between the reads would otherwise
    // leave a chain at revision R+1 labelled R, and the caller's correct roster refused as invalid.
    const rosters = (
        await groupsRepository.listRosters(group.id, {
            limit: Number.MAX_SAFE_INTEGER,
            maxBytes: Number.MAX_SAFE_INTEGER,
        })
    ).rosters.filter((row) => row.version <= fresh.rosterVersion);
    const successions = (await groupsRepository.listSuccessions(group.id)).filter(
        (row) => row.oldVersion < fresh.groupKeyVersion,
    );
    const mlDsaKeys = Object.fromEntries(
        [...rosters, ...successions].map((row) => [
            sha(row.signerMlDsaPublicKey),
            b64(row.signerMlDsaPublicKey),
        ]),
    );
    let chain: StoredChain;
    try {
        chain = await acceptStoredChain({
            groupId: group.id,
            firstKeys: firstKeysOf(fresh),
            rosters: rosters.map(storedSigned),
            successions: successions.map(storedSigned),
            mlDsaKeys,
            cache: null,
        });
    } catch {
        // A stored history the server's own acceptance refuses is an operator problem, not the caller's.
        throw unavailable();
    }
    // So is one that does not end at the head (cut short, or another roster at its version):
    // kept as the record it would also outlive a repair.
    if (!atHead(chain, fresh)) throw unavailable();
    await groupsRepository.putChainCache(group.id, fresh.chainRevision, storedRecord(chain));
    return { chain, revision: fresh.chainRevision };
}

/* ------------------------------------------------------------------------- */
/* Identities                                                                 */
/* ------------------------------------------------------------------------- */

type IdentityRow = NonNullable<
    ReturnType<Awaited<ReturnType<typeof groupsRepository.identitiesOf>>['get']>
>[number];

function served(identity: IdentityRow): ServedIdentity {
    return {
        keyVersion: identity.keyVersion,
        encryptionPublicKey: b64(identity.encryptionPublicKey),
        signingPublicKey: b64(identity.signingPublicKey),
        mlDsaPublicKey: b64(identity.mlDsaPublicKey),
        kemPublicKey: b64(identity.kemPublicKey),
        keysSignature: b64(identity.keysSignature),
    };
}
/* Whether an entry names exactly this identity's keys (its ML-DSA and ML-KEM keys by digest). */
function names(entry: RosterMember, identity: IdentityRow) {
    return (
        entry.encryptionPublicKey === b64(identity.encryptionPublicKey) &&
        entry.signingPublicKey === b64(identity.signingPublicKey) &&
        entry.mlDsaPublicKeyDigest === sha(identity.mlDsaPublicKey) &&
        entry.kemPublicKeyDigest === sha(identity.kemPublicKey)
    );
}
function sameKeys(a: RosterMember, b: RosterMember) {
    return (
        a.keyVersion === b.keyVersion &&
        a.encryptionPublicKey === b.encryptionPublicKey &&
        a.signingPublicKey === b.signingPublicKey &&
        a.mlDsaPublicKeyDigest === b.mlDsaPublicKeyDigest &&
        a.kemPublicKeyDigest === b.kemPublicKeyDigest
    );
}

/* ------------------------------------------------------------------------- */
/* Checking a roster and a succession                                         */
/* ------------------------------------------------------------------------- */

type CheckedRoster = {
    roster: Roster;
    digest: string;
    next: StoredChain;
    parsed: groupsRepository.ParsedRoster;
};

/*
 * A roster checked as every device will check it, continuing the stored
 * chain (checkNextRoster with the identities of every entry whose keys
 * changed, F3), then by the server's own rules: signed by the uploader; no
 * changed entry moved back to an identity older than the one its entry named
 * before (decision Q6). An entry marked left with the keys the head names
 * needs no identity, so a deleted account's departure can always be marked.
 */
async function checkRoster(
    group: GroupRow,
    chain: StoredChain,
    wire: SignedStatementWire,
    uploader: string,
): Promise<CheckedRoster> {
    const signed = signedOf(wire);
    let roster: Roster;
    try {
        roster = parseRoster(signed.statement);
    } catch {
        throw invalid('roster');
    }
    if (roster.groupId !== group.id || roster.kind !== group.kind) throw invalid('roster-group');
    if (roster.signerUserId !== uploader) throw forbidden('A roster is uploaded by its signer.');
    const previous = chain.roster;
    const changedKeys = roster.members.filter((entry) => {
        const before = rosterEntry(previous, entry.userId);
        return !before || !sameKeys(before, entry);
    });
    const identities = await groupsRepository.identitiesOf([
        ...new Set([...changedKeys.map((entry) => entry.userId), uploader]),
    ]);
    for (const entry of changedKeys) {
        const before = rosterEntry(previous, entry.userId);
        if (!before) continue;
        const own = identities.get(entry.userId) ?? [];
        const now = own.find((identity) => names(entry, identity));
        const was = own.find((identity) => names(before, identity));
        if (now && was && now.keyVersion < was.keyVersion) throw invalid('rollback');
    }
    const signerKeys = identities.get(uploader) ?? [];
    let next: StoredChain;
    try {
        next = await checkNextRoster(
            chain,
            signed,
            Object.fromEntries(
                signerKeys.map((identity) => [
                    sha(identity.mlDsaPublicKey),
                    b64(identity.mlDsaPublicKey),
                ]),
            ),
            Object.fromEntries(
                changedKeys.map((entry) => [
                    entry.userId,
                    (identities.get(entry.userId) ?? []).map(served),
                ]),
            ),
        );
    } catch {
        throw invalid('roster-chain');
    }
    // The key the signer's identity signature verified under: their entry's on the roster before.
    const signerEntry = rosterEntry(previous, uploader);
    const signerMlDsa = signerKeys.find(
        (identity) => sha(identity.mlDsaPublicKey) === signerEntry?.mlDsaPublicKeyDigest,
    );
    if (!signerMlDsa) throw invalid('signer-key');
    const parsed = {
        ...statementRow(signed),
        version: roster.rosterVersion,
        previousDigest: Buffer.from(roster.previousRosterDigest, 'base64url'),
        groupKeyVersion: roster.groupKeyVersion,
        signerUserId: roster.signerUserId,
        signerMlDsaPublicKey: signerMlDsa.mlDsaPublicKey,
        changes: roster.members
            .filter((entry) => entry.sinceVersion === roster.rosterVersion)
            .map((entry) => ({ userId: entry.userId, status: entry.status, roles: entry.roles })),
        dropsHolder: next.droppedHolder,
        commitments: commitmentsOf(roster),
    } as groupsRepository.ParsedRoster;
    return { roster, digest: next.rosterDigest, next, parsed };
}

/*
 * Every area key and root commitment a roster's key rows list (design 2.6,
 * 2.10), as bytes: the repository refuses one another group listed already.
 */
function commitmentsOf(roster: Roster) {
    return (roster.areas ?? []).flatMap((row) =>
        row.retired
            ? []
            : [row.commitment, ...(row.rootCommitment ? [row.rootCommitment] : [])].map((at) =>
                  Buffer.from(at, 'base64url'),
              ),
    );
}

/* A succession checked as every device will check it, continuing the chain after the call's roster. */
async function checkSuccession(
    group: GroupRow,
    chain: StoredChain,
    wire: SignedStatementWire,
    uploader: string,
) {
    const signed = signedOf(wire);
    let succession: ReturnType<typeof parseGroupSuccession>;
    try {
        succession = parseGroupSuccession(signed.statement);
    } catch {
        throw invalid('succession');
    }
    if (succession.groupId !== group.id) throw invalid('succession-group');
    if (succession.signerUserId !== uploader)
        throw forbidden('A succession is uploaded by its signer.');
    const signerKeys = (await groupsRepository.identitiesOf([uploader])).get(uploader) ?? [];
    let next: StoredChain;
    try {
        next = await checkNextSuccession(
            chain,
            signed,
            Object.fromEntries(
                signerKeys.map((identity) => [
                    sha(identity.mlDsaPublicKey),
                    b64(identity.mlDsaPublicKey),
                ]),
            ),
        );
    } catch {
        throw invalid('succession-chain');
    }
    const signerEntry = rosterEntry(chain.roster, uploader);
    const signerMlDsa = signerKeys.find(
        (identity) => sha(identity.mlDsaPublicKey) === signerEntry?.mlDsaPublicKeyDigest,
    );
    if (!signerMlDsa) throw invalid('signer-key');
    const parsed = {
        ...statementRow(signed),
        oldVersion: succession.oldVersion,
        newVersion: succession.newVersion,
        lastRosterVersion: succession.lastRosterVersion,
        lastRosterDigest: Buffer.from(succession.lastRosterDigest, 'base64url'),
        newEd25519PublicKey: Buffer.from(succession.newEd25519PublicKey, 'base64url'),
        newMlDsaPublicKey: Buffer.from(succession.newMlDsaPublicKey, 'base64url'),
        signerUserId: succession.signerUserId,
        signerMlDsaPublicKey: signerMlDsa.mlDsaPublicKey,
    } as groupsRepository.ParsedSuccession;
    return { next, parsed };
}

/* ------------------------------------------------------------------------- */
/* Seals and grants                                                           */
/* ------------------------------------------------------------------------- */

/* Rosters by version, parsed once: the call's own (not stored yet) or stored ones. */
function rosterLookup(groupId: string, own: { roster: Roster; digest: string } | null) {
    const seen = new Map<number, { roster: Roster; digest: string } | null>();
    if (own) seen.set(own.roster.rosterVersion, own);
    return async (version: number) => {
        if (!seen.has(version)) {
            const row = await groupsRepository.getRoster(groupId, version);
            seen.set(
                version,
                row ? { roster: parseRoster(row.statement), digest: b64(row.digest) } : null,
            );
        }
        return seen.get(version) ?? null;
    };
}

/*
 * Whether `envelope` carries the uploader's hybrid signature over `statement`
 * (built from the envelope's signed part) under the keys their entry names on
 * the roster the seal or grant itself names: the Ed25519 key from the entry,
 * the ML-DSA key one of their identities whose digest the entry names.
 */
async function signedUnderEntry(
    envelope: Buffer,
    statement: (sealed: Uint8Array) => Promise<Uint8Array>,
    named: { roster: Roster },
    uploader: string,
    uploaderIdentities: readonly IdentityRow[],
) {
    const entry = rosterEntry(named.roster, uploader);
    if (!activeWith(entry)) return false;
    const mlDsa = uploaderIdentities.find(
        (identity) => sha(identity.mlDsaPublicKey) === entry!.mlDsaPublicKeyDigest,
    );
    if (!mlDsa) return false;
    const signed = envelope.length - 3373;
    return verifyHybrid(await statement(envelope.subarray(0, signed)), envelope.subarray(signed), {
        signingPublicKey: Buffer.from(entry!.signingPublicKey, 'base64url'),
        mlDsaPublicKey: mlDsa.mlDsaPublicKey,
    });
}

/*
 * Seals of the group seed: to an active `members` holder on the head, at
 * the exact key version their entry names, of the head's group key, naming a
 * roster on the stored chain by version and digest, signed by the uploader
 * under their entry there.
 */
async function checkSeals(
    groupId: string,
    seals: readonly SealWire[],
    head: Roster,
    groupKeyVersion: number,
    rosterAt: ReturnType<typeof rosterLookup>,
    uploader: string,
    uploaderIdentities: readonly IdentityRow[],
): Promise<groupsRepository.SealInput[]> {
    if (seals.length > MAX_SEALS_PER_CALL) throw invalid('too-many-seals');
    const out: groupsRepository.SealInput[] = [];
    for (const seal of seals) {
        const envelope = bytes(seal.envelope, GROUP_KEY_SEAL_BYTES, 'seal');
        const holder = rosterEntry(head, seal.holderUserId);
        if (!activeWith(holder, 'members') || holder!.keyVersion !== seal.holderKeyVersion)
            throw new GroupError('members-changed', REFUSED, 409, { reason: 'seal-holder' });
        if (seal.groupKeyVersion !== groupKeyVersion) throw invalid('seal-key-version');
        const named = await rosterAt(seal.rosterVersion);
        if (!named || named.digest !== seal.rosterDigest) throw invalid('seal-roster');
        const ctx = {
            groupId,
            groupKeyVersion: seal.groupKeyVersion,
            holderUserId: seal.holderUserId,
            holderKeyVersion: seal.holderKeyVersion,
            sealerUserId: uploader,
            rosterVersion: seal.rosterVersion,
            rosterDigest: seal.rosterDigest,
        };
        if (
            !(await signedUnderEntry(
                envelope,
                (sealed) => groupKeySealStatement(ctx, sealed),
                named,
                uploader,
                uploaderIdentities,
            ))
        )
            throw invalid('seal-signature');
        out.push({
            ...ctx,
            rosterDigest: bytes(seal.rosterDigest, 32, 'seal'),
            envelope,
        });
    }
    return out;
}

/*
 * Area grants: to an active member on the head at the exact key version
 * their entry names, of an area version the chain lists, naming a roster on
 * the stored chain, signed by the uploader under their entry there.
 */
async function checkGrants(
    groupId: string,
    grants: readonly GrantWire[],
    head: Roster,
    chain: StoredChain,
    rosterAt: ReturnType<typeof rosterLookup>,
    uploader: string,
    uploaderIdentities: readonly IdentityRow[],
): Promise<groupsRepository.GrantInput[]> {
    if (grants.length > MAX_GRANTS_PER_CALL) throw invalid('too-many-grants');
    const out: groupsRepository.GrantInput[] = [];
    for (const grant of grants) {
        const envelope = bytes(grant.envelope, AREA_GRANT_BYTES, 'grant');
        const grantee = rosterEntry(head, grant.granteeUserId);
        if (!activeWith(grantee) || grantee!.keyVersion !== grant.granteeKeyVersion)
            throw new GroupError('members-changed', REFUSED, 409, { reason: 'grantee' });
        // A deleted family folder is granted no more (docs/groups-design.md 2.10).
        if (chain.retiredAreas.includes(grant.workspaceId)) throw invalid('grant-area-retired');
        if ((chain.areaKeys[grant.workspaceId]?.length ?? 0) < grant.workspaceKeyVersion)
            throw invalid('grant-area-version');
        const named = await rosterAt(grant.rosterVersion);
        if (!named || named.digest !== grant.rosterDigest) throw invalid('grant-roster');
        const ctx = {
            groupId,
            workspaceId: grant.workspaceId,
            workspaceKeyVersion: grant.workspaceKeyVersion,
            granteeUserId: grant.granteeUserId,
            granteeKeyVersion: grant.granteeKeyVersion,
            granterUserId: uploader,
            rosterVersion: grant.rosterVersion,
            rosterDigest: grant.rosterDigest,
        };
        if (
            !(await signedUnderEntry(
                envelope,
                (sealed) => areaGrantStatement(ctx, sealed),
                named,
                uploader,
                uploaderIdentities,
            ))
        )
            throw invalid('grant-signature');
        out.push({ ...ctx, rosterDigest: bytes(grant.rosterDigest, 32, 'grant'), envelope });
    }
    return out;
}

/*
 * The area rows a roster carries must be exactly what the call writes: a new
 * area at version 1 on the area route, one row per rotation the call
 * carries, at its new version, and a tombstone only for the area the delete
 * route deletes (docs/groups-design.md 2.10). A row with no write behind it
 * (an area the server does not have, a rotation that never happens, a
 * tombstone standing in for a rotation's row) would list a key the group's
 * files are not under, or retire an area the server still serves.
 */
function checkAreaRows(
    roster: Roster,
    expected: readonly { workspaceId: string; version: number; retired?: boolean }[],
) {
    const rows = (roster.areas ?? [])
        .map((row) => `${row.workspaceId}:${row.workspaceKeyVersion}:${row.retired === true}`)
        .sort();
    const want = expected
        .map((row) => `${row.workspaceId}:${row.version}:${row.retired === true}`)
        .sort();
    if (rows.length !== want.length || rows.some((row, i) => row !== want[i]))
        throw invalid('area-rows');
}

function requireArray<T>(value: readonly T[], reason: string) {
    if (!Array.isArray(value)) throw invalid(reason);
    return value;
}

function rotationInputs(rotations: readonly RotationWire[]): groupsRepository.RotationInput[] {
    if (rotations.length > MAX_ROTATIONS_PER_CALL) throw invalid('too-many-rotations');
    return rotations.map((rotation) => {
        if (!rotation.root.rotated) throw invalid('rotation-root');
        return {
            workspaceId: rotation.workspaceId,
            fromVersion: rotation.fromVersion,
            toVersion: rotation.toVersion,
            targetEpoch: rotation.targetEpoch,
            root: rotatedNodeInput(rotation.root),
            // The old root key under the new area key: what opens the unrotated rest (option A).
            previousRootKeyEnvelope: bytes(
                rotation.previousRootKeyEnvelope,
                72,
                'rotation-root-previous',
            ),
            selfGrant: selfGrantInput(rotation.selfGrant, rotation.workspaceId),
            documents: rotationDocuments(rotation.documents),
        };
    });
}

/*
 * A rotation's re-sealed documents, each checked as a document write checks it,
 * and all of them within what a workspace may hold (Drive's limits): re-sealing
 * at a larger padding must not carry an area past them, or the next rotation
 * would no longer fit a roster body. Which ones, against the area, the
 * repository checks under its lock.
 */
function rotationDocuments(documents: RotationWire['documents']) {
    const decoded = requireArray(documents, 'rotation-documents').map((document) => {
        try {
            return rotatedDocumentInput(document);
        } catch {
            throw invalid('rotation-documents');
        }
    });
    const bytes = decoded.reduce((sum, document) => sum + document.envelope.length, 0);
    if (decoded.length > WORKSPACE_DOCUMENT_KINDS || bytes > WORKSPACE_DOCUMENT_BYTES)
        throw invalid('rotation-documents');
    return decoded;
}

/* ------------------------------------------------------------------------- */
/* Answers                                                                    */
/* ------------------------------------------------------------------------- */

function headView(head: groupsRepository.Head): Head {
    return {
        version: head.rosterVersion,
        digest: b64(head.rosterDigest),
        revision: head.revision,
        groupKeyVersion: head.groupKeyVersion,
    };
}

/* A chain write's answer: the new head, or the refusal as the route's error. */
function chainAnswer(result: groupsRepository.ChainResult): Head & { replayed: boolean } {
    switch (result.status) {
        case 'ok':
        case 'replayed':
            return { ...headView(result), replayed: result.status === 'replayed' };
        case 'stale':
            throw new GroupError(
                'stale',
                'Someone else changed the group first. Reload and try again.',
                409,
                {
                    head: headView(result.head),
                    roster: result.roster
                        ? {
                              version: result.roster.version,
                              digest: b64(result.roster.digest),
                              ...statementWire(result.roster),
                          }
                        : undefined,
                    succession: result.succession ? statementWire(result.succession) : undefined,
                },
            );
        case 'seats':
            throw new GroupError(
                'seats',
                'The group has no seats left. Free one, or add seats to the plan.',
                402,
                { used: result.used, limit: result.limit },
            );
        case 'left-due':
            throw new GroupError(
                'left-due',
                'Someone left the group: mark them as left before anything else.',
                409,
                { userIds: result.userIds },
            );
        case 'members-changed':
            throw new GroupError(
                'members-changed',
                'The group’s members changed. Reload and try again.',
                409,
                { reason: result.reason },
            );
        case 'succession-due':
            throw new GroupError(
                'succession-due',
                'The group key must be replaced before the member list changes again.',
                409,
            );
        case 'not-pending':
            throw new GroupError('not-pending', 'This person has not accepted an invitation.', 409);
        case 'in-family':
            throw newcomerInFamily();
        case 'epoch-stale':
            throw new GroupError(
                'epoch-stale',
                'A file was added while the keys were being replaced. Try again.',
                409,
            );
        case 'root-moved':
            throw new GroupError(
                'root-moved',
                'A folder changed while the keys were being replaced. Try again.',
                409,
            );
        case 'root-mid-rotation':
            throw new GroupError(
                'root-mid-rotation',
                'A shared folder is in the middle of a key change this server cannot account for. Contact the server’s operator.',
                409,
            );
        case 'document-stale':
            throw new GroupError(
                'document-stale',
                'A shared folder’s settings changed while the keys were being replaced. Try again.',
                409,
                { workspaceId: result.workspaceId, kind: result.kind, stale: result.stale },
            );
        case 'rotating':
            throw new GroupError(
                'rotating',
                'A key change is still running in a shared folder. Finish it, then try again.',
                409,
                {
                    workspaceId: result.workspaceId,
                    rotationId: result.rotationId,
                    nodeId: result.nodeId,
                    targetEpoch: result.targetEpoch,
                },
            );
        case 'area-limit':
            throw new GroupError(
                'area-limit',
                `A group can have at most ${result.limit} shared folders on this server.`,
                409,
                { limit: result.limit },
            );
        case 'forbidden':
            throw forbidden();
        case 'not-member':
            throw notMember();
        case 'unavailable':
            throw unavailable();
        case 'invalid':
            throw invalid(result.reason);
    }
}

/* ------------------------------------------------------------------------- */
/* Writing the chain                                                          */
/* ------------------------------------------------------------------------- */

/*
 * Every roster route: the roster (and the succession it carries) checked
 * against the stored chain, the area rows against the call, every seal and
 * grant against the sealer's entry, then the repository under the lock.
 */
async function writeChain(
    groupId: string,
    uploader: string,
    call: RosterCall & { expectedRevision: number },
    route: groupsRepository.ChainRoute,
    options: {
        newArea?: { workspaceId: string };
        admitIdentity?: string;
        /*
         * Runs once every check has passed and before anything is written: an
         * admission's paid place. It throws to stop the write.
         */
        beforeAppend?: () => Promise<void>;
        /* The delete route's area: its tombstone, at the version after the chain's latest. */
        retireArea?: string;
    } = {},
) {
    const found = await membershipOf(groupId, uploader, 'members');
    const group = found.group;
    const { chain, revision } = await storedChain(group);
    // A resend is only compared, never written: it answers even when the budget is spent.
    if (revision !== call.expectedRevision) return answerResend(groupId, uploader, call);
    // Rosters are kept forever: their pace is bounded per group, charged only when one is stored.
    const budget = rosterBudget(groupId);
    await budget.check();
    // A roster after one that dropped a holder waits for the succession (the core refuses it too).
    if (chain.successionDue)
        throw new GroupError(
            'succession-due',
            'The group key must be replaced before the member list changes again.',
            409,
        );
    const checked = await checkRoster(group, chain, call.roster, uploader);
    if (options.admitIdentity) {
        // A newcomer's entry names their current identity, the one the words check compared.
        const entry = rosterEntry(checked.roster, options.admitIdentity);
        const current = (
            (await groupsRepository.identitiesOf([options.admitIdentity])).get(
                options.admitIdentity,
            ) ?? []
        ).find((identity) => identity.current);
        if (!entry || !current || !names(entry, current)) throw invalid('admit-identity');
    }
    const rotations = rotationInputs(call.rotations ?? []);
    checkAreaRows(checked.roster, [
        ...(options.newArea ? [{ workspaceId: options.newArea.workspaceId, version: 1 }] : []),
        ...rotations.map((rotation) => ({
            workspaceId: rotation.workspaceId,
            version: rotation.toVersion,
        })),
        ...(options.retireArea
            ? [
                  {
                      workspaceId: options.retireArea,
                      version: (chain.areaKeys[options.retireArea]?.length ?? 0) + 1,
                      retired: true,
                  },
              ]
            : []),
    ]);
    let after = checked.next;
    let succession: groupsRepository.ParsedSuccession | undefined;
    if (call.succession) {
        const checkedSuccession = await checkSuccession(group, after, call.succession, uploader);
        after = checkedSuccession.next;
        succession = checkedSuccession.parsed;
    }
    const uploaderIdentities =
        (await groupsRepository.identitiesOf([uploader])).get(uploader) ?? [];
    const rosterAt = rosterLookup(groupId, { roster: checked.roster, digest: checked.digest });
    const seals = await checkSeals(
        groupId,
        call.seals ?? [],
        checked.roster,
        after.groupKeyVersion,
        rosterAt,
        uploader,
        uploaderIdentities,
    );
    if (succession)
        await requireSealsCoverHolders(
            groupId,
            checked.roster,
            seals,
            after.groupKeyVersion,
            route.kind === 'admit' ? route.userId : null,
        );
    // Everyone the roster newly gives `members` gets the current group key in the same call:
    // a holder without the seed could never sign, and might be left the last one.
    for (const entry of checked.roster.members)
        if (
            activeWith(entry, 'members') &&
            !activeWith(rosterEntry(chain.roster, entry.userId), 'members') &&
            !seals.some(
                (seal) =>
                    seal.holderUserId === entry.userId &&
                    seal.groupKeyVersion === after.groupKeyVersion,
            )
        )
            throw invalid('holder-seal');
    const grants = await checkGrants(
        groupId,
        call.grants ?? [],
        checked.roster,
        after,
        rosterAt,
        uploader,
        uploaderIdentities,
    );
    await requireGrantsOwed(
        groupId,
        checked.roster,
        [
            ...rotations.map((r) => ({ workspaceId: r.workspaceId, version: r.toVersion })),
            ...(options.newArea ? [{ workspaceId: options.newArea.workspaceId, version: 1 }] : []),
        ],
        grants,
        route.kind === 'admit' ? route.userId : null,
        options.retireArea ?? null,
    );
    await options.beforeAppend?.();
    const result = await groupsRepository.appendChain({
        groupId,
        uploaderUserId: uploader,
        expectedRevision: call.expectedRevision,
        route,
        roster: checked.parsed,
        succession,
        seals,
        grants,
        rotations,
        cache: storedRecord(after),
    });
    if (result.status === 'ok') await budget.charge();
    return chainAnswer(result);
}

/*
 * A call built on another revision than the chain's, above or below it: a
 * resend of what is already stored (a replay, answered with the head), or a
 * loser (stale, with the winner). Its statements are parsed only for their
 * places, and the repository only compares them (classifyResend): nothing
 * unchecked is ever handed to a write, whatever the revision is by then.
 */
async function answerResend(
    groupId: string,
    uploader: string,
    call: { roster?: SignedStatementWire; succession?: SignedStatementWire },
) {
    let roster: { version: number; statement: Buffer } | undefined;
    let succession: { oldVersion: number; statement: Buffer } | undefined;
    try {
        if (call.roster) {
            const statement = bytes(call.roster.statement, null, 'statement');
            roster = { version: parseRoster(statement).rosterVersion, statement };
        }
        if (call.succession) {
            const statement = bytes(call.succession.statement, null, 'statement');
            succession = { oldVersion: parseGroupSuccession(statement).oldVersion, statement };
        }
    } catch {
        throw invalid('statement');
    }
    return chainAnswer(
        await groupsRepository.classifyResend({
            groupId,
            uploaderUserId: uploader,
            roster,
            succession,
        }),
    );
}

/*
 * The group's roster budget (60 an hour, 500 a day): checked before the work,
 * charged only for a roster actually stored, so refused, stale and replayed
 * calls cost nothing and one holder's junk cannot lock everyone else out.
 */
function rosterBudget(groupId: string) {
    const buckets = [
        { name: `groups:roster:hour:${groupId}`, count: 60, windowMs: 60 * 60 * 1000 },
        { name: `groups:roster:day:${groupId}`, count: 500, windowMs: DAY },
    ];
    return {
        async check() {
            for (const bucket of buckets)
                if (!(await authRepository.rateLimitHasRoom(hashBucket(bucket.name), bucket.count)))
                    throw new GroupError(
                        'rate-limited',
                        'This group has changed many times recently. Please try again later.',
                        429,
                    );
        },
        async charge() {
            for (const bucket of buckets)
                await authRepository.consumeRateLimit(
                    hashBucket(bucket.name),
                    bucket.count,
                    bucket.windowMs,
                );
        },
    };
}

/*
 * Grants owed in a family, where every member opens every area. A rotation
 * carries the new key's grant to every remaining active member (as many as a
 * call holds; the rest go through route 22), and no roster lands while an
 * active member lacks a grant of an area's current key, unless this call
 * carries it. Otherwise a remover whose device dies after the call leaves the
 * others unable to read, or to finish the rotation's walk, for good.
 */
async function requireGrantsOwed(
    groupId: string,
    head: Roster,
    keyed: readonly { workspaceId: string; version: number }[],
    grants: readonly groupsRepository.GrantInput[],
    admitted: string | null,
    /* The area this call deletes: nobody is owed its key any more. */
    retiring: string | null = null,
) {
    const granted = new Set(
        grants.map((g) => `${g.workspaceId}:${g.workspaceKeyVersion}:${g.granteeUserId}`),
    );
    const grantedTo = new Set(grants.map((g) => `${g.workspaceId}:${g.granteeUserId}`));
    const active = new Set(await groupsRepository.listActiveMemberIds(groupId, null, 100_000));
    // The newcomer too: a rotation in their admission is owed to them like everyone else.
    const remaining = head.members.filter(
        (entry) => activeWith(entry) && (active.has(entry.userId) || entry.userId === admitted),
    );
    // A newcomer is owed every area's current key; a new or rotated area's key is owed to all.
    const areas = admitted ? await groupsRepository.listAreas(groupId) : [];
    const owed = [
        ...keyed.flatMap((area) =>
            remaining.map((entry) => `${area.workspaceId}:${area.version}:${entry.userId}`),
        ),
        ...areas
            .filter((area) => !keyed.some((k) => k.workspaceId === area.workspaceId))
            .map((area) => `${area.workspaceId}:${area.workspaceKeyVersion}:${admitted}`),
    ];
    const missing = owed.filter((key) => !granted.has(key));
    // All of them when they fit in one call; otherwise a full call, and route 22 for the rest.
    if (
        missing.length > 0 &&
        (owed.length <= MAX_GRANTS_PER_CALL || grants.length < MAX_GRANTS_PER_CALL)
    )
        throw invalid('rotation-grants');
    const rotated = new Set(keyed.map((area) => area.workspaceId));
    const unpaid = (await groupsRepository.missingGrants(groupId)).filter(
        (gap) =>
            gap.workspaceId !== retiring &&
            !rotated.has(gap.workspaceId) &&
            !grantedTo.has(`${gap.workspaceId}:${gap.userId}`),
    );
    if (unpaid.length > 0)
        throw new GroupError(
            'grants-due',
            'Some members still need the key to a shared folder. Send their grants first.',
            409,
            { missing: unpaid },
        );
}

/*
 * A new group key's seals go to exactly the `members` holders of the roster
 * as it leaves the group: its active `members` entries who are active members
 * (whatever roles the database still has for them, so a promotion in the same
 * roster counts) or the person the call admits. Someone the roster still lists
 * who has left, or whose account is gone, is due to be marked left, not sealed
 * to (a seal to them could never be stored, and the succession would wedge).
 */
async function requireSealsCoverHolders(
    groupId: string,
    head: Roster,
    seals: readonly groupsRepository.SealInput[],
    groupKeyVersion: number,
    admitted: string | null,
) {
    const active = new Set(await groupsRepository.listActiveMemberIds(groupId, null, 100_000));
    if (admitted) active.add(admitted);
    const holders = head.members
        .filter((entry) => activeWith(entry, 'members') && active.has(entry.userId))
        .map((entry) => entry.userId)
        .sort();
    const sealed = seals
        .filter((seal) => seal.groupKeyVersion === groupKeyVersion)
        .map((seal) => seal.holderUserId)
        .sort();
    if (holders.length !== sealed.length || holders.some((holder, i) => holder !== sealed[i]))
        throw invalid('succession-seals');
}

/* ------------------------------------------------------------------------- */
/* Routes                                                                     */
/* ------------------------------------------------------------------------- */

function groupView(group: GroupRow) {
    return {
        id: group.id,
        kind: group.kind,
        name: group.name,
        rosterVersion: group.rosterVersion,
        groupKeyVersion: group.groupKeyVersion,
        revision: group.chainRevision,
    };
}

function groupName(name: string) {
    const trimmed = name.trim().normalize('NFC');
    const length = Array.from(trimmed).length;
    // Printable text only: the name goes into invitation emails.
    if (length < 1 || length > 100 || /\p{C}/u.test(trimmed))
        throw new GroupError('invalid', 'Use a name between 1 and 100 characters.');
    return trimmed;
}

/* JSON with every object's keys sorted: the same call always gives the same text. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object')
        // An undefined value is left out, as JSON.stringify leaves it out: absent, not null.
        return `{${Object.keys(value)
            .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
            )
            .join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}

/*
 * F7 on route 1: a resend of a creation that landed (the very call stored,
 * byte for byte, from its creator, still an active member) is a replay,
 * answered before anything that can change after it landed is checked: the
 * creator's current identity (replaced on another device), their seals' key
 * versions, the rate limits. It was checked when it was stored, and nothing is
 * written now. Anything else, a different call for a stored id or the same
 * call from someone else, takes the full path and its refusals.
 */
async function storedCreation(userId: string, groupId: string, digest: Buffer) {
    const found = await groupsRepository.getGroupFor(groupId, userId);
    if (!found || found.group.creatorUserId !== userId || found.membership.state !== 'active')
        return null;
    return found.group.creationDigest?.equals(digest) ? found.group : null;
}

/* Route 1: a new family, its first roster, the creator's seal, and its first area with its root. */
export async function createGroup(userId: string, body: CreateGroupBody) {
    if (body.kind !== 'family')
        throw new GroupError(
            'unsupported',
            'Company groups are not available on this server yet.',
            409,
        );
    const creationDigest = createHash('sha256').update(canonicalJson(body)).digest();
    const stored = await storedCreation(userId, body.id, creationDigest);
    if (stored) return { group: groupView(stored), replayed: true };
    // Before anything is spent or checked: the repository asks again under the creator's lock.
    // This very family, landed since storedCreation looked, is the repository's replay to answer.
    const family = await groupsRepository.familyOf(userId);
    if (family && family.groupId !== body.id) throw inYourFamily(family);
    await limit(`groups:create:user:${userId}`, 5, DAY);
    await limit('groups:create:global', 1000, 60 * 60 * 1000);
    const name = groupName(body.name);
    const firstKeys = {
        ed25519PublicKey: b64(bytes(body.groupKey.ed25519PublicKey, 32, 'group-key')),
        mlDsaPublicKey: b64(bytes(body.groupKey.mlDsaPublicKey, 1952, 'group-key')),
    };
    const signed = signedOf(body.roster);
    let roster: Roster;
    try {
        roster = parseRoster(signed.statement);
    } catch {
        throw invalid('roster');
    }
    if (roster.groupId !== body.id || roster.kind !== 'family' || roster.signerUserId !== userId)
        throw invalid('roster-group');
    const identities = (await groupsRepository.identitiesOf([userId])).get(userId) ?? [];
    const current = identities.find((identity) => identity.current);
    let chain: StoredChain;
    try {
        chain = await acceptStoredChain({
            groupId: body.id,
            firstKeys,
            rosters: [signed],
            successions: [],
            mlDsaKeys: Object.fromEntries(
                identities.map((identity) => [
                    sha(identity.mlDsaPublicKey),
                    b64(identity.mlDsaPublicKey),
                ]),
            ),
            cache: null,
        });
    } catch {
        throw invalid('roster-chain');
    }
    // The creator's entry is their current identity.
    const entry = rosterEntry(roster, userId);
    if (!entry || !current || !names(entry, current)) throw invalid('creator-identity');
    const area = body.area;
    checkAreaRows(roster, [{ workspaceId: area.workspaceId, version: 1 }]);
    if (!madeFor('node', area.workspaceId, area.root.id, area.root.idSeed))
        throw invalid('area-root-id');
    const digest = chain.rosterDigest;
    const rosterAt = rosterLookup(body.id, { roster, digest });
    const [keySeal] = await checkSeals(
        body.id,
        [
            {
                groupKeyVersion: 1,
                holderUserId: userId,
                holderKeyVersion: entry.keyVersion,
                rosterVersion: 1,
                rosterDigest: digest,
                envelope: body.keySeal.envelope,
            },
        ],
        roster,
        1,
        rosterAt,
        userId,
        identities,
    );
    const grants = await checkGrants(
        body.id,
        [
            {
                workspaceId: area.workspaceId,
                workspaceKeyVersion: 1,
                granteeUserId: userId,
                granteeKeyVersion: entry.keyVersion,
                rosterVersion: 1,
                rosterDigest: digest,
                envelope: area.grant.envelope,
            },
        ],
        roster,
        chain,
        rosterAt,
        userId,
        identities,
    );
    const signerMlDsa = identities.find(
        (identity) => sha(identity.mlDsaPublicKey) === entry.mlDsaPublicKeyDigest,
    )!;
    const result = await groupsRepository.createGroup({
        id: body.id,
        idSeed: body.idSeed,
        kind: 'family',
        name,
        creatorUserId: userId,
        firstEd25519PublicKey: bytes(firstKeys.ed25519PublicKey, 32, 'group-key'),
        firstMlDsaPublicKey: bytes(firstKeys.mlDsaPublicKey, 1952, 'group-key'),
        roster: {
            ...statementRow(signed),
            version: 1,
            previousDigest: null,
            groupKeyVersion: 1,
            signerUserId: userId,
            signerMlDsaPublicKey: signerMlDsa.mlDsaPublicKey,
            changes: roster.members.map((member) => ({
                userId: member.userId,
                status: member.status,
                roles: member.roles,
            })),
            dropsHolder: false,
            commitments: commitmentsOf(roster),
        } as groupsRepository.ParsedRoster,
        keySeal: keySeal!,
        area: areaInput(area),
        grants,
        cache: storedRecord(chain),
        ownedLimit: groupsEnv.GROUP_OWNED_LIMIT,
        creationDigest,
        pooled: billingEnabled(),
    });
    switch (result.status) {
        case 'group-limit':
            throw new GroupError(
                'group-limit',
                `You can create at most ${result.limit} groups on this server.`,
                409,
                { limit: result.limit },
            );
        case 'area-limit':
            throw new GroupError('area-limit', 'This group has no room for another folder.', 409);
        case 'in-family': {
            // Admitted elsewhere between the check above and the write. The index's answer
            // names no family: read it, and if they've already left it too, let them retry.
            const now = result.family ?? (await groupsRepository.familyOf(userId));
            if (now) throw inYourFamily(now);
            throw unavailable();
        }
        case 'created':
        case 'replayed': {
            const group = await groupsRepository.getGroupRow(body.id);
            return { group: groupView(group!), replayed: result.status === 'replayed' };
        }
        case 'taken':
            throw new GroupError('exists', 'This group id is already in use.', 409);
        case 'forbidden':
            throw forbidden();
        case 'unavailable':
            throw unavailable();
        case 'invalid':
            throw invalid(result.reason);
    }
}

function areaInput(area: AreaWire, limit?: number): groupsRepository.AreaInput {
    return {
        limit,
        workspaceId: area.workspaceId,
        idSeed: area.idSeed,
        // With billing on the group's pool is the allowance (group_storage): an area has none of its own.
        quotaBytes: billingEnabled() ? 0n : groupsEnv.GROUP_AREA_QUOTA_BYTES,
        selfGrant: selfGrantInput(area.selfGrant, area.workspaceId),
        root: {
            id: area.root.id,
            envelopes: nodeEnvelopesInput({
                keyEpoch: area.root.keyEpoch,
                parentKeyEpoch: area.root.parentKeyEpoch,
                keyEnvelope: area.root.keyEnvelope,
                metadataEnvelope: area.root.metadataEnvelope,
                metadataSignature: area.root.metadataSignature,
            }),
        },
    };
}

/* Route 2: the account's groups. */
export async function listGroups(userId: string) {
    return {
        groups: (await groupsRepository.listGroupsFor(userId)).map((group) => ({
            id: group.id,
            kind: group.kind,
            name: group.name,
            roles: group.roles,
            state: group.state,
            rosterVersion: group.rosterVersion,
            groupKeyVersion: group.groupKeyVersion,
        })),
    };
}

/* Route 3's `due`: `grants` for every active member, the rest for `members` holders only. */
export type GroupDue = {
    grants: { workspaceId: string; userId: string }[];
    markLeft?: string[];
    foldIn?: string[];
    succession?: boolean;
    rotations?: string[];
    holds?: { userId: string; heldBy: string | null; expiresAt: string }[];
};

/*
 * Route 3: the group, its members and seats, and what is due. For every
 * active member, the grants they could fill (route 22): members owed an
 * area's current key where the caller holds it, so a gap is closed by whoever
 * sees it first instead of only surfacing when a holder's roster is refused.
 * For `members` holders also: departures to mark left, members whose identity
 * moved on from their entry (to fold in), a succession, areas to rotate and
 * live holds.
 */
export async function getGroup(userId: string, groupId: string) {
    const found = await membershipOf(groupId, userId, 'accepted');
    const group = found.group;
    const members = await groupsRepository.listMembers(groupId);
    const seats = {
        used: await groupsRepository.seatsUsed(groupId),
        limit: group.seatLimit ?? seatLimitDefault(),
    };
    let due: GroupDue | undefined;
    if (found.membership.state === 'active')
        due = { grants: await groupsRepository.fillableGrants(groupId, userId) };
    if (due && found.membership.roles.includes('members')) {
        const head = await groupsRepository.getRoster(groupId, group.rosterVersion);
        const roster = head ? parseRoster(head.statement) : null;
        const active = members.filter((member) => member.state === 'active');
        const identities = await groupsRepository.identitiesOf(active.map((m) => m.userId));
        const foldIn = active
            .filter((member) => {
                const entry = roster ? rosterEntry(roster, member.userId) : undefined;
                const current = (identities.get(member.userId) ?? []).find((i) => i.current);
                return entry && current && !names(entry, current);
            })
            .map((member) => member.userId);
        due = {
            ...due,
            markLeft: (await groupsRepository.listDepartures(groupId)).map((d) => d.userId),
            foldIn,
            succession: group.successionDue,
            rotations: await groupsRepository.listRotationsDue(groupId),
            // Holds are unsigned: every holder sees who holds whom, so one cannot be silent.
            holds: (await groupsRepository.listHolds(groupId)).map((h) => ({
                userId: h.userId,
                heldBy: h.heldBy,
                expiresAt: h.expiresAt.toISOString(),
            })),
        };
    }
    return {
        group: groupView(group),
        head: headView(found.head),
        // Names are the server's word (rosters carry none): the address goes beside them (D10),
        // for active members only. Someone who only accepted (they proved an inbox, nothing else)
        // sees who manages the family, whom they compare words with; a member who doesn't manage
        // it sees who is in it or waiting, never who left or was turned down.
        members: members
            .filter((member) =>
                found.membership.state !== 'active'
                    ? member.state === 'active' && member.roles.includes('members')
                    : found.membership.roles.includes('members') ||
                      member.state === 'active' ||
                      member.state === 'accepted',
            )
            .map((member) => ({
                userId: member.userId,
                name: member.name,
                email: member.state === 'active' ? member.email : null,
                state: member.state,
                roles: member.roles,
            })),
        seats,
        ...(due ? { due } : {}),
    };
}

/* Route 4. */
export async function renameGroup(userId: string, groupId: string, input: { name: string }) {
    await membershipOf(groupId, userId, 'members');
    const group = await groupsRepository.renameGroup(groupId, groupName(input.name));
    if (!group) throw notMember();
    return { group: groupView(group) };
}

/*
 * Route 5: rosters after `after`, a page at a time, every succession from key
 * version 1, the version 1 keys, and every ML-DSA key a signer in the page or
 * a succession used, by digest (stored with the statements, so a deleted
 * signer's history still verifies).
 */
export async function getRosters(
    userId: string,
    groupId: string,
    query: { after?: number; limit?: number },
) {
    const found = await membershipOf(groupId, userId, 'accepted');
    const page = await groupsRepository.listRosters(groupId, {
        after: query.after,
        limit: Math.min(query.limit ?? ROSTER_PAGE, ROSTER_PAGE),
        maxBytes: ROSTER_PAGE_BYTES,
    });
    const successions = await groupsRepository.listSuccessions(groupId);
    const signerKeys = Object.fromEntries(
        [...page.rosters, ...successions].map((row) => [
            sha(row.signerMlDsaPublicKey),
            b64(row.signerMlDsaPublicKey),
        ]),
    );
    return {
        rosters: page.rosters.map((row) => ({ version: row.version, ...statementWire(row) })),
        successions: successions.map(statementWire),
        firstKeys: firstKeysOf(found.group),
        signerKeys,
        head: headView(found.head),
        next: page.next,
    };
}

/*
 * Route 6: the identity and succession links (consent included) of every
 * entry on the head roster, those marked left among them, in user id order a
 * page of accounts at a time: what verdicts and seal openers need, which the
 * contacts routes serve only one at a time. A former member's records still
 * need their links to tell a retired key from a stranger's; an account that is
 * gone has no identity and no links (null and []).
 */
export async function getIdentities(userId: string, groupId: string, after: string | null) {
    const found = await membershipOf(groupId, userId, 'active');
    const head = await groupsRepository.getRoster(groupId, found.group.rosterVersion);
    if (!head) throw unavailable();
    const ids = [...new Set(parseRoster(head.statement).members.map((entry) => entry.userId))]
        .sort()
        .filter((memberId) => after === null || memberId > after.toLowerCase());
    const page = ids.slice(0, IDENTITY_PAGE);
    const identities = await groupsRepository.identitiesOf(page);
    const memberships = await groupsRepository.membershipsOf(groupId, page);
    const out = [];
    for (const memberId of page) {
        const current = (identities.get(memberId) ?? []).find((identity) => identity.current);
        const links = (await authRepository.successionChain(memberId, 1)) ?? [];
        // A former member's links stop where their membership did: keys they made since are
        // none of the group's business. No departure time on record (they accepted a new
        // invitation since, or the account is gone): none at all.
        const membership = memberships.get(memberId);
        const until = membership?.state === 'active' ? null : (membership?.leftAt ?? new Date(0));
        out.push({
            userId: memberId,
            identity: current ? served(current) : null,
            links: links
                .filter((link) => link.oldMlDsaPublicKey && link.newMlDsaPublicKey)
                .filter((link) => until === null || link.replacedAt <= until)
                .map((link) => ({
                    oldKeyVersion: link.oldKeyVersion,
                    newKeyVersion: link.newKeyVersion,
                    oldEncryptionPublicKey: b64(link.oldEncryptionPublicKey),
                    oldSigningPublicKey: b64(link.oldSigningPublicKey),
                    oldMlDsaPublicKey: b64(link.oldMlDsaPublicKey!),
                    newEncryptionPublicKey: b64(link.newEncryptionPublicKey),
                    newSigningPublicKey: b64(link.newSigningPublicKey),
                    newMlDsaPublicKey: b64(link.newMlDsaPublicKey!),
                    newKemPublicKey: b64(link.newKemPublicKey),
                    signature: b64(link.signature),
                    consent: link.consent ? b64(link.consent) : null,
                })),
        });
    }
    return { identities: out, next: ids.length > page.length ? page.at(-1)! : null };
}

/* Route 7: fold-ins and marking departures left (with the rotations and succession that brings). */
export async function postRoster(userId: string, groupId: string, call: RosterCall) {
    return writeChain(groupId, userId, call, { kind: 'roster' });
}

/* Route 8: the caller's seal of the current group key. */
export async function getKeySeal(userId: string, groupId: string) {
    await membershipOf(groupId, userId, 'members');
    const seal = await groupsRepository.keySealFor(groupId, userId);
    if (!seal)
        throw new GroupError('no-seal', 'Nobody has sealed the current group key to you yet.', 409);
    return {
        groupKeyVersion: seal.groupKeyVersion,
        holderKeyVersion: seal.holderKeyVersion,
        sealerUserId: seal.sealerUserId,
        rosterVersion: seal.rosterVersion,
        rosterDigest: b64(seal.rosterDigest),
        envelope: b64(seal.envelope),
    };
}

/*
 * Grants and seals outside a roster (routes 9 and 22): checked against the
 * head and the stored chain as a roster's are, then stored under the lock on
 * the repository's overwrite rules.
 */
async function storeOutsideChain(
    userId: string,
    groupId: string,
    input: { seals?: SealWire[]; grants?: GrantWire[] },
    need: Need,
) {
    const found = await membershipOf(groupId, userId, need);
    const { chain } = await storedChain(found.group);
    const identities = (await groupsRepository.identitiesOf([userId])).get(userId) ?? [];
    const rosterAt = rosterLookup(groupId, null);
    const seals = await checkSeals(
        groupId,
        input.seals ?? [],
        chain.roster,
        chain.groupKeyVersion,
        rosterAt,
        userId,
        identities,
    );
    const grants = await checkGrants(
        groupId,
        input.grants ?? [],
        chain.roster,
        chain,
        rosterAt,
        userId,
        identities,
    );
    const result = await groupsRepository.storeGrants({
        groupId,
        uploaderUserId: userId,
        seals,
        grants,
    });
    switch (result.status) {
        case 'ok':
            return { stored: result.stored };
        case 'not-member':
            throw notMember();
        case 'forbidden':
            throw forbidden();
        case 'unavailable':
            throw unavailable();
        case 'members-changed':
            throw new GroupError('members-changed', REFUSED, 409, { reason: result.reason });
        case 'invalid':
            throw invalid(result.reason);
    }
}

/* Route 9: re-sealing the group seed to holders whose identity was folded in. */
export async function putKeySeals(userId: string, groupId: string, input: { seals: SealWire[] }) {
    return storeOutsideChain(userId, groupId, { seals: input.seals }, 'members');
}

/* Route 10: a succession on its own, with its seals to every remaining holder. */
export async function postSuccession(
    userId: string,
    groupId: string,
    input: { expectedRevision: number; succession: SignedStatementWire; seals: SealWire[] },
) {
    const found = await membershipOf(groupId, userId, 'members');
    const { chain, revision } = await storedChain(found.group);
    if (revision !== input.expectedRevision)
        return answerResend(groupId, userId, { succession: input.succession });
    const { next, parsed } = await checkSuccession(found.group, chain, input.succession, userId);
    const identities = (await groupsRepository.identitiesOf([userId])).get(userId) ?? [];
    const seals = await checkSeals(
        groupId,
        input.seals,
        chain.roster,
        next.groupKeyVersion,
        rosterLookup(groupId, null),
        userId,
        identities,
    );
    await requireSealsCoverHolders(groupId, chain.roster, seals, next.groupKeyVersion, null);
    return chainAnswer(
        await groupsRepository.appendChain({
            groupId,
            uploaderUserId: userId,
            expectedRevision: input.expectedRevision,
            route: { kind: 'succession' },
            succession: parsed,
            seals,
            cache: storedRecord(next),
        }),
    );
}

/*
 * With billing on, a family without a live plan invites nobody, makes no
 * family folders and takes no acceptances (docs/groups-design.md 3.5):
 * nobody could be let in, and the pool is empty. An invitation sent while a
 * plan ran stays open, so it works again once the plan is renewed. Asked
 * after the caller's own checks, so only a manager learns whether the family
 * has a plan.
 */
async function requirePlan(groupId: string, name?: string) {
    if (await familyHasPlan(groupId)) return;
    const family = name ?? (await groupsRepository.getGroupRow(groupId))?.name ?? 'this family';
    throw new GroupError(
        'no-plan',
        `Choose a plan for ${family} first. Until it has one, nobody can be invited and no family folders can be made.`,
        402,
    );
}

/* Route 11: an invitation by email, mailed with its one-time link. */
export async function invite(
    userId: string,
    groupId: string,
    input: { email: string; roles: GroupRoleWire[] },
) {
    const found = await membershipOf(groupId, userId, 'members');
    await requirePlan(groupId, found.group.name);
    const email = input.email.trim();
    const normalizedEmail = email.toLowerCase();
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
        throw new GroupError('invalid', 'Enter a valid email address.');
    const roles = [...new Set(input.roles)].sort();
    if (roles.some((role) => !FAMILY_ROLES.includes(role)))
        throw new GroupError('invalid', 'Choose roles a family member can have.');
    await limit(`groups:invite:group:${groupId}`, 30, DAY);
    await limit(`groups:invite:user:${userId}`, 20, 60 * 60 * 1000);
    // Per group and address: one group's invitations never use up another's for that address.
    await limit(`groups:invite:group-email:${groupId}:${normalizedEmail}`, 3, DAY);
    // Across groups, an address receives at most so many invitation mails: charged only per mail.
    const mailBucket = hashBucket(`groups:invite:email:${normalizedEmail}`);
    if (!(await authRepository.rateLimitHasRoom(mailBucket, 10)))
        throw new GroupError(
            'rate-limited',
            'That address has had several invitations today. Please try again tomorrow.',
            429,
        );
    const token = randomBytes(32).toString('base64url');
    const created = await groupsRepository.createInvitation({
        groupId,
        email,
        normalizedEmail,
        tokenHash: createHash('sha256').update(token).digest(),
        roles,
        invitedBy: userId,
        expiresAt: new Date(Date.now() + INVITATION_DAYS * DAY),
    });
    switch (created.status) {
        case 'created':
            break;
        case 'exists':
            throw new GroupError('exists', 'That address already has an open invitation.', 409);
        case 'already-member':
            throw new GroupError('already-member', 'That person is already in the group.', 409);
        case 'not-member':
            throw notMember();
        case 'unavailable':
            throw unavailable();
    }
    const inviter = await authRepository.getUserById(userId);
    try {
        await sendGroupInvitation(email, {
            inviterName: inviter?.name ?? 'A HushOS member',
            inviterEmail: inviter?.email ?? '',
            groupName: found.group.name,
            joinUrl: `${new URL('/join', appEnv.APP_ORIGIN).href}#invite=${token}`,
        });
    } catch {
        // Nobody can use an invitation whose link never left: withdraw it and say so.
        await groupsRepository.revokeInvitation(groupId, created.id);
        throw unavailable();
    }
    await authRepository.consumeRateLimit(mailBucket, 10, DAY);
    return { id: created.id, expiresAt: created.expiresAt.toISOString() };
}

/* Route 12. */
export async function listInvitations(userId: string, groupId: string) {
    await membershipOf(groupId, userId, 'members');
    return {
        invitations: (await groupsRepository.listOpenInvitations(groupId)).map((row) => ({
            id: row.id,
            email: row.email,
            roles: row.roles,
            invitedBy: row.invitedBy,
            expiresAt: row.expiresAt.toISOString(),
        })),
    };
}

/* Route 13. */
export async function revokeInvitation(userId: string, groupId: string, invitationId: string) {
    await membershipOf(groupId, userId, 'members');
    if ((await groupsRepository.revokeInvitation(groupId, invitationId)) !== 'revoked')
        throw new GroupError('gone', 'This invitation is no longer open.', 410);
    return { revoked: true as const };
}

const invitationHash = (token: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        throw new GroupError('gone', 'This invitation is no longer open.', 410);
    return createHash('sha256').update(token).digest();
};

/* Route 14: what an invitation is, for a signed-in account. No chain and no member list. */
export async function openInvitation(userId: string, token: string, address: string) {
    await limit(`invitations:open:address:${address}`, 30, 15 * 60 * 1000);
    await limit(`invitations:open:user:${userId}`, 30, 15 * 60 * 1000);
    const found = await groupsRepository.openInvitation(invitationHash(token));
    if (!found) throw new GroupError('gone', 'This invitation is no longer open.', 410);
    // The caller's own family, so the join page can say to leave it first; never this one.
    const family = found.group.kind === 'family' ? await groupsRepository.familyOf(userId) : null;
    return {
        inFamily: family && family.groupId !== found.group.id ? family : null,
        invitationId: found.invitation.id,
        groupId: found.group.id,
        kind: found.group.kind,
        name: found.group.name,
        // The inviter's address is in the invitation email already; names are the server's word.
        inviter: found.inviter?.id
            ? { id: found.inviter.id, name: found.inviter.name, email: found.inviter.email }
            : null,
        roles: found.invitation.roles,
        expiresAt: found.invitation.expiresAt.toISOString(),
    };
}

/*
 * Route 14b: the open invitations to this account's own address, for Account
 * → Family. Each is accepted from its emailed link, never from here.
 */
export async function listMyInvitations(userId: string) {
    return {
        invitations: (await groupsRepository.openInvitationsFor(userId)).map((row) => ({
            id: row.id,
            groupId: row.groupId,
            name: row.name,
            inviterName: row.inviterName,
            expiresAt: row.expiresAt.toISOString(),
        })),
    };
}

/* Route 15: binds the invitation to the signed-in account, which must hold the invited address. */
export async function acceptInvitation(userId: string, token: string, address: string) {
    await limit(`invitations:accept:address:${address}`, 30, 15 * 60 * 1000);
    await limit(`invitations:accept:user:${userId}`, 10, 15 * 60 * 1000);
    const opened = await groupsRepository.openInvitation(invitationHash(token));
    // One family per account, before the plan: leaving theirs is the first thing they must do.
    if (opened?.group.kind === 'family') {
        const family = await groupsRepository.familyOf(userId);
        if (family && family.groupId !== opened.group.id)
            throw inYourFamily(family, opened.group.name);
    }
    // A family whose plan lapsed takes nobody new: accepting would only wait for a place.
    if (opened && !(await familyHasPlan(opened.group.id)))
        throw new GroupError(
            'no-plan',
            `${opened.group.name} can’t take anyone new right now. Ask whoever invited you; this invitation works again once the family has a plan.`,
            402,
            { invitee: true },
        );
    const result = await groupsRepository.acceptInvitation({
        tokenHash: invitationHash(token),
        userId,
    });
    switch (result.status) {
        case 'accepted':
            return { groupId: result.groupId, state: 'accepted' as const };
        case 'gone':
            throw new GroupError('gone', 'This invitation is no longer open.', 410);
        case 'email-mismatch':
            throw new GroupError(
                'email-mismatch',
                'This invitation is for another email address. Sign in with that one.',
                403,
            );
        case 'already-member':
            throw new GroupError('already-member', 'You are already in this group.', 409);
        case 'in-family':
            throw inYourFamily(result.family, opened?.group.name ?? 'this family');
        case 'unavailable':
            throw unavailable();
    }
}

/* Route 16: who accepted and waits, with the identity the words check compares. */
export async function listPending(userId: string, groupId: string) {
    await membershipOf(groupId, userId, 'members');
    const rows = await groupsRepository.listPending(groupId);
    const identities = await groupsRepository.identitiesOf(rows.map((row) => row.userId));
    return {
        pending: rows.map((row) => {
            const current = (identities.get(row.userId) ?? []).find((i) => i.current);
            return {
                userId: row.userId,
                name: row.name,
                email: row.email,
                roles: row.invitationRoles ?? [],
                acceptedAt: row.acceptedAt?.toISOString() ?? null,
                identity: current ? served(current) : null,
                inFamily: row.inFamily,
            };
        }),
    };
}

/*
 * The seats a group has when billing has written none: the instance default,
 * or with billing on, the organizer alone until a plan pays for more.
 */
function seatLimitDefault() {
    return billingEnabled() ? UNPAID_GROUP_SEATS : groupsEnv.GROUP_SEAT_LIMIT_DEFAULT;
}

/* An admission that billing could not give a place to: 402 `seats`, with why. */
function seatRefusal(result: Exclude<SeatResult, { status: 'ok' }>) {
    if (result.status === 'unavailable') return unavailable();
    const messages: Record<Exclude<SeatResult['status'], 'ok' | 'unavailable'>, string> = {
        'no-plan': 'Choose a family plan before letting anyone in.',
        payer: 'The family is full. Ask the person who pays for it to add a place.',
        cap: 'The family has as many members as its plan allows.',
        canceling: 'The family plan is set to end. Resume it before letting anyone in.',
        declined:
            'Your bank declined the charge for another place. Nothing was charged and nobody was let in.',
        confirm:
            'Your bank wants you to confirm the charge for another place. Confirm it in the billing portal, then let them in again.',
        payment: 'The payment for another place did not go through. Nobody was let in.',
        busy: 'Another change to this plan is in progress. Try again in a moment.',
        changed:
            'The charge went through but the plan changed at the same time. Refresh to see your places.',
    };
    return new GroupError('seats', messages[result.status], 402, {
        reason: result.status,
        ...(result.status === 'confirm' ? { url: result.url } : {}),
        ...(result.status === 'cap' ? { limit: result.max } : {}),
    });
}

/*
 * Route 17: the admitting roster, the newcomer's grants and, with `members`,
 * their seal. With billing on, the place is paid for after every check and
 * before the write: Polar's 200 or no admission (a 402 there changed nothing).
 */
export async function admit(
    userId: string,
    groupId: string,
    targetId: string,
    call: RosterCall & { keySeal?: SealWire },
) {
    /*
     * One family per account, before the chain is checked and before a place is paid for;
     * asked only once the caller is known to manage this family, so nobody else learns
     * whether someone is in a family. The repository asks again under the lock.
     */
    await membershipOf(groupId, userId, 'members');
    if (await groupsRepository.waitingButInFamily(groupId, targetId)) throw newcomerInFamily();
    return writeChain(
        groupId,
        userId,
        { ...call, seals: call.keySeal ? [call.keySeal, ...(call.seals ?? [])] : call.seals },
        { kind: 'admit', userId: targetId, seatLimitDefault: seatLimitDefault() },
        {
            admitIdentity: targetId,
            beforeAppend: async () => {
                // Again after the chain checks, right before the charge: what remains is the
                // Polar call itself, which an admission elsewhere can still overtake.
                if (await groupsRepository.waitingButInFamily(groupId, targetId))
                    throw newcomerInFamily();
                if (!billingEnabled()) return;
                const seat = await ensureGroupSeat(groupId, userId);
                if (seat.status !== 'ok') throw seatRefusal(seat);
            },
        },
    );
}

/* Route 18: a member's roles; taking `members` carries the succession, seals and rotations. */
export async function patchMember(
    userId: string,
    groupId: string,
    targetId: string,
    call: RosterCall & { keySeal?: SealWire },
) {
    return writeChain(
        groupId,
        userId,
        { ...call, seals: call.keySeal ? [call.keySeal, ...(call.seals ?? [])] : call.seals },
        { kind: 'member', userId: targetId },
    );
}

/*
 * Route 19: a removal, with everything it makes due in one call: the
 * succession when the roster drops a holder, and in a family a rotation of
 * every area with the new keys' grants to those who remain.
 */
export async function removeMember(
    userId: string,
    groupId: string,
    targetId: string,
    call: RosterCall,
) {
    // The payer of a live plan stays until they cancel it: their card would go on being charged.
    if (await paysForGroup(groupId, targetId))
        throw new GroupError(
            'payer',
            'They pay for this family’s plan. They can cancel it in Billing on the family’s page; then you can remove them.',
            409,
        );
    return writeChain(groupId, userId, call, { kind: 'remove', userId: targetId });
}

const youPay = () =>
    new GroupError(
        'payer',
        'You pay for this family’s plan. Cancel it in Billing on the family’s page before you leave; the family keeps it until the end of the period.',
        409,
    );

/*
 * Route 20: leaving at once. The payer of the family's live plan is refused,
 * even when someone else holds `billing` and even as its last member, which
 * would dissolve it: their card would go on being charged for a family they
 * are not in. They hand billing over or cancel the plan first.
 */
export async function leave(userId: string, groupId: string) {
    if (await paysForGroup(groupId, userId)) throw youPay();
    const result = await groupsRepository.leaveGroup(groupId, userId);
    switch (result.status) {
        case 'left':
            return { state: 'left' as const };
        case 'dissolved':
            return { state: 'left' as const, dissolved: true };
        case 'not-member':
            throw notMember();
        case 'organizer':
            throw new GroupError(
                'organizer',
                'Hand the group’s billing to another member before you leave.',
                409,
            );
        // The last member of a family whose plan is still paid for: leaving would dissolve it.
        case 'billed':
            throw youPay();
        case 'last-holder':
            throw new GroupError(
                'last-holder',
                'Let another member manage the group before you leave.',
                409,
            );
        case 'unavailable':
            throw unavailable();
    }
}

/* How long a hold lasts unless its target is removed or departs first. */
const HOLD_MINUTES = 15;

/*
 * Route 27: a holder pauses a member's Drive writes in the group's areas
 * ahead of removing them, so the removal's rotation cannot be overtaken.
 */
export async function hold(userId: string, groupId: string, targetId: string) {
    await membershipOf(groupId, userId, 'members');
    const result = await groupsRepository.placeHold({
        groupId,
        holderUserId: userId,
        userId: targetId,
        minutes: HOLD_MINUTES,
    });
    switch (result.status) {
        case 'placed':
            return { heldUntil: result.expiresAt.toISOString() };
        case 'held':
            throw new GroupError(
                'held',
                'Another manager has paused your changes in this group for now.',
                409,
            );
        case 'not-member':
            throw notMember();
        case 'forbidden':
            throw forbidden();
        case 'members-changed':
            throw new GroupError('members-changed', REFUSED, 409, { reason: result.reason });
        case 'invalid':
            throw invalid(result.reason);
        case 'unavailable':
            throw unavailable();
    }
}

/* Route 26: turning down someone who accepted but was not admitted. */
export async function declinePending(userId: string, groupId: string, targetId: string) {
    const result = await groupsRepository.declinePending({
        groupId,
        holderUserId: userId,
        userId: targetId,
    });
    switch (result.status) {
        case 'declined':
            return { declined: true as const };
        case 'not-member':
            throw notMember();
        case 'forbidden':
            throw forbidden();
        case 'not-pending':
            throw new GroupError('not-pending', 'This person is not waiting to join.', 409);
        case 'unavailable':
            throw unavailable();
    }
}

/* Route 21: a new area, its roster row at version 1, its root, and grants of its key. */
export async function createArea(
    userId: string,
    groupId: string,
    call: RosterCall & { area: AreaWire },
) {
    if (!madeFor('workspace', groupId, call.area.workspaceId, call.area.idSeed))
        throw invalid('area-id');
    if (!madeFor('node', call.area.workspaceId, call.area.root.id, call.area.root.idSeed))
        throw invalid('area-root-id');
    return writeChain(
        groupId,
        userId,
        call,
        { kind: 'area', area: areaInput(call.area, groupsEnv.GROUP_AREA_LIMIT) },
        // After every check of the call, before anything is written: a plan, where plans are sold.
        {
            newArea: { workspaceId: call.area.workspaceId },
            beforeAppend: () => requirePlan(groupId),
        },
    );
}

/*
 * Deleting a family folder (docs/groups-design.md 2.10): a roster whose only
 * area row is the folder's tombstone, signed by a `members` holder like every
 * roster, and nothing else in the call. The repository marks the area deleted
 * in the same transaction; its files stay for Drive's trash retention, then
 * the purge job takes them.
 */
export async function deleteArea(
    userId: string,
    groupId: string,
    workspaceId: string,
    call: RosterCall,
) {
    if (
        (call.rotations?.length ?? 0) > 0 ||
        (call.grants?.length ?? 0) > 0 ||
        (call.seals?.length ?? 0) > 0 ||
        call.succession
    )
        throw invalid('area-delete');
    return writeChain(
        groupId,
        userId,
        call,
        { kind: 'retire', workspaceId },
        { retireArea: workspaceId },
    );
}

/* Route 22: grants of an area's key, from any active member. */
export async function postGrants(
    userId: string,
    groupId: string,
    workspaceId: string,
    input: { grants: GrantWire[] },
) {
    if (input.grants.some((grant) => grant.workspaceId !== workspaceId))
        throw invalid('grant-area');
    // A grant is someone handing a member the key: never to oneself, so the table keeps that meaning.
    if (input.grants.some((grant) => grant.granteeUserId === userId)) throw invalid('self-grant');
    return storeOutsideChain(userId, groupId, { grants: input.grants }, 'active');
}

/* Route 23: the caller's own wrap of an area key, at its current version. */
export async function putSelfGrant(
    userId: string,
    groupId: string,
    workspaceId: string,
    input: { grant: SelfGrantWire },
) {
    const result = await groupsRepository.putSelfGrant({
        groupId,
        workspaceId,
        userId,
        grant: selfGrantInput(input.grant, workspaceId),
    });
    switch (result.status) {
        case 'ok':
            return { ok: true as const };
        case 'not-member':
            throw notMember();
        case 'area':
            throw invalid('area');
        case 'no-grant':
            throw new GroupError('forbidden', 'You have not been given this area’s key yet.', 403);
        case 'stale':
            throw new GroupError(
                'area-moved',
                'This shared folder’s key changed. Reload and try again.',
                409,
            );
        case 'unavailable':
            throw unavailable();
    }
}

/*
 * Route 28: a holder replaces the area root's previous envelope (the old root
 * key under the current area key) while the roster's Drive rotation still
 * runs, when the one the rotation stored does not open.
 */
export async function putPreviousRoot(
    userId: string,
    groupId: string,
    workspaceId: string,
    input: { rotationId: string; previousRootKeyEnvelope: string },
) {
    const result = await groupsRepository.replacePreviousRoot({
        groupId,
        workspaceId,
        userId,
        rotationId: input.rotationId,
        envelope: bytes(input.previousRootKeyEnvelope, 72, 'rotation-root-previous'),
    });
    switch (result.status) {
        case 'ok':
            return { changeSeq: result.changeSeq };
        case 'not-member':
            throw notMember();
        case 'forbidden':
            throw forbidden();
        case 'held':
            throw new GroupError(
                'held',
                'Another manager has paused your changes in this group for now.',
                409,
            );
        case 'area':
            throw invalid('area');
        case 'not-rotating':
            throw new GroupError(
                'not-rotating',
                'This shared folder’s key change has finished or moved on. Reload and try again.',
                409,
            );
        case 'unavailable':
            throw unavailable();
    }
}

/*
 * Route 29: an area's root as a roster rotation re-keys it (route 24, or the
 * rotations a family removal carries), in the shape of Drive's rotation work:
 * the node, its versions, its live shares with their grantees' identities and
 * its live links, leaving out what a departed member granted, as the walk
 * does. Only `members` holders rotate, so only they read it, and only while
 * they hold the area's current key (a grant at it from a granter still active,
 * or their own wrap of it): without it they could not open the root to re-key
 * it. A hold does not stop a roster's rotation, so it does not stop this read.
 */
export async function areaRoot(userId: string, groupId: string, workspaceId: string) {
    await membershipOf(groupId, userId, 'members');
    const result = await groupsRepository.areaRootWork({ groupId, workspaceId, userId });
    switch (result.status) {
        case 'ok':
            return rotationWorkView(result.root);
        // An area of another group, or none; or (never expected) an area whose root is missing,
        // which no rotation could re-key either. The caller is a holder here, so not `not-member`.
        case 'area':
            throw invalid('area');
        // As route 23 answers a member with no grant: a holder waits for one (route 22) or its
        // own wrap of the current key, then reads again.
        case 'no-key':
            throw new GroupError('forbidden', 'You have not been given this area’s key yet.', 403);
    }
}

/* Route 24: an area's key rotation, listed on a roster, with the root re-keyed in the same call. */
export async function rotateArea(
    userId: string,
    groupId: string,
    workspaceId: string,
    call: RosterCall & { rotation: RotationWire },
) {
    if (call.rotation.workspaceId !== workspaceId) throw invalid('rotation-area');
    return writeChain(
        groupId,
        userId,
        { ...call, rotations: [call.rotation, ...(call.rotations ?? [])] },
        { kind: 'rotation' },
    );
}

/*
 * Route 25's group half: every group the account is active in, with its
 * areas: their seeds, key versions and change sequences, their roots (the
 * node as Drive serves it, whose previous envelope during a rotation is the
 * old root key under the current area key), the Drive rotation running in
 * each, and the account's newest grant and self-grant to each. What
 * /drive/workspace gives for the personal space, so a client opens an area
 * the same way.
 */
export async function spaces(userId: string) {
    return (await groupsRepository.spacesFor(userId)).map((space) => ({
        space: { kind: 'group' as const, groupId: space.groupId, name: space.name },
        areas: space.areas.map((area) => ({
            workspaceId: area.workspaceId,
            idSeed: area.idSeed,
            workspaceKeyVersion: area.workspaceKeyVersion,
            changeSeq: area.changeSeq,
            root: area.root ? nodeView(area.root) : null,
            rotation: area.rotation
                ? {
                      id: area.rotation.id,
                      nodeId: area.rotation.nodeId,
                      targetEpoch: area.rotation.targetEpoch,
                  }
                : null,
            grant: area.grant
                ? {
                      workspaceKeyVersion: area.grant.workspaceKeyVersion,
                      granteeKeyVersion: area.grant.granteeKeyVersion,
                      granterUserId: area.grant.granterUserId,
                      rosterVersion: area.grant.rosterVersion,
                      rosterDigest: b64(area.grant.rosterDigest),
                      envelope: b64(area.grant.envelope),
                  }
                : null,
            selfGrant: area.selfGrant
                ? {
                      version: 1 as const,
                      workspaceId: area.workspaceId,
                      keyVersion: area.selfGrant.keyVersion,
                      workspaceKeyVersion: area.selfGrant.workspaceKeyVersion,
                      wrappingSalt: b64(area.selfGrant.wrappingSalt),
                      wrappingNonce: b64(area.selfGrant.wrappingNonce),
                      encryptedKey: b64(area.selfGrant.encryptedKey),
                  }
                : null,
        })),
    }));
}

/* Whether groups are served at all: GROUPS_ENABLED. */
export function groupsEnabled() {
    return groupsEnv.GROUPS_ENABLED;
}

/* The head statement's size and the group's area count, for the wrapper's per-group body cap. */
export async function rosterBodyContext(
    userId: string,
    groupId: string,
): Promise<
    | { status: 'not-member' | 'not-holder' }
    | { status: 'ok'; headStatementBytes: number; areas: number }
> {
    const found = await groupsRepository.getGroupFor(groupId, userId);
    // A stranger or a former member: the wipe answer. Anyone else in the group is only refused.
    if (!found) return { status: 'not-member' };
    if (found.membership.state !== 'active' || !found.membership.roles.includes('members'))
        return { status: 'not-holder' };
    const head = await groupsRepository.getRoster(groupId, found.group.rosterVersion);
    return {
        status: 'ok',
        headStatementBytes: head?.statement.length ?? 0,
        areas: (await groupsRepository.listAreas(groupId)).length,
    };
}
