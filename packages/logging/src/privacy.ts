import { initLogger, type WideEvent } from 'evlog';

export const loggingOptions = {
    env: { service: 'HushOS Web' },
    routes: { '/api/**': { service: 'HushOS API' } },
    redact: {
        paths: [
            '*password*',
            '*Password*',
            '*secret*',
            '*Secret*',
            '*token*',
            '*Token*',
            '*key*',
            '*Key*',
            '*phrase*',
            '*Phrase*',
            '*mnemonic*',
            '*Mnemonic*',
            '*credential*',
            '*Credential*',
            '*opaque*',
            '*Opaque*',
            'body',
            'requestBody',
            'responseBody',
            'headers',
            'cookies',
            'cookie',
            'authorization',
            'email',
            'name',
            'query',
            'search',
            'params',
            'registrationRequest',
            'registrationResponse',
            'registrationRecord',
            'startLoginRequest',
            'finishLoginRequest',
            'loginResponse',
            'serverState',
            'clientState',
            // Every sealed blob and signature by any name: shareEnvelope, metadataSignature,
            // kemSignature, prevShareEnvelope, contentKeyEnvelope and whatever comes next.
            '*envelope*',
            '*Envelope*',
            '*signature*',
            '*Signature*',
            'settingsKey',
            'recovery',
            'identity',
            'error.data',
            'error.cause',
            'error.stack',
        ],
    },
};

export function initProcessLogger(service: string) {
    initLogger({
        ...loggingOptions,
        env: { service },
        redact: { ...loggingOptions.redact, transform: redactAuthenticationEvent },
    });
}

const safeAuthFields = new Set([
    'timestamp',
    'level',
    'service',
    'environment',
    'version',
    'commitHash',
    'region',
    'method',
    'path',
    'requestId',
    'status',
    'duration',
    'durationMs',
    'auth',
    'group',
    'failure',
]);
const authActions = new Set([
    'register/email',
    'register/verify',
    'register',
    'register/start',
    'register/finish',
    'login/start',
    'login/finish',
    'session',
    'session/forget',
    'logout',
    'recover/email',
    'recover',
    'recover/start',
    'recover/finish',
    'recovery-key',
    'recovery-key/confirm',
    'storage',
    'setup',
    'security/start',
    'security/finish',
    'delete/start',
    'delete/finish',
    'identity',
    'identity/upgrade',
    'identity/succession',
    'identity/succession/consent',
    'identity/history',
    'contacts/lookup',
    'contacts/:userId/succession',
    'settings',
    'settings-key',
    'profile',
    'devices',
    'devices/:id',
    'devices/others',
    'devices/reauth',
]);
const FAILURE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
export type Failure = { kind: string; code?: string; cause?: Failure };
// Only an error's class name and machine code survive, and the same for what caused
// it (a query wrapper's Postgres error, say): enough to tell an SMTP refusal from a
// database outage or a missing grant, never a message or stack that could carry an
// address.
export function sanitizeFailure(value: unknown, depth = 3): Failure | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const input = value as Record<string, unknown>;
    // `kind`, not `name`: bare `name` is a redacted leaf everywhere else in the event.
    const kind =
        typeof input.name === 'string' && FAILURE_TOKEN.test(input.name) ? input.name : 'unknown';
    const code =
        typeof input.code === 'string' && FAILURE_TOKEN.test(input.code) ? input.code : undefined;
    const cause =
        depth > 1 && input.cause !== value ? sanitizeFailure(input.cause, depth - 1) : undefined;
    return { kind, ...(code ? { code } : {}), ...(cause ? { cause } : {}) };
}
// Pages behind the private prefixes, by their exact path. One that carries an
// identifier is logged as its pattern, so the identifier never reaches the log.
const knownPages = new Set([
    '/app',
    '/app/account',
    '/app/billing',
    '/app/contacts',
    '/app/drive',
    '/app/shared',
    '/app/trash',
    '/app/search',
    '/app/tags',
    '/app/referrals',
    '/app/recovery-key',
    '/app/admin',
    '/app/admin/reports',
    '/app/admin/affiliates',
    '/setup/recovery-key',
    '/login',
    '/register',
    '/register/check-email',
    '/register/complete',
    '/recover',
    '/recover/check-email',
    '/recover/complete',
]);
const pagePatterns: [RegExp, string][] = [
    [/^\/app\/drive\/f\/[^/]+$/, '/app/drive/f/:folderId'],
    [/^\/app\/tags\/[^/]+$/, '/app/tags/:tagId'],
    [/^\/app\/admin\/reports\/[^/]+$/, '/app/admin/reports/:reportId'],
];
function privatePage(path: string) {
    if (knownPages.has(path)) return path;
    return pagePatterns.find(([pattern]) => pattern.test(path))?.[1] ?? '/private/unknown';
}
/*
 * Group routes by pattern (docs/groups-server.md 4, "Logs"): group, account,
 * area and invitation ids in a path would write the social graph into every
 * drained log, so only the pattern is kept, under `group.action`.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const groupActions: [RegExp, string][] = (
    [
        ['groups', 'groups'],
        ['groups/:id', `groups/${UUID}`],
        ['groups/:id/rosters', `groups/${UUID}/rosters`],
        ['groups/:id/identities', `groups/${UUID}/identities`],
        ['groups/:id/key-seal', `groups/${UUID}/key-seal`],
        ['groups/:id/key-seals', `groups/${UUID}/key-seals`],
        ['groups/:id/key-successions', `groups/${UUID}/key-successions`],
        ['groups/:id/invitations', `groups/${UUID}/invitations`],
        ['groups/:id/invitations/:invitationId', `groups/${UUID}/invitations/${UUID}`],
        ['groups/:id/pending', `groups/${UUID}/pending`],
        ['groups/:id/members/:userId', `groups/${UUID}/members/${UUID}`],
        ['groups/:id/members/:userId/admit', `groups/${UUID}/members/${UUID}/admit`],
        ['groups/:id/members/:userId/remove', `groups/${UUID}/members/${UUID}/remove`],
        ['groups/:id/members/:userId/decline', `groups/${UUID}/members/${UUID}/decline`],
        ['groups/:id/members/:userId/hold', `groups/${UUID}/members/${UUID}/hold`],
        ['groups/:id/leave', `groups/${UUID}/leave`],
        ['groups/:id/areas', `groups/${UUID}/areas`],
        ['groups/:id/areas/:workspaceId/grants', `groups/${UUID}/areas/${UUID}/grants`],
        ['groups/:id/areas/:workspaceId/self-grant', `groups/${UUID}/areas/${UUID}/self-grant`],
        [
            'groups/:id/areas/:workspaceId/previous-root',
            `groups/${UUID}/areas/${UUID}/previous-root`,
        ],
        ['groups/:id/areas/:workspaceId/rotations', `groups/${UUID}/areas/${UUID}/rotations`],
        ['groups/:id/areas/:workspaceId/delete', `groups/${UUID}/areas/${UUID}/delete`],
        ['groups/:id/areas/:workspaceId/root', `groups/${UUID}/areas/${UUID}/root`],
        ['invitations', 'invitations'],
        ['invitations/open', 'invitations/open'],
        ['invitations/accept', 'invitations/accept'],
    ] as const
).map(([action, pattern]) => [new RegExp(`^${pattern}$`, 'i'), action]);
const groupActionNames = new Set(groupActions.map(([, action]) => action));
/* A group route's action, from its path under /api/; 'unknown' for anything else. */
export function groupLogAction(pathname: string) {
    const path = pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
    return groupActions.find(([pattern]) => pattern.test(path))?.[1] ?? 'unknown';
}

export function authLogAction(pathname: string) {
    // A contact's succession chain names the account in its path, a device its id: both
    // are stable identifiers, logged as the pattern.
    const action = pathname
        .slice('/api/auth/'.length)
        .replace(/^contacts\/[0-9a-f-]{36}\/succession$/, 'contacts/:userId/succession')
        .replace(/^devices\/[0-9a-f-]{36}$/, 'devices/:id');
    return authActions.has(action) ? action : 'unknown';
}

/*
 * Paths that carry a bearer secret or a name on public routes: a link's token
 * (which opens its ciphertext, tree and sizes to whoever holds it), and the
 * download worker's own paths, which the server only sees when the worker was
 * bypassed. Logged as their patterns.
 */
const secretPaths: [RegExp, string][] = [
    [/^\/s\/[^/]+(?:\/.*)?$/, '/s/:token'],
    [/^\/api\/drive\/links\/[^/]+/, '/api/drive/links/:link'],
    [/^\/hushos-download(?:\/.*)?$/, '/hushos-download/:download'],
];
/*
 * The path as the router matches it, so every check below sees what was
 * served: percent-decoded, lowercased, slashes collapsed. `/S/<token>` and
 * `/%73/<token>` serve a link page as surely as `/s/<token>` does.
 */
function routePath(path: string) {
    try {
        return decodeURIComponent(path)
            .toLowerCase()
            .replace(/\/{2,}/g, '/');
    } catch {
        return '/unreadable';
    }
}
function withoutSecrets(path: string) {
    for (const [pattern, replacement] of secretPaths)
        if (pattern.test(path)) return path.replace(pattern, replacement);
    return path;
}

// Runtime transform: evlog applies it before console output and before drains.
// Keep auth telemetry allowlisted even if a future handler attaches a raw object.
export function redactAuthenticationEvent(event: WideEvent) {
    const path = withoutSecrets(
        routePath(typeof event.path === 'string' ? (event.path.split(/[?#]/)[0] ?? '') : ''),
    );
    const privateRoute =
        /^\/(api\/auth(?:\/|$)|api\/groups(?:\/|$)|api\/invitations(?:\/|$)|app(?:\/|$)|register(?:\/|$)|recover(?:\/|$)|login(?:\/|$)|setup(?:\/|$))/.test(
            path,
        );
    event.path = path;
    if (!privateRoute) return;
    for (const key of Object.keys(event)) if (!safeAuthFields.has(key)) delete event[key];
    // A failure on a private page keeps its class and code, so the operator still sees what broke.
    if (event.failure) event.failure = sanitizeFailure(event.failure);
    if (path.startsWith('/api/auth/')) event.path = `/api/auth/${authLogAction(path)}`;
    else if (path.startsWith('/api/groups') || path.startsWith('/api/invitations'))
        event.path = `/api/${groupLogAction(path)}`;
    else event.path = privatePage(path);
    const group = event.group;
    if (group && typeof group === 'object') {
        const value = group as Record<string, unknown>;
        event.group = {
            action:
                typeof value.action === 'string' && groupActionNames.has(value.action)
                    ? value.action
                    : 'unknown',
            outcome:
                value.outcome === 'success' ||
                value.outcome === 'rejected' ||
                value.outcome === 'unavailable'
                    ? value.outcome
                    : 'unknown',
        };
    } else delete event.group;
    const auth = event.auth;
    if (auth && typeof auth === 'object') {
        const value = auth as Record<string, unknown>;
        event.auth = {
            action:
                typeof value.action === 'string' && authActions.has(value.action)
                    ? value.action
                    : 'unknown',
            outcome:
                value.outcome === 'success' ||
                value.outcome === 'rejected' ||
                value.outcome === 'unavailable'
                    ? value.outcome
                    : 'unknown',
            ...(value.failure ? { failure: sanitizeFailure(value.failure) } : {}),
        };
    } else delete event.auth;
}
