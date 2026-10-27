import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { rosterDigest } from '@hushos/crypto/groups';
import {
    DOCUMENT_ENVELOPE_MAX_BYTES,
    WORKSPACE_DOCUMENT_BYTES,
    WORKSPACE_DOCUMENT_KINDS,
} from '@hushos/drive/protocol';
import {
    authRepository,
    driveRepository,
    groupsRepository,
    rotationsRepository,
    scopedId,
} from '@hushos/db';
import { areaKeyCommitment, areaRootCommitment } from '../../crypto/src/area-keys';
import { acceptStoredChain, storedRecord } from '@hushos/crypto/group-trust/server';
import {
    history,
    mlDsaKeysOf,
    person,
    tombstoneAt,
    type Person,
} from '../../crypto/src/group-testkit';
import { db } from '../../db/src/client';
import {
    accountKeys,
    accountIdentityHistory,
    areaGrants,
    driveLinks,
    driveNodes,
    driveRotations,
    driveShares,
    groupChainCaches,
    groupHolds,
    groupKeySuccessions,
    groupMemberships,
    groupRosters,
    personalWorkspaces,
    users,
    workspaceStorage,
    workspaceDocuments,
    workspaceKeys,
    workspaces,
} from '../../db/src/schema';
import {
    closeDatabase,
    insertLegacyLink,
    insertLegacyShare,
    resetDatabase,
    storeTestIdentity,
} from '../../db/test/helpers';
import {
    ADDRESS,
    ORGANIZER,
    accepted,
    b64,
    admitted,
    documentEnvelope,
    entries,
    family,
    familyBody,
    forgedRoster,
    grantWire,
    head,
    kitAreaKey,
    lockWaiters,
    member,
    nextAreaRow,
    nextRoster,
    resealedDocuments,
    rootWire,
    rotationWire,
    sealWire,
    selfGrant,
    succeedIdentity,
    wire,
    withEntry,
    type Family,
    type Member,
} from '../test/kit';
import * as driveServer from '@hushos/drive/server';
import * as groups from './server';
import type * as DriveProtocol from '@hushos/drive/protocol';
import type { GroupRole } from '@hushos/crypto/groups';
import type { SignedStatementWire } from './api';

/*
 * As if clients had shipped more document kinds than `tags`: a rotation must
 * carry every kind an area holds, so these tests use several. The server's own
 * list is tested in @hushos/drive (server.document-kinds.test.ts).
 */
vi.mock('@hushos/drive/protocol', async (original) => ({
    ...(await original<typeof DriveProtocol>()),
    DOCUMENT_KINDS: ['tags', 'pins', 'views', 'notes'],
}));

/*
 * The group domain with the real crypto core and a real database: every
 * roster, succession, seal and grant is checked as devices check it before it
 * is stored (F3), the route's policy holds, and a refusal leaves nothing
 * behind, after which the correct statement still lands.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

type Refusal = {
    code: string;
    status: number;
    data?: { reason?: string } & Record<string, unknown>;
};
async function refusal(promise: Promise<unknown>): Promise<Refusal> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof groups.GroupError)
            return { code: error.code, status: error.status, data: error.data as Refusal['data'] };
        throw error;
    }
    throw new Error('Expected a refusal.');
}
const rosterCount = async (groupId: string) =>
    (await db.select().from(groupRosters).where(eq(groupRosters.groupId, groupId))).length;

/* A family with a second `members` holder admitted. */
async function withHolder() {
    const fam = await family();
    const holder = await member();
    await admitted(fam, holder, ['members']);
    return { fam, holder };
}

/*
 * The roster that marks `leaving` left in a family: every area rotated (the
 * kit adds the rows), with the rotation, the new key's grant, and the
 * succession and seals when asked. Built once (the kit's history moves on
 * with it); `send` uploads it on a route, with any part left out, so a
 * refused call can be resent as the same bytes.
 */
async function markLeftCall(fam: Family, leaving: Member, options: { succession?: boolean } = {}) {
    const before = entries(fam.h).find((entry) => entry.userId === leaving.userId)!;
    const { at, call } = await nextRoster(
        fam,
        fam.organizer,
        withEntry(fam.h, { ...before, status: 'left' }),
    );
    const rotation = await rotationWire(fam.areaId, fam.organizer.who, 1);
    const succession = options.succession
        ? wire(await fam.h.succession(fam.organizer.who))
        : undefined;
    const seals = options.succession
        ? [await sealWire(fam.groupId, fam.organizer.who, fam.organizer.who, at, fam.h.keys.length)]
        : undefined;
    const body = {
        ...call,
        succession,
        seals,
        rotations: [rotation],
        grants: [
            await grantWire(fam.groupId, fam.areaId, 2, fam.organizer.who, fam.organizer.who, at),
        ],
    };
    return {
        send: (
            route: 'roster' | 'remove',
            without: Partial<Record<keyof typeof body, true>> = {},
        ) => {
            const sent = { ...body };
            for (const key of Object.keys(without) as (keyof typeof body)[]) delete sent[key];
            return route === 'remove'
                ? groups.removeMember(fam.organizer.userId, fam.groupId, leaving.userId, sent)
                : groups.postRoster(fam.organizer.userId, fam.groupId, sent);
        },
    };
}
async function markLeft(
    fam: Family,
    leaving: Member,
    route: 'roster' | 'remove',
    options: { succession?: boolean } = {},
) {
    return (await markLeftCall(fam, leaving, options)).send(route);
}

describe('creating a family', () => {
    test('stores the first roster, the creator, the area with its root, and answers a resend as a replay', async () => {
        const fam = await family();
        expect(fam.created.group).toMatchObject({ id: fam.groupId, rosterVersion: 1, revision: 1 });
        expect(fam.created.replayed).toBe(false);
        const [area] = await db.select().from(workspaces).where(eq(workspaces.id, fam.areaId));
        expect(area).toMatchObject({ ownerKind: 'group', groupId: fam.groupId, keyEpochSeq: 1 });
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        expect(root).toMatchObject({
            keyEpoch: 1,
            parentKeyEpoch: 1,
            metadataSignerId: fam.organizer.userId,
        });
        expect((await groups.createGroup(fam.organizer.userId, fam.body)).replayed).toBe(true);
        expect(
            await refusal(groups.createGroup(fam.organizer.userId, { ...fam.body, kind: 'org' })),
        ).toMatchObject({ code: 'unsupported', status: 409 });
    });

    test('an area not derived under the group, or a seal not signed by the creator, stores nothing', async () => {
        const organizer = await member();
        const fam = await family(organizer);
        const other = await member();
        const second = await family(other);
        // The other family's area, offered as this one's.
        const borrowed = { ...second.body, area: { ...second.body.area, workspaceId: fam.areaId } };
        expect(await refusal(groups.createGroup(other.userId, borrowed))).toMatchObject({
            code: 'invalid',
        });
        const stranger = await member();
        const forged = {
            ...second.body,
            keySeal: await sealWire(
                second.groupId,
                stranger.who,
                other.who,
                { rosterVersion: 1, rosterDigest: Buffer.alloc(32, 9).toString('base64url') },
                1,
            ),
        };
        expect((await refusal(groups.createGroup(other.userId, forged))).code).toBe('invalid');
        expect(await rosterCount(second.groupId)).toBe(1);
    });
});

describe('a resent creation (F7)', () => {
    test("lands, and its identical resend is a replay after the creator replaced their identity and spent the day's creations", async () => {
        const fam = await family();
        await succeedIdentity(fam.organizer);
        const bucket = createHash('sha256')
            .update(`groups:create:user:${fam.organizer.userId}`)
            .digest();
        for (let i = 0; i < 4; i += 1) await authRepository.consumeRateLimit(bucket, 5, 86_400_000);
        const resent = await groups.createGroup(fam.organizer.userId, fam.body);
        expect(resent).toMatchObject({
            replayed: true,
            group: { id: fam.groupId, rosterVersion: 1, revision: 1 },
        });
        expect(await rosterCount(fam.groupId)).toBe(1);
    });

    test('the same call with its keys in another order, or an undefined field, is still a replay', async () => {
        const fam = await family();
        await succeedIdentity(fam.organizer);
        const reversed = <T extends object>(value: T) =>
            Object.fromEntries(Object.entries(value).reverse()) as T;
        const reordered = {
            ...fam.body,
            area: { ...fam.body.area, root: reversed(fam.body.area.root) },
        };
        expect(Object.keys(reordered.area.root)).not.toEqual(Object.keys(fam.body.area.root));
        expect((await groups.createGroup(fam.organizer.userId, reordered)).replayed).toBe(true);
        const withUndefined = { ...fam.body, area: { ...fam.body.area, extra: undefined } };
        expect((await groups.createGroup(fam.organizer.userId, withUndefined)).replayed).toBe(true);
        expect(await rosterCount(fam.groupId)).toBe(1);
    });

    test('a different first roster for a stored id is refused and changes nothing', async () => {
        const fam = await family();
        const stored = (await groupsRepository.getRoster(fam.groupId, 1))!.digest;
        const who = await succeedIdentity(fam.organizer);
        // The same id and seed, a first roster signed by the creator's new identity.
        const alt = await history('family', {
            groupId: fam.groupId,
            areas: fam.h.statements[0]!.areas,
        });
        const first = await alt.roster(who, [who.entry(ORGANIZER)]);
        const at = { rosterVersion: 1, rosterDigest: await rosterDigest(first.statement) };
        const body = {
            ...fam.body,
            roster: wire(first),
            keySeal: { envelope: (await sealWire(fam.groupId, who, who, at, 1)).envelope },
            area: {
                ...fam.body.area,
                grant: {
                    envelope: (await grantWire(fam.groupId, fam.areaId, 1, who, who, at)).envelope,
                },
            },
        };
        expect(await refusal(groups.createGroup(fam.organizer.userId, body))).toMatchObject({
            code: 'exists',
            status: 409,
        });
        expect(await rosterCount(fam.groupId)).toBe(1);
        expect((await groupsRepository.getRoster(fam.groupId, 1))!.digest.equals(stored)).toBe(
            true,
        );
    });

    test('the same bytes from anyone but the creator are refused, a member of the group included', async () => {
        const fam = await family();
        const holder = await member();
        await admitted(fam, holder, ['members']);
        const stranger = await member();
        for (const other of [holder, stranger])
            expect(await refusal(groups.createGroup(other.userId, fam.body))).toMatchObject({
                code: 'invalid',
                status: 400,
            });
    });
});

describe('every roster is checked as devices check it', () => {
    test('a forged previous digest, a wrong entry version or a dropped entry is refused, and the correct roster still lands', async () => {
        const { fam, holder } = await withHolder();
        const { revision } = await head(fam.groupId);
        const upload = async (signed: Awaited<ReturnType<typeof forgedRoster>>) =>
            refusal(
                groups.postRoster(fam.organizer.userId, fam.groupId, {
                    expectedRevision: revision,
                    roster: wire(signed),
                }),
            );
        expect(
            await upload(
                await forgedRoster(fam, fam.organizer, (r) => ({
                    ...r,
                    previousRosterDigest: Buffer.alloc(32, 7).toString('base64url'),
                })),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'roster-chain' } });
        expect(
            await upload(
                await forgedRoster(fam, fam.organizer, (r) => ({
                    ...r,
                    members: r.members.map((m) =>
                        m.userId === holder.userId ? { ...m, sinceVersion: r.rosterVersion } : m,
                    ),
                })),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'roster-chain' } });
        expect(
            await upload(
                await forgedRoster(fam, fam.organizer, (r) => ({
                    ...r,
                    members: r.members.filter((m) => m.userId !== holder.userId),
                })),
            ),
        ).toMatchObject({ code: 'invalid' });
        expect(await rosterCount(fam.groupId)).toBe(2);
        const { call } = await nextRoster(fam, fam.organizer, entries(fam.h));
        expect(await groups.postRoster(fam.organizer.userId, fam.groupId, call)).toMatchObject({
            version: 3,
        });
    });

    test('an entry naming keys its member never had is refused; so is one moved back to an older identity', async () => {
        const { fam, holder } = await withHolder();
        const stranger = await member();
        const planted = {
            ...stranger.who.entry(['members']),
            userId: holder.userId,
        };
        const { revision } = await head(fam.groupId);
        expect(
            await refusal(
                groups.postRoster(fam.organizer.userId, fam.groupId, {
                    expectedRevision: revision,
                    roster: wire(
                        await forgedRoster(fam, fam.organizer, (r) => ({
                            ...r,
                            members: r.members.map((m) =>
                                m.userId === holder.userId
                                    ? { ...planted, sinceVersion: r.rosterVersion }
                                    : m,
                            ),
                        })),
                    ),
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'roster-chain' } });
        // The holder's identity moves on; a fold-in to it lands.
        const older = holder.who;
        await succeedIdentity(holder);
        const foldIn = await nextRoster(
            fam,
            fam.organizer,
            withEntry(fam.h, holder.who.entry(['members'])),
        );
        await groups.postRoster(fam.organizer.userId, fam.groupId, foldIn.call);
        // Moving the entry back to the identity it replaced is refused, though the member had it.
        const back = await head(fam.groupId);
        expect(
            await refusal(
                groups.postRoster(fam.organizer.userId, fam.groupId, {
                    expectedRevision: back.revision,
                    roster: wire(
                        await forgedRoster(fam, fam.organizer, (r) => ({
                            ...r,
                            members: r.members.map((m) =>
                                m.userId === holder.userId
                                    ? { ...older.entry(['members']), sinceVersion: r.rosterVersion }
                                    : m,
                            ),
                        })),
                    ),
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'rollback' } });
    });

    test('only a members holder uploads, and only what they signed', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        const { call } = await nextRoster(fam, plain, entries(fam.h));
        expect(await refusal(groups.postRoster(plain.userId, fam.groupId, call))).toMatchObject({
            code: 'forbidden',
            status: 403,
        });
        // The organizer uploading what someone else signed.
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, call)),
        ).toMatchObject({ code: 'forbidden' });
    });

    test('a roster under a group key a succession replaced is refused', async () => {
        const fam = await family();
        const { revision, rosterVersion, rosterDigest: digest } = await head(fam.groupId);
        const succession = await fam.h.succession(fam.organizer.who);
        await groups.postSuccession(fam.organizer.userId, fam.groupId, {
            expectedRevision: revision,
            succession: wire(succession),
            seals: [
                await sealWire(
                    fam.groupId,
                    fam.organizer.who,
                    fam.organizer.who,
                    { rosterVersion, rosterDigest: digest },
                    2,
                ),
            ],
        });
        const after = await head(fam.groupId);
        expect(after).toMatchObject({ groupKeyVersion: 2, revision: 2 });
        expect(
            await refusal(
                groups.postRoster(fam.organizer.userId, fam.groupId, {
                    expectedRevision: after.revision,
                    roster: wire(await forgedRoster(fam, fam.organizer, (r) => r, 1)),
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'roster-chain' } });
    });

    test('a succession tied before the latest roster is refused, and seals must cover every holder', async () => {
        const { fam, holder } = await withHolder();
        // Tied to roster 1, though roster 2 is already signed under key 1.
        const stale = await head(fam.groupId);
        const early = await groups
            .postSuccession(fam.organizer.userId, fam.groupId, {
                expectedRevision: stale.revision,
                succession: wire(
                    await (async () => {
                        const h = fam.h;
                        const saved = h.rosters.pop()!;
                        const signed = await h.succession(fam.organizer.who);
                        h.rosters.push(saved);
                        h.successions.pop();
                        h.keys.pop();
                        return signed;
                    })(),
                ),
                seals: [],
            })
            .catch((error: unknown) => error);
        expect(early).toBeInstanceOf(groups.GroupError);
        expect((early as groups.GroupError).code).toBe('invalid');
        const at = { rosterVersion: stale.rosterVersion, rosterDigest: stale.rosterDigest };
        const succession = wire(await fam.h.succession(fam.organizer.who));
        // One holder's seal missing.
        expect(
            await refusal(
                groups.postSuccession(fam.organizer.userId, fam.groupId, {
                    expectedRevision: stale.revision,
                    succession,
                    seals: [
                        await sealWire(fam.groupId, fam.organizer.who, fam.organizer.who, at, 2),
                    ],
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'succession-seals' } });
        expect(
            await groups.postSuccession(fam.organizer.userId, fam.groupId, {
                expectedRevision: stale.revision,
                succession,
                seals: [
                    await sealWire(fam.groupId, fam.organizer.who, fam.organizer.who, at, 2),
                    await sealWire(fam.groupId, fam.organizer.who, holder.who, at, 2),
                ],
            }),
        ).toMatchObject({ groupKeyVersion: 2 });
    });
});

describe('the route policy and departures', () => {
    test('a plain roster cannot add a member, an admission cannot change anyone else, a removal names its target', async () => {
        const { fam, holder } = await withHolder();
        const outsider = await member();
        await accepted(fam, outsider);
        const adding = await nextRoster(fam, fam.organizer, [
            ...entries(fam.h),
            outsider.who.entry([]),
        ]);
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, adding.call)),
        ).toMatchObject({ code: 'members-changed', data: { reason: 'entry-not-member' } });
        fam.h.rosters.pop();
        fam.h.statements.pop();
        // An admission that also takes the holder's role away.
        const grabbing = await nextRoster(fam, fam.organizer, [
            ...withEntry(fam.h, {
                ...entries(fam.h).find((e) => e.userId === holder.userId)!,
                roles: [],
            }),
            outsider.who.entry([]),
        ]);
        expect(
            await refusal(
                groups.admit(fam.organizer.userId, fam.groupId, outsider.userId, grabbing.call),
            ),
        ).toMatchObject({ code: 'invalid' });
        fam.h.rosters.pop();
        fam.h.statements.pop();
        // An admission that changes the organizer's roles too (no holder dropped): the server's own rule.
        const regranting = await nextRoster(fam, fam.organizer, [
            ...withEntry(fam.h, { ...fam.organizer.who.entry(['billing', 'members']) }),
            outsider.who.entry([]),
        ]);
        expect(
            await refusal(
                groups.admit(fam.organizer.userId, fam.groupId, outsider.userId, {
                    ...regranting.call,
                    grants: [
                        await grantWire(
                            fam.groupId,
                            fam.areaId,
                            1,
                            fam.organizer.who,
                            outsider.who,
                            regranting.at,
                        ),
                    ],
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'role-change' } });
        expect(await rosterCount(fam.groupId)).toBe(2);
    });

    test('a holder leaving blocks every roster until one marks them left, with the rotation and the succession in that roster', async () => {
        const { fam, holder } = await withHolder();
        expect(await groups.leave(holder.userId, fam.groupId)).toEqual({ state: 'left' });
        const unrelated = await nextRoster(fam, fam.organizer, entries(fam.h));
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, unrelated.call)),
        ).toMatchObject({ code: 'left-due', data: { userIds: [holder.userId] } });
        fam.h.rosters.pop();
        fam.h.statements.pop();
        // The family rule: marking someone left rotates every area, in this same roster.
        const marking = await markLeftCall(fam, holder, { succession: true });
        expect(await refusal(marking.send('roster', { rotations: true }))).toMatchObject({
            code: 'invalid',
            data: { reason: 'area-rows' },
        });
        // A holder marked left takes the succession with them, on this route too.
        expect(
            await refusal(marking.send('roster', { succession: true, seals: true })),
        ).toMatchObject({ code: 'invalid', data: { reason: 'succession-required' } });
        // The same bytes, with everything this time.
        const marked = await marking.send('roster');
        expect(marked).toMatchObject({ version: 3, groupKeyVersion: 2 });
        const [area] = await db.select().from(workspaces).where(eq(workspaces.id, fam.areaId));
        expect(area).toMatchObject({ workspaceKeyVersion: 2, rotationDueAt: null });
        const [rotation] = await db
            .select()
            .from(driveRotations)
            .where(eq(driveRotations.workspaceId, fam.areaId));
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        // The root re-keyed at the rotation's target, under the new workspace key.
        expect(root).toMatchObject({ keyEpoch: rotation!.targetEpoch, parentKeyEpoch: 2 });
        const due = await groups.getGroup(fam.organizer.userId, fam.groupId);
        expect(due).toMatchObject({ due: { succession: false, markLeft: [] } });
        const next = await nextRoster(fam, fam.organizer, entries(fam.h));
        expect(await groups.postRoster(fam.organizer.userId, fam.groupId, next.call)).toMatchObject(
            { version: 4 },
        );
    });

    test('removing a holder carries the succession, the rotation and the grants in one call', async () => {
        const { fam, holder } = await withHolder();
        const removal = await markLeftCall(fam, holder, { succession: true });
        expect(
            await refusal(removal.send('remove', { succession: true, seals: true })),
        ).toMatchObject({ code: 'invalid', data: { reason: 'succession-required' } });
        const removed = await removal.send('remove');
        expect(removed).toMatchObject({ version: 3, groupKeyVersion: 2 });
        expect(await driveRepository.isMember(holder.userId, fam.areaId)).toBe(false);
        expect(await refusal(groups.getGroup(holder.userId, fam.groupId))).toMatchObject({
            code: 'not-member',
            status: 404,
        });
    });

    test("a deleted account's departure is marked left with no identity left to serve", async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        await groups.leave(plain.userId, fam.groupId);
        await db.delete(users).where(eq(users.id, plain.userId));
        expect(await markLeft(fam, plain, 'roster')).toMatchObject({ version: 3 });
        expect(await groupsRepository.listDepartures(fam.groupId)).toEqual([]);
    });
});

describe('seals and grants', () => {
    test('a seal naming a roster off the chain, to a non-holder, or not signed by the uploader is refused', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        const at = await head(fam.groupId);
        const position = { rosterVersion: at.rosterVersion, rosterDigest: at.rosterDigest };
        const put = async (seal: Awaited<ReturnType<typeof sealWire>>) =>
            refusal(groups.putKeySeals(fam.organizer.userId, fam.groupId, { seals: [seal] }));
        expect(
            await put(
                await sealWire(
                    fam.groupId,
                    fam.organizer.who,
                    fam.organizer.who,
                    { ...position, rosterDigest: Buffer.alloc(32, 1).toString('base64url') },
                    1,
                ),
            ),
        ).toMatchObject({ data: { reason: 'seal-roster' } });
        expect(
            await put(await sealWire(fam.groupId, fam.organizer.who, plain.who, position, 1)),
        ).toMatchObject({ code: 'members-changed', data: { reason: 'seal-holder' } });
        const flipped = await sealWire(
            fam.groupId,
            fam.organizer.who,
            fam.organizer.who,
            position,
            1,
        );
        const bytes = Buffer.from(flipped.envelope, 'base64url');
        bytes[bytes.length - 1]! ^= 1;
        expect(await put({ ...flipped, envelope: bytes.toString('base64url') })).toMatchObject({
            data: { reason: 'seal-signature' },
        });
        expect(
            await groups.putKeySeals(fam.organizer.userId, fam.groupId, {
                seals: [
                    await sealWire(fam.groupId, fam.organizer.who, fam.organizer.who, position, 1),
                ],
            }),
        ).toEqual({ stored: 1 });
    });

    test('a grant of a version the chain never listed, or to someone who left, is refused', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        const at = await head(fam.groupId);
        const position = { rosterVersion: at.rosterVersion, rosterDigest: at.rosterDigest };
        expect(
            await refusal(
                groups.postGrants(plain.userId, fam.groupId, fam.areaId, {
                    grants: [
                        await grantWire(
                            fam.groupId,
                            fam.areaId,
                            2,
                            plain.who,
                            fam.organizer.who,
                            position,
                        ),
                    ],
                }),
            ),
        ).toMatchObject({ data: { reason: 'grant-area-version' } });
        await groups.leave(plain.userId, fam.groupId);
        expect(
            await refusal(
                groups.postGrants(fam.organizer.userId, fam.groupId, fam.areaId, {
                    grants: [
                        await grantWire(
                            fam.groupId,
                            fam.areaId,
                            1,
                            fam.organizer.who,
                            plain.who,
                            position,
                        ),
                    ],
                }),
            ),
        ).toMatchObject({ code: 'members-changed' });
    });
});

describe('invitations', () => {
    test('an invitation is mailed, listed, opened without the chain, accepted only by its address, and spent once', async () => {
        const fam = await family();
        const invitee = await member();
        const sent = await groups.invite(fam.organizer.userId, fam.groupId, {
            email: invitee.email,
            roles: ['guardian'],
        });
        const listed = await groups.listInvitations(fam.organizer.userId, fam.groupId);
        expect(listed.invitations).toMatchObject([
            { id: sent.id, email: invitee.email, roles: ['guardian'] },
        ]);
        expect(
            await refusal(
                groups.invite(fam.organizer.userId, fam.groupId, {
                    email: invitee.email,
                    roles: [],
                }),
            ),
        ).toMatchObject({ code: 'exists', status: 409 });
        await groups.revokeInvitation(fam.organizer.userId, fam.groupId, sent.id);
        expect(
            await refusal(groups.revokeInvitation(fam.organizer.userId, fam.groupId, sent.id)),
        ).toMatchObject({
            code: 'gone',
            status: 410,
        });
        const other = await member();
        await accepted(fam, other);
        // An invitation whose token the test holds (the mailed one never leaves the server).
        const secret = randomBytes(32).toString('base64url');
        await groupsRepository.createInvitation({
            groupId: fam.groupId,
            email: invitee.email,
            normalizedEmail: invitee.email,
            tokenHash: createHash('sha256').update(secret).digest(),
            roles: [],
            invitedBy: fam.organizer.userId,
            expiresAt: new Date(Date.now() + 86_400_000),
        });
        const opened = await groups.openInvitation(invitee.userId, secret, ADDRESS);
        expect(opened).toMatchObject({ groupId: fam.groupId, name: 'The Family', roles: [] });
        expect(Object.keys(opened)).not.toContain('rosters');
        expect(Object.keys(opened)).not.toContain('firstKeys');
        const stranger = await member();
        expect(
            await refusal(groups.acceptInvitation(stranger.userId, secret, ADDRESS)),
        ).toMatchObject({
            code: 'email-mismatch',
            status: 403,
        });
        expect(await groups.acceptInvitation(invitee.userId, secret, ADDRESS)).toEqual({
            groupId: fam.groupId,
            state: 'accepted',
        });
        expect(
            await refusal(groups.acceptInvitation(invitee.userId, secret, ADDRESS)),
        ).toMatchObject({
            code: 'gone',
        });
        const pending = await groups.listPending(fam.organizer.userId, fam.groupId);
        expect(pending.pending.map((p) => p.userId).sort()).toEqual(
            [invitee.userId, other.userId].sort(),
        );
        expect(
            pending.pending.find((p) => p.userId === invitee.userId)?.identity?.signingPublicKey,
        ).toBe(invitee.who.served.signingPublicKey);
    });
});

describe('one family per account (families-shared-pool 3.2)', () => {
    /* An invitation to `fam` for `m` whose token the test holds. */
    async function invitation(fam: Family, m: Member) {
        const token = randomBytes(32).toString('base64url');
        await groupsRepository.createInvitation({
            groupId: fam.groupId,
            email: m.email,
            normalizedEmail: m.email,
            tokenHash: createHash('sha256').update(token).digest(),
            roles: [],
            invitedBy: fam.organizer.userId,
            expiresAt: new Date(Date.now() + 86_400_000),
        });
        return token;
    }

    test('a second family is refused before its statements are read, naming the first to its member', async () => {
        const maya = await member();
        const first = await family(maya);
        const second = await member();
        const theirs = await family(second);
        // Statements no device would sign: refused for the family, never reaching the checks.
        const garbled = {
            ...theirs.body,
            id: randomUUID(),
            roster: { ...theirs.body.roster, statement: 'AA' },
        };
        expect(await refusal(groups.createGroup(maya.userId, garbled))).toEqual({
            code: 'in-family',
            status: 409,
            data: { reason: 'self', family: { groupId: first.groupId, name: 'The Family' } },
        });
        expect((await groupsRepository.listGroupsFor(maya.userId)).map((g) => g.id)).toEqual([
            first.groupId,
        ]);
    });

    test('someone waiting to join a family can’t create another: they’d be refused once let in', async () => {
        const ortega = await family();
        await groupsRepository.renameGroup(ortega.groupId, 'Ortega family');
        const sam = await member();
        await accepted(ortega, sam);
        const { body } = await familyBody(sam);
        const refused = await groups.createGroup(sam.userId, body).then(
            () => null,
            (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(groups.GroupError);
        expect(refused).toMatchObject({
            code: 'in-family',
            status: 409,
            message:
                'You’re joining Ortega family already. Decline that invitation first, then you can create your own.',
            data: { reason: 'waiting', family: { groupId: ortega.groupId, name: 'Ortega family' } },
        });
        expect((await groupsRepository.listGroupsFor(sam.userId)).map((g) => g.id)).toEqual([
            ortega.groupId,
        ]);
        // Once they withdraw from it, they may make their own.
        await groups.leave(sam.userId, ortega.groupId);
        await expect(groups.createGroup(sam.userId, body)).resolves.toMatchObject({
            group: { id: body.id },
        });
    });

    test('waiting to join is refused before the creation’s statements are read', async () => {
        const ortega = await family();
        await groupsRepository.renameGroup(ortega.groupId, 'Ortega family');
        const sam = await member();
        await accepted(ortega, sam);
        const { body } = await familyBody(sam);
        // Statements no device would sign: refused for the waiting, never reaching the checks.
        const garbled = { ...body, roster: { ...body.roster, statement: 'AA' } };
        expect(await refusal(groups.createGroup(sam.userId, garbled))).toEqual({
            code: 'in-family',
            status: 409,
            data: { reason: 'waiting', family: { groupId: ortega.groupId, name: 'Ortega family' } },
        });
    });

    test('a family that dissolved while they waited holds nobody back', async () => {
        const ortega = await family();
        const sam = await member();
        await accepted(ortega, sam);
        await groups.leave(ortega.organizer.userId, ortega.groupId);
        const { body } = await familyBody(sam);
        await expect(groups.createGroup(sam.userId, body)).resolves.toMatchObject({
            group: { id: body.id },
        });
    });

    test('opening an invitation says which family you are in; accepting is refused and leaves nothing waiting', async () => {
        const ortega = await family();
        await groupsRepository.renameGroup(ortega.groupId, 'Ortega family');
        const sam = await member();
        const token = await invitation(ortega, sam);
        expect((await groups.openInvitation(sam.userId, token, ADDRESS)).inFamily).toBeNull();
        const lindqvist = await family(sam);
        await groupsRepository.renameGroup(lindqvist.groupId, 'Lindqvist family');
        const yours = { groupId: lindqvist.groupId, name: 'Lindqvist family' };
        expect((await groups.openInvitation(sam.userId, token, ADDRESS)).inFamily).toEqual(yours);
        const refused = await refusal(groups.acceptInvitation(sam.userId, token, ADDRESS));
        expect(refused).toEqual({
            code: 'in-family',
            status: 409,
            data: { reason: 'self', family: yours },
        });
        expect((await groups.listPending(ortega.organizer.userId, ortega.groupId)).pending).toEqual(
            [],
        );
        // Once they leave, the same link still works.
        await groups.leave(sam.userId, lindqvist.groupId);
        expect(await groups.acceptInvitation(sam.userId, token, ADDRESS)).toEqual({
            groupId: ortega.groupId,
            state: 'accepted',
        });
    });

    test('letting in someone who joined another family since accepting is refused before the call is checked, and only to its managers', async () => {
        const ortega = await family();
        const sam = await member();
        await accepted(ortega, sam);
        const waiting = async () =>
            (await groups.listPending(ortega.organizer.userId, ortega.groupId)).pending.map(
                (p) => ({ userId: p.userId, inFamily: p.inFamily }),
            );
        expect(await waiting()).toEqual([{ userId: sam.userId, inFamily: false }]);
        // Waiting, Sam can't make a family, but can accept another and be let in there first.
        await admitted(await family(), sam);
        // The waiting list says so before anyone checks words (never which family).
        expect(await waiting()).toEqual([{ userId: sam.userId, inFamily: true }]);
        const before = await head(ortega.groupId);
        // A call that would fail every check: the family rule answers first.
        const call = {
            expectedRevision: before.revision,
            roster: {
                ...wire(await ortega.h.roster(ortega.organizer.who, entries(ortega.h))),
                statement: 'AA',
            },
        };
        expect(
            await refusal(groups.admit(ortega.organizer.userId, ortega.groupId, sam.userId, call)),
        ).toEqual({ code: 'in-family', status: 409, data: { reason: 'newcomer' } });
        // Someone outside the family can't use the route to learn whether Sam is in one.
        const outsider = await member();
        expect(
            await refusal(groups.admit(outsider.userId, ortega.groupId, sam.userId, call)),
        ).toMatchObject({ code: 'not-member', status: 404 });
        expect(await head(ortega.groupId)).toEqual(before);
        expect(
            (await groupsRepository.membershipsOf(ortega.groupId, [sam.userId])).get(sam.userId)
                ?.state,
        ).toBe('accepted');
    });
});

describe('one family per account under races', () => {
    test('a family made while its creator is let in elsewhere: the index refuses it, and the answer names the family that won', async () => {
        const ortega = await family();
        await groupsRepository.renameGroup(ortega.groupId, 'Ortega family');
        const sam = await member();
        const built = await familyBody(sam);
        /*
         * Sam's creation passes every check, its one-family checks included, then waits on its
         * area commitment, which this session has written and not committed. Meanwhile Sam
         * accepts Ortega family's invitation and is let in; then the commitment is let go, and
         * the creation's membership meets the index. (Waiting to join before creating is
         * refused up front: see 'one family per account'.)
         */
        const blocker = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        let creating: Promise<unknown> | undefined;
        try {
            await blocker.query('begin');
            await blocker.query(
                'insert into group_area_commitments (commitment, group_id, roster_version) values ($1, $2, 1)',
                [
                    Buffer.from(await areaKeyCommitment(kitAreaKey(built.areaId, 1)), 'base64url'),
                    randomUUID(),
                ],
            );
            creating = refusal(groups.createGroup(sam.userId, built.body));
            expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
            await accepted(ortega, sam);
            const { at, call } = await nextRoster(ortega, ortega.organizer, [
                ...entries(ortega.h),
                sam.who.entry([]),
            ]);
            await groups.admit(ortega.organizer.userId, ortega.groupId, sam.userId, {
                ...call,
                grants: [
                    await grantWire(
                        ortega.groupId,
                        ortega.areaId,
                        1,
                        ortega.organizer.who,
                        sam.who,
                        at,
                    ),
                ],
            });
        } finally {
            await blocker.query('rollback');
            await blocker.end();
        }
        expect(await creating).toEqual({
            code: 'in-family',
            status: 409,
            data: { reason: 'self', family: { groupId: ortega.groupId, name: 'Ortega family' } },
        });
        expect(await groupsRepository.getGroupRow(built.groupId)).toBeNull();
        expect((await groupsRepository.familyOf(sam.userId))?.groupId).toBe(ortega.groupId);
    });
});

describe('waiting to join, under races', () => {
    test('a family made as its creator accepts an invitation: the repository, under their lock, refuses it', async () => {
        const ortega = await family();
        await groupsRepository.renameGroup(ortega.groupId, 'Ortega family');
        const sam = await member();
        const built = await familyBody(sam);
        /*
         * The route's early check finds Sam waiting for nothing; the creation then queues on
         * Sam's own row, which this session holds while it writes Sam's acceptance of Ortega
         * family (as accepting does) and commits. The repository's check, under that lock, is
         * the one left to see it.
         */
        const blocker = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        let creating: Promise<unknown> | undefined;
        try {
            await blocker.query('begin');
            await blocker.query('select id from users where id = $1 for update', [sam.userId]);
            creating = groups.createGroup(sam.userId, built.body).then(
                () => null,
                (error: unknown) => error,
            );
            expect(await lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
            await blocker.query(
                `insert into group_memberships (group_id, group_kind, user_id, state, roles, accepted_at)
                 values ($1, 'family', $2, 'accepted', '{}', now())`,
                [ortega.groupId, sam.userId],
            );
            await blocker.query('commit');
        } finally {
            await blocker.end();
        }
        expect(await creating).toMatchObject({
            code: 'in-family',
            status: 409,
            data: { reason: 'waiting', family: { groupId: ortega.groupId, name: 'Ortega family' } },
        });
        expect(await groupsRepository.getGroupRow(built.groupId)).toBeNull();
    });
});

describe('who reads what', () => {
    test('strangers and former members get the same not-member; an accepted newcomer reads the chain and is refused the seal, never told they are out', async () => {
        const fam = await family();
        const stranger = await member();
        const former = await member();
        await admitted(fam, former);
        await groups.leave(former.userId, fam.groupId);
        for (const who of [stranger, former])
            expect(await refusal(groups.getGroup(who.userId, fam.groupId))).toMatchObject({
                code: 'not-member',
                status: 404,
            });
        const newcomer = await member();
        await accepted(fam, newcomer);
        const chain = await groups.getRosters(newcomer.userId, fam.groupId, {});
        expect(chain.rosters.map((r) => r.version)).toEqual([1, 2]);
        expect(Object.keys(chain.signerKeys)).toHaveLength(1);
        expect(chain.firstKeys).toEqual(fam.body.groupKey);
        expect(await refusal(groups.getKeySeal(newcomer.userId, fam.groupId))).toMatchObject({
            code: 'forbidden',
            status: 403,
        });
        // Every entry on the head roster: the former member's is still there (not yet marked
        // left); the newcomer, accepted but not admitted, has none.
        const opened = await groups.getIdentities(fam.organizer.userId, fam.groupId, null);
        expect(opened.identities.map((i) => i.userId).sort()).toEqual(
            [fam.organizer.userId, former.userId].sort(),
        );
    });

    test('route 3 names only the members a caller may know, with addresses for active members only', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        const former = await member();
        await admitted(fam, former);
        await groups.leave(former.userId, fam.groupId);
        const waiting = await member();
        await accepted(fam, waiting);
        const rows = async (who: Member) =>
            (await groups.getGroup(who.userId, fam.groupId)).members
                .map((m) => [m.userId, m.state, m.email] as const)
                .sort((a, b) => a[0].localeCompare(b[0]));
        const sorted = (list: (readonly [string, string, string | null])[]) =>
            [...list].sort((a, b) => a[0].localeCompare(b[0]));
        // Who manages the family sees everyone, but an address only beside an active member.
        expect(await rows(fam.organizer)).toEqual(
            sorted([
                [fam.organizer.userId, 'active', fam.organizer.email],
                [plain.userId, 'active', plain.email],
                [former.userId, 'left', null],
                [waiting.userId, 'accepted', null],
            ]),
        );
        // A member who doesn't manage it: never who left.
        expect(await rows(plain)).toEqual(
            sorted([
                [fam.organizer.userId, 'active', fam.organizer.email],
                [plain.userId, 'active', plain.email],
                [waiting.userId, 'accepted', null],
            ]),
        );
        // Someone who only accepted: who manages the family, and nobody else.
        expect(await rows(waiting)).toEqual([
            [fam.organizer.userId, 'active', fam.organizer.email],
        ]);
    });

    test('spaces list the group area with the account’s grant and self-grant', async () => {
        const fam = await family();
        const [space] = await groups.spaces(fam.organizer.userId);
        expect(space).toMatchObject({
            space: { kind: 'group', groupId: fam.groupId, name: 'The Family' },
            areas: [{ workspaceId: fam.areaId, workspaceKeyVersion: 1 }],
        });
        expect(space!.areas[0]!.grant?.workspaceKeyVersion).toBe(1);
        expect(space!.areas[0]!.selfGrant?.workspaceKeyVersion).toBe(1);
    });
});

describe('races, replays and the stored chain', () => {
    test('two admissions at the same version: one lands, the other is stale with the winner, and resending the winner is a replay', async () => {
        const fam = await family();
        const a = await member();
        const b = await member();
        await accepted(fam, a);
        await accepted(fam, b);
        const base = entries(fam.h);
        const { revision } = await head(fam.groupId);
        const rosterA = await fam.h.roster(fam.organizer.who, [...base, a.who.entry([])]);
        fam.h.rosters.pop();
        fam.h.statements.pop();
        const rosterB = await fam.h.roster(fam.organizer.who, [...base, b.who.entry([])]);
        const atOf = async (signed: typeof rosterA) => ({
            rosterVersion: 2,
            rosterDigest: await rosterDigest(signed.statement),
        });
        const callA = {
            expectedRevision: revision,
            roster: wire(rosterA),
            grants: [
                await grantWire(
                    fam.groupId,
                    fam.areaId,
                    1,
                    fam.organizer.who,
                    a.who,
                    await atOf(rosterA),
                ),
            ],
        };
        const callB = {
            expectedRevision: revision,
            roster: wire(rosterB),
            grants: [
                await grantWire(
                    fam.groupId,
                    fam.areaId,
                    1,
                    fam.organizer.who,
                    b.who,
                    await atOf(rosterB),
                ),
            ],
        };
        const results = await Promise.allSettled([
            groups.admit(fam.organizer.userId, fam.groupId, a.userId, callA),
            groups.admit(fam.organizer.userId, fam.groupId, b.userId, callB),
        ]);
        const won = results.findIndex((r) => r.status === 'fulfilled');
        const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(won).toBeGreaterThanOrEqual(0);
        expect((lost.reason as groups.GroupError).code).toBe('stale');
        const winner = won === 0 ? rosterA : rosterB;
        expect((lost.reason as groups.GroupError).data).toMatchObject({
            roster: { version: 2, digest: await rosterDigest(winner.statement) },
        });
        const resent = await groups.admit(
            fam.organizer.userId,
            fam.groupId,
            won === 0 ? a.userId : b.userId,
            won === 0 ? callA : callB,
        );
        expect(resent).toMatchObject({ replayed: true, version: 2 });
    });

    test('a missing record is rebuilt from the stored history, a deleted signer’s rosters included', async () => {
        const { fam, holder } = await withHolder();
        // The holder signs a roster, then their account goes, identities and all.
        const byHolder = await nextRoster(fam, holder, entries(fam.h));
        await groups.postRoster(holder.userId, fam.groupId, byHolder.call);
        await groups.leave(holder.userId, fam.groupId).catch(() => undefined);
        await db.delete(users).where(eq(users.id, holder.userId));
        await db.delete(groupChainCaches).where(eq(groupChainCaches.groupId, fam.groupId));
        // Their departure is marked (rotating the area), checked against a chain rebuilt from version 1.
        const marked = await markLeft(fam, holder, 'roster', { succession: true });
        expect(marked).toMatchObject({ version: 4 });
        const [record] = await db
            .select()
            .from(groupChainCaches)
            .where(eq(groupChainCaches.groupId, fam.groupId));
        expect(record!.chainRevision).toBe(marked.revision);
    });

    test('a stored history that is tampered with, missing a roster, or cut short is 503: no write is checked against it', async () => {
        const fam = await family();
        const { organizer } = fam;
        for (const _ of [2, 3])
            await groups.postRoster(
                organizer.userId,
                fam.groupId,
                (await nextRoster(fam, organizer, entries(fam.h))).call,
            );
        // Signed once and resent unchanged after each repair, as a client retries a 503.
        const next = await nextRoster(fam, organizer, entries(fam.h));
        const at = (version: number) =>
            and(eq(groupRosters.groupId, fam.groupId), eq(groupRosters.version, version));
        const rowAt = async (version: number) =>
            (await db.select().from(groupRosters).where(at(version)))[0]!;
        const send = async () => {
            // No record: the server rebuilds from its rows.
            await db.delete(groupChainCaches).where(eq(groupChainCaches.groupId, fam.groupId));
            return refusal(groups.postRoster(organizer.userId, fam.groupId, next.call));
        };
        const [two, three] = [await rowAt(2), await rowAt(3)];

        // Roster 2's bytes edited (the organizer loses a role), its signatures kept.
        const text = two.statement.toString('utf8');
        expect(text).toContain('"billing","guardian","members"');
        await db
            .update(groupRosters)
            .set({ statement: Buffer.from(text.replace('"billing","guardian",', '"billing",')) })
            .where(at(2));
        expect(await send()).toMatchObject({ code: 'unavailable', status: 503 });
        await db.update(groupRosters).set({ statement: two.statement }).where(at(2));
        // Roster 2 missing.
        await db.delete(groupRosters).where(at(2));
        expect(await send()).toMatchObject({ code: 'unavailable', status: 503 });
        await db.insert(groupRosters).values(two);
        // The newest roster missing: what is left verifies as a chain at version 2, which
        // must not stand in for the head at 3 (nor be kept as the record).
        await db.delete(groupRosters).where(at(3));
        expect(await send()).toMatchObject({ code: 'unavailable', status: 503 });
        expect(
            await db
                .select()
                .from(groupChainCaches)
                .where(eq(groupChainCaches.groupId, fam.groupId)),
        ).toEqual([]);
        await db.insert(groupRosters).values(three);
        expect(await rosterCount(fam.groupId)).toBe(3);
        // Whole again, the same call lands.
        await db.delete(groupChainCaches).where(eq(groupChainCaches.groupId, fam.groupId));
        expect(await groups.postRoster(organizer.userId, fam.groupId, next.call)).toMatchObject({
            version: 4,
        });
    });

    test('a record stored short of the head, or of another roster at its version, is rebuilt on the next read, not trusted', async () => {
        const fam = await family();
        const { organizer } = fam;
        await groups.postRoster(
            organizer.userId,
            fam.groupId,
            (await nextRoster(fam, organizer, entries(fam.h))).call,
        );
        // A validly signed roster 3 the group never stored: the organizer drops a role.
        const fork = await forgedRoster(fam, organizer, (roster) => ({
            ...roster,
            members: roster.members.map((entry) =>
                entry.userId === organizer.userId
                    ? { ...entry, roles: ['billing', 'members'], sinceVersion: 3 }
                    : entry,
            ),
        }));
        await groups.postRoster(
            organizer.userId,
            fam.groupId,
            (await nextRoster(fam, organizer, entries(fam.h))).call,
        );
        const stored = (rosters: typeof fam.h.rosters) =>
            acceptStoredChain({
                groupId: fam.groupId,
                firstKeys: fam.h.keys[0]!.publicKey,
                rosters,
                successions: [],
                mlDsaKeys: mlDsaKeysOf(organizer.who),
                cache: null,
            });
        const records = {
            // What the old rebuild stored when the newest row was missing: a chain at 2.
            short: storedRecord(await stored(fam.h.rosters.slice(0, 2))),
            // A chain at 3 through the roster the group never stored.
            forked: storedRecord(await stored([...fam.h.rosters.slice(0, 2), fork])),
        };
        for (const [label, record] of Object.entries(records)) {
            const { revision } = await head(fam.groupId);
            expect(await groupsRepository.putChainCache(fam.groupId, revision, record)).toBe(true);
            // The next write is checked against the stored history, lands, and its record is the head's.
            const next = await nextRoster(fam, organizer, entries(fam.h));
            expect(
                await groups.postRoster(organizer.userId, fam.groupId, next.call),
                label,
            ).toMatchObject({ version: next.at.rosterVersion });
            const healed = await groupsRepository.getChainCache(fam.groupId);
            expect((healed!.cache as { rosterDigests: string[] }).rosterDigests.at(-1)).toBe(
                next.at.rosterDigest,
            );
        }
    });

    test('a stored head roster swapped for another validly signed one is 503', async () => {
        const fam = await family();
        const { organizer } = fam;
        await groups.postRoster(
            organizer.userId,
            fam.groupId,
            (await nextRoster(fam, organizer, entries(fam.h))).call,
        );
        const fork = await forgedRoster(fam, organizer, (roster) => ({
            ...roster,
            members: roster.members.map((entry) =>
                entry.userId === organizer.userId
                    ? { ...entry, roles: ['billing', 'members'], sinceVersion: 3 }
                    : entry,
            ),
        }));
        await groups.postRoster(
            organizer.userId,
            fam.groupId,
            (await nextRoster(fam, organizer, entries(fam.h))).call,
        );
        const next = await nextRoster(fam, organizer, entries(fam.h));
        const at3 = and(eq(groupRosters.groupId, fam.groupId), eq(groupRosters.version, 3));
        const [real] = await db.select().from(groupRosters).where(at3);
        // Roster 3's row now holds the fork, whole and verifiable, at the same version.
        await db
            .update(groupRosters)
            .set({
                statement: Buffer.from(fork.statement),
                digest: createHash('sha256').update(fork.statement).digest(),
                ed25519Signature: Buffer.from(fork.signature.ed25519),
                mlDsaSignature: Buffer.from(fork.signature.mlDsa),
                signerSignature: Buffer.from(fork.signerSignature),
            })
            .where(at3);
        await db.delete(groupChainCaches).where(eq(groupChainCaches.groupId, fam.groupId));
        expect(
            await refusal(groups.postRoster(organizer.userId, fam.groupId, next.call)),
        ).toMatchObject({ code: 'unavailable', status: 503 });
        await db.update(groupRosters).set(real!).where(at3);
        expect(await groups.postRoster(organizer.userId, fam.groupId, next.call)).toMatchObject({
            version: 4,
        });
    });

    test('a stored history missing its newest succession is 503', async () => {
        const { fam, holder } = await withHolder();
        await groups.leave(holder.userId, fam.groupId);
        // The holder's departure marked with the succession: the head is roster 3 under key 2.
        await markLeft(fam, holder, 'roster', { succession: true });
        expect(await head(fam.groupId)).toMatchObject({ rosterVersion: 3, groupKeyVersion: 2 });
        const next = await nextRoster(fam, fam.organizer, entries(fam.h));
        const newest = and(
            eq(groupKeySuccessions.groupId, fam.groupId),
            eq(groupKeySuccessions.oldVersion, 1),
        );
        const [succession] = await db.select().from(groupKeySuccessions).where(newest);
        // Without it the rows verify as a chain at roster 3 still under key 1.
        await db.delete(groupKeySuccessions).where(newest);
        await db.delete(groupChainCaches).where(eq(groupChainCaches.groupId, fam.groupId));
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, next.call)),
        ).toMatchObject({ code: 'unavailable', status: 503 });
        await db.insert(groupKeySuccessions).values(succession!);
        expect(await groups.postRoster(fam.organizer.userId, fam.groupId, next.call)).toMatchObject(
            { version: 4 },
        );
    });
});

describe('areas', () => {
    test('a new area lands with its row at version 1 and its root; a rotation moves it to the next version', async () => {
        const fam = await family();
        const areaSeed = randomBytes(16).toString('base64url');
        const areaId = scopedId('workspace', fam.groupId, areaSeed)!;
        const key = randomBytes(32);
        const { at, call } = await nextRoster(fam, fam.organizer, entries(fam.h), {
            areas: [
                {
                    workspaceId: areaId,
                    workspaceKeyVersion: 1,
                    commitment: await areaKeyCommitment(key),
                },
            ],
        });
        const created = await groups.createArea(fam.organizer.userId, fam.groupId, {
            ...call,
            area: {
                workspaceId: areaId,
                idSeed: areaSeed,
                root: await rootWire(areaId, fam.organizer.who),
                selfGrant: selfGrant(areaId),
            },
            grants: [
                await grantWire(fam.groupId, areaId, 1, fam.organizer.who, fam.organizer.who, at),
            ],
        });
        expect(created).toMatchObject({ version: 2 });
        // A row for an area the call does not create is refused.
        const ghost = await nextRoster(fam, fam.organizer, entries(fam.h), {
            areas: [
                {
                    workspaceId: scopedId(
                        'workspace',
                        fam.groupId,
                        randomBytes(16).toString('base64url'),
                    )!,
                    workspaceKeyVersion: 1,
                    commitment: await areaKeyCommitment(randomBytes(32)),
                },
            ],
        });
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, ghost.call)),
        ).toMatchObject({ data: { reason: 'area-rows' } });
        fam.h.rosters.pop();
        fam.h.statements.pop();
        const rotation = await rotationWire(areaId, fam.organizer.who, 1);
        const rotated = await nextRoster(fam, fam.organizer, entries(fam.h), {
            areas: [
                {
                    workspaceId: areaId,
                    workspaceKeyVersion: 2,
                    commitment: await areaKeyCommitment(randomBytes(32)),
                },
            ],
        });
        // Without the new key's grant to the members who remain, nobody else could open it.
        expect(
            await refusal(
                groups.rotateArea(fam.organizer.userId, fam.groupId, areaId, {
                    ...rotated.call,
                    rotation,
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'rotation-grants' } });
        expect(
            await groups.rotateArea(fam.organizer.userId, fam.groupId, areaId, {
                ...rotated.call,
                rotation,
                grants: [
                    await grantWire(
                        fam.groupId,
                        areaId,
                        2,
                        fam.organizer.who,
                        fam.organizer.who,
                        rotated.at,
                    ),
                ],
            }),
        ).toMatchObject({ version: 3 });
        const [area] = await db.select().from(workspaces).where(eq(workspaces.id, areaId));
        expect(area!.workspaceKeyVersion).toBe(2);
    });
});

/* The default area rotated from version 1 to 2 by the organizer, with the new key's grants. */
async function rotateDefaultArea(fam: Family, others: Member[] = []) {
    const rotation = await rotationWire(fam.areaId, fam.organizer.who, 1);
    const rotated = await nextRoster(fam, fam.organizer, entries(fam.h), {
        areas: [await nextAreaRow(fam.areaId, 2)],
    });
    const grants = [];
    for (const to of [fam.organizer, ...others])
        grants.push(
            await grantWire(fam.groupId, fam.areaId, 2, fam.organizer.who, to.who, rotated.at),
        );
    return { rotation, rotated, grants };
}

/* A new area's call: its roster row at version 1, its root, and its key granted to the organizer. */
async function areaCall(fam: Family) {
    const areaSeed = randomBytes(16).toString('base64url');
    const areaId = scopedId('workspace', fam.groupId, areaSeed)!;
    const { at, call } = await nextRoster(fam, fam.organizer, entries(fam.h), {
        areas: [
            {
                workspaceId: areaId,
                workspaceKeyVersion: 1,
                commitment: await areaKeyCommitment(randomBytes(32)),
            },
        ],
    });
    return {
        ...call,
        area: {
            workspaceId: areaId,
            idSeed: areaSeed,
            root: await rootWire(areaId, fam.organizer.who),
            selfGrant: selfGrant(areaId),
        },
        grants: [await grantWire(fam.groupId, areaId, 1, fam.organizer.who, fam.organizer.who, at)],
    };
}

describe('the review rules', () => {
    test('a call naming a revision the chain has not reached is stale and stores nothing, whatever it carries', async () => {
        const fam = await family();
        const { call } = await nextRoster(fam, fam.organizer, entries(fam.h));
        const ahead = { ...call, expectedRevision: call.expectedRevision + 1 };
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, ahead)),
        ).toMatchObject({
            code: 'stale',
        });
        expect(await rosterCount(fam.groupId)).toBe(1);
        const { revision, rosterVersion, rosterDigest: digest } = await head(fam.groupId);
        expect(
            await refusal(
                groups.postSuccession(fam.organizer.userId, fam.groupId, {
                    expectedRevision: revision + 1,
                    succession: wire(await fam.h.succession(fam.organizer.who)),
                    seals: [
                        await sealWire(
                            fam.groupId,
                            fam.organizer.who,
                            fam.organizer.who,
                            { rosterVersion, rosterDigest: digest },
                            2,
                        ),
                    ],
                }),
            ),
        ).toMatchObject({ code: 'stale' });
        expect(await head(fam.groupId)).toMatchObject({ revision: 1, groupKeyVersion: 1 });
    });

    test('marking a holder left needs the succession on every route; a route 10 succession seals only holders still in the group', async () => {
        const { fam, holder } = await withHolder();
        // The holder leaves; the head roster still lists them active with `members`.
        await groups.leave(holder.userId, fam.groupId);
        const { revision, rosterVersion, rosterDigest: digest } = await head(fam.groupId);
        const at = { rosterVersion, rosterDigest: digest };
        // A seal to them cannot be stored, so the succession must not require one.
        const replaced = await groups.postSuccession(fam.organizer.userId, fam.groupId, {
            expectedRevision: revision,
            succession: wire(await fam.h.succession(fam.organizer.who)),
            seals: [await sealWire(fam.groupId, fam.organizer.who, fam.organizer.who, at, 2)],
        });
        expect(replaced).toMatchObject({ groupKeyVersion: 2 });
        // Marking them left drops a holder: it carries its own succession, so none is ever left due.
        const marking = await markLeftCall(fam, holder, { succession: true });
        expect(
            await refusal(marking.send('roster', { succession: true, seals: true })),
        ).toMatchObject({
            data: { reason: 'succession-required' },
        });
        expect(await marking.send('roster')).toMatchObject({ groupKeyVersion: 3 });
        expect(await groups.getGroup(fam.organizer.userId, fam.groupId)).toMatchObject({
            due: { succession: false, markLeft: [] },
        });
    });

    test('a removal closes a Drive rotation that re-keyed nothing, rather than wait on it', async () => {
        const { fam, holder } = await withHolder();
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        const running = await rotationsRepository.startRotation({
            workspaceId: fam.areaId,
            nodeId: root!.id,
            startedBy: fam.organizer.userId,
        });
        if (running.status !== 'ok') throw new Error(running.status);
        const removal = await markLeftCall(fam, holder, { succession: true });
        expect(await removal.send('remove')).toMatchObject({ groupKeyVersion: 2 });
        const rows = await db
            .select()
            .from(driveRotations)
            .where(eq(driveRotations.workspaceId, fam.areaId));
        expect(rows.find((row) => row.id === running.rotation.id)?.finishedAt).not.toBeNull();
        expect(rows.filter((row) => row.finishedAt === null)).toHaveLength(1);
        expect(rows.find((row) => row.finishedAt === null)!.targetEpoch).toBeGreaterThan(
            running.rotation.targetEpoch,
        );
    });

    test('an area root re-keyed at the wrong parent epoch, or under an epoch a node already carries, is refused with nothing changed', async () => {
        const fam = await family();
        const { rotated, grants } = await rotateDefaultArea(fam);
        const send = (rotation: Awaited<ReturnType<typeof rotationWire>>) =>
            groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                ...rotated.call,
                rotation,
                grants,
            });
        // A root under the old area key is a malformed rotation: final for those bytes.
        const wrongParent = await rotationWire(fam.areaId, fam.organizer.who, 1);
        wrongParent.root.parentKeyEpoch = 1;
        expect(await refusal(send(wrongParent))).toMatchObject({
            code: 'invalid',
            data: { reason: 'rotation-root' },
        });
        // A root that changed since the rotator read it: re-read and resend.
        const moved = await rotationWire(fam.areaId, fam.organizer.who, 1);
        moved.root.changeSeq -= 1;
        expect(await refusal(send(moved))).toMatchObject({ code: 'root-moved', status: 409 });
        const overtaken = await rotationWire(fam.areaId, fam.organizer.who, 1);
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        // A node written at the drawn epoch since: the root's new key would not be above it.
        await db
            .update(driveNodes)
            .set({ keyEpoch: overtaken.targetEpoch })
            .where(eq(driveNodes.id, root!.id));
        expect(await refusal(send(overtaken))).toMatchObject({ code: 'epoch-stale', status: 409 });
        await db
            .update(driveNodes)
            .set({ keyEpoch: root!.keyEpoch })
            .where(eq(driveNodes.id, root!.id));
        const [area] = await db.select().from(workspaces).where(eq(workspaces.id, fam.areaId));
        expect(area!.workspaceKeyVersion).toBe(1);
        expect(
            await db
                .select()
                .from(driveRotations)
                .where(eq(driveRotations.workspaceId, fam.areaId)),
        ).toEqual([]);
        expect(await send(await rotationWire(fam.areaId, fam.organizer.who, 1))).toMatchObject({
            version: 2,
        });
    });

    test("the group's roster budget is charged only for a roster stored", async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        await groups.leave(plain.userId, fam.groupId);
        // The admission was the first roster this hour; 58 more make 59.
        const bucket = createHash('sha256').update(`groups:roster:hour:${fam.groupId}`).digest();
        for (let i = 0; i < 58; i += 1)
            await authRepository.consumeRateLimit(bucket, 60, 3_600_000);
        // Refused by the repository under the lock (a departure to mark first): costs nothing.
        const unrelated = await nextRoster(fam, fam.organizer, entries(fam.h));
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, unrelated.call)),
        ).toMatchObject({ code: 'left-due' });
        fam.h.rosters.pop();
        fam.h.statements.pop();
        // Refused by the chain check before the repository: costs nothing.
        const { revision } = await head(fam.groupId);
        expect(
            await refusal(
                groups.postRoster(fam.organizer.userId, fam.groupId, {
                    expectedRevision: revision,
                    roster: wire(
                        await forgedRoster(fam, fam.organizer, (r) => ({
                            ...r,
                            previousRosterDigest: Buffer.alloc(32, 7).toString('base64url'),
                        })),
                    ),
                }),
            ),
        ).toMatchObject({ code: 'invalid' });
        // The 60th stored this hour lands, and resending it is a replay that costs nothing.
        const marking = await markLeftCall(fam, plain);
        expect(await marking.send('roster')).toMatchObject({ version: 3 });
        expect(await marking.send('roster')).toMatchObject({ replayed: true });
        const next = await nextRoster(fam, fam.organizer, entries(fam.h));
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, next.call)),
        ).toMatchObject({ code: 'rate-limited', status: 429 });
    });

    test('members without the role, and people not yet admitted, are refused, never told they are out', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        const newcomer = await member();
        await accepted(fam, newcomer);
        expect(await refusal(groups.getKeySeal(plain.userId, fam.groupId))).toMatchObject({
            code: 'forbidden',
            status: 403,
        });
        const at = await head(fam.groupId);
        expect(
            await refusal(
                groups.postGrants(newcomer.userId, fam.groupId, fam.areaId, {
                    grants: [
                        await grantWire(fam.groupId, fam.areaId, 1, newcomer.who, plain.who, {
                            rosterVersion: at.rosterVersion,
                            rosterDigest: at.rosterDigest,
                        }),
                    ],
                }),
            ),
        ).toMatchObject({ code: 'forbidden', status: 403 });
    });

    test("a self-grant below the area's key is area-moved; one to another group's area is invalid", async () => {
        const fam = await family();
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        await groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
            ...rotated.call,
            rotation,
            grants,
        });
        expect(
            await refusal(
                groups.putSelfGrant(fam.organizer.userId, fam.groupId, fam.areaId, {
                    grant: selfGrant(fam.areaId, 1),
                }),
            ),
        ).toMatchObject({ code: 'area-moved', status: 409 });
        expect(
            await groups.putSelfGrant(fam.organizer.userId, fam.groupId, fam.areaId, {
                grant: selfGrant(fam.areaId, 2),
            }),
        ).toEqual({ ok: true });
        const other = await family();
        expect(
            await refusal(
                groups.putSelfGrant(fam.organizer.userId, fam.groupId, other.areaId, {
                    grant: selfGrant(other.areaId, 1),
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'area' } });
    });

    test('a grant on route 22 is to someone else, never to the uploader', async () => {
        const fam = await family();
        const at = await head(fam.groupId);
        expect(
            await refusal(
                groups.postGrants(fam.organizer.userId, fam.groupId, fam.areaId, {
                    grants: [
                        await grantWire(
                            fam.groupId,
                            fam.areaId,
                            1,
                            fam.organizer.who,
                            fam.organizer.who,
                            {
                                rosterVersion: at.rosterVersion,
                                rosterDigest: at.rosterDigest,
                            },
                        ),
                    ],
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'self-grant' } });
    });

    test('an account is in one family at most, and a group holds at most ten areas', async () => {
        const organizer = await member();
        const fam = await family(organizer);
        // GROUP_OWNED_LIMIT is for company groups now: a second family is in-family first.
        expect(await refusal(family(organizer))).toMatchObject({
            code: 'in-family',
            status: 409,
        });
        for (let i = 2; i <= 10; i += 1)
            await groups.createArea(organizer.userId, fam.groupId, await areaCall(fam));
        expect(
            await refusal(groups.createArea(organizer.userId, fam.groupId, await areaCall(fam))),
        ).toMatchObject({
            code: 'area-limit',
            status: 409,
        });
    });

    test('a roster that gives someone members carries the current group key sealed to them', async () => {
        const fam = await family();
        const newcomer = await member();
        await accepted(fam, newcomer, ['members']);
        const { at, call } = await nextRoster(fam, fam.organizer, [
            ...entries(fam.h),
            newcomer.who.entry(['members']),
        ]);
        const grants = [
            await grantWire(fam.groupId, fam.areaId, 1, fam.organizer.who, newcomer.who, at),
        ];
        expect(
            await refusal(
                groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, {
                    ...call,
                    grants,
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'holder-seal' } });
        expect(
            await groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, {
                ...call,
                grants,
                keySeal: await sealWire(fam.groupId, fam.organizer.who, newcomer.who, at, 1),
            }),
        ).toMatchObject({ version: 2 });
    });

    test('a member owed an area key holds up every roster until a grant reaches them', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        // As a rotation too large for one call would leave it: their grant still to come on route 22.
        await db.delete(areaGrants).where(eq(areaGrants.granteeUserId, plain.userId));
        const { call } = await nextRoster(fam, fam.organizer, entries(fam.h));
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, call)),
        ).toMatchObject({
            code: 'grants-due',
            status: 409,
            data: { missing: [{ workspaceId: fam.areaId, userId: plain.userId }] },
        });
        const at = await head(fam.groupId);
        await groups.postGrants(fam.organizer.userId, fam.groupId, fam.areaId, {
            grants: [
                await grantWire(fam.groupId, fam.areaId, 1, fam.organizer.who, plain.who, {
                    rosterVersion: at.rosterVersion,
                    rosterDigest: at.rosterDigest,
                }),
            ],
        });
        expect(await groups.postRoster(fam.organizer.userId, fam.groupId, call)).toMatchObject({
            version: 3,
        });
    });

    test('a rotation grants the new key to every member who remains', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        expect(
            await refusal(
                groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                    ...rotated.call,
                    rotation,
                    grants,
                }),
            ),
        ).toMatchObject({ data: { reason: 'rotation-grants' } });
        const toPlain = await grantWire(
            fam.groupId,
            fam.areaId,
            2,
            fam.organizer.who,
            plain.who,
            rotated.at,
        );
        expect(
            await groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                ...rotated.call,
                rotation,
                grants: [...grants, toPlain],
            }),
        ).toMatchObject({ version: 3 });
    });

    test('a holder with only a grant of an area, no wrap of their own yet, can rotate it', async () => {
        const { fam, holder } = await withHolder();
        const rotation = await rotationWire(fam.areaId, holder.who, 1);
        const rotated = await nextRoster(fam, holder, entries(fam.h), {
            areas: [await nextAreaRow(fam.areaId, 2)],
        });
        const grants = [];
        for (const to of [fam.organizer, holder])
            grants.push(
                await grantWire(fam.groupId, fam.areaId, 2, holder.who, to.who, rotated.at),
            );
        expect(
            await groups.rotateArea(holder.userId, fam.groupId, fam.areaId, {
                ...rotated.call,
                rotation,
                grants,
            }),
        ).toMatchObject({ version: 3 });
        expect(await driveRepository.isMember(holder.userId, fam.areaId)).toBe(true);
    });

    test('invitations to one address are limited per group, and accepting is limited per account', async () => {
        const fam = await family();
        const invitee = await member();
        for (let i = 0; i < 3; i += 1) {
            const sent = await groups.invite(fam.organizer.userId, fam.groupId, {
                email: invitee.email,
                roles: [],
            });
            await groups.revokeInvitation(fam.organizer.userId, fam.groupId, sent.id);
        }
        expect(
            await refusal(
                groups.invite(fam.organizer.userId, fam.groupId, {
                    email: invitee.email,
                    roles: [],
                }),
            ),
        ).toMatchObject({ code: 'rate-limited', status: 429 });
        // Another group's invitations to the same address are their own.
        const other = await family();
        await groups.invite(other.organizer.userId, other.groupId, {
            email: invitee.email,
            roles: [],
        });
        const guesser = await member();
        for (let i = 0; i < 10; i += 1)
            expect(
                await refusal(
                    groups.acceptInvitation(
                        guesser.userId,
                        randomBytes(32).toString('base64url'),
                        ADDRESS,
                    ),
                ),
            ).toMatchObject({ code: 'gone' });
        expect(
            await refusal(
                groups.acceptInvitation(
                    guesser.userId,
                    randomBytes(32).toString('base64url'),
                    ADDRESS,
                ),
            ),
        ).toMatchObject({ code: 'rate-limited', status: 429 });
    });
});

describe('removing someone who keeps writing', () => {
    test('a held member cannot draw epochs, create nodes or start a rotation, and their removal lands', async () => {
        const fam = await family();
        const target = await member();
        await admitted(fam, target);
        await groups.putSelfGrant(target.userId, fam.groupId, fam.areaId, {
            grant: selfGrant(fam.areaId, 1),
        });
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        // Before the hold they draw epochs like any member.
        expect(
            await driveRepository.allocateKeyEpochs(fam.areaId, 1, target.userId),
        ).not.toBeNull();
        // Only a holder holds, and never themselves.
        expect(
            await refusal(groups.hold(target.userId, fam.groupId, fam.organizer.userId)),
        ).toMatchObject({ code: 'forbidden', status: 403 });
        expect(
            await refusal(groups.hold(fam.organizer.userId, fam.groupId, fam.organizer.userId)),
        ).toMatchObject({ code: 'invalid' });
        const held = await groups.hold(fam.organizer.userId, fam.groupId, target.userId);
        expect(Date.parse(held.heldUntil)).toBeGreaterThan(Date.now() + 14 * 60_000);
        const paused = { name: 'AccessEndedError', reason: 'held' };
        await expect(
            driveRepository.allocateKeyEpochs(fam.areaId, 1, target.userId),
        ).rejects.toMatchObject(paused);
        await expect(
            driveRepository.createFolders({
                workspaceId: fam.areaId,
                userId: target.userId,
                folders: [
                    {
                        id: randomUUID(),
                        parentId: root!.id,
                        envelopes: {
                            keyEpoch: 1,
                            parentKeyEpoch: root!.keyEpoch,
                            keyEnvelope: randomBytes(72),
                            metadataEnvelope: randomBytes(24 + 16 + 256),
                            metadataSignature: randomBytes(64),
                        },
                    },
                ],
            }),
        ).rejects.toMatchObject(paused);
        await expect(
            rotationsRepository.startRotation({
                workspaceId: fam.areaId,
                nodeId: root!.id,
                startedBy: target.userId,
            }),
        ).rejects.toMatchObject(paused);
        // A lapsed hold pauses nothing.
        await db.update(groupHolds).set({ expiresAt: new Date(Date.now() - 1000) });
        expect(
            await driveRepository.allocateKeyEpochs(fam.areaId, 1, target.userId),
        ).not.toBeNull();
        await groups.hold(fam.organizer.userId, fam.groupId, target.userId);
        // Held, they cannot overtake the removal's drawn epoch: it lands first time, and the hold goes.
        const removal = await markLeftCall(fam, target);
        expect(await removal.send('remove')).toMatchObject({ version: 3 });
        expect(await db.select().from(groupHolds)).toEqual([]);
    });
});

describe('a departed holder marked left in the same call', () => {
    test('promoting a member to holder seals the new key to them and lands in one call', async () => {
        const { fam, holder } = await withHolder();
        const plain = await member();
        await admitted(fam, plain);
        await groups.leave(holder.userId, fam.groupId);
        const leaving = entries(fam.h).find((entry) => entry.userId === holder.userId)!;
        const { at, call } = await nextRoster(fam, fam.organizer, [
            ...withEntry(fam.h, { ...leaving, status: 'left' }).filter(
                (entry) => entry.userId !== plain.userId,
            ),
            plain.who.entry(['members']),
        ]);
        const rotation = await rotationWire(fam.areaId, fam.organizer.who, 1);
        const succession = wire(await fam.h.succession(fam.organizer.who));
        const seals: Awaited<ReturnType<typeof sealWire>>[] = [];
        for (const to of [fam.organizer, plain])
            seals.push(await sealWire(fam.groupId, fam.organizer.who, to.who, at, 2));
        const grants: Awaited<ReturnType<typeof grantWire>>[] = [];
        for (const to of [fam.organizer, plain])
            grants.push(await grantWire(fam.groupId, fam.areaId, 2, fam.organizer.who, to.who, at));
        expect(
            await groups.patchMember(fam.organizer.userId, fam.groupId, plain.userId, {
                ...call,
                succession,
                seals,
                rotations: [rotation],
                grants,
            }),
        ).toMatchObject({ groupKeyVersion: 2 });
        expect(await groups.getKeySeal(plain.userId, fam.groupId)).toMatchObject({
            groupKeyVersion: 2,
        });
    });

    test('an admission that also replaces the group key seals the new key to the newcomer', async () => {
        const fam = await family();
        const newcomer = await member();
        await accepted(fam, newcomer, ['members']);
        const { at, call } = await nextRoster(fam, fam.organizer, [
            ...entries(fam.h),
            newcomer.who.entry(['members']),
        ]);
        const succession = wire(await fam.h.succession(fam.organizer.who));
        expect(
            await groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, {
                ...call,
                succession,
                seals: [
                    await sealWire(fam.groupId, fam.organizer.who, fam.organizer.who, at, 2),
                    await sealWire(fam.groupId, fam.organizer.who, newcomer.who, at, 2),
                ],
                grants: [
                    await grantWire(
                        fam.groupId,
                        fam.areaId,
                        1,
                        fam.organizer.who,
                        newcomer.who,
                        at,
                    ),
                ],
            }),
        ).toMatchObject({ version: 2, groupKeyVersion: 2 });
    });

    test('no one is admitted on the roster that drops a holder (I10): mark them left first, then admit', async () => {
        const { fam, holder } = await withHolder();
        await groups.leave(holder.userId, fam.groupId);
        const newcomer = await member();
        await accepted(fam, newcomer, ['members']);
        const leaving = entries(fam.h).find((entry) => entry.userId === holder.userId)!;
        const { at, call } = await nextRoster(fam, fam.organizer, [
            ...withEntry(fam.h, { ...leaving, status: 'left' }),
            newcomer.who.entry(['members']),
        ]);
        expect(
            await refusal(
                groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, {
                    ...call,
                    succession: wire(await fam.h.succession(fam.organizer.who)),
                    seals: [
                        await sealWire(fam.groupId, fam.organizer.who, fam.organizer.who, at, 2),
                        await sealWire(fam.groupId, fam.organizer.who, newcomer.who, at, 2),
                    ],
                    rotations: [await rotationWire(fam.areaId, fam.organizer.who, 1)],
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'roster-chain' } });
    });

    test('an admission that marks a member left rotates the area and grants the newcomer its new key', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        await groups.leave(plain.userId, fam.groupId);
        const newcomer = await member();
        await accepted(fam, newcomer, ['members']);
        const leaving = entries(fam.h).find((entry) => entry.userId === plain.userId)!;
        const { at, call } = await nextRoster(fam, fam.organizer, [
            ...withEntry(fam.h, { ...leaving, status: 'left' }),
            newcomer.who.entry(['members']),
        ]);
        const rotation = await rotationWire(fam.areaId, fam.organizer.who, 1);
        const keySeal = await sealWire(fam.groupId, fam.organizer.who, newcomer.who, at, 1);
        const toOrganizer = await grantWire(
            fam.groupId,
            fam.areaId,
            2,
            fam.organizer.who,
            fam.organizer.who,
            at,
        );
        const toNewcomer = await grantWire(
            fam.groupId,
            fam.areaId,
            2,
            fam.organizer.who,
            newcomer.who,
            at,
        );
        const admit = (grants: (typeof toOrganizer)[]) =>
            groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, {
                ...call,
                keySeal,
                rotations: [rotation],
                grants,
            });
        // The newcomer is owed the rotated key too, in this call.
        expect(await refusal(admit([toOrganizer]))).toMatchObject({
            data: { reason: 'rotation-grants' },
        });
        expect(await admit([toOrganizer, toNewcomer])).toMatchObject({ version: 3 });
        // Nobody is left owed a grant: the next roster lands.
        const next = await nextRoster(fam, fam.organizer, entries(fam.h));
        expect(await groups.postRoster(fam.organizer.userId, fam.groupId, next.call)).toMatchObject(
            { version: 4 },
        );
    });
});

describe('holds between holders', () => {
    test('a holder held by the person they remove still commits the family removal', async () => {
        const { fam, holder } = await withHolder();
        // The target holds their remover first; the remover can then hold no one.
        await groups.hold(holder.userId, fam.groupId, fam.organizer.userId);
        expect(
            await refusal(groups.hold(fam.organizer.userId, fam.groupId, holder.userId)),
        ).toMatchObject({ code: 'held', status: 409 });
        // Every holder sees the hold; a member without the role sees only the grants they could fill.
        const view = await groups.getGroup(fam.organizer.userId, fam.groupId);
        expect(view.due).toMatchObject({
            holds: [{ userId: fam.organizer.userId, heldBy: holder.userId }],
        });
        // The roster's own rotation is not a held write: the removal lands.
        const removal = await markLeftCall(fam, holder, { succession: true });
        expect(await removal.send('remove')).toMatchObject({ groupKeyVersion: 2 });
        expect(await db.select().from(groupHolds)).toEqual([]);
    });

    test("a holder held by another holder still commits a roster's rotation", async () => {
        const { fam, holder } = await withHolder();
        const plain = await member();
        await admitted(fam, plain);
        await groups.hold(holder.userId, fam.groupId, fam.organizer.userId);
        const before = entries(fam.h).find((entry) => entry.userId === plain.userId)!;
        const { at, call } = await nextRoster(
            fam,
            fam.organizer,
            withEntry(fam.h, { ...before, status: 'left' }),
        );
        const grants = [];
        for (const to of [fam.organizer, holder])
            grants.push(await grantWire(fam.groupId, fam.areaId, 2, fam.organizer.who, to.who, at));
        expect(
            await groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
                ...call,
                rotations: [await rotationWire(fam.areaId, fam.organizer.who, 1)],
                grants,
            }),
        ).toMatchObject({ version: 4 });
        // The hold stands for their own Drive writes, and stays listed.
        expect(await db.select().from(groupHolds)).toHaveLength(1);
    });

    test('a hold ends when its placer loses members or leaves', async () => {
        const { fam, holder } = await withHolder();
        const plain = await member();
        await admitted(fam, plain);
        await groups.hold(holder.userId, fam.groupId, plain.userId);
        // Demoted: the hold they placed goes with the role.
        const before = entries(fam.h).find((entry) => entry.userId === holder.userId)!;
        const { at, call } = await nextRoster(
            fam,
            fam.organizer,
            withEntry(fam.h, { ...before, roles: [] }),
        );
        await groups.patchMember(fam.organizer.userId, fam.groupId, holder.userId, {
            ...call,
            succession: wire(await fam.h.succession(fam.organizer.who)),
            seals: [await sealWire(fam.groupId, fam.organizer.who, fam.organizer.who, at, 2)],
        });
        expect(await db.select().from(groupHolds)).toEqual([]);
        // Leaving: the holds they placed go too.
        const second = await withHolder();
        const other = await member();
        await admitted(second.fam, other);
        await groups.hold(second.holder.userId, second.fam.groupId, other.userId);
        expect(await db.select().from(groupHolds)).toHaveLength(1);
        await groups.leave(second.holder.userId, second.fam.groupId);
        expect(await db.select().from(groupHolds)).toEqual([]);
    });
});

describe('what a client opens an area with (route 25)', () => {
    test('an area serves its root, change sequence and running rotation; mid-rotation the root’s previous envelope is its old key under the new area key', async () => {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        const area = async () => (await groups.spaces(plain.userId))[0]!.areas[0]!;
        const rootId = fam.body.area.root.id;
        const before = await area();
        expect(before).toMatchObject({
            workspaceId: fam.areaId,
            workspaceKeyVersion: 1,
            root: {
                id: rootId,
                keyEpoch: 1,
                parentKeyEpoch: 1,
                keyEnvelope: fam.body.area.root.keyEnvelope,
                prevKeyEnvelope: null,
            },
            rotation: null,
        });
        const { rotation, rotated, grants } = await rotateDefaultArea(fam, [plain]);
        const send = (previousRootKeyEnvelope: string) =>
            groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                ...rotated.call,
                rotation: { ...rotation, previousRootKeyEnvelope },
                grants,
            });
        // Without the old root key under the new area key, nobody given only the new key could
        // open what the walk has not reached: refused, and nothing moves.
        for (const malformed of [b64(randomBytes(71)), undefined as unknown as string])
            expect(await refusal(send(malformed))).toMatchObject({
                code: 'invalid',
                data: { reason: 'rotation-root-previous' },
            });
        expect(await area()).toMatchObject({ workspaceKeyVersion: 1, rotation: null });
        expect(await send(rotation.previousRootKeyEnvelope)).toMatchObject({ version: 3 });
        const during = await area();
        const [running] = await db
            .select()
            .from(driveRotations)
            .where(
                and(eq(driveRotations.workspaceId, fam.areaId), isNull(driveRotations.finishedAt)),
            );
        expect(during).toMatchObject({
            workspaceKeyVersion: 2,
            root: {
                id: rootId,
                keyEpoch: rotation.targetEpoch,
                parentKeyEpoch: 2,
                keyEnvelope: rotation.root.keyEnvelope,
                prevKeyEnvelope: rotation.previousRootKeyEnvelope,
                prevKeyEpoch: 1,
                // Under the area key a member now holds, not the version the rotation retired.
                prevParentKeyEpoch: 2,
            },
            rotation: { id: running!.id, nodeId: rootId, targetEpoch: rotation.targetEpoch },
        });
        expect(during.changeSeq).toBeGreaterThan(before.changeSeq);
        // The holder who rotated sees the same area.
        expect((await groups.spaces(fam.organizer.userId))[0]!.areas[0]).toEqual({
            ...during,
            grant: expect.anything(),
            selfGrant: expect.anything(),
        });
        expect(
            await rotationsRepository.finishRotation({
                workspaceId: fam.areaId,
                rootId,
                targetEpoch: rotation.targetEpoch,
            }),
        ).toBe(true);
        expect(await area()).toMatchObject({
            root: { prevKeyEnvelope: null, prevParentKeyEpoch: null },
            rotation: null,
        });
    });
});

describe('grants any member can fill (route 3)', () => {
    test('every active member sees the gaps they hold the key to fill, never their own, and one fill clears it for all', async () => {
        const fam = await family();
        const [a, b, c, d] = [await member(), await member(), await member(), await member()];
        for (const m of [a, b, c, d]) await admitted(fam, m);
        // d wraps the area key for themselves, then loses the grant: they still hold the key.
        await groups.putSelfGrant(d.userId, fam.groupId, fam.areaId, {
            grant: selfGrant(fam.areaId, 1),
        });
        // As a rotation too large for one call leaves it: grants still to come on route 22.
        await db
            .delete(areaGrants)
            .where(inArray(areaGrants.granteeUserId, [b.userId, c.userId, d.userId]));
        const dueOf = async (m: Member) => (await groups.getGroup(m.userId, fam.groupId)).due;
        const gaps = (...owed: Member[]) =>
            owed
                .map((m) => ({ workspaceId: fam.areaId, userId: m.userId }))
                .sort((x, y) => (x.userId < y.userId ? -1 : 1));
        // a holds a grant: b, c and d are owed one, and a member without the role sees only that.
        expect(await dueOf(a)).toEqual({ grants: gaps(b, c, d) });
        // b and c hold no key: nothing they could seal.
        expect(await dueOf(b)).toEqual({ grants: [] });
        // d holds it by their own wrap: b and c, never d's own gap (route 22 refuses self-grants).
        expect(await dueOf(d)).toEqual({ grants: gaps(b, c) });
        expect(await dueOf(fam.organizer)).toMatchObject({ grants: gaps(b, c, d), markLeft: [] });
        // Someone accepted but not admitted is owed nothing and told nothing.
        const waiting = await member();
        await accepted(fam, waiting);
        expect(await dueOf(waiting)).toBeUndefined();
        // a fills b's gap: nobody is asked to fill it again, and b can now fill the others.
        const at = await head(fam.groupId);
        expect(
            await groups.postGrants(a.userId, fam.groupId, fam.areaId, {
                grants: [
                    await grantWire(fam.groupId, fam.areaId, 1, a.who, b.who, {
                        rosterVersion: at.rosterVersion,
                        rosterDigest: at.rosterDigest,
                    }),
                ],
            }),
        ).toEqual({ stored: 1 });
        expect(await dueOf(d)).toEqual({ grants: gaps(c) });
        expect(await dueOf(b)).toEqual({ grants: gaps(c, d) });
    });
});

describe('identities for every entry on the head roster (route 6)', () => {
    test('members marked left are served with their links, a deleted account with none, and nobody off the roster', async () => {
        const fam = await family();
        const left = await member();
        const gone = await member();
        await admitted(fam, left);
        await admitted(fam, gone);
        // A succession of their own: the link a reader needs to retire their first keys.
        await succeedIdentity(left);
        await groups.leave(left.userId, fam.groupId);
        // And one after they left, which is none of the group's business.
        await succeedIdentity(left);
        const [{ leftAt }] = (await db
            .select({ leftAt: groupMemberships.leftAt })
            .from(groupMemberships)
            .where(
                and(
                    eq(groupMemberships.groupId, fam.groupId),
                    eq(groupMemberships.userId, left.userId),
                ),
            )) as [{ leftAt: Date }];
        // Times set apart explicitly: the database's clock and this process's need not agree.
        for (const [keyVersion, offset] of [
            [1, -60_000],
            [2, 60_000],
        ] as const)
            await db
                .update(accountIdentityHistory)
                .set({ replacedAt: new Date(leftAt.getTime() + offset) })
                .where(
                    and(
                        eq(accountIdentityHistory.userId, left.userId),
                        eq(accountIdentityHistory.keyVersion, keyVersion),
                    ),
                );
        await groups.leave(gone.userId, fam.groupId);
        await db.delete(users).where(eq(users.id, gone.userId));
        const marked = entries(fam.h).map((entry) =>
            entry.userId === left.userId || entry.userId === gone.userId
                ? { ...entry, status: 'left' as const }
                : entry,
        );
        const { at, call } = await nextRoster(fam, fam.organizer, marked);
        expect(
            await groups.postRoster(fam.organizer.userId, fam.groupId, {
                ...call,
                rotations: [await rotationWire(fam.areaId, fam.organizer.who, 1)],
                grants: [
                    await grantWire(
                        fam.groupId,
                        fam.areaId,
                        2,
                        fam.organizer.who,
                        fam.organizer.who,
                        at,
                    ),
                ],
            }),
        ).toMatchObject({ version: 4 });
        const waiting = await member();
        await accepted(fam, waiting);
        const served = await groups.getIdentities(fam.organizer.userId, fam.groupId, null);
        const ids = [fam.organizer.userId, left.userId, gone.userId].sort();
        expect(served.identities.map((entry) => entry.userId)).toEqual(ids);
        expect(served.next).toBeNull();
        const byId = new Map(served.identities.map((entry) => [entry.userId, entry]));
        // Their links up to their departure only: the one made after it is not served.
        expect(byId.get(left.userId)!.links).toMatchObject([
            { oldKeyVersion: 1, newKeyVersion: 2, consent: null },
        ]);
        expect(byId.get(left.userId)!.links).toHaveLength(1);
        // An active member's links are all served.
        await succeedIdentity(fam.organizer);
        const organizer = (
            await groups.getIdentities(fam.organizer.userId, fam.groupId, null)
        ).identities.find((entry) => entry.userId === fam.organizer.userId)!;
        expect(organizer.links.map((link) => link.newKeyVersion)).toEqual([2]);
        expect(byId.get(gone.userId)).toEqual({ userId: gone.userId, identity: null, links: [] });
        // The cursor continues after the id it names.
        expect(
            (await groups.getIdentities(fam.organizer.userId, fam.groupId, ids[0]!)).identities.map(
                (entry) => entry.userId,
            ),
        ).toEqual(ids.slice(1));
        // Those who left read none of it.
        expect(await refusal(groups.getIdentities(left.userId, fam.groupId, null))).toMatchObject({
            code: 'not-member',
        });
    });
});

describe('what counts as holding an area key for due.grants', () => {
    test('a grant from someone who has left does not count', async () => {
        const { fam, holder } = await withHolder();
        const [a, b] = [await member(), await member()];
        for (const m of [a, b]) await admitted(fam, m);
        await db.delete(areaGrants).where(eq(areaGrants.granteeUserId, b.userId));
        // a's key came from the holder, who then leaves: a's client would not accept it.
        await db
            .update(areaGrants)
            .set({ granterUserId: holder.userId })
            .where(eq(areaGrants.granteeUserId, a.userId));
        const owed = [{ workspaceId: fam.areaId, userId: b.userId }];
        expect((await groups.getGroup(a.userId, fam.groupId)).due).toEqual({ grants: owed });
        await groups.leave(holder.userId, fam.groupId);
        expect((await groups.getGroup(a.userId, fam.groupId)).due).toEqual({ grants: [] });
        expect((await groups.getGroup(fam.organizer.userId, fam.groupId)).due).toMatchObject({
            grants: owed,
        });
    });

    test('a grant or self-grant of an older key version does not count', async () => {
        const fam = await family();
        const [a, b] = [await member(), await member()];
        for (const m of [a, b]) await admitted(fam, m);
        await groups.putSelfGrant(b.userId, fam.groupId, fam.areaId, {
            grant: selfGrant(fam.areaId, 1),
        });
        const { rotation, rotated, grants } = await rotateDefaultArea(fam, [a, b]);
        await groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
            ...rotated.call,
            rotation,
            grants,
        });
        // Both lose their grant of version 2: a keeps one of version 1, b a self-grant of it.
        await db
            .delete(areaGrants)
            .where(
                and(
                    inArray(areaGrants.granteeUserId, [a.userId, b.userId]),
                    eq(areaGrants.workspaceKeyVersion, 2),
                ),
            );
        for (const m of [a, b])
            expect((await groups.getGroup(m.userId, fam.groupId)).due).toEqual({ grants: [] });
        expect((await groups.getGroup(fam.organizer.userId, fam.groupId)).due).toMatchObject({
            grants: [a, b]
                .map((m) => ({ workspaceId: fam.areaId, userId: m.userId }))
                .sort((x, y) => (x.userId < y.userId ? -1 : 1)),
        });
    });
});

describe("repairing the root's previous envelope (route 28)", () => {
    test('only a holder, not held, for the running rotation, replaces it; the change sequence moves', async () => {
        const { fam, holder } = await withHolder();
        const plain = await member();
        await admitted(fam, plain);
        const { rotation, rotated, grants } = await rotateDefaultArea(fam, [holder, plain]);
        await groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
            ...rotated.call,
            rotation,
            grants,
        });
        const area = async () => (await groups.spaces(plain.userId))[0]!.areas[0]!;
        const before = await area();
        const rotationId = before.rotation!.id;
        const repaired = b64(randomBytes(72));
        const put = (who: Member, body: { rotationId: string; previousRootKeyEnvelope: string }) =>
            groups.putPreviousRoot(who.userId, fam.groupId, fam.areaId, body);
        const unchanged = async () =>
            expect((await area()).root).toMatchObject({
                prevKeyEnvelope: rotation.previousRootKeyEnvelope,
            });
        // A member without `members`: refused, never told they are out.
        expect(
            await refusal(put(plain, { rotationId, previousRootKeyEnvelope: repaired })),
        ).toMatchObject({ code: 'forbidden', status: 403 });
        const stranger = await member();
        expect(
            await refusal(put(stranger, { rotationId, previousRootKeyEnvelope: repaired })),
        ).toMatchObject({ code: 'not-member', status: 404 });
        // Another run than the one running, or not 72 bytes.
        expect(
            await refusal(
                put(holder, { rotationId: randomUUID(), previousRootKeyEnvelope: repaired }),
            ),
        ).toMatchObject({ code: 'not-rotating', status: 409 });
        expect(
            await refusal(
                put(holder, { rotationId, previousRootKeyEnvelope: b64(randomBytes(71)) }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'rotation-root-previous' } });
        await unchanged();
        // Held ahead of a removal, a holder may not touch it either.
        await groups.hold(fam.organizer.userId, fam.groupId, holder.userId);
        expect(
            await refusal(put(holder, { rotationId, previousRootKeyEnvelope: repaired })),
        ).toMatchObject({ code: 'held', status: 409 });
        await unchanged();
        const done = await put(fam.organizer, { rotationId, previousRootKeyEnvelope: repaired });
        expect(done.changeSeq).toBeGreaterThan(before.changeSeq);
        expect(await area()).toMatchObject({
            changeSeq: done.changeSeq,
            root: {
                // The root itself carries the new change sequence: the change feed hands it on.
                changeSeq: done.changeSeq,
                prevKeyEnvelope: repaired,
                // The same old root key at its own epoch, under the current area key.
                prevKeyEpoch: before.root!.prevKeyEpoch,
                prevParentKeyEpoch: 2,
                keyEnvelope: before.root!.keyEnvelope,
            },
        });
        // Once the walk is finished there is nothing left to repair.
        expect(
            await rotationsRepository.finishRotation({
                workspaceId: fam.areaId,
                rootId: before.root!.id,
                targetEpoch: rotation.targetEpoch,
            }),
        ).toBe(true);
        expect(
            await refusal(put(fam.organizer, { rotationId, previousRootKeyEnvelope: repaired })),
        ).toMatchObject({ code: 'not-rotating', status: 409 });
        expect((await area()).root).toMatchObject({ prevKeyEnvelope: null });
    });

    test('a roster rotation over a root that still carries a previous envelope is its own 409, with nothing changed', async () => {
        const fam = await family();
        // A previous envelope no running rotation accounts for (a bug, or a hand-edited row).
        await db
            .update(driveNodes)
            .set({ prevKeyEnvelope: randomBytes(72), prevKeyEpoch: 1, prevParentKeyEpoch: 1 })
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        expect(
            await refusal(
                groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                    ...rotated.call,
                    rotation,
                    grants,
                }),
            ),
        ).toMatchObject({ code: 'root-mid-rotation', status: 409 });
        const [area] = await db.select().from(workspaces).where(eq(workspaces.id, fam.areaId));
        expect(area!.workspaceKeyVersion).toBe(1);
        expect(
            await db
                .select()
                .from(driveRotations)
                .where(eq(driveRotations.workspaceId, fam.areaId)),
        ).toEqual([]);
    });
});

describe('the root a roster rotation re-keys (route 29)', () => {
    /*
     * The area root with a live share and link from the organizer, and one of each revoked:
     * rows a server before the family-sharing refusal could have stored, written directly.
     */
    async function sharedRoot(fam: Family) {
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        const share = async (to: Member) => {
            const row = await insertLegacyShare({
                workspaceId: fam.areaId,
                nodeId: root!.id,
                granterUserId: fam.organizer.userId,
                granteeUserId: to.userId,
                role: 'viewer',
                keyEpoch: root!.keyEpoch,
                shareEnvelope: randomBytes(driveRepository.SHARE_ENVELOPE_BYTES),
            });
            return row.id;
        };
        const link = async (hasPassword: boolean) => {
            const row = await insertLegacyLink({
                id: randomUUID(),
                workspaceId: fam.areaId,
                nodeId: root!.id,
                granterUserId: fam.organizer.userId,
                tokenHash: randomBytes(32),
                keyEpoch: root!.keyEpoch,
                linkEnvelope: randomBytes(72),
                linkSalt: randomBytes(16),
                secretEnvelope: randomBytes(104),
                hasPassword,
                expiresAt: null,
            });
            return row.id;
        };
        const outsider = await member();
        const former = await member();
        const liveShare = await share(outsider);
        const revokedShare = await share(former);
        const liveLink = await link(true);
        const revokedLink = await link(false);
        await driveRepository.revokeShare(fam.areaId, revokedShare);
        await driveRepository.revokeLink(fam.areaId, revokedLink);
        const [now] = await db.select().from(driveNodes).where(eq(driveNodes.id, root!.id));
        return { root: now!, outsider, liveShare, revokedShare, liveLink, revokedLink };
    }

    /* A rotation of the root as a client builds it from what route 29 served: every share and link re-sealed. */
    function fromServed(
        rotation: Awaited<ReturnType<typeof rotateDefaultArea>>['rotation'],
        served: Awaited<ReturnType<typeof groups.areaRoot>>,
    ) {
        return {
            ...rotation,
            root: {
                ...rotation.root,
                id: served.id,
                changeSeq: served.changeSeq!,
                rotated: {
                    ...rotation.root.rotated!,
                    shares: served.shares.map((share) => ({
                        id: share.id,
                        shareEnvelope: b64(randomBytes(driveRepository.SHARE_ENVELOPE_BYTES)),
                    })),
                    links: served.links.map((link) => ({
                        id: link.id,
                        linkEnvelope: b64(randomBytes(72)),
                        secretEnvelope: b64(randomBytes(104)),
                    })),
                },
            },
        };
    }

    test('only an active members holder reads it, held or not; others are refused, strangers told nothing', async () => {
        const { fam, holder } = await withHolder();
        const plain = await member();
        await admitted(fam, plain);
        const waiting = await member();
        await accepted(fam, waiting);
        const { root, outsider, liveShare, liveLink } = await sharedRoot(fam);
        const read = (who: Member, areaId = fam.areaId) =>
            groups.areaRoot(who.userId, fam.groupId, areaId);
        const served = await read(holder);
        expect(served).toMatchObject({
            id: root.id,
            kind: 'folder',
            parentId: null,
            // The area key version the root is wrapped under: what the rotation replaces.
            parentKeyEpoch: 1,
            keyEpoch: root.keyEpoch,
            keyEnvelope: b64(root.keyEnvelope!),
            metadataVersion: root.metadataVersion,
            metadataEnvelope: b64(root.metadataEnvelope!),
            metadataSigner: { id: fam.organizer.userId },
            // The precondition route 24 checks: the node's own, not the workspace's.
            changeSeq: root.changeSeq,
            prevKeyEnvelope: null,
            // A folder carries no file versions.
            versions: [],
            shares: [
                {
                    id: liveShare,
                    granteeUserId: outsider.userId,
                    grantee: {
                        keyVersion: 1,
                        identityVersion: 2,
                        encryptionPublicKey: outsider.who.served.encryptionPublicKey,
                        signingPublicKey: outsider.who.served.signingPublicKey,
                        kemPublicKey: outsider.who.served.kemPublicKey,
                    },
                },
            ],
            links: [{ id: liveLink, hasPassword: true, secretEnvelope: expect.any(String) }],
        });
        // A member without `members`, and someone accepted but not admitted: refused, never told they are out.
        for (const who of [plain, waiting])
            expect(await refusal(read(who))).toMatchObject({ code: 'forbidden', status: 403 });
        const stranger = await member();
        expect(await refusal(read(stranger))).toMatchObject({ code: 'not-member', status: 404 });
        // Another group's area, read through this group, or no area at all.
        const other = await family();
        for (const areaId of [other.areaId, randomUUID()])
            expect(await refusal(read(fam.organizer, areaId))).toMatchObject({
                code: 'invalid',
                data: { reason: 'area' },
            });
        // A hold stops Drive writes, not a roster's rotation: the held holder still reads what it re-keys.
        const second = await member();
        await admitted(fam, second, ['members']);
        await groups.hold(fam.organizer.userId, fam.groupId, second.userId);
        expect(await read(second)).toEqual(await read(fam.organizer));
        // Gone from the group, a former holder is a stranger again.
        await groupsRepository.leaveGroup(fam.groupId, holder.userId);
        expect(await refusal(read(holder))).toMatchObject({ code: 'not-member', status: 404 });
    });

    test('a holder reads it only while holding the area’s current key, from a granter still in the group or their own wrap', async () => {
        const { fam, holder } = await withHolder();
        const read = () => groups.areaRoot(holder.userId, fam.groupId, fam.areaId);
        const noKey = { code: 'forbidden', status: 403 };
        const rootId = fam.body.area.root.id;
        const myGrants = and(
            eq(areaGrants.workspaceId, fam.areaId),
            eq(areaGrants.granteeUserId, holder.userId),
        );
        const myWrap = and(
            eq(workspaceKeys.workspaceId, fam.areaId),
            eq(workspaceKeys.userId, holder.userId),
        );
        await groups.putSelfGrant(holder.userId, fam.groupId, fam.areaId, {
            grant: selfGrant(fam.areaId),
        });
        const { rotation, rotated, grants } = await rotateDefaultArea(fam, [holder]);
        await groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
            ...rotated.call,
            rotation,
            grants,
        });
        // A grant of version 2 from the organizer, and their own wrap of version 1.
        expect(await read()).toMatchObject({ id: rootId, parentKeyEpoch: 2 });
        // The granter gone from the group, their grant no longer counts.
        const organizerState = (state: 'active' | 'left') =>
            db
                .update(groupMemberships)
                .set({ state, leftAt: state === 'left' ? new Date() : null })
                .where(
                    and(
                        eq(groupMemberships.groupId, fam.groupId),
                        eq(groupMemberships.userId, fam.organizer.userId),
                    ),
                );
        await organizerState('left');
        expect(await refusal(read())).toMatchObject(noKey);
        await organizerState('active');
        expect(await read()).toMatchObject({ id: rootId });
        // Without the version 2 grant, keys of version 1 (a grant and their own wrap) are not enough.
        await db.delete(areaGrants).where(and(myGrants, eq(areaGrants.workspaceKeyVersion, 2)));
        expect(await refusal(read())).toMatchObject(noKey);
        // Their own wrap of version 2 alone is.
        await db.update(workspaceKeys).set({ workspaceKeyVersion: 2 }).where(myWrap);
        expect(await read()).toMatchObject({ id: rootId });
        await db.delete(workspaceKeys).where(myWrap);
        expect(await refusal(read())).toMatchObject(noKey);
    });

    test('revoked grants are left out, and a rotation built from what it serves lands and keeps exactly those', async () => {
        const fam = await family();
        const { root, liveShare, revokedShare, liveLink, revokedLink } = await sharedRoot(fam);
        const served = await groups.areaRoot(fam.organizer.userId, fam.groupId, fam.areaId);
        expect(served.shares.map((share) => share.id)).toEqual([liveShare]);
        expect(served.links.map((link) => link.id)).toEqual([liveLink]);
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        expect(
            await groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                ...rotated.call,
                rotation: fromServed(rotation, served),
                grants,
            }),
        ).toMatchObject({ version: 2 });
        // What was served is re-sealed at the target; what was revoked stays revoked, at its old epoch.
        const shares = await db
            .select()
            .from(driveShares)
            .where(inArray(driveShares.id, [liveShare, revokedShare]));
        expect(shares.find((share) => share.id === liveShare)).toMatchObject({
            revokedAt: null,
            keyEpoch: rotation.targetEpoch,
        });
        expect(shares.find((share) => share.id === revokedShare)).toMatchObject({
            revokedAt: expect.any(Date),
            keyEpoch: root.keyEpoch,
        });
        const links = await db
            .select()
            .from(driveLinks)
            .where(inArray(driveLinks.id, [liveLink, revokedLink]));
        expect(links.find((link) => link.id === liveLink)).toMatchObject({
            revokedAt: null,
            keyEpoch: rotation.targetEpoch,
        });
        expect(links.find((link) => link.id === revokedLink)).toMatchObject({
            revokedAt: expect.any(Date),
            keyEpoch: root.keyEpoch,
        });
        // Read again, it is the root the roster left: under the new area key, mid-walk.
        expect(await groups.areaRoot(fam.organizer.userId, fam.groupId, fam.areaId)).toMatchObject({
            id: root.id,
            parentKeyEpoch: 2,
            keyEpoch: rotation.targetEpoch,
            keyEnvelope: rotation.root.keyEnvelope,
            prevKeyEnvelope: rotation.previousRootKeyEnvelope,
            changeSeq: expect.any(Number),
            shares: [{ id: liveShare }],
            links: [{ id: liveLink }],
        });
    });

    test('a share or link tried on the root after the read is refused and moves nothing, so the rotation from that read lands', async () => {
        const fam = await family();
        const { root, liveShare, liveLink } = await sharedRoot(fam);
        const before = await groups.areaRoot(fam.organizer.userId, fam.groupId, fam.areaId);
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        const late = await member();
        expect(
            await driveRepository.createShare({
                workspaceId: fam.areaId,
                nodeId: root.id,
                granterUserId: fam.organizer.userId,
                granteeUserId: late.userId,
                role: 'viewer',
                keyEpoch: root.keyEpoch,
                shareEnvelope: randomBytes(driveRepository.SHARE_ENVELOPE_BYTES),
            }),
        ).toEqual({ status: 'family-sharing' });
        expect(
            await driveRepository.createLink({
                id: randomUUID(),
                workspaceId: fam.areaId,
                nodeId: root.id,
                granterUserId: fam.organizer.userId,
                tokenHash: randomBytes(32),
                keyEpoch: root.keyEpoch,
                linkEnvelope: randomBytes(72),
                linkSalt: randomBytes(16),
                secretEnvelope: null,
                hasPassword: false,
                expiresAt: null,
            }),
        ).toEqual({ status: 'family-sharing' });
        expect(
            await groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                ...rotated.call,
                rotation: fromServed(rotation, before),
                grants,
            }),
        ).toMatchObject({ version: 2 });
        // Only the grants it was served exist, and both are re-sealed at the target.
        const shares = await db.select().from(driveShares).where(eq(driveShares.nodeId, root.id));
        const links = await db.select().from(driveLinks).where(eq(driveLinks.nodeId, root.id));
        expect(
            [...shares, ...links]
                .filter((row) => row.revokedAt === null)
                .map((row) => [row.id, row.keyEpoch]),
        ).toEqual(
            expect.arrayContaining([
                [liveShare, rotation.targetEpoch],
                [liveLink, rotation.targetEpoch],
            ]),
        );
        expect([...shares, ...links].filter((row) => row.revokedAt === null)).toHaveLength(2);
    });
});

describe('workspace documents ride on the rotation', () => {
    const DOCUMENT_LIMITS = { kinds: WORKSPACE_DOCUMENT_KINDS, bytes: WORKSPACE_DOCUMENT_BYTES };
    /* A member's ordinary document write, at the version they read (0 for none). */
    async function writeDocument(workspaceId: string, kind: string, version: number) {
        const envelope = Buffer.from(documentEnvelope(), 'base64url');
        const written = await driveRepository.putWorkspaceDocument({
            limits: DOCUMENT_LIMITS,
            workspaceId,
            kind,
            version,
            envelope,
        });
        if (written.status !== 'ok') throw new Error(written.status);
        return envelope;
    }
    async function documentsOf(workspaceId: string) {
        return db
            .select()
            .from(workspaceDocuments)
            .where(eq(workspaceDocuments.workspaceId, workspaceId))
            .orderBy(workspaceDocuments.kind);
    }
    async function stateOf(groupId: string, userId: string) {
        const [row] = await db
            .select({ state: groupMemberships.state })
            .from(groupMemberships)
            .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
        return row?.state;
    }
    async function areaOf(workspaceId: string) {
        const [area] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, workspaceId), isNull(driveNodes.parentId)));
        return { version: area!.workspaceKeyVersion, rootEpoch: root!.keyEpoch };
    }

    test('route 24 stores each at the next version with the roster; a stale, missing or foreign one refuses the whole call, and the same roster bytes land once rebuilt', async () => {
        const fam = await family();
        await writeDocument(fam.areaId, 'tags', 0);
        await writeDocument(fam.areaId, 'tags', 1);
        await writeDocument(fam.areaId, 'pins', 0);
        // The rotator reads the area now: tags at 2, pins at 1.
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        const send = (documents: typeof rotation.documents) =>
            groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                ...rotated.call,
                rotation: { ...rotation, documents },
                grants,
            });
        const tags = rotation.documents.find((document) => document.kind === 'tags')!;
        const pins = rotation.documents.find((document) => document.kind === 'pins')!;
        expect([tags.version, pins.version]).toEqual([2, 1]);
        const invalidDocuments = {
            code: 'invalid',
            status: 400,
            data: { reason: 'rotation-documents' },
        };
        // A kind the area does not hold, one named twice, or bytes a document write would refuse.
        expect(
            await refusal(
                send([tags, pins, { kind: 'notes', version: 1, envelope: documentEnvelope() }]),
            ),
        ).toMatchObject(invalidDocuments);
        expect(await refusal(send([tags, tags, pins]))).toMatchObject(invalidDocuments);
        expect(
            await refusal(send([{ ...tags, envelope: b64(randomBytes(24 + 16 + 100)) }, pins])),
        ).toMatchObject(invalidDocuments);
        // One left out is named, so a client that did not know the kind learns it and re-reads it.
        expect(await refusal(send([pins]))).toMatchObject({
            code: 'document-stale',
            status: 409,
            data: { workspaceId: fam.areaId, kind: 'tags' },
        });
        // A member rewrites the tags after the rotator read them.
        const theirs = await writeDocument(fam.areaId, 'tags', 2);
        const before = await areaOf(fam.areaId);
        expect(await refusal(send([tags, pins]))).toMatchObject({
            code: 'document-stale',
            status: 409,
            data: { workspaceId: fam.areaId, kind: 'tags' },
        });
        // Nothing of the call stayed: no roster, the area key and root as they were, the
        // documents as the member left them, no Drive rotation started.
        expect(await rosterCount(fam.groupId)).toBe(1);
        expect(await areaOf(fam.areaId)).toEqual(before);
        expect((await documentsOf(fam.areaId)).map((row) => [row.kind, row.version])).toEqual([
            ['pins', 1],
            ['tags', 3],
        ]);
        expect((await documentsOf(fam.areaId))[1]!.envelope.equals(theirs)).toBe(true);
        expect(
            await db
                .select()
                .from(driveRotations)
                .where(eq(driveRotations.workspaceId, fam.areaId)),
        ).toEqual([]);
        // The client re-reads, re-seals and resends the same roster bytes: it lands.
        const resealed = await resealedDocuments(fam.areaId);
        expect(await send(resealed)).toMatchObject({ version: 2 });
        const stored = await documentsOf(fam.areaId);
        expect(stored.map((row) => [row.kind, row.version, row.envelopeSuite])).toEqual([
            ['pins', 2, 1],
            ['tags', 4, 1],
        ]);
        for (const row of stored)
            expect(
                row.envelope.equals(
                    Buffer.from(
                        resealed.find((document) => document.kind === row.kind)!.envelope,
                        'base64url',
                    ),
                ),
            ).toBe(true);
        expect((await areaOf(fam.areaId)).version).toBe(2);
        // A write built on what was read before the rotation no longer lands over the re-sealed one.
        expect(
            await driveRepository.putWorkspaceDocument({
                limits: DOCUMENT_LIMITS,
                workspaceId: fam.areaId,
                kind: 'tags',
                version: 3,
                envelope: Buffer.from(documentEnvelope(), 'base64url'),
            }),
        ).toMatchObject({ status: 'stale', document: { version: 4 } });
    });

    test('a family removal (route 19) carries every area’s documents; stale ones in several areas are named in one answer, and the rebuilt rotations land with the same roster bytes', async () => {
        const fam = await family();
        const second = await areaCall(fam);
        await groups.createArea(fam.organizer.userId, fam.groupId, second);
        const secondId = second.area.workspaceId;
        // A member admitted with both areas' keys.
        const plain = await member();
        await accepted(fam, plain);
        const admission = await nextRoster(fam, fam.organizer, [
            ...entries(fam.h),
            plain.who.entry([]),
        ]);
        await groups.admit(fam.organizer.userId, fam.groupId, plain.userId, {
            ...admission.call,
            grants: await Promise.all(
                [fam.areaId, secondId].map((workspaceId) =>
                    grantWire(
                        fam.groupId,
                        workspaceId,
                        1,
                        fam.organizer.who,
                        plain.who,
                        admission.at,
                    ),
                ),
            ),
        });
        await writeDocument(fam.areaId, 'tags', 0);
        await writeDocument(secondId, 'tags', 0);
        // The removal rotates both areas, with both areas' documents. Each new key is its own:
        // the kit would derive the same one for every area but its first.
        const before = entries(fam.h).find((entry) => entry.userId === plain.userId)!;
        const removal = await nextRoster(
            fam,
            fam.organizer,
            withEntry(fam.h, { ...before, status: 'left' }),
            {
                areas: await Promise.all(
                    [fam.areaId, secondId].sort().map(async (workspaceId) => ({
                        workspaceId,
                        workspaceKeyVersion: 2,
                        commitment: await areaKeyCommitment(randomBytes(32)),
                    })),
                ),
            },
        );
        const rotations = [
            await rotationWire(fam.areaId, fam.organizer.who, 1),
            await rotationWire(secondId, fam.organizer.who, 1),
        ];
        const grants = await Promise.all(
            [fam.areaId, secondId].map((workspaceId) =>
                grantWire(
                    fam.groupId,
                    workspaceId,
                    2,
                    fam.organizer.who,
                    fam.organizer.who,
                    removal.at,
                ),
            ),
        );
        const remove = () =>
            groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
                ...removal.call,
                rotations,
                grants,
            });
        // The removed member writes both areas' tags before the removal arrives.
        await writeDocument(fam.areaId, 'tags', 1);
        await writeDocument(secondId, 'tags', 1);
        const rostersBefore = await rosterCount(fam.groupId);
        // Every stale document in one answer, the first also on its own as before.
        expect(await refusal(remove())).toMatchObject({
            code: 'document-stale',
            status: 409,
            data: {
                workspaceId: fam.areaId,
                kind: 'tags',
                stale: [
                    { workspaceId: fam.areaId, kind: 'tags' },
                    { workspaceId: secondId, kind: 'tags' },
                ],
            },
        });
        // Nothing of the removal stayed; the member is still in.
        expect(await rosterCount(fam.groupId)).toBe(rostersBefore);
        expect((await areaOf(fam.areaId)).version).toBe(1);
        expect((await areaOf(secondId)).version).toBe(1);
        expect(await stateOf(fam.groupId, plain.userId)).toBe('active');
        // Both areas' documents rebuilt from one answer; the roster bytes are the same.
        rotations[0] = { ...rotations[0]!, documents: await resealedDocuments(fam.areaId) };
        rotations[1] = { ...rotations[1]!, documents: await resealedDocuments(secondId) };
        expect(await remove()).toMatchObject({ version: rostersBefore + 1 });
        expect(await stateOf(fam.groupId, plain.userId)).toBe('removed');
        for (const [workspaceId, version] of [
            [fam.areaId, 3],
            [secondId, 3],
        ] as const) {
            expect((await areaOf(workspaceId)).version).toBe(2);
            const [tags] = await documentsOf(workspaceId);
            expect(tags!.version).toBe(version);
            const sent = rotations.find((r) => r.workspaceId === workspaceId)!.documents[0]!;
            expect(tags!.envelope.equals(Buffer.from(sent.envelope, 'base64url'))).toBe(true);
        }
    });

    test('a rotation cannot re-seal an area’s documents past what a workspace may hold', async () => {
        const fam = await family();
        for (const kind of ['tags', 'pins', 'views']) await writeDocument(fam.areaId, kind, 0);
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        const send = (documents: typeof rotation.documents) =>
            groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                ...rotated.call,
                rotation: { ...rotation, documents },
                grants,
            });
        // Each at the largest size a document may be: together past the workspace's bytes.
        const largest = b64(randomBytes(DOCUMENT_ENVELOPE_MAX_BYTES));
        expect(
            await refusal(send(rotation.documents.map((d) => ({ ...d, envelope: largest })))),
        ).toMatchObject({ code: 'invalid', data: { reason: 'rotation-documents' } });
        expect((await areaOf(fam.areaId)).version).toBe(1);
        // Re-sealed at the size they were, it lands.
        expect(await send(rotation.documents)).toMatchObject({ version: 2 });
    });

    test('a role change (route 18) that marks a departed holder left carries the area’s documents', async () => {
        const { fam, holder } = await withHolder();
        const plain = await member();
        await admitted(fam, plain);
        await writeDocument(fam.areaId, 'tags', 0);
        await groups.leave(holder.userId, fam.groupId);
        const leaving = entries(fam.h).find((entry) => entry.userId === holder.userId)!;
        const { at, call } = await nextRoster(fam, fam.organizer, [
            ...withEntry(fam.h, { ...leaving, status: 'left' }).filter(
                (entry) => entry.userId !== plain.userId,
            ),
            plain.who.entry(['members']),
        ]);
        const rotation = await rotationWire(fam.areaId, fam.organizer.who, 1);
        const succession = wire(await fam.h.succession(fam.organizer.who));
        const seals: Awaited<ReturnType<typeof sealWire>>[] = [];
        for (const to of [fam.organizer, plain])
            seals.push(await sealWire(fam.groupId, fam.organizer.who, to.who, at, 2));
        const grants: Awaited<ReturnType<typeof grantWire>>[] = [];
        for (const to of [fam.organizer, plain])
            grants.push(await grantWire(fam.groupId, fam.areaId, 2, fam.organizer.who, to.who, at));
        const promote = (documents: typeof rotation.documents) =>
            groups.patchMember(fam.organizer.userId, fam.groupId, plain.userId, {
                ...call,
                succession,
                seals,
                rotations: [{ ...rotation, documents }],
                grants,
            });
        expect(await refusal(promote([]))).toMatchObject({
            code: 'document-stale',
            data: { stale: [{ workspaceId: fam.areaId, kind: 'tags' }] },
        });
        expect(await promote(rotation.documents)).toMatchObject({ groupKeyVersion: 2 });
        const [tags] = await documentsOf(fam.areaId);
        expect(tags!.version).toBe(2);
        expect(
            tags!.envelope.equals(Buffer.from(rotation.documents[0]!.envelope, 'base64url')),
        ).toBe(true);
    });

    test('a rotation carrying a kind the server does not keep is invalid, even one the area holds', async () => {
        const fam = await family();
        // Stored past the domain (as a kind from before the list would be): only the list refuses it.
        await writeDocument(fam.areaId, 'bogus', 0);
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        expect(rotation.documents.map((document) => document.kind)).toEqual(['bogus']);
        expect(
            await refusal(
                groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
                    ...rotated.call,
                    rotation,
                    grants,
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'rotation-documents' } });
        expect((await areaOf(fam.areaId)).version).toBe(1);
    });
});

describe('roster format 2 and deleting a family folder (route 30, groups design 2.10)', () => {
    /* A format 2 family of two, with a second folder its organizer made on a format 2 roster. */
    async function photosFamily() {
        const fam = await family();
        const plain = await member();
        await admitted(fam, plain);
        // The chain switches up from here (design 2.10): every later roster is format 2.
        fam.h.format = 2;
        const areaSeed = randomBytes(16).toString('base64url');
        const photos = scopedId('workspace', fam.groupId, areaSeed)!;
        const { at, call } = await nextRoster(fam, fam.organizer, entries(fam.h), {
            areas: [
                {
                    workspaceId: photos,
                    workspaceKeyVersion: 1,
                    commitment: await areaKeyCommitment(randomBytes(32)),
                    rootCommitment: await areaRootCommitment(randomBytes(32)),
                },
            ],
        });
        await groups.createArea(fam.organizer.userId, fam.groupId, {
            ...call,
            area: {
                workspaceId: photos,
                idSeed: areaSeed,
                root: await rootWire(photos, fam.organizer.who),
                selfGrant: selfGrant(photos),
            },
            grants: [
                await grantWire(fam.groupId, photos, 1, fam.organizer.who, fam.organizer.who, at),
                await grantWire(fam.groupId, photos, 1, fam.organizer.who, plain.who, at),
            ],
        });
        return { fam, plain, photos };
    }
    const deleteCall = async (fam: Family, workspaceId: string, by = fam.organizer) =>
        (await nextRoster(fam, by, entries(fam.h), { areas: [tombstoneAt(workspaceId, 2)] })).call;
    const spaceAreas = async (userId: string) =>
        (await groups.spaces(userId)).flatMap((space) => space.areas.map((a) => a.workspaceId));

    test('a manager deletes a folder: gone from everyone’s spaces, and a later removal rotates only what is left', async () => {
        const { fam, plain, photos } = await photosFamily();
        expect(await spaceAreas(plain.userId)).toContain(photos);
        await groups.deleteArea(
            fam.organizer.userId,
            fam.groupId,
            photos,
            await deleteCall(fam, photos),
        );
        expect(await spaceAreas(plain.userId)).toEqual([fam.areaId]);
        expect(await spaceAreas(fam.organizer.userId)).toEqual([fam.areaId]);
        const [row] = await db.select().from(workspaces).where(eq(workspaces.id, photos));
        expect(row!.deletedAt).not.toBeNull();
        // The removal's roster rotates the live folder alone (the kit skips the retired one), and
        // the server takes it with that one rotation.
        await markLeft(fam, plain, 'remove');
        expect((await head(fam.groupId)).rosterVersion).toBe(fam.h.statements.length);
        // A grant into the deleted folder is refused.
        const at = {
            rosterVersion: fam.h.statements.length,
            rosterDigest: await rosterDigest(fam.h.rosters.at(-1)!.statement),
        };
        expect(
            await refusal(
                groups.postGrants(fam.organizer.userId, fam.groupId, photos, {
                    grants: [
                        await grantWire(
                            fam.groupId,
                            photos,
                            1,
                            fam.organizer.who,
                            fam.organizer.who,
                            at,
                        ),
                    ],
                }),
            ),
        ).toMatchObject({ code: 'invalid', status: 400 });
    });

    test('a removal that still rotates the deleted folder is refused by the chain rules', async () => {
        const { fam, plain, photos } = await photosFamily();
        await groups.deleteArea(
            fam.organizer.userId,
            fam.groupId,
            photos,
            await deleteCall(fam, photos),
        );
        const before = entries(fam.h).find((entry) => entry.userId === plain.userId)!;
        const { call } = await nextRoster(
            fam,
            fam.organizer,
            withEntry(fam.h, { ...before, status: 'left' }),
            {
                areas: [
                    {
                        ...(await nextAreaRow(fam.areaId, 2)),
                        rootCommitment: await areaRootCommitment(randomBytes(32)),
                    },
                    {
                        workspaceId: photos,
                        workspaceKeyVersion: 3,
                        commitment: await areaKeyCommitment(randomBytes(32)),
                        rootCommitment: await areaRootCommitment(randomBytes(32)),
                    },
                ].sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1)),
            },
        );
        expect(
            await refusal(
                groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, call),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'roster-chain' } });
    });

    test('the delete route takes only the tombstone, from a manager, and no other route takes one', async () => {
        const { fam, plain, photos } = await photosFamily();
        // A member who does not manage the family: refused before anything is checked.
        expect(
            await refusal(
                groups.deleteArea(plain.userId, fam.groupId, photos, {
                    expectedRevision: (await head(fam.groupId)).revision,
                    roster: wire(fam.h.rosters.at(-1)!),
                }),
            ),
        ).toMatchObject({ status: 403 });
        // A tombstone standing in for a rotation's row on route 24 is not that rotation.
        const rotation = await rotationWire(photos, fam.organizer.who, 1);
        const masquerade = await deleteCall(fam, photos);
        expect(
            await refusal(
                groups.rotateArea(fam.organizer.userId, fam.groupId, photos, {
                    ...masquerade,
                    rotation,
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'area-rows' } });
        // The same tombstone on the delete route, but carrying a grant too: refused.
        expect(
            await refusal(
                groups.deleteArea(fam.organizer.userId, fam.groupId, photos, {
                    ...masquerade,
                    grants: [
                        await grantWire(fam.groupId, fam.areaId, 1, fam.organizer.who, plain.who, {
                            rosterVersion: 1,
                            rosterDigest: await rosterDigest(fam.h.rosters[0]!.statement),
                        }),
                    ],
                }),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'area-delete' } });
        // Named for another folder than the one its tombstone retires: refused.
        expect(
            await refusal(
                groups.deleteArea(fam.organizer.userId, fam.groupId, fam.areaId, masquerade),
            ),
        ).toMatchObject({ code: 'invalid', data: { reason: 'area-rows' } });
        // And as it should be: it lands, once.
        await groups.deleteArea(fam.organizer.userId, fam.groupId, photos, masquerade);
        const [row] = await db.select().from(workspaces).where(eq(workspaces.id, photos));
        expect(row!.deletedAt).not.toBeNull();
    });

    test('an area or top-folder commitment another family listed is refused, whatever the chain says', async () => {
        const { fam: first } = await photosFamily();
        const firstRows = first.h.statements.flatMap((roster) => roster.areas ?? []);
        const takenRoot = firstRows.find((row) => row.rootCommitment)!.rootCommitment!;
        const second = await family();
        second.h.format = 2;
        const newArea = async (commitment: string, rootCommitment: string) => {
            const areaSeed = randomBytes(16).toString('base64url');
            const areaId = scopedId('workspace', second.groupId, areaSeed)!;
            const { at, call } = await nextRoster(second, second.organizer, entries(second.h), {
                areas: [
                    { workspaceId: areaId, workspaceKeyVersion: 1, commitment, rootCommitment },
                ],
            });
            // Each attempt leaves the kit's history ahead of the server: take it back.
            const sent = {
                ...call,
                area: {
                    workspaceId: areaId,
                    idSeed: areaSeed,
                    root: await rootWire(areaId, second.organizer.who),
                    selfGrant: selfGrant(areaId),
                },
                grants: [
                    await grantWire(
                        second.groupId,
                        areaId,
                        1,
                        second.organizer.who,
                        second.organizer.who,
                        at,
                    ),
                ],
            };
            const answer = await refusal(
                groups.createArea(second.organizer.userId, second.groupId, sent),
            ).catch(() => null);
            second.h.statements.pop();
            second.h.rosters.pop();
            return answer;
        };
        const fresh = async () => areaRootCommitment(randomBytes(32));
        // The first family's folder key, and its top folder's key, each under another family.
        expect(
            await newArea(await areaKeyCommitment(kitAreaKey(first.areaId, 1)), await fresh()),
        ).toMatchObject({ code: 'invalid', data: { reason: 'area-commitment' } });
        expect(await newArea(await areaKeyCommitment(randomBytes(32)), takenRoot)).toMatchObject({
            code: 'invalid',
            data: { reason: 'area-commitment' },
        });
        // Fresh keys land.
        expect(await newArea(await areaKeyCommitment(randomBytes(32)), await fresh())).toBeNull();
    });

    test('a format 1 roster after a format 2 one is refused, and format 1 chains still take rosters', async () => {
        const fam = await family();
        // Format 1 throughout still lands.
        const { call } = await nextRoster(fam, fam.organizer, entries(fam.h));
        await groups.postRoster(fam.organizer.userId, fam.groupId, call);
        fam.h.format = 2;
        const up = await nextRoster(fam, fam.organizer, entries(fam.h));
        await groups.postRoster(fam.organizer.userId, fam.groupId, up.call);
        expect((await head(fam.groupId)).rosterVersion).toBe(3);
        fam.h.format = 1;
        const down = await nextRoster(fam, fam.organizer, entries(fam.h));
        expect(
            await refusal(groups.postRoster(fam.organizer.userId, fam.groupId, down.call)),
        ).toMatchObject({ code: 'invalid', data: { reason: 'roster-chain' } });
        expect(await rosterCount(fam.groupId)).toBe(3);
    });

    test('during the walk a roster rotation started, no Drive batch re-keys or re-wraps the top folder', async () => {
        const fam = await family();
        const { rotation, rotated, grants } = await rotateDefaultArea(fam);
        await groups.rotateArea(fam.organizer.userId, fam.groupId, fam.areaId, {
            ...rotated.call,
            rotation,
            grants,
        });
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        // A re-wrap of the root under the area's current version, from a member, during the pass.
        const { results } = await driveServer.rotateNodes(
            fam.organizer.userId,
            fam.areaId,
            root!.id,
            [
                {
                    id: root!.id,
                    changeSeq: root!.changeSeq!,
                    parentKeyEpoch: 2,
                    keyEnvelope: b64(randomBytes(72)),
                    rotated: null,
                },
            ],
        );
        expect(results).toEqual([{ id: root!.id, status: 'forbidden' }]);
        const [after] = await db.select().from(driveNodes).where(eq(driveNodes.id, root!.id));
        expect(after!.keyEnvelope).toEqual(root!.keyEnvelope);
        expect(after!.changeSeq).toBe(root!.changeSeq);
    });

    test('a Drive rotation started at a family folder’s top folder is refused; its key moves only with a roster', async () => {
        const fam = await family();
        const [root] = await db
            .select()
            .from(driveNodes)
            .where(and(eq(driveNodes.workspaceId, fam.areaId), isNull(driveNodes.parentId)));
        await expect(
            driveServer.startRotation(fam.organizer.userId, fam.areaId, root!.id),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
        expect(
            await db
                .select()
                .from(driveRotations)
                .where(eq(driveRotations.workspaceId, fam.areaId)),
        ).toEqual([]);
    });
});

/*
 * Groups 1d, Core 5a: the bodies each twin's roster call builder made (the
 * Rust core's AreaLedger::admit_body, roles_body and handover_body; the web
 * worker's groupStage) land on these routes as built. Both fixtures sign the
 * same family (persons 1 to 5 of the group test kit, a group id derived under
 * person 1): it is stored here route by route as clients would have sent it,
 * then each body is posted, and posted again as the outbox resends it after an
 * unknown outcome, which answers as a replay.
 */
describe('roster calls the phones and the web build (Core 5a)', () => {
    const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    const documents = {
        core: read('../../crypto/src/__fixtures__/core-roster-calls.json'),
        web: read('../../../crates/hushos-core/fixtures/web-roster-calls.json'),
    };

    /* Persons 1 to 5 as accounts with the fixtures' fixed ids and their real identities. */
    async function people() {
        const out: Person[] = [];
        for (const n of [1, 2, 3, 4, 5]) {
            const who = await person(n);
            const email = `person${n}-${randomUUID()}@hushos.test`;
            await db.insert(users).values({
                id: who.userId,
                name: `Person ${n}`,
                email,
                normalizedEmail: email,
                emailVerifiedAt: new Date(),
            });
            const [workspace] = await db
                .insert(workspaces)
                .values({ ownerKind: 'personal' })
                .returning({ id: workspaces.id });
            await db
                .insert(personalWorkspaces)
                .values({ userId: who.userId, workspaceId: workspace!.id });
            await db
                .insert(workspaceStorage)
                .values({ workspaceId: workspace!.id, baseQuotaBytes: 1_073_741_824n });
            // An account root at key version 1: a self-grant is checked against it.
            await db.insert(accountKeys).values({
                userId: who.userId,
                envelopeVersion: 1,
                wrappingSalt: randomBytes(32),
                wrappingNonce: randomBytes(24),
                encryptedKey: randomBytes(48),
            });
            await storeTestIdentity(who.userId, who.served);
            out.push(Object.assign(who, { email }));
        }
        return out as (Person & { email: string })[];
    }

    async function invited(
        groupId: string,
        by: string,
        to: { userId: string; email: string },
        roles: GroupRole[],
    ) {
        const token = randomBytes(32).toString('base64url');
        const created = await groupsRepository.createInvitation({
            groupId,
            email: to.email,
            normalizedEmail: to.email,
            tokenHash: createHash('sha256').update(token).digest(),
            roles,
            invitedBy: by,
            expiresAt: new Date(Date.now() + 86_400_000),
        });
        if (created.status !== 'created') throw new Error(created.status);
        await groups.acceptInvitation(to.userId, token, ADDRESS);
    }

    /* The family of `doc` stored as its clients sent it: rosters 1 to 5, persons 4 and 5 waiting. */
    async function stored(doc: Record<string, any>) {
        const p = await people();
        const [p1, p2, p3, p4, p5] = p as [
            Person & { email: string },
            ...(Person & { email: string })[],
        ];
        const family = doc.family;
        const rosters = family.rosters as SignedStatementWire[];
        const at = async (version: number) => ({
            rosterVersion: version,
            rosterDigest: await rosterDigest(
                Buffer.from(rosters[version - 1]!.statement, 'base64url'),
            ),
        });
        const [a1, a2, a3] = family.areas as { workspaceId: string; idSeed: string }[];
        const groupId: string = family.groupId;
        await groups.createGroup(p1.userId, {
            id: groupId,
            idSeed: family.groupIdSeed,
            kind: 'family',
            name: 'The Fixture Family',
            groupKey: family.firstKeys,
            roster: rosters[0]!,
            keySeal: { envelope: (await sealWire(groupId, p1, p1, await at(1), 1)).envelope },
            area: {
                workspaceId: a1!.workspaceId,
                idSeed: a1!.idSeed,
                root: await rootWire(a1!.workspaceId, p1),
                selfGrant: selfGrant(a1!.workspaceId),
                grant: {
                    envelope: (await grantWire(groupId, a1!.workspaceId, 1, p1, p1, await at(1)))
                        .envelope,
                },
            },
        });
        await invited(groupId, p1.userId, p2!, []);
        await groups.admit(p1.userId, groupId, p2!.userId, {
            expectedRevision: 1,
            roster: rosters[1]!,
            grants: [await grantWire(groupId, a1!.workspaceId, 1, p1, p2!, await at(2))],
        });
        await invited(groupId, p1.userId, p3!, ['members']);
        await groups.admit(p1.userId, groupId, p3!.userId, {
            expectedRevision: 2,
            roster: rosters[2]!,
            grants: [await grantWire(groupId, a1!.workspaceId, 1, p1, p3!, await at(3))],
            keySeal: await sealWire(groupId, p1, p3!, await at(3), 1),
        });
        await groups.createArea(p1.userId, groupId, {
            expectedRevision: 3,
            roster: rosters[3]!,
            area: {
                workspaceId: a2!.workspaceId,
                idSeed: a2!.idSeed,
                root: await rootWire(a2!.workspaceId, p1),
                selfGrant: selfGrant(a2!.workspaceId),
            },
            grants: await Promise.all(
                [p1, p2!, p3!].map(async (to) =>
                    grantWire(groupId, a2!.workspaceId, 1, p1, to, await at(4)),
                ),
            ),
        });
        await groups.deleteArea(p1.userId, groupId, a2!.workspaceId, {
            expectedRevision: 4,
            roster: rosters[4]!,
        });
        await groups.createArea(p1.userId, groupId, {
            expectedRevision: 5,
            roster: rosters[5]!,
            area: {
                workspaceId: a3!.workspaceId,
                idSeed: a3!.idSeed,
                root: await rootWire(a3!.workspaceId, p1),
                selfGrant: selfGrant(a3!.workspaceId),
            },
            grants: await Promise.all(
                [p1, p2!, p3!].map(async (to) =>
                    grantWire(groupId, a3!.workspaceId, 1, p1, to, await at(6)),
                ),
            ),
        });
        // A3's key replaced (route 24): every family folder a newcomer is owed is not at version 1.
        await groups.rotateArea(p1.userId, groupId, a3!.workspaceId, {
            expectedRevision: 6,
            roster: rosters[6]!,
            rotation: await rotationWire(a3!.workspaceId, p1, 1),
            grants: await Promise.all(
                [p1, p2!, p3!].map(async (to) =>
                    grantWire(groupId, a3!.workspaceId, 2, p1, to, await at(7)),
                ),
            ),
        });
        await invited(groupId, p1.userId, p4!, []);
        await invited(groupId, p1.userId, p5!, ['members']);
        expect(await head(groupId)).toMatchObject({ revision: 7, rosterVersion: 7 });
        return { groupId, p1 };
    }

    for (const [twin, doc] of Object.entries(documents))
        for (const call of (doc.calls as Record<string, any>[]).filter((c) => c.body !== null))
            test(`the ${twin}'s ${call.name} lands, and its resend is a replay`, async () => {
                const { groupId, p1 } = await stored(doc);
                const send = () => post(p1.userId, groupId, call);
                expect(await send()).toMatchObject({ version: 8, replayed: false });
                expect(await send()).toMatchObject({ version: 8, replayed: true });
                expect(await head(groupId)).toMatchObject({
                    rosterVersion: 8,
                    groupKeyVersion: call.expected.groupKeyVersion,
                });
            });

    /* A call posted on its route: admissions on 17, role changes on 18. */
    function post(userId: string, groupId: string, call: Record<string, any>) {
        const route = call.expected.route as { kind: 'admit' | 'member'; userId: string };
        return route.kind === 'admit'
            ? groups.admit(userId, groupId, route.userId, call.body)
            : groups.patchMember(userId, groupId, route.userId, call.body);
    }

    for (const [twin, doc] of Object.entries(documents))
        test(`two of the ${twin}'s calls built on one head (two devices): the first lands, the second is stale`, async () => {
            const { groupId, p1 } = await stored(doc);
            const named = (name: string) =>
                doc.calls.find((c: Record<string, any>) => c.name === name);
            expect(await post(p1.userId, groupId, named('admit-member'))).toMatchObject({
                version: 8,
                replayed: false,
            });
            expect(await refusal(post(p1.userId, groupId, named('grant-members')))).toMatchObject({
                code: 'stale',
                status: 409,
            });
            expect(await head(groupId)).toMatchObject({ rosterVersion: 8 });
        });
});
