/*
 * The outbox's rules (F7; docs/groups-design.md 2.4 "Staged chains",
 * docs/groups-server.md 6), shared with the Rust core
 * (crates/hushos-core/src/roster_calls.rs: outbox_step, AreaLedger::outbox_open)
 * so both phones and the web move an entry on the same answers and send the
 * same entries. apps/web/src/lib/groups/outbox.ts drives them; the shared
 * fixtures (crates/hushos-core/fixtures/outbox-steps.json, the outbox entries
 * in the roster-call fixtures) and the fuzz kind `outbox_entry` hold the twins
 * to each other.
 */

/* What one answer to a roster call means for its outbox entry: the core's OutboxStep. */
export type OutboxStep =
    /* 2xx, a replay of a stored call included: drop the entry, then sync. */
    | 'landed'
    /* No definite answer (none, a 5xx, a 4xx without a code, signed-out, rate-limited): the same bytes again. */
    | 'resend'
    /* 409 grants-due: send the grants route 22 asks for, then the same bytes. */
    | 'send-grants'
    /* 409 rotating, epoch-stale, root-moved, document-stale: rebuild the rotations, same roster. */
    | 'rebuild'
    /* 409 stale: another roster won. Drop it, sync, rebuild over the winner only if it still applies. */
    | 'stale'
    /* 409 members-changed or left-due: dropped, never resent. */
    | 'membership-moved'
    /* Any other refusal with a code: final for these bytes. */
    | 'refused'
    /* 404 not-member: the only answer that wipes the family from this device. */
    | 'wiped';

/*
 * The answer table: `status` is the HTTP status (0 when no answer came back),
 * `code` the refusal's code when the server gave one.
 */
export function outboxStep(status: number, code: string | null): OutboxStep {
    if (status >= 200 && status < 300) return 'landed';
    if (status === 404 && code === 'not-member') return 'wiped';
    // A refusal: a 4xx with a code, but not the session's or the rate limiter's.
    const refusal =
        status >= 400 &&
        status < 500 &&
        code !== null &&
        code !== 'signed-out' &&
        code !== 'rate-limited';
    if (!refusal) return 'resend';
    switch (code) {
        case 'grants-due':
            return 'send-grants';
        case 'rotating':
        case 'epoch-stale':
        case 'root-moved':
        case 'document-stale':
            return 'rebuild';
        case 'stale':
            return 'stale';
        case 'members-changed':
        case 'left-due':
            return 'membership-moved';
        default:
            return 'refused';
    }
}

export type OutboxRoute =
    | { kind: 'create' }
    | { kind: 'rosters' }
    | { kind: 'admit'; userId: string }
    | { kind: 'member'; userId: string }
    | { kind: 'remove'; userId: string }
    | { kind: 'areas' }
    | { kind: 'rotation'; workspaceId: string }
    | { kind: 'delete'; workspaceId: string };

/* Why an entry is kept but never sent: the core's OutboxHold. */
export type OutboxHold = 'awaiting-check' | 'other-keys' | 'committed';

export type OutboxRead =
    /* `body`: the exact text to send (the core keeps it as text; a web entry's object, as JSON). */
    | { status: 'send'; id: string; route: OutboxRoute; body: string }
    | { status: 'hold'; id: string; route: OutboxRoute; reason: OutboxHold }
    /* The committed chain holds the call's roster: it landed. Drop it; nothing is sent. */
    | { status: 'landed'; id: string; route: OutboxRoute }
    /* The committed chain moved off the head it was built on without it: it can never land. */
    | { status: 'superseded'; id: string; route: OutboxRoute };

const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function routeOf(value: unknown): OutboxRoute | null {
    if (!isObject(value)) return null;
    const { kind, userId, workspaceId } = value;
    switch (kind) {
        case 'create':
        case 'rosters':
        case 'areas':
            return { kind };
        case 'admit':
        case 'member':
        case 'remove':
            return isId(userId) ? { kind, userId } : null;
        case 'rotation':
        case 'delete':
            return isId(workspaceId) ? { kind, workspaceId } : null;
        default:
            return null;
    }
}

/* Whether every string in a parsed value (keys included) is well-formed UTF-16, as serde_json requires. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function wellFormed(value: unknown): boolean {
    if (typeof value === 'string') return !LONE_SURROGATE.test(value);
    if (Array.isArray(value)) return value.every(wellFormed);
    if (isObject(value))
        return Object.entries(value).every(
            ([key, at]) => !LONE_SURROGATE.test(key) && wellFormed(at),
        );
    return true;
}

/* A body as an entry holds it: the core's exact text (of a JSON object), or the web's object. */
function bodyText(value: unknown): string | null {
    if (isObject(value)) return JSON.stringify(value);
    if (typeof value !== 'string') return null;
    try {
        const parsed: unknown = JSON.parse(value);
        return isObject(parsed) && wellFormed(parsed) ? value : null;
    } catch {
        return null;
    }
}

/*
 * An outbox entry as opened from the device store, read for `groupId`: null
 * when it is no entry (deleted, and counted as lost), else what to do with it,
 * field by field in the core's order (version, a non-empty id and, with
 * `options.id`, that one, family, staged envelope, state, body, route; then an
 * earlier version's held-back admission; against `options.head`, the
 * committed chain's roster digests, landed or superseded; an admission's keys;
 * a creation committed but not pinned). An admission is sent only while `pin`,
 * the admin's pin of the person now (their user id and fingerprint), has the
 * fingerprint the entry was built from.
 */
export function readOutboxEntry(
    value: unknown,
    groupId: string,
    pin: { userId: string; fingerprint: string } | null,
    options: { id?: string; head?: readonly string[] | null } = {},
): OutboxRead | null {
    if (!isObject(value)) return null;
    if (value.v !== 1) return null;
    if (typeof value.id !== 'string' || value.id === '') return null;
    // The kept id compared without ASCII case, as user ids are (the core's eq_ignore_ascii_case).
    if (options.id !== undefined && asciiLower(value.id) !== asciiLower(options.id)) return null;
    if (value.groupId !== groupId) return null;
    if (typeof value.stagedEnvelope !== 'string') return null;
    const state = value.state;
    if (state !== 'awaiting-check' && state !== 'ready' && state !== 'committed') return null;
    const body = bodyText(value.body);
    if (body === null) return null;
    const route = routeOf(value.route);
    if (!route) return null;
    const id = value.id;
    const hold = (reason: OutboxHold): OutboxRead => ({ status: 'hold', id, route, reason });
    if (state === 'awaiting-check') return hold('awaiting-check');
    // Answered here when the committed chain says so: it landed, or it never can.
    const digest = (key: string) =>
        typeof value[key] === 'string' && value[key] !== '' ? (value[key] as string) : null;
    const previous = digest('previousRosterDigest');
    const own = digest('rosterDigest');
    if (options.head && previous && own) {
        if (options.head.includes(own)) return { status: 'landed', id, route };
        // Superseded only when the chain passed through the head it was built on and moved on.
        if (options.head.includes(previous) && options.head.at(-1) !== previous)
            return { status: 'superseded', id, route };
    }
    if (route.kind === 'admit') {
        const admits = isObject(value.admits) ? value.admits : null;
        const same =
            admits !== null &&
            typeof admits.userId === 'string' &&
            typeof admits.fingerprint === 'string' &&
            pin !== null &&
            admits.userId === route.userId &&
            pin.userId === route.userId &&
            admits.fingerprint === pin.fingerprint;
        if (!same) return hold('other-keys');
    }
    if (state === 'committed') return hold('committed');
    return { status: 'send', id, route, body };
}
