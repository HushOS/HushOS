// @vitest-environment node
import { treaty } from '@elysia/eden';
import { describe, expect, test } from 'vitest';
import type { Api } from '@/lib/api.server';
import { createGroupsApi, GroupApiError, isRefusal, NO_ANSWER } from './api';

/*
 * The outbox decides on what answer() reports: a refusal drops the staged
 * call, anything else keeps it to send again. Eden 2.0.0-beta.5 reports a
 * fetch that threw as a 503 with no response, the same status a real server
 * gives when it is unavailable. The two must stay apart: a dropped connection
 * is no answer at all, and a server's 503 keeps its status and code. Neither
 * may read as a refusal, or the outbox throws away a call the server never
 * turned down.
 */

const GROUP = '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';

/* The real Eden client the app uses, with the network swapped for `fetcher`. */
function groupsWith(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    // Eden types the option as the global fetch, which carries Bun's `preconnect` too.
    const client = treaty<Api>('http://hushos.test', { fetcher: fetcher as typeof fetch });
    return createGroupsApi(() => client.api);
}

function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function failure(pending: Promise<unknown>) {
    const error = await pending.then(
        () => {
            throw new Error('expected the call to fail');
        },
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(GroupApiError);
    return error as GroupApiError;
}

describe('groups client answers', () => {
    test('a fetch that throws is no answer, not a 503 and not a refusal', async () => {
        const api = groupsWith(async () => {
            throw new TypeError('Failed to fetch');
        });
        const error = await failure(api.group(GROUP));
        expect(error.status).toBe(0);
        expect(error.code).toBeNull();
        expect(error.message).toBe(NO_ANSWER);
        expect(isRefusal(error)).toBe(false);
    });

    test("a server's 503 keeps its status and code and is not a refusal", async () => {
        const api = groupsWith(async () =>
            json(503, { code: 'unavailable', message: 'Groups are paused.' }),
        );
        const error = await failure(api.rename(GROUP, 'Household'));
        expect(error.status).toBe(503);
        expect(error.code).toBe('unavailable');
        expect(error.message).toBe('Groups are paused.');
        expect(isRefusal(error)).toBe(false);
    });

    test('a coded 4xx is a refusal carrying its code and data', async () => {
        const api = groupsWith(async () =>
            json(409, { code: 'stale', message: 'The roster moved.', data: { revision: 7 } }),
        );
        const error = await failure(api.rename(GROUP, 'Household'));
        expect(error.status).toBe(409);
        expect(error.code).toBe('stale');
        expect(error.data).toEqual({ revision: 7 });
        expect(isRefusal(error)).toBe(true);
    });
});
