import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { db } from '../../db/src/client';
import { workspaceKeys } from '../../db/src/schema';
import {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    createTestIdentity,
    insertLegacyLink,
    insertLegacyShare,
    resetDatabase,
} from '../../db/test/helpers';
import * as signed from '../../db/test/signed';
import {
    epoch,
    folder,
    keyEnvelope,
    member,
    metadataEnvelope,
    minted,
    root,
    share,
    type Account,
} from '../test/fixtures';
import * as server from './server';

/*
 * Share envelopes at the domain: suite 4 (4565 bytes) is the only one taken
 * or served. An envelope of a retired suite (1, 2, or 3 with Ed25519 alone) is
 * an outdated client, told to update; any other length is no envelope at all.
 * An older envelope a rotation left behind as the previous one is never handed
 * to the grantee.
 */

const b64 = (bytes: Buffer) => bytes.toString('base64url');

let owner: Account;
let guest: Account;
let project: Awaited<ReturnType<typeof folder>>;

beforeEach(async () => {
    await resetDatabase();
    owner = await member();
    guest = await createTestAccount();
    await createTestIdentity(guest.userId);
    project = await folder(owner, await root(owner));
});
afterAll(closeDatabase);

async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
    );
    if (!(error instanceof server.DriveError)) throw new Error('expected a DriveError');
    return { status: error.status, code: error.code };
}

describe('creating and re-sealing', () => {
    const shareWith = (length: number) =>
        server.shareNode(owner.userId, owner.workspaceId, project.id, {
            granteeUserId: guest.userId,
            role: 'viewer',
            keyEpoch: project.keyEpoch,
            shareEnvelope: b64(randomBytes(length)),
        });

    test('a retired suite is told to update, any other length is invalid, and nothing is stored', async () => {
        for (const length of [72, 1160, 1256])
            expect(await refusal(shareWith(length))).toEqual({ status: 409, code: 'unsupported' });
        for (const length of [100, 4564, 4566])
            expect(await refusal(shareWith(length))).toEqual({ status: 400, code: 'invalid' });
        expect(await server.listNodeShares(owner.userId, owner.workspaceId, project.id)).toEqual({
            shares: [],
        });
        const made = await shareWith(4565);
        expect(made.share.suite).toBe(4);
    });

    test('a re-seal takes suite 4 only and leaves the stored envelope alone otherwise', async () => {
        const shareId = await share(owner, project, guest, 'viewer');
        const before = (await server.listSharedWithMe(guest.userId)).shares[0]!.shareEnvelope;
        const reseal = (length: number) =>
            server.resealShare(owner.userId, owner.workspaceId, shareId, {
                keyEpoch: project.keyEpoch,
                shareEnvelope: b64(randomBytes(length)),
            });
        expect(await refusal(reseal(1160))).toEqual({ status: 409, code: 'unsupported' });
        expect(await refusal(reseal(1256))).toEqual({ status: 409, code: 'unsupported' });
        expect(await refusal(reseal(1000))).toEqual({ status: 400, code: 'invalid' });
        expect((await server.listSharedWithMe(guest.userId)).shares[0]!.shareEnvelope).toBe(before);
        const fresh = randomBytes(4565);
        await server.resealShare(owner.userId, owner.workspaceId, shareId, {
            keyEpoch: project.keyEpoch,
            shareEnvelope: b64(fresh),
        });
        expect((await server.listSharedWithMe(guest.userId)).shares[0]!.shareEnvelope).toBe(
            b64(fresh),
        );
    });
});

describe('in a family folder', () => {
    /* The owner's family, its folder (which they hold a key to) and the folder's root. */
    async function familyRoot() {
        const { areaIds } = await createTestFamily({ organizerId: owner.userId });
        const areaId = areaIds[0]!;
        await db.insert(workspaceKeys).values({
            workspaceId: areaId,
            userId: owner.userId,
            keyVersion: 1,
            wrappingSalt: randomBytes(32),
            wrappingNonce: randomBytes(24),
            encryptedKey: randomBytes(48),
        });
        const created = await signed.createRoot({
            workspaceId: areaId,
            userId: owner.userId,
            id: randomUUID(),
            envelopes: {
                keyEpoch: await epoch(areaId),
                parentKeyEpoch: 1,
                keyEnvelope: keyEnvelope(),
                metadataEnvelope: metadataEnvelope(),
            },
        });
        if (created.status !== 'created') throw new Error(created.status);
        return { areaId, node: created.root };
    }

    test('no share or link is made, sealed again or given a new expiry, and stopping one left from before still works', async () => {
        const { areaId, node } = await familyRoot();
        const refused = { status: 409, code: 'family-sharing' };
        expect(
            await refusal(
                server.shareNode(owner.userId, areaId, node.id, {
                    granteeUserId: guest.userId,
                    role: 'viewer',
                    keyEpoch: node.keyEpoch,
                    shareEnvelope: b64(randomBytes(4565)),
                }),
            ),
        ).toEqual(refused);
        const { id: linkId, seed: linkIdSeed } = minted('link', areaId);
        expect(
            await refusal(
                server.createLink(owner.userId, areaId, node.id, {
                    linkId,
                    linkIdSeed,
                    token: randomBytes(32).toString('base64url'),
                    keyEpoch: node.keyEpoch,
                    linkEnvelope: b64(randomBytes(72)),
                    linkSalt: b64(randomBytes(16)),
                    secretEnvelope: b64(randomBytes(136)),
                    hasPassword: false,
                    expiresAt: null,
                }),
            ),
        ).toEqual(refused);
        expect(await server.listNodeShares(owner.userId, areaId, node.id)).toEqual({ shares: [] });
        expect(await server.listNodeLinks(owner.userId, areaId, node.id)).toEqual({ links: [] });
        // Rows a server before the refusal could have stored: refused alike, left as they were.
        const legacyShare = await insertLegacyShare({
            workspaceId: areaId,
            nodeId: node.id,
            granterUserId: owner.userId,
            granteeUserId: guest.userId,
            role: 'viewer',
            keyEpoch: node.keyEpoch,
            shareEnvelope: randomBytes(4565),
        });
        const legacyLink = await insertLegacyLink({
            id: randomUUID(),
            workspaceId: areaId,
            nodeId: node.id,
            granterUserId: owner.userId,
            tokenHash: randomBytes(32),
            keyEpoch: node.keyEpoch,
            linkEnvelope: randomBytes(72),
            linkSalt: randomBytes(16),
            secretEnvelope: randomBytes(136),
            hasPassword: false,
            expiresAt: null,
        });
        // As the grantee is served it, leaving out the feed cursor, which is sealed afresh each time.
        const served = async () =>
            (await server.listSharedWithMe(guest.userId)).shares.map(
                ({ cursor: _cursor, ...row }) => row,
            );
        const shareBefore = await served();
        const linksBefore = await server.listNodeLinks(owner.userId, areaId, node.id);
        expect(shareBefore.map((row) => row.shareEnvelope)).toEqual([
            b64(legacyShare.shareEnvelope),
        ]);
        expect(
            await refusal(
                server.resealShare(owner.userId, areaId, legacyShare.id, {
                    keyEpoch: node.keyEpoch,
                    shareEnvelope: b64(randomBytes(4565)),
                }),
            ),
        ).toEqual(refused);
        expect(
            await refusal(
                server.updateLink(owner.userId, areaId, legacyLink.id, {
                    keyEpoch: node.keyEpoch,
                    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                }),
            ),
        ).toEqual(refused);
        expect(
            await refusal(
                server.updateLink(owner.userId, areaId, legacyLink.id, {
                    keyEpoch: node.keyEpoch,
                    seal: {
                        linkEnvelope: b64(randomBytes(72)),
                        linkSalt: b64(randomBytes(16)),
                        hasPassword: true,
                    },
                }),
            ),
        ).toEqual(refused);
        expect(await served()).toEqual(shareBefore);
        expect(await server.listNodeLinks(owner.userId, areaId, node.id)).toEqual(linksBefore);
        expect(await server.revokeShare(owner.userId, areaId, legacyShare.id)).toEqual({
            revoked: true,
        });
        expect(await server.revokeLink(owner.userId, areaId, legacyLink.id)).toEqual({
            revoked: true,
        });
        // The same calls in the owner's own Drive go through.
        expect(
            (
                await server.shareNode(owner.userId, owner.workspaceId, project.id, {
                    granteeUserId: guest.userId,
                    role: 'viewer',
                    keyEpoch: project.keyEpoch,
                    shareEnvelope: b64(randomBytes(4565)),
                })
            ).share.suite,
        ).toBe(4);
    });
});

describe('the previous envelope', () => {
    test('is served while a rotation runs only when it is suite 4', async () => {
        const shareId = await share(owner, project, guest, 'viewer');
        const previous = async (envelope: Buffer) => {
            await db.$client.query(
                'update drive_shares set prev_share_envelope = $1, prev_key_epoch = $2 where id = $3',
                [envelope, project.keyEpoch - 1, shareId],
            );
            const [row] = (await server.listSharedWithMe(guest.userId)).shares;
            return { envelope: row!.prevShareEnvelope, epoch: row!.prevKeyEpoch };
        };
        // An older row re-sealed by a rotation keeps its old envelope as the previous one.
        expect(await previous(randomBytes(72))).toEqual({ envelope: null, epoch: null });
        expect(await previous(randomBytes(1160))).toEqual({ envelope: null, epoch: null });
        expect(await previous(randomBytes(1256))).toEqual({ envelope: null, epoch: null });
        const suite4 = randomBytes(4565);
        expect(await previous(suite4)).toEqual({
            envelope: b64(suite4),
            epoch: project.keyEpoch - 1,
        });
    });
});
