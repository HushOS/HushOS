import { groupLogAction } from '@hushos/logging';
import {
    CREATE_BODY_BYTES,
    GRANTS_BODY_BYTES,
    MAX_ROSTER_BODIES_IN_FLIGHT,
    SEALS_BODY_BYTES,
    SMALL_BODY_BYTES,
    rosterBodyLimit,
    type RosterDocuments,
} from '@hushos/groups/protocol';

/*
 * The edge of every group request (docs/groups-server.md 4), apart from the
 * server so it can be tested without one: off when GROUPS_ENABLED is false
 * (501, as for any route this server does not offer, which no client reads as
 * "gone"); private and uncached; logged by pattern only; a named client and a
 * session first, then the per-account rate limits; and every body read as a
 * stream under its cap before anything parses it. A roster route's cap
 * follows the group's head roster and is worked out only for a `members`
 * holder of that group, so nobody can make the server buffer megabytes for a
 * group they cannot write to, and one account has at most two roster bodies
 * in flight at once (per server process).
 */

export type GroupRequestDeps = {
    enabled: () => boolean;
    /* Throws (with a `status`) for a client below the operator's minimum. */
    requireClient: (request: Request) => void;
    /* Throws (with a `status`) for a mutation from another origin. */
    guardMutation: (request: Request) => void;
    sessionUser: (request: Request) => Promise<{ id: string } | null>;
    consumeRateLimit: (bucket: string, count: number, windowMs: number) => Promise<boolean>;
    rosterContext: (
        userId: string,
        groupId: string,
    ) => Promise<
        | { status: 'not-member' }
        | { status: 'not-holder' }
        | { status: 'ok'; headStatementBytes: number; areas: number }
    >;
    handle: (request: Request) => Promise<Response>;
    log: { set: (fields: Record<string, unknown>) => void; error: (error: Error) => void };
    describeFailure: (error: unknown) => unknown;
};

const HEADERS = {
    'Cache-Control': 'private, no-store',
    Vary: 'Cookie',
    'Referrer-Policy': 'no-referrer',
};

/*
 * A group route's body cap, or for the roster routes, whose cap follows the
 * group's head, which of the group's areas' documents the request may re-seal.
 */
export function groupBodyCap(method: string, path: string): number | { roster: RosterDocuments } {
    const tail = path.replace(/^\/api\//, '');
    if (method === 'POST' && tail === 'groups') return CREATE_BODY_BYTES;
    if (/^groups\/[^/]+\/(key-seals|key-successions)$/.test(tail)) return SEALS_BODY_BYTES;
    if (/^groups\/[^/]+\/areas\/[^/]+\/grants$/.test(tail)) return GRANTS_BODY_BYTES;
    if (method === 'POST' && /^groups\/[^/]+\/(rosters|members\/[^/]+\/remove)$/.test(tail))
        return { roster: 'all' };
    if (method === 'PATCH' && /^groups\/[^/]+\/members\/[^/]+$/.test(tail))
        return { roster: 'all' };
    if (method === 'POST' && /^groups\/[^/]+\/areas\/[^/]+\/rotations$/.test(tail))
        return { roster: 'one' };
    if (method === 'POST' && /^groups\/[^/]+\/(areas|members\/[^/]+\/admit)$/.test(tail))
        return { roster: 'none' };
    return SMALL_BODY_BYTES;
}

/* Reads a body as a stream, stopping at the first byte past `limit`: null when it is too large. */
async function readCapped(request: Request, limit: number) {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader)
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
    }
    return body;
}

export function createGroupRequestHandler(deps: GroupRequestDeps) {
    // Roster bodies each account is reading or handling now: the largest bodies, held whole.
    const rosterBodies = new Map<string, number>();
    return async function handleGroupRequest(request: Request): Promise<Response> {
        let release: (() => void) | undefined;
        const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
        deps.log.set({ group: { action: groupLogAction(pathname) } });
        const refuse = async (status: number, body: { message: string; code: string }) => {
            await request.body?.cancel().catch(() => undefined);
            deps.log.set({ group: { outcome: status >= 500 ? 'unavailable' : 'rejected' } });
            return Response.json(body, { status, headers: HEADERS });
        };
        if (!deps.enabled())
            return refuse(501, {
                message: 'This server does not offer groups yet.',
                code: 'unsupported',
            });
        try {
            deps.requireClient(request);
            const mutation = request.method !== 'GET' && request.method !== 'HEAD';
            if (mutation) deps.guardMutation(request);
            const user = await deps.sessionUser(request);
            if (!user)
                return refuse(401, { message: 'Sign in to open your groups.', code: 'signed-out' });
            const bucket = mutation
                ? { name: `groups:write:user:${user.id}`, count: 120 }
                : /\/(rosters|identities)$|\/areas\/[^/]+\/root$/.test(pathname)
                  ? { name: `groups:read:user:${user.id}`, count: 300 }
                  : null;
            if (bucket && !(await deps.consumeRateLimit(bucket.name, bucket.count, 60_000)))
                return refuse(429, {
                    message: 'Too many requests to groups just now. Please try again shortly.',
                    code: 'rate-limited',
                });
            if (mutation) {
                const cap = groupBodyCap(request.method, pathname);
                let limit: number;
                if (typeof cap === 'object') {
                    const groupId = pathname.split('/')[3] ?? '';
                    const context: Awaited<ReturnType<GroupRequestDeps['rosterContext']>> =
                        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                            groupId,
                        )
                            ? await deps.rosterContext(user.id, groupId)
                            : { status: 'not-member' };
                    if (context.status === 'not-member')
                        return refuse(404, {
                            message: 'This group does not exist.',
                            code: 'not-member',
                        });
                    // A member who may not write rosters is refused, never told they are not in it.
                    if (context.status === 'not-holder')
                        return refuse(403, {
                            message: 'Only someone who manages the group can do that.',
                            code: 'forbidden',
                        });
                    const inFlight = rosterBodies.get(user.id) ?? 0;
                    if (inFlight >= MAX_ROSTER_BODIES_IN_FLIGHT)
                        return refuse(429, {
                            message:
                                'Too many changes to groups at once. Please try again shortly.',
                            code: 'rate-limited',
                        });
                    rosterBodies.set(user.id, inFlight + 1);
                    release = () => {
                        const left = (rosterBodies.get(user.id) ?? 1) - 1;
                        if (left > 0) rosterBodies.set(user.id, left);
                        else rosterBodies.delete(user.id);
                    };
                    limit = rosterBodyLimit(context.headStatementBytes, context.areas, cap.roster);
                } else limit = cap;
                const body = await readCapped(request, limit);
                if (!body)
                    return refuse(413, { message: 'Request is too large.', code: 'too-large' });
                request = new Request(request.url, {
                    method: request.method,
                    headers: request.headers,
                    body,
                });
            }
            const result = await deps.handle(request);
            deps.log.set({
                group: {
                    outcome:
                        result.status < 400
                            ? 'success'
                            : result.status < 500
                              ? 'rejected'
                              : 'unavailable',
                },
            });
            for (const [key, value] of Object.entries(HEADERS)) result.headers.set(key, value);
            return result;
        } catch (error) {
            const status = (error as { status?: unknown }).status;
            if (typeof status === 'number' && status >= 400 && status < 500)
                return refuse(status, {
                    message: (error as Error).message,
                    code: (error as { code?: string }).code ?? 'forbidden',
                });
            deps.log.set({ failure: deps.describeFailure(error) });
            deps.log.error(new Error('Group request failed.'));
            return refuse(503, {
                message: 'Groups are temporarily unavailable. Please try again.',
                code: 'unavailable',
            });
        } finally {
            release?.();
        }
    };
}
