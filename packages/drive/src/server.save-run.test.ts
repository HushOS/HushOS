import { randomBytes, randomUUID } from 'node:crypto';
import { driveRepository } from '@hushos/db';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../../db/test/helpers';
import * as signed from '../../db/test/signed';
import { epoch, file, member, root, type Account } from '../test/fixtures';
import { DriveApiError } from './api';
import { abortFateOf, askAbort, deniedWhole, trashFatesOf } from './save-runs';
import * as server from './server';

/*
 * The save path's clean-up reads the server's own answers (askAbort,
 * trashFatesOf, deniedWhole): an abort refused because the upload is still
 * finishing must be asked again, one refused because it finished is a result
 * that landed, and a trash answer that refuses an item must keep the run's
 * row. These run the real routes' answers through the client's mapping, as
 * the web's unwrapDrive hands them over (message, code, status, data).
 */

const MiB = 1024n * 1024n;

let owner: Account;
let top: Awaited<ReturnType<typeof root>>;

beforeEach(async () => {
    await resetDatabase();
    owner = await member();
    top = await root(owner);
});
afterAll(closeDatabase);

/* What the client receives for a route that threw. */
async function answered(call: () => Promise<unknown>) {
    try {
        await call();
        return null;
    } catch (error) {
        if (!(error instanceof server.DriveError)) throw error;
        return new DriveApiError(error.message, error.code, error.status, error.data);
    }
}

/* An open upload of a new file under the root. */
async function begun() {
    const objectId = randomUUID();
    const result = await signed.beginUpload({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        node: {
            existing: false,
            id: randomUUID(),
            parentId: top.id,
            envelopes: {
                keyEpoch: await epoch(owner.workspaceId),
                parentKeyEpoch: top.keyEpoch,
                keyEnvelope: randomBytes(72),
                metadataEnvelope: randomBytes(100),
            },
        },
        version: { id: randomUUID(), contentKeyEnvelope: randomBytes(84) },
        object: {
            id: objectId,
            objectKey: `ws/${owner.workspaceId}/${objectId}`,
            contentSuite: 3,
            chunkSize: Number(8n * MiB),
            chunkCount: 1,
            contentNonce: randomBytes(16),
            ciphertextSize: MiB,
        },
        multipartId: `mp-${objectId}`,
        expiresAt: new Date(Date.now() + 3600_000),
    });
    if (result.status !== 'ok') throw new Error(result.status);
    return result.uploadId;
}

const abort = (uploadId: string) => () =>
    answered(() => server.abortUpload(owner.userId, owner.workspaceId, uploadId)).then((error) => {
        if (error) throw error;
    });

describe('an abort’s answer, from the route', () => {
    test('an open upload is aborted; aborted again, it is gone (settled either way)', async () => {
        const uploadId = await begun();
        expect(await askAbort(abort(uploadId), { stillOn: () => true })).toBe('aborted');
        expect(await askAbort(abort(uploadId), { stillOn: () => true })).toBe('gone');
    });

    test('one still finishing is asked again (data.upload completing), and settles once it finishes', async () => {
        const uploadId = await begun();
        await driveRepository.startCompleting(owner.workspaceId, uploadId);
        expect(
            abortFateOf(
                await answered(() => server.abortUpload(owner.userId, owner.workspaceId, uploadId)),
            ),
        ).toBe('finishing');
        // It finishes between the first ask and the second: the second says finished, a result that landed.
        let asked = 0;
        const fate = await askAbort(abort(uploadId), {
            stillOn: () => true,
            pause: async () => {
                asked += 1;
                await driveRepository.finishCompleting(owner.workspaceId, uploadId, MiB);
            },
        });
        expect(asked).toBe(1);
        expect(fate).toBe('finished');
    });

    test('one that finished is finished (data.upload completed); one that never was is gone', async () => {
        const uploadId = await begun();
        await driveRepository.startCompleting(owner.workspaceId, uploadId);
        await driveRepository.finishCompleting(owner.workspaceId, uploadId, MiB);
        expect(await askAbort(abort(uploadId), { stillOn: () => true })).toBe('finished');
        expect(await askAbort(abort(randomUUID()), { stillOn: () => true })).toBe('gone');
    });
});

describe('a trash batch’s answer, from the route', () => {
    test('trashed, already in the Trash and not found are each fates; someone with no access is refused whole', async () => {
        const kept = await file(owner, top);
        const already = await file(owner, top);
        await server.trashNodes(owner.userId, owner.workspaceId, [already.id]);
        const missing = randomUUID();
        const { results } = await server.trashNodes(owner.userId, owner.workspaceId, [
            kept.id,
            already.id,
            missing,
        ]);
        const fates = trashFatesOf(results);
        expect(fates.get(kept.id)).toBe('done');
        expect(fates.get(already.id)).toBe('done');
        expect(fates.get(missing)).toBe('gone');
        const stranger = await createTestAccount();
        const whole = await answered(() =>
            server.trashNodes(stranger.userId, owner.workspaceId, [kept.id]),
        );
        expect(deniedWhole(whole)).toBe(true);
    });
});
