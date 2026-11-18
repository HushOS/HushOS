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
        async () => null,
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
            async () => null,
            { pause: async () => {} },
        );
        expect((await sends.purge('ws', ['node-a'])).get('node-a')).toBe('done');
        expect(sent).toEqual(['purge 1', 'purge 1']);
    });
});

/*
 * A family folder that may not be changed now (read-only here, its keys changed since the run
 * began): its clean-up removes nothing, before any batch or resend, and every item stays refused,
 * so the run's row is kept for when it may.
 */
describe('a family folder that may not be changed', () => {
    function family(refusals: (string | null)[]) {
        const sent: string[] = [];
        let tries = 0;
        let asked = 0;
        const sends = cleanUpSends(
            () => true,
            () => ({
                trashMany: async (_ws, ids) => {
                    sent.push(`trash ${ids.length}`);
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
            // Asked before each send: its answers in turn, the last one standing.
            async () => refusals[Math.min(asked++, refusals.length - 1)] ?? null,
            { pause: async () => {} },
        );
        return { sent, sends };
    }
    const changed = 'This folder’s keys changed. Use Check again on the folder, then try again.';

    test('read-only or re-keyed from the start: nothing is trashed or deleted forever', async () => {
        const { sent, sends } = family([changed]);
        const ids = Array.from({ length: MAX_TRASH_BATCH + 1 }, (_, i) => `node-${i}`);
        const trashed = await sends.trash('ws-family', ids);
        expect([...trashed.values()].every((fate) => fate === 'refused')).toBe(true);
        const purged = await sends.purge('ws-family', ['node-a']);
        expect(purged.get('node-a')).toBe('refused');
        expect(sent).toEqual([]);
    });

    test('its keys changing between two batches, or before a resend: nothing more is sent', async () => {
        const between = family([null, changed]);
        const ids = Array.from({ length: MAX_TRASH_BATCH + 1 }, (_, i) => `node-${i}`);
        const trashed = await between.sends.trash('ws-family', ids);
        expect(between.sent).toEqual([`trash ${MAX_TRASH_BATCH}`]);
        expect(trashed.get(ids[MAX_TRASH_BATCH]!)).toBe('refused');
        // A delete forever the workspace was too busy for is not sent again once it may not be.
        const resend = family([null, changed]);
        expect((await resend.sends.purge('ws-family', ['node-a'])).get('node-a')).toBe('refused');
        expect(resend.sent).toEqual(['purge 1']);
    });
});
