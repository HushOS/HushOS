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
            'envelope',
            'recovery',
            'identity',
            'signature',
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
]);
const FAILURE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
// Only an error's class name and machine code survive: enough to tell an SMTP refusal
// from a database outage, never a message or stack that could carry an address.
export function sanitizeFailure(value: unknown) {
    if (!value || typeof value !== 'object') return undefined;
    const input = value as Record<string, unknown>;
    // `kind`, not `name`: bare `name` is a redacted leaf everywhere else in the event.
    const kind =
        typeof input.name === 'string' && FAILURE_TOKEN.test(input.name) ? input.name : 'unknown';
    const code =
        typeof input.code === 'string' && FAILURE_TOKEN.test(input.code) ? input.code : undefined;
    return code ? { kind, code } : { kind };
}
export function authLogAction(pathname: string) {
    const action = pathname.slice('/api/auth/'.length);
    return authActions.has(action) ? action : 'unknown';
}

// Runtime transform: evlog applies it before console output and before drains.
// Keep auth telemetry allowlisted even if a future handler attaches a raw object.
export function redactAuthenticationEvent(event: WideEvent) {
    const path = typeof event.path === 'string' ? (event.path.split(/[?#]/)[0] ?? '') : '';
    const privateRoute =
        /^\/(api\/auth(?:\/|$)|app(?:\/|$)|register(?:\/|$)|recover(?:\/|$)|login(?:\/|$)|setup(?:\/|$))/.test(
            path,
        );
    event.path = path;
    if (!privateRoute) return;
    for (const key of Object.keys(event)) if (!safeAuthFields.has(key)) delete event[key];
    if (path.startsWith('/api/auth/')) event.path = `/api/auth/${authLogAction(path)}`;
    else {
        const knownPages = new Set([
            '/app',
            '/app/account',
            '/setup/recovery-key',
            '/app/recovery-key',
            '/login',
            '/register',
            '/register/check-email',
            '/register/complete',
            '/recover',
            '/recover/check-email',
            '/recover/complete',
        ]);
        event.path = knownPages.has(path) ? path : '/private/unknown';
    }
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
