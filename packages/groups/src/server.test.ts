import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { rosterDigest } from '@hushos/crypto/groups';
import {
    authRepository,
    driveRepository,
    groupsRepository,
    rotationsRepository,
    scopedId,
} from '@hushos/db';
import { areaKeyCommitment } from '../../crypto/src/area-keys';
import { db } from '../../db/src/client';
import {
    areaGrants,
    driveNodes,
    driveRotations,
    groupChainCaches,
    groupHolds,
    groupMemberships,
    groupRosters,
    users,
    workspaces,
} from '../../db/src/schema';
import { closeDatabase, resetDatabase } from '../../db/test/helpers';
import {
    ADDRESS,
    accepted,
    admitted,
    entries,
    family,
    forgedRoster,
    grantWire,
    head,
    member,
    nextAreaRow,
    nextRoster,
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
import * as groups from './server';

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
        const opened = await groups.getIdentities(fam.organizer.userId, fam.groupId, null);
        expect(opened.identities.map((i) => i.userId).sort()).toEqual(
            [fam.organizer.userId].sort(),
        );
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

    test('an account creates at most three groups, and a group holds at most ten areas', async () => {
        const organizer = await member();
        const fam = await family(organizer);
        await family(organizer);
        const third = await family(organizer);
        expect(await refusal(family(organizer))).toMatchObject({
            code: 'group-limit',
            status: 409,
        });
        // A group they handed on and left no longer counts against them.
        await db
            .update(groupMemberships)
            .set({ state: 'left', leftAt: new Date() })
            .where(
                and(
                    eq(groupMemberships.groupId, third.groupId),
                    eq(groupMemberships.userId, organizer.userId),
                ),
            );
        await family(organizer);
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
        // Every holder sees the hold; a member without the role sees no due list at all.
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
