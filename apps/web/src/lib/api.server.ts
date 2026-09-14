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
import * as growth from '@hushos/billing/growth';
import { growthRepository } from '@hushos/db';
import { CLIENT_HEADER, checkClient, parseMinimums } from '@hushos/drive/protocol';
import { REPORT_CATEGORIES } from '@hushos/drive/api';
import * as drive from '@hushos/drive/server';
import { storageEnv } from '@hushos/env/storage';
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
        if (/^\/api\/(drive|admin)\//.test(new URL(request.url).pathname)) {
            if (error instanceof drive.DriveError)
                return status(error.status, {
                    message: error.message,
                    code: error.code,
                    data: error.data,
                });
            if (error instanceof auth.AuthError)
                return status(error.status, { message: error.message, code: 'forbidden' as const });
            if (error instanceof ValidationError || error instanceof ParseError)
                return status(400, {
                    message: 'Please check your information and try again.',
                    code: 'invalid' as const,
                });
            useLogger().set({ drive: { failure: describeFailure(error) } });
            useLogger().error(new Error('Drive request failed.'));
            return status(503, {
                message: 'Drive is temporarily unavailable. Please try again.',
                code: 'unavailable' as const,
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

/*
 * Every Drive request names its client; one below the operator's minimum for
 * that client is refused with 426 and told how to update, before any work.
 */
const clientMinimums = parseMinimums(storageEnv.DRIVE_CLIENT_MINIMUMS);
function requireClient(request: Request) {
    const check = checkClient(request.headers.get(CLIENT_HEADER), clientMinimums);
    if (!check.ok)
        throw new drive.DriveError(
            check.status === 426 ? 'unsupported' : 'invalid',
            check.message,
            check.status,
        );
    return check.client;
}

async function driveUser(request: Request, sessionToken: string | null) {
    requireClient(request);
    const user = await auth.getSessionUser(sessionToken);
    if (!user) throw new auth.AuthError('Sign in to open Drive.', 401);
    return user;
}
/* Drive writes carry the app's Origin like every other browser-originated mutation. */
function driveMutation(request: Request, sessionToken: string | null) {
    guardAuthMutation(request);
    return driveUser(request, sessionToken);
}

const uuidSchema = t.String({
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const epochSchema = t.Integer({ minimum: 1, maximum: 2147483646 });
// 72 bytes of nonce || wrapped key is 96 Base64url characters; metadata is bounded by its column.
const keyEnvelopeSchema = t.String({ minLength: 96, maxLength: 96, pattern: '^[A-Za-z0-9_-]+$' });
/* A suite 2 version envelope (84 bytes): the content key sealed with the sizes. */
const versionEnvelopeSchema = t.String({
    minLength: 112,
    maxLength: 112,
    pattern: '^[A-Za-z0-9_-]+$',
});
/* A version envelope of either suite; the domain holds it to the object's. */
const anyVersionEnvelopeSchema = t.String({
    minLength: 96,
    maxLength: 112,
    pattern: '^[A-Za-z0-9_-]+$',
});
const metadataEnvelopeSchema = t.String({
    minLength: 56,
    maxLength: 5515,
    pattern: '^[A-Za-z0-9_-]+$',
});
const nodeEnvelopesSchema = {
    keyEpoch: epochSchema,
    parentKeyEpoch: epochSchema,
    keyEnvelope: keyEnvelopeSchema,
    metadataEnvelope: metadataEnvelopeSchema,
};
const cursorSchema = t.Optional(uuidSchema);
const linkTokenSchema = t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' });
const linkSaltSchema = t.String({ minLength: 22, maxLength: 22, pattern: '^[A-Za-z0-9_-]+$' });
// 104 or 136 bytes: 139 or 182 Base64url characters; the server checks the exact lengths.
const linkSecretSchema = t.String({ minLength: 139, maxLength: 182, pattern: '^[A-Za-z0-9_-]+$' });
const uploadNodeSchema = t.Union([
    t.Object({
        existing: t.Literal(false),
        id: uuidSchema,
        parentId: uuidSchema,
        ...nodeEnvelopesSchema,
    }),
    t.Object({
        existing: t.Literal(true),
        id: uuidSchema,
        keyEpoch: epochSchema,
        expectedVersionId: t.Nullable(uuidSchema),
    }),
]);
const partSchema = t.Object({
    partNumber: t.Integer({ minimum: 1, maximum: 10_000 }),
    etag: t.String({ minLength: 1, maxLength: 256 }),
});

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
            // The code the person signed up with, if any: attribution and its storage, never a failed sign-up.
            try {
                await growth.attributeNewAccount(
                    user.id,
                    (await growthRepository.pendingReferralCode(user.id)) ?? undefined,
                );
            } catch (error) {
                useLogger().set({ growth: { failure: describeFailure(error) } });
                useLogger().error(new Error('Referral attribution failed.'));
            }
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
    .get('/auth/identity', ({ sessionToken }) => auth.getIdentityEnvelope(sessionToken))
    .get(
        '/auth/contacts/lookup',
        { query: t.Object({ email: emailSchema }) },
        ({ sessionToken, query }) => auth.lookupContact(sessionToken, query.email),
    )
    .get('/auth/settings', ({ sessionToken }) => auth.getSettings(sessionToken))
    .put(
        '/auth/settings',
        {
            body: t.Object({
                expectedVersion: t.Integer({ minimum: 0, maximum: 2147483646 }),
                nonce: t.String({ minLength: 32, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' }),
                ciphertext: t.String({
                    minLength: 22,
                    maxLength: 87_408,
                    pattern: '^[A-Za-z0-9_-]+$',
                }),
            }),
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.putSettings(sessionToken, body);
        },
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
    // Referrals and affiliates: a person's own invite, and the operator's creators.
    .get('/billing/referrals', async ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        const user = await billingUser(sessionToken);
        return growth.getReferralSummary(user.id);
    })
    .post(
        '/billing/coupon',
        { body: t.Object({ code: t.String({ minLength: 3, maxLength: 32 }) }) },
        async ({ request, sessionToken, body }) => {
            const user = await billingMutation(request, sessionToken);
            return growth.rememberCoupon(user.id, body.code);
        },
    )
    .get('/billing/affiliates', async ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        await auth.requireAdmin(sessionToken);
        return growth.listAffiliates();
    })
    .post(
        '/billing/affiliates',
        {
            body: t.Object({
                name: t.String({ minLength: 1, maxLength: 100 }),
                slug: t.String({ minLength: 1, maxLength: 40 }),
                code: t.String({ minLength: 3, maxLength: 32 }),
                percentOff: t.Integer({ minimum: 1, maximum: 100 }),
                duration: t.Union([
                    t.Literal('once'),
                    t.Literal('forever'),
                    t.Literal('repeating'),
                ]),
                durationMonths: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 36 }))),
                commissionBps: t.Integer({ minimum: 0, maximum: 10000 }),
                userEmail: t.Optional(t.Nullable(t.String({ maxLength: 254 }))),
                notes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
            }),
        },
        async ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            await auth.requireAdmin(sessionToken);
            return growth.createAffiliate(body);
        },
    )
    .patch(
        '/billing/affiliates/:id',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
                commissionBps: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
                notes: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
                userEmail: t.Optional(t.Nullable(t.String({ maxLength: 254 }))),
                active: t.Optional(t.Boolean()),
            }),
        },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            await auth.requireAdmin(sessionToken);
            return growth.updateAffiliate(params.id, body);
        },
    )
    .post(
        '/billing/affiliates/:id/paid',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            await auth.requireAdmin(sessionToken);
            return growth.markAffiliatePaid(params.id);
        },
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
    .get('/drive/capabilities', ({ request, set }) => {
        requireClient(request);
        set.headers['Cache-Control'] = 'public, max-age=300';
        return drive.capabilities();
    })
    .get('/drive/workspace', async ({ request, sessionToken }) =>
        drive.getWorkspace((await driveUser(request, sessionToken)).id),
    )
    .post(
        '/drive/workspaces/:id/epochs',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ count: t.Integer({ minimum: 1, maximum: 10_000 }) }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.allocateEpochs(
                (await driveMutation(request, sessionToken)).id,
                params.id,
                body.count,
            ),
    )
    .post(
        '/drive/workspaces/:id/root',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ id: uuidSchema, ...nodeEnvelopesSchema }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.createRoot((await driveMutation(request, sessionToken)).id, params.id, body),
    )
    .get(
        '/drive/nodes/:id/children',
        {
            params: t.Object({ id: uuidSchema }),
            query: t.Object({ workspaceId: uuidSchema, after: cursorSchema }),
        },
        async ({ request, sessionToken, params, query }) =>
            drive.listChildren(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                params.id,
                query.after,
            ),
    )
    .post(
        '/drive/folders',
        {
            body: t.Object({
                workspaceId: uuidSchema,
                folders: t.Array(
                    t.Object({ id: uuidSchema, parentId: uuidSchema, ...nodeEnvelopesSchema }),
                    {
                        minItems: 1,
                        maxItems: 64,
                    },
                ),
            }),
        },
        async ({ request, sessionToken, body }) =>
            drive.createFolders(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                body.folders,
            ),
    )
    .post(
        '/drive/nodes/:id/metadata',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                metadataVersion: epochSchema,
                keyEpoch: epochSchema,
                metadataEnvelope: metadataEnvelopeSchema,
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.renameNode(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body,
            ),
    )
    .post(
        '/drive/nodes/:id/parent',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                parentId: uuidSchema,
                parentKeyEpoch: epochSchema,
                keyEnvelope: keyEnvelopeSchema,
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.moveNode(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body,
            ),
    )
    .post(
        '/drive/nodes/:id/trash',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, body }) =>
            drive.trashNode(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
            ),
    )
    .post(
        '/drive/nodes/:id/restore',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                toRoot: t.Optional(
                    t.Object({ parentKeyEpoch: epochSchema, keyEnvelope: keyEnvelopeSchema }),
                ),
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.restoreNode(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body.toRoot,
            ),
    )
    .post(
        '/drive/uploads',
        {
            body: t.Object({
                workspaceId: uuidSchema,
                node: uploadNodeSchema,
                versionId: uuidSchema,
                objectId: uuidSchema,
                contentKeyEnvelope: versionEnvelopeSchema,
                contentNonce: t.String({
                    minLength: 22,
                    maxLength: 22,
                    pattern: '^[A-Za-z0-9_-]+$',
                }),
                contentSuite: t.Integer({ minimum: 1, maximum: 255 }),
                chunkCount: t.Integer({ minimum: 1, maximum: 10_000 }),
                ciphertextSize: t.String({ pattern: '^[0-9]{1,16}$' }),
            }),
        },
        async ({ request, sessionToken, body }) =>
            drive.beginUpload(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                body,
            ),
    )
    .get(
        '/drive/uploads/:id',
        { params: t.Object({ id: uuidSchema }), query: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, query }) =>
            drive.getUploadState(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                params.id,
            ),
    )
    .get(
        '/drive/uploads/:id/parts',
        {
            params: t.Object({ id: uuidSchema }),
            query: t.Object({
                workspaceId: uuidSchema,
                from: t.Integer({ minimum: 1, maximum: 10_000 }),
                count: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
            }),
        },
        async ({ request, sessionToken, params, query }) =>
            drive.uploadPartUrls(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                params.id,
                query.from,
                query.count ?? 64,
            ),
    )
    .post(
        '/drive/uploads/:id/complete',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                parts: t.Array(partSchema, { minItems: 1, maxItems: 10_000 }),
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.completeUpload(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body.parts,
            ),
    )
    .post(
        '/drive/uploads/:id/attach',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                attach: t.Union([
                    t.Object({
                        mode: t.Literal('same-node'),
                        keyEpoch: epochSchema,
                        contentKeyEnvelope: versionEnvelopeSchema,
                    }),
                    t.Object({
                        mode: t.Literal('sibling'),
                        node: t.Object({
                            id: uuidSchema,
                            parentId: uuidSchema,
                            ...nodeEnvelopesSchema,
                        }),
                        contentKeyEnvelope: versionEnvelopeSchema,
                    }),
                ]),
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.attachUpload(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body.attach,
            ),
    )
    .post(
        '/drive/uploads/:id/abort',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, body }) =>
            drive.abortUpload(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
            ),
    )
    .get(
        '/drive/thumbnails',
        {
            query: t.Object({
                workspaceId: uuidSchema,
                versions: t.String({ minLength: 36, maxLength: 3700 }),
            }),
        },
        async ({ request, sessionToken, query }) =>
            drive.thumbnailUrls(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                query.versions.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
            ),
    )
    .delete(
        '/drive/nodes/:id',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, body }) =>
            drive.purgeNode(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
            ),
    )
    .post(
        '/drive/nodes/:id/copy',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                sourceVersionId: uuidSchema,
                node: t.Object({ id: uuidSchema, parentId: uuidSchema, ...nodeEnvelopesSchema }),
                versionId: uuidSchema,
                contentKeyEnvelope: anyVersionEnvelopeSchema,
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.copyNode(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body,
            ),
    )
    .get(
        '/drive/nodes/:id/versions',
        { params: t.Object({ id: uuidSchema }), query: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, query }) =>
            drive.listVersions(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                params.id,
            ),
    )
    .post(
        '/drive/versions/:id/restore',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, body }) =>
            drive.restoreVersion(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
            ),
    )
    .delete(
        '/drive/versions/:id',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, body }) =>
            drive.discardVersion(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
            ),
    )
    .post(
        '/drive/nodes/:id/shares',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                granteeUserId: uuidSchema,
                role: t.Union([t.Literal('viewer'), t.Literal('editor')]),
                keyEpoch: epochSchema,
                shareEnvelope: keyEnvelopeSchema,
            }),
        },
        async ({ request, sessionToken, params, body, log }) => {
            const user = await driveMutation(request, sessionToken);
            const result = await drive.shareNode(user.id, body.workspaceId, params.id, body);
            // The person is told by mail; a mail problem is the operator's, not the sharer's.
            void auth
                .notifyShare(user.id, body.granteeUserId, body.role)
                .catch((error: unknown) => {
                    if (error instanceof Error) log.error(error);
                });
            return result;
        },
    )
    .get(
        '/drive/nodes/:id/shares',
        { params: t.Object({ id: uuidSchema }), query: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, query }) =>
            drive.listNodeShares(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                params.id,
            ),
    )
    .delete(
        '/drive/shares/:id',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, body }) =>
            drive.revokeShare(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
            ),
    )
    .get('/drive/shares', async ({ request, sessionToken }) =>
        drive.listSharedWithMe((await driveUser(request, sessionToken)).id),
    )
    .get('/drive/shares/mine', async ({ request, sessionToken }) =>
        drive.listSharedByMe((await driveUser(request, sessionToken)).id),
    )
    .post(
        '/drive/nodes/:id/links',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                linkId: uuidSchema,
                token: linkTokenSchema,
                keyEpoch: epochSchema,
                linkEnvelope: keyEnvelopeSchema,
                linkSalt: linkSaltSchema,
                secretEnvelope: linkSecretSchema,
                hasPassword: t.Boolean(),
                expiresAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.createLink(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body,
            ),
    )
    .get(
        '/drive/nodes/:id/links',
        { params: t.Object({ id: uuidSchema }), query: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, query }) =>
            drive.listNodeLinks(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                params.id,
            ),
    )
    .patch(
        '/drive/links/:id',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                keyEpoch: epochSchema,
                seal: t.Optional(
                    t.Object({
                        linkEnvelope: keyEnvelopeSchema,
                        linkSalt: linkSaltSchema,
                        hasPassword: t.Boolean(),
                        secretEnvelope: t.Optional(linkSecretSchema),
                    }),
                ),
                expiresAt: t.Optional(t.Union([t.String({ format: 'date-time' }), t.Null()])),
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.updateLink(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body,
            ),
    )
    .delete(
        '/drive/links/:id',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, body }) =>
            drive.revokeLink(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
            ),
    )
    // Change feeds: a range over the workspace's sequence; a share's is filtered to its subtree.
    .get(
        '/drive/workspaces/:id/changes',
        {
            params: t.Object({ id: uuidSchema }),
            query: t.Object({
                since: t.Integer({ minimum: 0 }),
                limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
            }),
        },
        async ({ request, sessionToken, params, query }) =>
            drive.changes(
                (await driveUser(request, sessionToken)).id,
                params.id,
                query.since,
                query.limit,
            ),
    )
    .get(
        '/drive/shares/:id/changes',
        {
            params: t.Object({ id: uuidSchema }),
            query: t.Object({ since: t.Integer({ minimum: 0 }) }),
        },
        async ({ request, sessionToken, params, query }) =>
            drive.shareChanges((await driveUser(request, sessionToken)).id, params.id, query.since),
    )
    // Rotation: the owner's device re-keys a subtree after a revocation, in batches.
    .post(
        '/drive/nodes/:id/rotation',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, body }) =>
            drive.startRotation(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
            ),
    )
    .get(
        '/drive/nodes/:id/rotation/work',
        {
            params: t.Object({ id: uuidSchema }),
            query: t.Object({
                workspaceId: uuidSchema,
                after: t.Optional(t.String({ minLength: 38, maxLength: 40 })),
            }),
        },
        async ({ request, sessionToken, params, query }) =>
            drive.rotationWork(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                params.id,
                query.after ?? null,
            ),
    )
    .post(
        '/drive/nodes/:id/rotation/nodes',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                nodes: t.Array(
                    t.Object({
                        id: uuidSchema,
                        changeSeq: t.Integer({ minimum: 0 }),
                        parentKeyEpoch: epochSchema,
                        keyEnvelope: keyEnvelopeSchema,
                        rotated: t.Nullable(
                            t.Object({
                                metadataEnvelope: metadataEnvelopeSchema,
                                versions: t.Array(
                                    t.Object({
                                        id: uuidSchema,
                                        contentKeyEnvelope: anyVersionEnvelopeSchema,
                                    }),
                                    { maxItems: 1000 },
                                ),
                                shares: t.Array(
                                    t.Object({ id: uuidSchema, shareEnvelope: keyEnvelopeSchema }),
                                    { maxItems: 1000 },
                                ),
                                links: t.Array(
                                    t.Object({
                                        id: uuidSchema,
                                        linkEnvelope: keyEnvelopeSchema,
                                        secretEnvelope: linkSecretSchema,
                                    }),
                                    { maxItems: 1000 },
                                ),
                                unsealableLinks: t.Array(uuidSchema, { maxItems: 1000 }),
                            }),
                        ),
                    }),
                    { minItems: 1, maxItems: 200 },
                ),
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.rotateNodes(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body.nodes,
            ),
    )
    // The visitor's surface: no session, the token names the link, bounded per address and token.
    .get(
        '/drive/links/:id/open',
        { params: t.Object({ id: linkTokenSchema }) },
        ({ request, params }) => {
            requireClient(request);
            return drive.openLink(params.id, requestAddress(request));
        },
    )
    .get(
        '/drive/links/:id/nodes/:nodeId/children',
        {
            params: t.Object({ id: linkTokenSchema, nodeId: uuidSchema }),
            query: t.Object({ after: cursorSchema }),
        },
        ({ request, params, query }) => {
            requireClient(request);
            return drive.linkChildren(
                params.id,
                requestAddress(request),
                params.nodeId,
                query.after,
            );
        },
    )
    .get(
        '/drive/links/:id/versions/:versionId/url',
        { params: t.Object({ id: linkTokenSchema, versionId: uuidSchema }) },
        ({ request, params }) => {
            requireClient(request);
            return drive.linkDownloadUrl(params.id, requestAddress(request), params.versionId);
        },
    )
    .post(
        '/drive/links/:id/versions/urls',
        {
            params: t.Object({ id: linkTokenSchema }),
            body: t.Object({ versionIds: t.Array(uuidSchema, { minItems: 1, maxItems: 100 }) }),
        },
        ({ request, params, body }) => {
            requireClient(request);
            return drive.linkDownloadUrls(params.id, requestAddress(request), body.versionIds);
        },
    )
    .get(
        '/drive/links/:id/thumbnails',
        {
            params: t.Object({ id: linkTokenSchema }),
            query: t.Object({ versions: t.String({ minLength: 36, maxLength: 3700 }) }),
        },
        ({ request, params, query }) => {
            requireClient(request);
            return drive.linkThumbnailUrls(
                params.id,
                requestAddress(request),
                query.versions.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
            );
        },
    )
    .get(
        '/drive/workspaces/:id/storage',
        { params: t.Object({ id: uuidSchema }) },
        async ({ request, sessionToken, params }) =>
            drive.storageBreakdown((await driveUser(request, sessionToken)).id, params.id),
    )
    .post(
        '/drive/workspaces/:id/versions/discard-superseded',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) =>
            drive.discardSupersededVersions(
                (await driveMutation(request, sessionToken)).id,
                params.id,
            ),
    )
    .post(
        '/drive/workspaces/:id/trash/empty',
        // A JSON body, empty or not: the mutation guard accepts nothing else.
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) =>
            drive.emptyTrash((await driveMutation(request, sessionToken)).id, params.id),
    )
    .post(
        '/drive/versions/urls',
        {
            body: t.Object({
                workspaceId: uuidSchema,
                versionIds: t.Array(uuidSchema, { minItems: 1, maxItems: 100 }),
            }),
        },
        async ({ request, sessionToken, body }) =>
            drive.downloadUrls(
                (await driveUser(request, sessionToken)).id,
                body.workspaceId,
                body.versionIds,
            ),
    )
    .get(
        '/drive/versions/:id/url',
        { params: t.Object({ id: uuidSchema }), query: t.Object({ workspaceId: uuidSchema }) },
        async ({ request, sessionToken, params, query }) =>
            drive.downloadUrl(
                (await driveUser(request, sessionToken)).id,
                query.workspaceId,
                params.id,
            ),
    )
    .get(
        '/drive/workspaces/:id/trash',
        { params: t.Object({ id: uuidSchema }), query: t.Object({ after: cursorSchema }) },
        async ({ request, sessionToken, params, query }) =>
            drive.listTrash((await driveUser(request, sessionToken)).id, params.id, query.after),
    )
    // Reports: anyone who can see a node through a link or a share may file one, session or not.
    .get('/drive/reports/operators', ({ request }) => {
        requireClient(request);
        return drive.reportOperators();
    })
    .post(
        '/drive/reports',
        {
            body: t.Object({
                id: uuidSchema,
                workspaceId: uuidSchema,
                nodeId: uuidSchema,
                keyEpoch: epochSchema,
                category: t.UnionEnum(REPORT_CATEGORIES),
                reason: t.String({ minLength: 1, maxLength: 2000 }),
                via: t.Union([
                    t.Object({ link: linkTokenSchema }),
                    t.Object({ share: t.Literal(true) }),
                ]),
                reporterEmail: t.Nullable(emailSchema),
                contentHash: t.Nullable(
                    t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' }),
                ),
                keys: t.Array(
                    t.Object({
                        operatorUserId: uuidSchema,
                        keyEnvelope: t.String({
                            minLength: 150,
                            maxLength: 150,
                            pattern: '^[A-Za-z0-9_-]+$',
                        }),
                    }),
                    { minItems: 1, maxItems: 100 },
                ),
            }),
        },
        async ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            requireClient(request);
            const user = await auth.getSessionUser(sessionToken);
            return drive.fileReport(
                { userId: user?.id ?? null, address: requestAddress(request) },
                body,
            );
        },
    )
    // The operator's side: every route is a 404 to anyone but an operator.
    .get(
        '/admin/reports',
        {
            query: t.Object({
                status: t.Optional(
                    t.Union([
                        t.Literal('open'),
                        t.Literal('dismissed'),
                        t.Literal('removed'),
                        t.Literal('filed'),
                        t.Literal('all'),
                    ]),
                ),
                // Not UnionEnum: Elysia fills an absent optional UnionEnum query field with its first value.
                category: t.Optional(t.Union(REPORT_CATEGORIES.map((value) => t.Literal(value)))),
            }),
        },
        async ({ sessionToken, query, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            await auth.requireAdmin(sessionToken);
            return drive.listReports(query);
        },
    )
    .get(
        '/admin/reports/:id',
        { params: t.Object({ id: uuidSchema }) },
        async ({ sessionToken, params, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            await auth.requireAdmin(sessionToken);
            return drive.getReport(params.id);
        },
    )
    .post(
        '/admin/reports/:id/open',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.openReport(operator.id, params.id);
        },
    )
    .get(
        '/admin/reports/:id/nodes/:nodeId/children',
        { params: t.Object({ id: uuidSchema, nodeId: uuidSchema }) },
        async ({ sessionToken, params }) => {
            await auth.requireAdmin(sessionToken);
            return drive.reportChildren(params.id, params.nodeId);
        },
    )
    .post(
        '/admin/reports/:id/versions/urls',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ versionIds: t.Array(uuidSchema, { minItems: 1, maxItems: 100 }) }),
        },
        async ({ sessionToken, params, body }) => {
            await auth.requireAdmin(sessionToken);
            return drive.reportDownloadUrls(params.id, body.versionIds);
        },
    )
    .get(
        '/admin/reports/:id/versions/:versionId/url',
        { params: t.Object({ id: uuidSchema, versionId: uuidSchema }) },
        async ({ sessionToken, params }) => {
            await auth.requireAdmin(sessionToken);
            return drive.reportDownloadUrl(params.id, params.versionId);
        },
    )
    .get(
        '/admin/reports/:id/thumbnails',
        {
            params: t.Object({ id: uuidSchema }),
            query: t.Object({ versions: t.String({ minLength: 36, maxLength: 3700 }) }),
        },
        async ({ sessionToken, params, query }) => {
            await auth.requireAdmin(sessionToken);
            return drive.reportThumbnailUrls(
                params.id,
                query.versions.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
            );
        },
    )
    .post(
        '/admin/reports/:id/evidence',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.requestEvidence(operator.id, params.id);
        },
    )
    .get(
        '/admin/reports/:id/evidence/:requestId',
        { params: t.Object({ id: uuidSchema, requestId: uuidSchema }) },
        async ({ sessionToken, params, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            await auth.requireAdmin(sessionToken);
            return drive.getEvidenceRequest(params.id, params.requestId);
        },
    )
    .get(
        '/admin/reports/:id/keys',
        { params: t.Object({ id: uuidSchema }) },
        async ({ sessionToken, params, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            await auth.requireAdmin(sessionToken);
            return drive.reportKeyHolders(params.id);
        },
    )
    .post(
        '/admin/reports/:id/keys',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                keys: t.Array(
                    t.Object({
                        operatorUserId: uuidSchema,
                        keyEnvelope: t.String({
                            minLength: 150,
                            maxLength: 150,
                            pattern: '^[A-Za-z0-9_-]+$',
                        }),
                    }),
                    { minItems: 1, maxItems: 100 },
                ),
            }),
        },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.resealReport(operator.id, params.id, body.keys);
        },
    )
    .post(
        '/admin/reports/:id/packet',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.recordPacket(operator.id, params.id);
        },
    )
    .post(
        '/admin/reports/:id/resolve',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Union([
                t.Object({ status: t.Literal('dismissed'), hold: t.Boolean() }),
                t.Object({ status: t.Literal('removed'), hold: t.Boolean() }),
                t.Object({
                    status: t.Literal('filed'),
                    filedWith: t.String({ minLength: 1, maxLength: 200 }),
                    filedReference: t.Nullable(t.String({ maxLength: 200 })),
                }),
            ]),
        },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.resolveReport(operator.id, params.id, body);
        },
    )
    .post(
        '/admin/reports/:id/hold',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ held: t.Boolean() }) },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.holdReport(operator.id, params.id, body.held);
        },
    )
    .post(
        '/admin/reports/:id/reopen',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.reopenReport(operator.id, params.id);
        },
    )
    .post(
        '/admin/reports/:id/uploader',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ suspended: t.Boolean() }) },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.suspendUploader(operator.id, params.id, body.suspended);
        },
    )
    .post(
        '/admin/reports/:id/notes',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ note: t.String({ minLength: 1, maxLength: 2000 }) }),
        },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            const operator = await auth.requireAdmin(sessionToken);
            return drive.noteReport(operator.id, params.id, body.note);
        },
    )
    .get('/admin/overview', async ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        return auth.getAdminOverview(sessionToken);
    })
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
