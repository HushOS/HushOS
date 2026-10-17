import { createHash, randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { and, eq, isNull } from 'drizzle-orm';
import {
    AREA_GRANT_BYTES,
    GROUP_KEY_SEAL_BYTES,
    areaGrantStatement,
    groupKeySealStatement,
    rosterDigest,
    signRoster,
    type GroupRole,
    type Roster,
    type RosterArea,
    type RosterMember,
    type SignedGroupStatement,
} from '@hushos/crypto/groups';
import { signHybrid } from '@hushos/crypto/signatures';
import { driveRepository, groupsRepository, scopedId } from '@hushos/db';
// The group core's test kit and area commitments: test-only, not package exports.
import { areaKeyCommitment } from '../../crypto/src/area-keys';
import {
    groupIdFor,
    history,
    person,
    type History,
    type Person,
} from '../../crypto/src/group-testkit';
import { db } from '../../db/src/client';
import {
    accountIdentities,
    accountIdentityHistory,
    driveNodes,
    workspaceDocuments,
} from '../../db/src/schema';
import { metadataRekeyedStatement, metadataStatement } from '../../db/src/signatures';
import { createTestAccount, storeTestIdentity } from '../../db/test/helpers';
import type {
    GrantWire,
    RosterCall,
    RotationDocumentWire,
    RotationWire,
    SealWire,
    SelfGrantWire,
    SignedStatementWire,
} from '../src/api';
import * as groups from '../src/server';

/*
 * Groups as the server's tests need them: stored accounts with real identities
 * (the core's test kit `person` bound to each account), a group history signed
 * as clients sign it (the kit's `history`, for a group id derived under its
 * creator), and the seals, grants, roots and rotations a client would send.
 * A seal or grant here carries a real signature over its statement and random
 * sealed bytes: the server checks the signature, never what is sealed.
 */

export const ORGANIZER: GroupRole[] = ['billing', 'guardian', 'members'];
/* The client address the invitation routes' buckets are keyed by. */
export const ADDRESS = '203.0.113.7';
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export type Member = Awaited<ReturnType<typeof createTestAccount>> & { who: Person };
let people = 10;
/* An account with a real identity at key version 1. */
export async function member(): Promise<Member> {
    const account = await createTestAccount();
    const who = await person(people++, 1, { userId: account.userId });
    await storeTestIdentity(account.userId, who.served);
    return { ...account, who };
}

/* The member's next identity: the current one moves to history, the new one becomes current. */
export async function succeedIdentity(m: Member) {
    const old = m.who;
    const next = await person(old.n, old.keyVersion + 1, { userId: m.userId });
    const [current] = await db
        .select()
        .from(accountIdentities)
        .where(eq(accountIdentities.userId, m.userId));
    const { userId: _userId, ...row } = current!;
    await db.insert(accountIdentityHistory).values({
        ...row,
        userId: m.userId,
        replacedByKeyVersion: next.keyVersion,
        newEncryptionPublicKey: Buffer.from(next.served.encryptionPublicKey, 'base64url'),
        newSigningPublicKey: Buffer.from(next.served.signingPublicKey, 'base64url'),
        newKemPublicKey: Buffer.from(next.served.kemPublicKey, 'base64url'),
        newMlDsaPublicKey: Buffer.from(next.served.mlDsaPublicKey, 'base64url'),
        successionSignature: randomBytes(3373),
    });
    await db.delete(accountIdentities).where(eq(accountIdentities.userId, m.userId));
    await storeTestIdentity(m.userId, next.served);
    m.who = next;
    return next;
}

export function wire(signed: SignedGroupStatement): SignedStatementWire {
    return {
        statement: b64(signed.statement),
        signature: { ed25519: b64(signed.signature.ed25519), mlDsa: b64(signed.signature.mlDsa) },
        signerSignature: b64(signed.signerSignature),
    };
}

export async function sealWire(
    groupId: string,
    by: Person,
    holder: Person,
    at: { rosterVersion: number; rosterDigest: string },
    groupKeyVersion: number,
): Promise<SealWire> {
    const ctx = {
        groupId,
        groupKeyVersion,
        holderUserId: holder.userId,
        holderKeyVersion: holder.keyVersion,
        sealerUserId: by.userId,
        ...at,
    };
    const sealed = randomBytes(GROUP_KEY_SEAL_BYTES - 3373);
    const signature = await signHybrid(await groupKeySealStatement(ctx, sealed), by.signer);
    return {
        groupKeyVersion,
        holderUserId: holder.userId,
        holderKeyVersion: holder.keyVersion,
        ...at,
        envelope: b64(Buffer.concat([sealed, signature])),
    };
}

export async function grantWire(
    groupId: string,
    workspaceId: string,
    workspaceKeyVersion: number,
    by: Person,
    grantee: Person,
    at: { rosterVersion: number; rosterDigest: string },
): Promise<GrantWire> {
    const ctx = {
        groupId,
        workspaceId,
        workspaceKeyVersion,
        granteeUserId: grantee.userId,
        granteeKeyVersion: grantee.keyVersion,
        granterUserId: by.userId,
        ...at,
    };
    const sealed = randomBytes(AREA_GRANT_BYTES - 3373);
    const signature = await signHybrid(await areaGrantStatement(ctx, sealed), by.signer);
    return {
        workspaceId,
        workspaceKeyVersion,
        granteeUserId: grantee.userId,
        granteeKeyVersion: grantee.keyVersion,
        ...at,
        envelope: b64(Buffer.concat([sealed, signature])),
    };
}

export function selfGrant(workspaceId: string, workspaceKeyVersion = 1): SelfGrantWire {
    return {
        version: 1,
        workspaceId,
        keyVersion: 1,
        workspaceKeyVersion,
        wrappingSalt: b64(randomBytes(32)),
        wrappingNonce: b64(randomBytes(24)),
        encryptedKey: b64(randomBytes(48)),
    };
}

/* Ed25519 over a node's metadata statement, with the identity's own signing key. */
async function signMetadata(
    by: Person,
    workspaceId: string,
    nodeId: string,
    metadataVersion: number,
    metadataEnvelope: Buffer,
) {
    await sodium.ready;
    return b64(
        sodium.crypto_sign_detached(
            metadataStatement({
                workspaceId,
                nodeId,
                kind: 'folder',
                metadataVersion,
                metadataEnvelope,
            }),
            by.signer.signingKey,
        ),
    );
}

/* The rekeyed statement over `origin` (as the server will copy it), signed by `by`. */
async function rekeyMetadata(
    by: Person,
    fields: Parameters<typeof metadataRekeyedStatement>[0],
    origin: { envelope: Buffer; signerId: string; signature: Buffer },
) {
    await sodium.ready;
    const keyEnvelope = randomBytes(72);
    return {
        originKeyEnvelope: b64(keyEnvelope),
        signature: b64(
            sodium.crypto_sign_detached(
                metadataRekeyedStatement(fields, { ...origin, keyEnvelope }),
                by.signer.signingKey,
            ),
        ),
    };
}

export async function rootWire(workspaceId: string, by: Person) {
    const idSeed = b64(randomBytes(16));
    const id = scopedId('node', workspaceId, idSeed)!;
    const metadataEnvelope = randomBytes(24 + 16 + 256);
    return {
        id,
        idSeed,
        keyEpoch: 1,
        parentKeyEpoch: 1,
        keyEnvelope: b64(randomBytes(72)),
        metadataEnvelope: b64(metadataEnvelope),
        metadataSignature: await signMetadata(by, workspaceId, id, 1, metadataEnvelope),
    };
}

/* A rotation of an area from `fromVersion`: a target epoch drawn first, the root re-keyed under it. */
/* A sealed workspace document's bytes as a client pads them: one 1 KiB step of plaintext. */
export const documentEnvelope = () => b64(randomBytes(24 + 1024 + 16));

/* Every workspace document the area holds, sealed again at the version stored, as a rotator would. */
export async function resealedDocuments(workspaceId: string): Promise<RotationDocumentWire[]> {
    const stored = await db
        .select({ kind: workspaceDocuments.kind, version: workspaceDocuments.version })
        .from(workspaceDocuments)
        .where(eq(workspaceDocuments.workspaceId, workspaceId));
    return stored.map((row) => ({ ...row, envelope: documentEnvelope() }));
}

export async function rotationWire(
    workspaceId: string,
    by: Person,
    fromVersion: number,
): Promise<RotationWire> {
    const range = await driveRepository.allocateKeyEpochs(workspaceId, 1);
    const [root] = await db
        .select()
        .from(driveNodes)
        .where(and(eq(driveNodes.workspaceId, workspaceId), isNull(driveNodes.parentId)));
    const metadataEnvelope = randomBytes(24 + 16 + 256);
    return {
        workspaceId,
        fromVersion,
        toVersion: fromVersion + 1,
        targetEpoch: range!.from,
        root: {
            id: root!.id,
            changeSeq: root!.changeSeq!,
            parentKeyEpoch: fromVersion + 1,
            keyEnvelope: b64(randomBytes(72)),
            rotated: {
                metadataEnvelope: b64(metadataEnvelope),
                // A family folder's rotation keeps the writer's record: re-keyed, never re-signed.
                metadataRekey: await rekeyMetadata(
                    by,
                    {
                        workspaceId,
                        nodeId: root!.id,
                        kind: 'folder',
                        metadataVersion: root!.metadataVersion,
                        metadataEnvelope,
                        keyEpoch: range!.from,
                    },
                    {
                        envelope: root!.metadataOriginEnvelope ?? root!.metadataEnvelope!,
                        signerId: root!.metadataOriginSignerId ?? root!.metadataSignerId!,
                        signature: root!.metadataOriginSignature ?? root!.metadataSignature!,
                    },
                ),
                versions: [],
                shares: [],
                links: [],
                unsealableLinks: [],
            },
        },
        previousRootKeyEnvelope: b64(randomBytes(72)),
        selfGrant: selfGrant(workspaceId, fromVersion + 1),
        documents: await resealedDocuments(workspaceId),
    };
}

/*
 * The keys the kit gives a group's areas and their roots, one per area and
 * version: the server refuses a commitment another group listed (design 2.10),
 * so groups in one test never share one (the core's testkit keys are per
 * workspace id only when it is its AREA).
 */
export function kitAreaKey(workspaceId: string, version: number) {
    return new Uint8Array(createHash('sha256').update(`area:${workspaceId}:${version}`).digest());
}
export function kitRootKey(workspaceId: string, version: number) {
    return new Uint8Array(createHash('sha256').update(`root:${workspaceId}:${version}`).digest());
}

export type Family = Awaited<ReturnType<typeof family>>;

/*
 * A family created through the domain: its creator holding every family
 * role, its first area at version 1 with a root, the creator's seal and
 * grant. `h` is its history as the creator's client signs it.
 */
export async function family(creator?: Member) {
    const organizer = creator ?? (await member());
    const idSeed = b64(randomBytes(16));
    const groupId = await groupIdFor(organizer.userId, idSeed);
    const areaSeed = b64(randomBytes(16));
    const areaId = scopedId('workspace', groupId, areaSeed)!;
    const areas: RosterArea[] = [
        {
            workspaceId: areaId,
            workspaceKeyVersion: 1,
            commitment: await areaKeyCommitment(kitAreaKey(areaId, 1)),
        },
    ];
    const h = await history('family', {
        groupId,
        areas,
        areaKey: kitAreaKey,
        rootKey: kitRootKey,
    });
    const first = await h.roster(organizer.who, [organizer.who.entry(ORGANIZER)]);
    const at = { rosterVersion: 1, rosterDigest: await rosterDigest(first.statement) };
    const body = {
        id: groupId,
        idSeed,
        kind: 'family' as const,
        name: 'The Family',
        groupKey: h.keys[0]!.publicKey,
        roster: wire(first),
        keySeal: {
            envelope: (await sealWire(groupId, organizer.who, organizer.who, at, 1)).envelope,
        },
        area: {
            workspaceId: areaId,
            idSeed: areaSeed,
            root: await rootWire(areaId, organizer.who),
            selfGrant: selfGrant(areaId),
            grant: {
                envelope: (await grantWire(groupId, areaId, 1, organizer.who, organizer.who, at))
                    .envelope,
            },
        },
    };
    const created = await groups.createGroup(organizer.userId, body);
    return { organizer, groupId, areaId, h, body, created };
}

/* The group's head as stored: the revision a writer names, and where the next roster goes. */
export async function head(groupId: string) {
    const row = await groupsRepository.getGroupRow(groupId);
    return {
        revision: row!.chainRevision,
        rosterVersion: row!.rosterVersion,
        rosterDigest: b64(row!.rosterDigest),
        groupKeyVersion: row!.groupKeyVersion,
    };
}

/* The last roster's entries, to build the next from. */
export function entries(h: History): RosterMember[] {
    return h.statements.at(-1)!.members.map((entry) => ({ ...entry }));
}
export function withEntry(h: History, entry: RosterMember) {
    return [...entries(h).filter((e) => e.userId !== entry.userId), entry];
}

/* The next roster signed by `by`, and the call that uploads it. */
export async function nextRoster(
    fam: Family,
    by: Member,
    members: RosterMember[],
    options: { keyVersion?: number; areas?: RosterArea[] } = {},
) {
    const { revision } = await head(fam.groupId);
    const signed = await fam.h.roster(by.who, members, options.keyVersion, options.areas);
    const at = {
        rosterVersion: fam.h.statements.length,
        rosterDigest: await rosterDigest(signed.statement),
    };
    const call: RosterCall = { expectedRevision: revision, roster: wire(signed) };
    return { signed, at, call };
}

/*
 * A roster signed outside the kit's rules (a forged previous digest, a wrong
 * entry version, a planted key): the last roster changed by `change`, signed
 * with the group key at `keyVersion`. Not added to the history.
 */
export async function forgedRoster(
    fam: Family,
    by: Member,
    change: (roster: Roster) => Roster,
    keyVersion = fam.h.keys.length,
) {
    const last = fam.h.statements.at(-1)!;
    const roster = change({
        ...structuredClone(last),
        rosterVersion: last.rosterVersion + 1,
        previousRosterDigest: await rosterDigest(fam.h.rosters.at(-1)!.statement),
        signerUserId: by.userId,
        groupKeyVersion: keyVersion,
        areas: [],
    });
    return signRoster(roster, fam.h.keys[keyVersion - 1]!, by.who.signer);
}

/* An invitation accepted by `m`, with the invitation's roles. */
export async function accepted(fam: Family, m: Member, roles: GroupRole[] = []) {
    const token = randomBytes(32).toString('base64url');
    const created = await groupsRepository.createInvitation({
        groupId: fam.groupId,
        email: m.email,
        normalizedEmail: m.email,
        tokenHash: createHash('sha256').update(token).digest(),
        roles,
        invitedBy: fam.organizer.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
    });
    if (created.status !== 'created') throw new Error(created.status);
    await groups.acceptInvitation(m.userId, token, ADDRESS);
    return token;
}

/* Admits `m` (accepted first) with `roles`: the roster, their area grant, and with `members` their seal. */
export async function admitted(fam: Family, m: Member, roles: GroupRole[] = []) {
    await accepted(fam, m, roles);
    const { at, call } = await nextRoster(fam, fam.organizer, [
        ...entries(fam.h),
        m.who.entry(roles),
    ]);
    const { groupKeyVersion } = await head(fam.groupId);
    return groups.admit(fam.organizer.userId, fam.groupId, m.userId, {
        ...call,
        grants: [await grantWire(fam.groupId, fam.areaId, 1, fam.organizer.who, m.who, at)],
        keySeal: roles.includes('members')
            ? await sealWire(fam.groupId, fam.organizer.who, m.who, at, groupKeyVersion)
            : undefined,
    });
}

/* The area's current key version and roster commitment for its next version. */
export async function nextAreaRow(workspaceId: string, version: number): Promise<RosterArea> {
    return {
        workspaceId,
        workspaceKeyVersion: version,
        commitment: await areaKeyCommitment(kitAreaKey(workspaceId, version)),
    };
}
