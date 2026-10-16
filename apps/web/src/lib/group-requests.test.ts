// @vitest-environment node
import { SMALL_BODY_BYTES, rosterBodyLimit } from '@hushos/groups/protocol';
import { describe, expect, test } from 'vitest';
import { createGroupRequestHandler, type GroupRequestDeps } from './group-requests';

/*
 * The edge every group request passes before Elysia sees it. What it must
 * hold: nothing about a group is reachable while groups are off; no body is
 * read past its cap (an attacker streaming gigabytes costs one cap's worth of
 * memory); a roster route's larger cap is only worked out for someone who
 * may write that group's rosters; and the per-account limits hold.
 */

const GROUP = '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const USER = '1c8f2d3e-4e5b-4c6d-9e7f-8091a2b3c4d5';
const CHUNK = 64 * 1024;

/* A body that records how much of it was pulled, endless unless `total` is given. */
function streamed(total = Number.POSITIVE_INFINITY) {
    const state = { pulled: 0 };
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (state.pulled >= total) return controller.close();
            const size = Math.min(CHUNK, total - state.pulled);
            state.pulled += size;
            controller.enqueue(new Uint8Array(size));
        },
    });
    return { body, state };
}

function request(method: string, path: string, body?: ReadableStream<Uint8Array>) {
    return new Request(`https://hushos.test/api/${path}`, {
        method,
        body,
        // @ts-expect-error Node needs this for a streamed body; the DOM types lack it.
        duplex: body ? 'half' : undefined,
    });
}

/* A rate limiter that counts, so the limits are exercised rather than stubbed. */
function limiter() {
    const counts = new Map<string, number>();
    return async (bucket: string, count: number) => {
        const used = (counts.get(bucket) ?? 0) + 1;
        counts.set(bucket, used);
        return used <= count;
    };
}

function setup(overrides: Partial<GroupRequestDeps> = {}) {
    const seen = { handled: [] as { path: string; bytes: number }[], sessions: 0, errors: 0 };
    const deps: GroupRequestDeps = {
        enabled: () => true,
        requireClient: () => undefined,
        guardMutation: () => undefined,
        sessionUser: async () => {
            seen.sessions += 1;
            return { id: USER };
        },
        consumeRateLimit: limiter(),
        rosterContext: async () => ({ status: 'ok', headStatementBytes: 10_000, areas: 2 }),
        handle: async (req) => {
            const bytes = (await req.arrayBuffer()).byteLength;
            seen.handled.push({ path: new URL(req.url).pathname, bytes });
            return Response.json({ ok: true }, { headers: { 'Cache-Control': 'max-age=600' } });
        },
        log: { set: () => undefined, error: () => void (seen.errors += 1) },
        describeFailure: () => ({}),
        ...overrides,
    };
    return { handle: createGroupRequestHandler(deps), seen };
}

describe('while groups are off', () => {
    test('every route answers 501 without a session lookup or reading the body', async () => {
        const { handle, seen } = setup({ enabled: () => false });
        const { body, state } = streamed();
        const response = await handle(request('POST', `groups/${GROUP}/rosters`, body));
        expect(response.status).toBe(501);
        expect(((await response.json()) as { code: string }).code).toBe('unsupported');
        expect(seen.sessions).toBe(0);
        expect(seen.handled).toEqual([]);
        expect(state.pulled).toBeLessThanOrEqual(CHUNK);
        const read = await handle(request('GET', 'groups'));
        expect(read.status).toBe(501);
    });
});

describe('before any body is read', () => {
    test('no session is 401 and the handler never runs', async () => {
        const { handle, seen } = setup({ sessionUser: async () => null });
        const response = await handle(request('POST', `groups/${GROUP}/leave`, streamed(2).body));
        expect(response.status).toBe(401);
        expect(seen.handled).toEqual([]);
    });

    test('a cross-origin mutation is refused before the session is looked up', async () => {
        const { handle, seen } = setup({
            guardMutation: () => {
                throw Object.assign(new Error('Cross-origin request.'), { status: 403 });
            },
        });
        const response = await handle(request('POST', `groups/${GROUP}/leave`, streamed(2).body));
        expect(response.status).toBe(403);
        expect(seen.sessions).toBe(0);
    });

    test('an outdated client keeps its own status and code', async () => {
        const { handle } = setup({
            requireClient: () => {
                throw Object.assign(new Error('Update HushOS.'), {
                    status: 426,
                    code: 'unsupported',
                });
            },
        });
        const response = await handle(request('GET', 'groups'));
        expect(response.status).toBe(426);
        expect(((await response.json()) as { code: string }).code).toBe('unsupported');
    });
});

describe('roster routes', () => {
    test('a member who may not write rosters is 403, never told they are not in the group', async () => {
        const { handle, seen } = setup({ rosterContext: async () => ({ status: 'not-holder' }) });
        const { body, state } = streamed();
        const response = await handle(request('POST', `groups/${GROUP}/rosters`, body));
        expect(response.status).toBe(403);
        expect(((await response.json()) as { code: string }).code).toBe('forbidden');
        expect(state.pulled).toBeLessThanOrEqual(CHUNK);
        expect(seen.handled).toEqual([]);
    });

    test('someone outside the group, or a malformed id, is 404 without reading the body', async () => {
        const { handle } = setup({ rosterContext: async () => ({ status: 'not-member' }) });
        const outside = await handle(request('POST', `groups/${GROUP}/rosters`, streamed().body));
        expect(outside.status).toBe(404);
        let asked = false;
        const { handle: strict } = setup({
            rosterContext: async () => {
                asked = true;
                return { status: 'ok', headStatementBytes: 1, areas: 1 };
            },
        });
        const malformed = await strict(
            request('POST', 'groups/not-an-id/rosters', streamed().body),
        );
        expect(malformed.status).toBe(404);
        expect(asked).toBe(false);
    });

    test("the cap follows the group's head: exactly the cap passes, one byte more is 413", async () => {
        const limit = rosterBodyLimit(10_000, 2);
        const { handle, seen } = setup();
        const at = await handle(request('POST', `groups/${GROUP}/rosters`, streamed(limit).body));
        expect(at.status).toBe(200);
        expect(seen.handled).toEqual([{ path: `/api/groups/${GROUP}/rosters`, bytes: limit }]);
        const over = await handle(
            request('POST', `groups/${GROUP}/rosters`, streamed(limit + 1).body),
        );
        expect(over.status).toBe(413);
        expect(seen.handled).toHaveLength(1);
    });

    test('an id in capitals is the same group, not a stranger', async () => {
        const { handle } = setup({ rosterContext: async () => ({ status: 'not-holder' }) });
        const response = await handle(
            request('POST', `groups/${GROUP.toUpperCase()}/rosters`, streamed(2).body),
        );
        expect(response.status).toBe(403);
    });

    test('the member routes are roster routes too', async () => {
        const { handle } = setup({ rosterContext: async () => ({ status: 'not-holder' }) });
        for (const [method, path] of [
            ['POST', `groups/${GROUP}/members/${USER}/admit`],
            ['POST', `groups/${GROUP}/members/${USER}/remove`],
            ['PATCH', `groups/${GROUP}/members/${USER}`],
            ['POST', `groups/${GROUP}/areas`],
            ['POST', `groups/${GROUP}/areas/${GROUP}/rotations`],
        ] as const)
            expect((await handle(request(method, path, streamed(2).body))).status).toBe(403);
    });
});

describe('small routes', () => {
    test('an endless body is cut off just past the cap, not read to the end', async () => {
        const { handle, seen } = setup();
        const { body, state } = streamed();
        const response = await handle(request('POST', `groups/${GROUP}/leave`, body));
        expect(response.status).toBe(413);
        expect(((await response.json()) as { code: string }).code).toBe('too-large');
        expect(state.pulled).toBeLessThanOrEqual(SMALL_BODY_BYTES + 2 * CHUNK);
        expect(seen.handled).toEqual([]);
    });

    test('a body at the cap reaches the handler intact', async () => {
        const { handle, seen } = setup();
        const response = await handle(
            request('POST', `groups/${GROUP}/leave`, streamed(SMALL_BODY_BYTES).body),
        );
        expect(response.status).toBe(200);
        expect(seen.handled[0]?.bytes).toBe(SMALL_BODY_BYTES);
    });
});

describe('rate limits', () => {
    test('the 121st write in a minute is 429, and reads keep their own budget', async () => {
        const { handle, seen } = setup();
        for (let i = 0; i < 120; i += 1)
            expect((await handle(request('POST', `groups/${GROUP}/leave`))).status).toBe(200);
        const refused = await handle(request('POST', `groups/${GROUP}/leave`));
        expect(refused.status).toBe(429);
        expect(seen.handled).toHaveLength(120);
        expect((await handle(request('GET', `groups/${GROUP}/rosters`))).status).toBe(200);
    });

    test('roster and identity pages stop at 300 a minute', async () => {
        const { handle } = setup();
        for (let i = 0; i < 150; i += 1) {
            await handle(request('GET', `groups/${GROUP}/rosters`));
            await handle(request('GET', `groups/${GROUP}/identities`));
        }
        expect((await handle(request('GET', `groups/${GROUP}/identities`))).status).toBe(429);
    });
});

describe('answers', () => {
    test('every answer is private and uncached, whatever the handler set', async () => {
        const { handle } = setup();
        const response = await handle(request('GET', 'groups'));
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(response.headers.get('Vary')).toBe('Cookie');
    });

    test('an unexpected failure is 503 and logged, never its message', async () => {
        const { handle, seen } = setup({
            handle: async () => {
                throw new Error('connection to 10.0.0.5 refused');
            },
        });
        const response = await handle(request('GET', 'groups'));
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('10.0.0.5');
        expect(seen.errors).toBe(1);
    });
});
