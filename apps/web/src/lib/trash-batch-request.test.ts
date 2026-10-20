import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';
import { describe, expect, test } from 'vitest';
import { boundTrashBatch, TRASH_BATCH_BODY_BYTES } from '@/lib/trash-batch-request';

/*
 * The batch routes' edge: a body past the cap is refused before anything
 * parses it, and the largest batch a client may send still fits.
 */

const ORIGIN = 'http://localhost';
const WORKSPACE = '0b6d4a3e-2c1f-4d5e-8a9b-1c2d3e4f5a6b';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const post = (path: string, body: string) =>
    new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
    });

describe('a batch request’s body', () => {
    test('past the cap is a 413, for trash, restore and purge', async () => {
        const huge = JSON.stringify({ nodeIds: Array.from({ length: 400 }, (_, n) => id(n)) });
        expect(huge.length).toBeGreaterThan(TRASH_BATCH_BODY_BYTES);
        for (const route of ['trash-batch', 'restore-batch', 'purge-batch']) {
            const answer = await boundTrashBatch(
                post(`/api/drive/workspaces/${WORKSPACE}/${route}`, huge),
            );
            expect(answer).toBeInstanceOf(Response);
            expect((answer as Response).status).toBe(413);
            expect(await (answer as Response).json()).toMatchObject({ code: 'too-large' });
        }
    });

    test('the largest batch a client may send fits, and reaches the route as it was sent', async () => {
        const body = JSON.stringify({
            nodeIds: Array.from({ length: MAX_TRASH_BATCH }, (_, n) => id(n)),
        });
        const answer = await boundTrashBatch(
            post(`/api/drive/workspaces/${WORKSPACE}/trash-batch`, body),
        );
        expect(answer).toBeInstanceOf(Request);
        expect(await (answer as Request).text()).toBe(body);
    });

    test('any other request goes on untouched, however large', async () => {
        const huge = 'x'.repeat(TRASH_BATCH_BODY_BYTES * 2);
        expect(await boundTrashBatch(post(`/api/drive/nodes/${id(1)}/trash`, huge))).toBeNull();
        expect(
            await boundTrashBatch(
                new Request(`${ORIGIN}/api/drive/workspaces/${WORKSPACE}/trash-batch`),
            ),
        ).toBeNull();
    });
});
