import { DriveApiError, type PurgeBatchItem, type TrashBatchItem } from '@hushos/drive/api';
import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';
import { describe, expect, test } from 'vitest';
import { cleanUpSends, type CleanUpClient } from '@/lib/save-run-sends';

/*
 * A save run's clean-up after a sign-out: nothing more is sent for that session, between two
 * batches, two deletes forever, or two tries of one request.
 */
function session() {
    const state = { on: true };
    const sent: string[] = [];
    const client: CleanUpClient = {
        trashMany: async (_ws, ids) => {
            sent.push(`trash ${ids.length}`);
            state.on = false;
            return {
                results: ids.map((id): TrashBatchItem => ({
                    id,
                    status: 'trashed',
                    trashedAt: 'now',
                    changeSeq: 1,
                })),
            };
        },
        purgeMany: async (_ws, ids) => {
            sent.push(`purge ${ids.length}`);
            state.on = false;
            // The workspace too busy: the Trash page's rule sends it again after a pause.
            throw new DriveApiError('Busy.', 'conflict', 409);
        },
    };
    const sends = cleanUpSends(
        () => state.on,
        () => client,
        async () => {
            sent.push('abort');
            state.on = false;
            throw new DriveApiError('Still finishing.', 'conflict', 409, { upload: 'completing' });
        },
        { pause: async () => {} },
    );
    return { state, sent, sends };
}

describe('a sign-out during a clean-up', () => {
    test(`during the first of two trash batches (${MAX_TRASH_BATCH + 1} ids): no second is sent`, async () => {
        const { sent, sends } = session();
        const ids = Array.from({ length: MAX_TRASH_BATCH + 1 }, (_, i) => `node-${i}`);
        const fates = await sends.trash('ws', ids);
        expect(sent).toEqual([`trash ${MAX_TRASH_BATCH}`]);
        expect(fates.get(ids[MAX_TRASH_BATCH]!)).toBe('refused');
    });

    test('during a delete forever the workspace was too busy for: it is not sent again', async () => {
        const { sent, sends } = session();
        const fates = await sends.purge('ws', ['node-a']);
        expect(sent).toEqual(['purge 1']);
        expect(fates.get('node-a')).toBe('refused');
    });

    test('during an abort still finishing: no next try', async () => {
        const { sent, sends } = session();
        expect(await sends.abortUpload('ws', 'up')).toBe('unknown');
        expect(sent).toEqual(['abort']);
    });

    test('while signed in, a busy delete forever is sent again', async () => {
        const sent: string[] = [];
        let tries = 0;
        const sends = cleanUpSends(
            () => true,
            () => ({
                trashMany: async () => ({ results: [] }),
                purgeMany: async (_ws, ids) => {
                    sent.push(`purge ${ids.length}`);
                    if (++tries === 1) throw new DriveApiError('Busy.', 'conflict', 409);
                    return {
                        results: ids.map((id): PurgeBatchItem => ({
                            id,
                            status: 'purged',
                            changeSeq: 2,
                        })),
                    };
                },
            }),
            async () => {},
            { pause: async () => {} },
        );
        expect((await sends.purge('ws', ['node-a'])).get('node-a')).toBe('done');
        expect(sent).toEqual(['purge 1', 'purge 1']);
    });
});
