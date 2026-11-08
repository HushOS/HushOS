import '@/lib/server-only';
import { createHash } from 'node:crypto';
import { cors } from '@elysia/cors';
import { authLogAction } from '@hushos/logging';
import { Elysia } from 'elysia';
import * as auth from '@hushos/auth/server';
import { guardAuthMutation, readSessionToken } from '@hushos/auth/http';
import * as billing from '@hushos/billing/server';
import { authRepository } from '@hushos/db';
import * as groups from '@hushos/groups/server';
import { createGroupRequestHandler } from '@/lib/group-requests';
import { bodyCap, boundBody } from '@/lib/body-caps';
import { useLogger } from '@/lib/logging.server';
import { authApi } from '@/lib/api/auth.server';
import { billingApi } from '@/lib/api/billing.server';
import { driveApi } from '@/lib/api/drive.server';
import { adminApi } from '@/lib/api/admin.server';
import { groupsApi } from '@/lib/api/groups.server';
import { notificationsApi } from '@/lib/api/notifications.server';
import { systemApi } from '@/lib/api/system.server';
import {
    describeFailure,
    requestAddress,
    requestContext,
    requireClient,
} from '@/lib/api/shared.server';

export const apiApp = new Elysia({ prefix: '/api' })
    .use(
        cors({
            origin: import.meta.env.DEV,
            methods: ['GET', 'OPTIONS'],
            exposeHeaders: ['x-request-id'],
            credentials: false,
        }),
    )
    .use(requestContext)
    .use(authApi)
    .use(billingApi)
    .use(driveApi)
    .use(adminApi)
    .use(groupsApi)
    .use(notificationsApi)
    .use(systemApi);

export type Api = typeof apiApp;

/*
 * Before a body larger than the default cap is read (body-caps.ts): a signed-in account, within
 * its own rate limit and its address's, so neither a stranger nor one account can make the server
 * buffer megabytes at will. Its own buckets, not auth's: a bulk upload completes one upload a file.
 */
const LARGE_BODIES = { perAccount: 600, perAddress: 1_200, windowMs: 60_000 } as const;
// A rotation part, up to 8 MiB: a page of widely shared files is sent in a few, so a rotation
// sends tens a minute at most, never hundreds.
const HUGE_BODIES = { perAccount: 60, perAddress: 120, windowMs: 60_000 } as const;
async function largeBodyAllowed(request: Request): Promise<Response | null> {
    const huge = bodyCap(request.method, new URL(request.url).pathname).bytes > 4 * 1024 * 1024;
    const limits = huge ? HUGE_BODIES : LARGE_BODIES;
    const user = await auth.getSessionUser(readSessionToken(request));
    if (!user)
        return Response.json(
            { message: 'Sign in to continue.', code: 'forbidden' },
            { status: 401 },
        );
    const bucket = (key: string) =>
        createHash('sha256')
            .update(`api:${huge ? 'huge' : 'large'}-body:${key}`)
            .digest();
    const allowed =
        (await authRepository.consumeRateLimit(
            bucket(`user:${user.id}`),
            limits.perAccount,
            limits.windowMs,
        )) &&
        (await authRepository.consumeRateLimit(
            bucket(`address:${requestAddress(request)}`),
            limits.perAddress,
            limits.windowMs,
        ));
    return allowed
        ? null
        : Response.json(
              { message: 'Too many requests. Wait a minute and try again.', code: 'rate-limited' },
              { status: 429 },
          );
}

// Bound auth bodies before JSON parsing; never log protocol messages or tokens.
export async function handleApiRequest(request: Request): Promise<Response> {
    if (request.method === 'HEAD') {
        const result = await handleApiRequest(
            new Request(request.url, { method: 'GET', headers: request.headers }),
        );
        return new Response(null, { status: result.status, headers: result.headers });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/billing/webhook') return handleBillingWebhook(request);
    if (/^\/api\/(groups|invitations)(\/|$)/.test(pathname)) return handleGroupRequest(request);
    // Every other write is read under its route's cap before anything parses it (lib/body-caps.ts).
    if (!pathname.startsWith('/api/auth/')) {
        const bounded = await boundBody(request, () => largeBodyAllowed(request));
        if (bounded instanceof Response) return bounded;
        request = bounded;
    }
    // Settings carry every pin and the sharing ledger: up to 64 KiB sealed, Base64url, in JSON.
    /*
     * Auth bodies are small, so they are read whole under a cap. A few carry
     * identities, which are about 9 KB each since they hold ML-DSA and ML-KEM
     * public keys and a 3373-byte keys signature: a succession adds a hybrid
     * signature, and a master-key rotation carries every earlier identity.
     */
    const SETTINGS_BODY_LIMIT = 96 * 1024;
    const bodyLimit = (path: string) =>
        path === '/api/auth/settings'
            ? SETTINGS_BODY_LIMIT
            : path === '/api/auth/security/finish'
              ? // Up to every earlier identity beside the current one; narrowed per account below.
                (authRepository.IDENTITY_HISTORY_LIMIT + 1) * auth.SECURITY_CHANGE_IDENTITY_BYTES +
                auth.SECURITY_CHANGE_REST_BYTES
              : path === '/api/auth/identity/succession' ||
                  path === '/api/auth/identity/upgrade' ||
                  path === '/api/auth/register/finish' ||
                  path === '/api/auth/setup'
                ? 64 * 1024
                : 16_384;
    if (!pathname.startsWith('/api/auth/')) return apiApp.fetch(request);
    const log = useLogger();
    log.set({ auth: { action: authLogAction(new URL(request.url).pathname) } });
    const headers = {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    };
    // A path the API does not define answers before its body is read or the shared budget is
    // spent: a client looping on a removed route must not lock out sign-ins behind its address.
    // The logging allowlist decides it; auth-log-routes.test.ts keeps the two in step.
    if (authLogAction(pathname.replace(/\/+$/, '')) === 'unknown') {
        await request.body?.cancel();
        log.set({ auth: { outcome: 'rejected' } });
        return Response.json({ message: 'Not found.' }, { status: 404, headers });
    }
    try {
        if (request.method !== 'GET' && request.method !== 'OPTIONS') {
            guardAuthMutation(request);
            let limit = bodyLimit(pathname);
            // The one route whose cap runs to megabytes is rate limited before its body is read,
            // read only for a current session, and only as far as that account's identities need,
            // so neither a stranger nor a fresh account can make the server buffer megabytes.
            const large = limit > SETTINGS_BODY_LIMIT;
            if (large) {
                await auth.limitAuthMutation(requestAddress(request));
                const allowed = await auth.securityChangeBodyLimit(readSessionToken(request));
                if (allowed === null) {
                    await request.body?.cancel();
                    log.set({ auth: { outcome: 'rejected' } });
                    return Response.json(
                        { message: 'Sign in before changing account security.' },
                        { status: 401, headers },
                    );
                }
                limit = Math.min(limit, allowed);
            }
            const reader = request.body?.getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            if (reader) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    length += value.byteLength;
                    if (length > limit) {
                        await reader.cancel();
                        log.set({ auth: { outcome: 'rejected' } });
                        return Response.json(
                            { message: 'Request is too large.' },
                            { status: 413, headers },
                        );
                    }
                    chunks.push(value);
                }
            }
            const body = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.length;
            }
            request = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body,
            });
            // Consume the budget only for requests that passed the cheap checks above.
            if (!large) await auth.limitAuthMutation(requestAddress(request));
        }
        const result = await apiApp.fetch(request);
        log.set({
            auth: {
                outcome:
                    result.status < 400
                        ? 'success'
                        : result.status < 500
                          ? 'rejected'
                          : 'unavailable',
            },
        });
        for (const [key, value] of Object.entries(headers)) result.headers.set(key, value);
        return result;
    } catch (error) {
        log.set({
            auth: {
                outcome:
                    error instanceof auth.AuthError && error.status < 500
                        ? 'rejected'
                        : 'unavailable',
            },
        });
        if (!(error instanceof auth.AuthError) || error.status >= 500) {
            log.set({ auth: { failure: describeFailure(error) } });
            log.error(new Error('Authentication request failed.'));
        }
        return Response.json(
            {
                message:
                    error instanceof auth.AuthError
                        ? error.message
                        : 'Authentication is temporarily unavailable. Please try again.',
                code: error instanceof auth.AuthError ? error.code : undefined,
            },
            { status: error instanceof auth.AuthError ? error.status : 503, headers },
        );
    }
}

/* Provider deliveries: raw body for the signature, never an Origin check or a rate limit. */
async function handleBillingWebhook(request: Request): Promise<Response> {
    const log = useLogger();
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    try {
        const response = await billing.handleWebhook(request);
        log.set({ billing: { webhook: response.status < 400 ? 'accepted' : 'rejected' } });
        return response;
    } catch (error) {
        log.set({ billing: { webhook: 'failed', failure: describeFailure(error) } });
        log.error(new Error('Billing webhook failed.'));
        return Response.json({ message: 'Try again later.' }, { status: 503 });
    }
}

/* Group requests through their edge (group-requests.ts), with this server's own checks. */
const handleGroupRequest = (request: Request) =>
    createGroupRequestHandler({
        enabled: groups.groupsEnabled,
        requireClient,
        guardMutation: guardAuthMutation,
        sessionUser: (req) => auth.getSessionUser(readSessionToken(req)),
        consumeRateLimit: (bucket, count, windowMs) =>
            authRepository.consumeRateLimit(
                createHash('sha256').update(bucket).digest(),
                count,
                windowMs,
            ),
        rosterContext: groups.rosterBodyContext,
        handle: async (req) => apiApp.fetch(req),
        log: useLogger(),
        describeFailure,
    })(request);
