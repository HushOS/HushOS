import { cors } from '@elysia/cors';
import { db } from '@hushos/db';
import { EvlogError, parseError, authLogAction } from '@hushos/logging';
import { API_SERVICE, APP_NAME } from '@hushos/shared';
import { welcomeMessage } from '@hushos/utils';
import { Elysia, t, ValidationError, ParseError } from 'elysia';
import * as auth from '@hushos/auth/server';

import { useLogger, useRequestId } from '@/lib/logging.server';

const requestContext = new Elysia({ name: 'hushos-api-context' })
    .derive(() => ({ log: useLogger(), requestId: useRequestId() }))
    .error(({ error, status, request }) => {
        if (new URL(request.url).pathname.startsWith('/api/auth/')) {
            if (error instanceof auth.AuthError)
                return status(error.status, { message: error.message });
            if (error instanceof ValidationError || error instanceof ParseError)
                return status(400, { message: 'Please check your information and try again.' });
            useLogger().error(new Error('Authentication request failed.'));
            return status(503, {
                message: 'Authentication is temporarily unavailable. Please try again.',
            });
        }
        if (error instanceof Error) useLogger().error(error);
        if (error instanceof EvlogError) {
            const parsed = parseError(error);
            return status(parsed.status, {
                message: parsed.message,
                why: parsed.why,
                fix: parsed.fix,
                link: parsed.link,
            });
        }
    })
    .as('global');

const emailSchema = t.String({
    minLength: 3,
    maxLength: 254,
    pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
});
const opaqueMessage = t.String({ minLength: 1, maxLength: 4096 });
const tokenSchema = t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' });
const envelopeSchema = t.Object({
    envelopeVersion: t.Literal(1),
    keyVersion: t.Literal(1),
    credentialVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    wrappingSalt: tokenSchema,
    wrappingNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedKey: t.String({ minLength: 64, maxLength: 64 }),
});

const recoverySchema = t.Object({
    version: t.Literal(1),
    keyVersion: t.Literal(1),
    recoveryVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    wrappingSalt: tokenSchema,
    wrappingNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedKey: t.String({ minLength: 64, maxLength: 64 }),
    backupNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedRecoveryKey: t.String({ minLength: 64, maxLength: 64 }),
    publicKey: tokenSchema,
});

const identitySchema = t.Object({
    version: t.Literal(1),
    keyVersion: t.Literal(1),
    wrappingSalt: tokenSchema,
    encryptionPublicKey: tokenSchema,
    encryptionPrivateKeyNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedEncryptionPrivateKey: t.String({ minLength: 64, maxLength: 64 }),
    signingPublicKey: tokenSchema,
    signingSeedNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedSigningSeed: t.String({ minLength: 64, maxLength: 64 }),
});

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
    .get('/auth/setup', ({ request }) => auth.getAccountSetup(request))
    .post(
        '/auth/setup',
        {
            body: t.Object({
                recovery: t.Optional(recoverySchema),
                identity: t.Optional(identitySchema),
            }),
        },
        ({ request, body }) => auth.initializeAccount(request, body),
    )
    .post('/auth/register/email', { body: t.Object({ email: emailSchema }) }, ({ body }) =>
        auth.requestRegistrationEmail(body.email),
    )
    .post(
        '/auth/register/verify',
        { body: t.Object({ token: tokenSchema }) },
        async ({ body, set }) => {
            const { enrollment, cookie } = await auth.verifyEmail(body.token);
            set.headers['set-cookie'] = cookie;
            return { enrollment };
        },
    )
    .get('/auth/register', async ({ request }) => ({
        enrollment: await auth.getEnrollment(request),
    }))
    .post(
        '/auth/register/start',
        { body: t.Object({ registrationRequest: opaqueMessage }) },
        ({ request, body }) => auth.startRegistration(request, body.registrationRequest),
    )
    .post(
        '/auth/register/finish',
        {
            body: t.Object({
                name: t.String({ minLength: 1, maxLength: 200 }),
                registrationRecord: opaqueMessage,
                envelope: envelopeSchema,
                recovery: recoverySchema,
                identity: identitySchema,
            }),
        },
        async ({ request, body, set }) => {
            const { user, cookie } = await auth.finishRegistration(request, body);
            set.headers['set-cookie'] = cookie;
            return { user };
        },
    )
    .post(
        '/auth/login/start',
        { body: t.Object({ email: emailSchema, startLoginRequest: opaqueMessage }) },
        ({ body }) => auth.startLogin(body.email, body.startLoginRequest),
    )
    .post(
        '/auth/login/finish',
        { body: t.Object({ attemptToken: tokenSchema, finishLoginRequest: opaqueMessage }) },
        async ({ request, body, set }) => {
            const { user, envelope, cookie } = await auth.finishLogin(
                request,
                body.attemptToken,
                body.finishLoginRequest,
            );
            set.headers['set-cookie'] = cookie;
            return { user, envelope };
        },
    )
    .post('/auth/recover/email', { body: t.Object({ email: emailSchema }) }, ({ body }) =>
        auth.requestRegistrationEmail(body.email, 'recover'),
    )
    .get('/auth/recover', async ({ request }) => ({
        enrollment: await auth.getEnrollment(request, 'recover'),
    }))
    .post(
        '/auth/recover/start',
        { body: t.Object({ registrationRequest: opaqueMessage }) },
        ({ request, body }) => auth.startRecovery(request, body.registrationRequest),
    )
    .post(
        '/auth/recover/finish',
        {
            body: t.Object({
                userId: t.String({ format: 'uuid' }),
                attemptToken: tokenSchema,
                credentialVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
                registrationRecord: opaqueMessage,
                envelope: envelopeSchema,
                recovery: recoverySchema,
                signature: t.String({ minLength: 86, maxLength: 86 }),
            }),
        },
        async ({ request, body, set }) => {
            const { user, cookie } = await auth.finishRecovery(request, body);
            set.headers['set-cookie'] = [cookie, auth.authCookie('session', null)];
            return { user };
        },
    )
    .post(
        '/auth/delete/start',
        { body: t.Object({ startLoginRequest: opaqueMessage }) },
        ({ request, body }) => auth.startAccountDeletion(request, body.startLoginRequest),
    )
    .post(
        '/auth/delete/finish',
        { body: t.Object({ attemptToken: tokenSchema, finishLoginRequest: opaqueMessage }) },
        async ({ request, body, set }) => {
            const result = await auth.finishAccountDeletion(request, body);
            set.headers['set-cookie'] = [
                auth.authCookie('session', null),
                auth.authCookie('enrollment', null),
            ];
            return result;
        },
    )
    .get('/auth/storage', ({ request }) => auth.getStorageAllowance(request))
    .get('/auth/recovery-key', ({ request }) => auth.getRecoveryBackup(request))
    .post(
        '/auth/recovery-key/confirm',
        { body: t.Object({ recoveryVersion: t.Integer({ minimum: 1, maximum: 2147483646 }) }) },
        ({ request, body }) => auth.confirmRecoveryBackup(request, body.recoveryVersion),
    )
    .get('/auth/session', async ({ request }) => ({ user: await auth.getSessionUser(request) }))
    .post('/auth/logout', { body: t.Object({}) }, async ({ request, set }) => {
        set.headers['set-cookie'] = await auth.logout(request);
        return { success: true };
    })
    .get('/health', () => ({ status: 'ok' as const, service: API_SERVICE }))
    .get('/greeting', ({ log }) => {
        log.set({ action: 'greeting' });
        return { message: welcomeMessage(APP_NAME) };
    })
    .get('/ready', async ({ status, log, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        try {
            await db.execute('select 1');
            return { status: 'ok' as const };
        } catch (error) {
            if (error instanceof Error) log.error(error);
            return status(503, { status: 'unavailable' as const });
        }
    });

export type Api = typeof apiApp;

// Bound auth bodies before JSON parsing; never log protocol messages or tokens.
export async function handleApiRequest(request: Request) {
    if (!new URL(request.url).pathname.startsWith('/api/auth/')) return apiApp.fetch(request);
    const log = useLogger();
    log.set({ auth: { action: authLogAction(new URL(request.url).pathname) } });
    const headers = {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    };
    try {
        if (request.method !== 'GET' && request.method !== 'OPTIONS') {
            await auth.guardAuthMutation(request);
            const reader = request.body?.getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            if (reader) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    length += value.byteLength;
                    if (length > 16_384) {
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
        if (!(error instanceof auth.AuthError))
            log.error(new Error('Authentication request failed.'));
        return Response.json(
            {
                message:
                    error instanceof auth.AuthError
                        ? error.message
                        : 'Authentication is temporarily unavailable. Please try again.',
            },
            { status: error instanceof auth.AuthError ? error.status : 503, headers },
        );
    }
}
