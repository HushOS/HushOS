import '@/lib/server-only';
import { cors } from '@elysia/cors';
import { db } from '@hushos/db';
import { EvlogError, parseError, authLogAction, sanitizeFailure } from '@hushos/logging';
import { useRequest } from 'nitro/context';
import { API_SERVICE } from '@hushos/shared';
import { Elysia, t, ValidationError, ParseError } from 'elysia';
import * as auth from '@hushos/auth/server';
import {
    authCookie,
    clientAddress,
    guardAuthMutation,
    readEnrollmentToken,
    readSessionToken,
} from '@hushos/auth/http';
import * as billing from '@hushos/billing/server';
import { CANCELLATION_REASONS } from '@hushos/billing/protocol';
import { appEnv } from '@hushos/env/app';
import { chargeableCurrency } from '@/lib/currency';

import { useLogger, useRequestId } from '@/lib/logging.server';

// A non-literal status here would erase every response type Eden Treaty infers.
const ERROR_CODES = [400, 401, 403, 404, 409, 422, 429, 500, 503] as const;
type ErrorCode = (typeof ERROR_CODES)[number];
function errorStatus(value: number): ErrorCode {
    return (ERROR_CODES as readonly number[]).includes(value) ? (value as ErrorCode) : 500;
}

const requestContext = new Elysia({ name: 'hushos-api-context' })
    .derive(({ request }) => ({
        log: useLogger(),
        requestId: useRequestId(),
        // Read once per request; handlers hand the tokens to the auth domain.
        sessionToken: readSessionToken(request),
        enrollmentToken: readEnrollmentToken(request),
    }))
    .error(({ error, status, request }) => {
        if (new URL(request.url).pathname.startsWith('/api/auth/')) {
            if (error instanceof auth.AuthError) {
                // A 5xx is an operator problem (mail, database): say what kind, never what it said.
                if (error.status >= 500) {
                    useLogger().set({ auth: { failure: describeFailure(error) } });
                    useLogger().error(new Error('Authentication request failed.'));
                }
                return status(error.status, { message: error.message });
            }
            if (error instanceof ValidationError || error instanceof ParseError)
                return status(400, { message: 'Please check your information and try again.' });
            useLogger().set({ auth: { failure: describeFailure(error) } });
            useLogger().error(new Error('Authentication request failed.'));
            return status(503, {
                message: 'Authentication is temporarily unavailable. Please try again.',
            });
        }
        if (new URL(request.url).pathname.startsWith('/api/billing/')) {
            if (error instanceof billing.BillingError || error instanceof auth.AuthError) {
                if (error.status >= 500) {
                    useLogger().set({ billing: { failure: describeFailure(error) } });
                    useLogger().error(new Error('Billing request failed.'));
                }
                return status(error.status, { message: error.message });
            }
            if (error instanceof ValidationError || error instanceof ParseError)
                return status(400, { message: 'Please check your information and try again.' });
            useLogger().set({ billing: { failure: describeFailure(error) } });
            useLogger().error(new Error('Billing request failed.'));
            return status(503, {
                message: 'Billing is temporarily unavailable. Please try again.',
            });
        }
        if (error instanceof Error) useLogger().error(error);
        if (error instanceof EvlogError) {
            const parsed = parseError(error);
            return status(errorStatus(parsed.status), {
                message: parsed.message,
                why: parsed.why,
                fix: parsed.fix,
                link: parsed.link,
            });
        }
    })
    .as('global');

/* What the operator gets to see about a failure: the class and machine code, one cause deep. */
function describeFailure(error: unknown) {
    const source =
        (error instanceof auth.AuthError || error instanceof billing.BillingError) &&
        error.cause instanceof Error
            ? error.cause
            : error;
    if (!(source instanceof Error)) return sanitizeFailure({ name: 'unknown' });
    const code = (source as Error & { code?: unknown }).code;
    const name = /^[A-Za-z0-9_.:-]{1,64}$/.test(source.name)
        ? source.name
        : source.constructor.name;
    return sanitizeFailure({ name, code });
}
function requestAddress(request: Request) {
    return clientAddress(request, useRequest().ip);
}

function requestCountry(request: Request) {
    const header = appEnv.TRUSTED_COUNTRY_HEADER;
    return header ? request.headers.get(header) : null;
}

async function billingUser(sessionToken: string | null) {
    const user = await auth.getSessionUser(sessionToken);
    if (!user) throw new auth.AuthError('Sign in to manage billing.', 401);
    return user;
}

/* Browser-originated billing changes carry the app's Origin, like auth mutations. */
function billingMutation(request: Request, sessionToken: string | null) {
    guardAuthMutation(request);
    return billingUser(sessionToken);
}

const intentValue = t.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' });
const intentSchema = t.Object({
    plan: t.Optional(intentValue),
    referral: t.Optional(intentValue),
    source: t.Optional(intentValue),
});

const cancellationSchema = t.Object({
    reason: t.Optional(t.UnionEnum(CANCELLATION_REASONS)),
    comment: t.Optional(t.String({ maxLength: 500 })),
});

const emailSchema = t.String({
    minLength: 3,
    maxLength: 254,
    pattern: auth.EMAIL_ADDRESS_PATTERN.source,
});
const opaqueMessage = t.String({ minLength: 1, maxLength: 4096 });
const tokenSchema = t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' });
const envelopeSchema = t.Object({
    envelopeVersion: t.Literal(1),
    keyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    credentialVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    wrappingSalt: tokenSchema,
    wrappingNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedKey: t.String({ minLength: 64, maxLength: 64 }),
});

const recoverySchema = t.Object({
    version: t.Literal(1),
    keyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
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
    keyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    wrappingSalt: tokenSchema,
    encryptionPublicKey: tokenSchema,
    encryptionPrivateKeyNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedEncryptionPrivateKey: t.String({ minLength: 64, maxLength: 64 }),
    signingPublicKey: tokenSchema,
    signingSeedNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedSigningSeed: t.String({ minLength: 64, maxLength: 64 }),
});

const workspaceIdSchema = t.String({
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const workspaceKeySchema = t.Object({
    version: t.Literal(1),
    workspaceId: workspaceIdSchema,
    keyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    workspaceKeyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    wrappingSalt: tokenSchema,
    wrappingNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedKey: t.String({ minLength: 64, maxLength: 64 }),
});
const workspaceSetupSchema = t.Object({ id: workspaceIdSchema, grant: workspaceKeySchema });

const securityActionSchema = t.Union([
    t.Literal('password'),
    t.Literal('master-key'),
    t.Literal('recovery-key'),
]);

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
    .get('/auth/setup', ({ sessionToken }) => auth.getAccountSetup(sessionToken))
    .post(
        '/auth/setup',
        {
            body: t.Object({
                recovery: t.Optional(recoverySchema),
                identity: t.Optional(identitySchema),
                workspace: t.Optional(workspaceSetupSchema),
            }),
        },
        ({ sessionToken, body }) => auth.initializeAccount(sessionToken, body),
    )
    .post(
        '/auth/register/email',
        { body: t.Object({ email: emailSchema, intent: t.Optional(intentSchema) }) },
        ({ body, request }) =>
            auth.requestRegistrationEmail(
                body.email,
                'register',
                requestAddress(request),
                body.intent,
            ),
    )
    .post(
        '/auth/register/verify',
        { body: t.Object({ token: tokenSchema }) },
        async ({ body, set }) => {
            const { enrollment, enrollmentToken } = await auth.verifyEmail(body.token);
            set.headers['set-cookie'] = authCookie('enrollment', enrollmentToken);
            return { enrollment };
        },
    )
    .get('/auth/register', async ({ enrollmentToken }) => ({
        enrollment: await auth.getEnrollment(enrollmentToken),
    }))
    .post(
        '/auth/register/start',
        { body: t.Object({ registrationRequest: opaqueMessage }) },
        ({ enrollmentToken, body }) =>
            auth.startRegistration(enrollmentToken, body.registrationRequest),
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
                workspace: workspaceSetupSchema,
            }),
        },
        async ({ enrollmentToken, body, set }) => {
            const { user } = await auth.finishRegistration(enrollmentToken, body);
            set.headers['set-cookie'] = authCookie('enrollment', null);
            return { user };
        },
    )
    .post(
        '/auth/login/start',
        { body: t.Object({ email: emailSchema, startLoginRequest: opaqueMessage }) },
        ({ body, request }) =>
            auth.startLogin(body.email, body.startLoginRequest, undefined, requestAddress(request)),
    )
    .post(
        '/auth/login/finish',
        { body: t.Object({ attemptToken: tokenSchema, finishLoginRequest: opaqueMessage }) },
        async ({ sessionToken, body, set }) => {
            const {
                user,
                envelope,
                sessionToken: token,
            } = await auth.finishLogin(body.attemptToken, body.finishLoginRequest, sessionToken);
            set.headers['set-cookie'] = authCookie('session', token);
            return { user, envelope };
        },
    )
    .post('/auth/recover/email', { body: t.Object({ email: emailSchema }) }, ({ body, request }) =>
        auth.requestRegistrationEmail(body.email, 'recover', requestAddress(request)),
    )
    .get('/auth/recover', async ({ enrollmentToken }) => ({
        enrollment: await auth.getEnrollment(enrollmentToken, 'recover'),
    }))
    .post(
        '/auth/recover/start',
        { body: t.Object({ registrationRequest: opaqueMessage }) },
        ({ enrollmentToken, body }) =>
            auth.startRecovery(enrollmentToken, body.registrationRequest),
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
        async ({ enrollmentToken, body, set }) => {
            const { user } = await auth.finishRecovery(enrollmentToken, body);
            set.headers['set-cookie'] = [
                authCookie('enrollment', null),
                authCookie('session', null),
            ];
            return { user };
        },
    )
    .post(
        '/auth/delete/start',
        { body: t.Object({ startLoginRequest: opaqueMessage }) },
        ({ sessionToken, body }) => auth.startAccountDeletion(sessionToken, body.startLoginRequest),
    )
    .post(
        '/auth/delete/finish',
        { body: t.Object({ attemptToken: tokenSchema, finishLoginRequest: opaqueMessage }) },
        async ({ sessionToken, body, set }) => {
            const result = await auth.finishAccountDeletion(
                sessionToken,
                body,
                billing.revokeForDeletion,
            );
            set.headers['set-cookie'] = [
                authCookie('session', null),
                authCookie('enrollment', null),
            ];
            return result;
        },
    )
    .post(
        '/auth/security/start',
        {
            body: t.Object({
                action: securityActionSchema,
                startLoginRequest: opaqueMessage,
                registrationRequest: opaqueMessage,
            }),
        },
        ({ sessionToken, body }) => auth.startSecurityChange(sessionToken, body),
    )
    .post(
        '/auth/security/finish',
        {
            body: t.Object({
                action: securityActionSchema,
                attemptToken: tokenSchema,
                finishLoginRequest: opaqueMessage,
                registrationRecord: opaqueMessage,
                envelope: envelopeSchema,
                recovery: t.Optional(recoverySchema),
                identity: t.Optional(identitySchema),
                workspaces: t.Optional(t.Array(workspaceKeySchema, { maxItems: 200 })),
            }),
        },
        async ({ sessionToken, body, set }) => {
            const result = await auth.finishSecurityChange(sessionToken, body);
            set.headers['set-cookie'] = [
                authCookie('session', null),
                authCookie('enrollment', null),
            ];
            return result;
        },
    )
    .get('/auth/storage', ({ sessionToken }) => auth.getStorageAllowance(sessionToken))
    .get('/auth/recovery-key', ({ sessionToken }) => auth.getRecoveryBackup(sessionToken))
    .post(
        '/auth/recovery-key/confirm',
        { body: t.Object({ recoveryVersion: t.Integer({ minimum: 1, maximum: 2147483646 }) }) },
        ({ sessionToken, body }) => auth.confirmRecoveryBackup(sessionToken, body.recoveryVersion),
    )
    .get('/auth/session', async ({ sessionToken }) => ({
        user: await auth.getSessionUser(sessionToken),
    }))
    .post(
        '/auth/profile',
        { body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }) },
        ({ sessionToken, body }) => auth.updateProfile(sessionToken, body),
    )
    .post('/auth/logout', { body: t.Object({}) }, async ({ sessionToken, set }) => {
        await auth.logout(sessionToken);
        set.headers['set-cookie'] = authCookie('session', null);
        return { success: true };
    })
    .get('/billing/catalogue', ({ set }) => {
        set.headers['Cache-Control'] = 'public, max-age=60';
        return billing.listCatalogue();
    })
    .get('/billing', async ({ sessionToken }) =>
        billing.getSummary(await billingUser(sessionToken)),
    )
    .post(
        '/billing/checkout',
        {
            body: t.Object({
                productId: t.String({ minLength: 1, maxLength: 100 }),
                currency: t.Optional(t.String({ pattern: '^[a-z]{3}$' })),
            }),
        },
        async ({ request, sessionToken, body }) =>
            billing.startCheckout(
                await billingMutation(request, sessionToken),
                body.productId,
                requestAddress(request),
                // The page's currency is a display choice; Polar is told it only when
                // the visitor's country pays in it, else Polar decides from the address.
                chargeableCurrency(body.currency, requestCountry(request)) ?? undefined,
            ),
    )
    .post('/billing/portal', { body: t.Object({}) }, async ({ request, sessionToken }) =>
        billing.createPortalSession(await billingMutation(request, sessionToken)),
    )
    .post('/billing/sync', { body: t.Object({}) }, async ({ request, sessionToken }) =>
        billing.sync(await billingMutation(request, sessionToken)),
    )
    .post(
        '/billing/cancel',
        { body: cancellationSchema },
        async ({ request, sessionToken, body }) =>
            billing.cancelAtPeriodEnd(await billingMutation(request, sessionToken), body),
    )
    .post('/billing/resume', { body: t.Object({}) }, async ({ request, sessionToken }) =>
        billing.resume(await billingMutation(request, sessionToken)),
    )
    .get('/health', () => ({ status: 'ok' as const, service: API_SERVICE }))
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
export async function handleApiRequest(request: Request): Promise<Response> {
    if (request.method === 'HEAD') {
        const result = await handleApiRequest(
            new Request(request.url, { method: 'GET', headers: request.headers }),
        );
        return new Response(null, { status: result.status, headers: result.headers });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/billing/webhook') return handleBillingWebhook(request);
    if (!pathname.startsWith('/api/auth/')) return apiApp.fetch(request);
    const log = useLogger();
    log.set({ auth: { action: authLogAction(new URL(request.url).pathname) } });
    const headers = {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    };
    try {
        if (request.method !== 'GET' && request.method !== 'OPTIONS') {
            guardAuthMutation(request);
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
            // Consume the budget only for requests that passed the cheap checks above.
            await auth.limitAuthMutation(requestAddress(request));
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
