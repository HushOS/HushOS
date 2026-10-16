import '@/lib/server-only';
import { createHash } from 'node:crypto';
import { cors } from '@elysia/cors';
import { db } from '@hushos/db';
import { EvlogError, parseError, authLogAction, sanitizeFailure } from '@hushos/logging';
import { useRequest } from 'nitro/context';
import { API_SERVICE } from '@hushos/shared';
import { Elysia, t, NotFound, ValidationError, ParseError } from 'elysia';
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
import { authRepository, driveRepository, growthRepository } from '@hushos/db';
import {
    CLIENT_HEADER,
    LINK_TOKEN_HEADER,
    checkClient,
    parseMinimums,
} from '@hushos/drive/protocol';
import { REPORT_CATEGORIES } from '@hushos/drive/api';
import * as drive from '@hushos/drive/server';
import * as groups from '@hushos/groups/server';
import {
    MAX_GRANTS_PER_CALL,
    MAX_ROTATIONS_PER_CALL,
    MAX_SEALS_PER_CALL,
} from '@hushos/groups/protocol';
import { createGroupRequestHandler } from '@/lib/group-requests';
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
        // A route the API does not define is not an outage: nothing is logged as an error. Drive
        // and admin answer 501, never 404: their clients read a 404 as "this item is gone" and drop
        // what they hold, and an unknown route there means a client newer than this server.
        if (error instanceof NotFound)
            return /^\/api\/(drive|admin|groups|invitations)(\/|$)/.test(
                new URL(request.url).pathname,
            )
                ? status(501, {
                      message: 'This server does not offer that yet. It may need an update.',
                      code: 'unsupported' as const,
                  })
                : status(404, { message: 'Not found.' });
        if (new URL(request.url).pathname.startsWith('/api/auth/')) {
            if (error instanceof auth.AuthError) {
                // A 5xx is an operator problem (mail, database): say what kind, never what it said.
                if (error.status >= 500) {
                    useLogger().set({ auth: { failure: describeFailure(error) } });
                    useLogger().error(new Error('Authentication request failed.'));
                }
                return status(error.status, { message: error.message, code: error.code });
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
        if (/^\/api\/(groups|invitations)(\/|$)/.test(new URL(request.url).pathname)) {
            // Access ended between the domain's check and the write (requireStillWriter).
            // Never `not-member`, the code a client wipes the group on.
            if (error instanceof driveRepository.AccessEndedError)
                return error.reason === 'held'
                    ? status(409, {
                          message: 'Another manager has paused your changes in this group for now.',
                          code: 'held' as const,
                      })
                    : status(409, {
                          message: 'The group’s members changed. Reload and try again.',
                          code: 'members-changed' as const,
                      });
            if (error instanceof groups.GroupError)
                return status(error.status, {
                    message: error.message,
                    code: error.code,
                    data: error.data,
                });
            if (error instanceof drive.DriveError)
                return status(error.status, {
                    message: error.message,
                    code: error.code,
                    data: error.data,
                });
            if (error instanceof auth.AuthError)
                return status(error.status, {
                    message: error.message,
                    code: error.status === 401 ? ('signed-out' as const) : ('forbidden' as const),
                });
            if (error instanceof ValidationError || error instanceof ParseError)
                return status(400, {
                    message: 'Please check your information and try again.',
                    code: 'invalid' as const,
                });
            useLogger().set({ group: { outcome: 'unavailable' }, failure: describeFailure(error) });
            useLogger().error(new Error('Group request failed.'));
            return status(503, {
                message: 'Groups are temporarily unavailable. Please try again.',
                code: 'unavailable' as const,
            });
        }
        if (/^\/api\/(drive|admin)\//.test(new URL(request.url).pathname)) {
            // A signed write from an identity still on version 1: an outdated build (see signedBy).
            // Access to a group area ended between the domain's check and the write.
            if (error instanceof driveRepository.AccessEndedError)
                return error.reason === 'held'
                    ? status(403, {
                          message: 'A group manager has paused changes to this folder.',
                          code: 'forbidden' as const,
                      })
                    : status(404, {
                          message: 'This item no longer exists.',
                          code: 'not-found' as const,
                      });
            if (error instanceof driveRepository.OutdatedIdentityError)
                return status(409, {
                    message: 'Update HushOS to save changes.',
                    code: 'unsupported' as const,
                });
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

/*
 * A device security notice, sent after the action and never awaited: the action
 * already happened, and a mail problem is the operator's. Logged by class and
 * code only, on the auth failure field the redaction allows.
 */
function notifyDevices(
    log: ReturnType<typeof useLogger>,
    userId: string,
    kind: 'new-device' | 'device-removed' | 'devices-removed',
    count?: number,
) {
    void auth.notifyDevices(userId, kind, count).catch((error: unknown) => {
        log.set({ auth: { failure: describeFailure(error) } });
        log.error(new Error('Security notice failed.'));
    });
}

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
/*
 * The seed a client-made id was derived from. Optional and loose here on
 * purpose: the domain derives the id again and answers a missing, malformed
 * or wrong seed alike, "This id was not made for this workspace".
 */
const idSeedSchema = t.Optional(t.String({ maxLength: 64 }));
// 72 bytes of nonce || wrapped key is 96 Base64url characters; metadata is bounded by its column.
const keyEnvelopeSchema = t.String({ minLength: 96, maxLength: 96, pattern: '^[A-Za-z0-9_-]+$' });
const MAX_REPORT_OPERATORS = 500;
/* A report key envelope: 112 bytes sealed under X25519 alone, or 1224 hybrid. */
const reportEnvelopeSchema = t.Union([
    t.String({ minLength: 150, maxLength: 150, pattern: '^[A-Za-z0-9_-]+$' }),
    t.String({ minLength: 1632, maxLength: 1632, pattern: '^[A-Za-z0-9_-]+$' }),
]);
/*
 * A share envelope of any suite by length (72, 1160, 1256 or 4565 bytes), so a
 * client still sealing an older suite hears 409 "Update HushOS to share" from
 * the domain rather than a bare 400.
 */
const shareEnvelopeSchema = t.Union([
    keyEnvelopeSchema,
    t.String({ minLength: 1547, maxLength: 1547, pattern: '^[A-Za-z0-9_-]+$' }),
    t.String({ minLength: 1675, maxLength: 1675, pattern: '^[A-Za-z0-9_-]+$' }),
    t.String({ minLength: 6087, maxLength: 6087, pattern: '^[A-Za-z0-9_-]+$' }),
]);
/* A version envelope of suites 2 and 3 (84 bytes): the content key sealed with the sizes. */
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
/* A workspace document envelope: 42 bytes at least, 1 MiB and its framing at most, Base64url. */
const documentEnvelopeSchema = t.String({
    minLength: 56,
    maxLength: 1398155,
    pattern: '^[A-Za-z0-9_-]+$',
});
const documentKindSchema = t.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' });
/* An Ed25519 signature, 64 bytes; the domain checks it against the writer's current key. */
const signatureSchema = t.String({ minLength: 86, maxLength: 86, pattern: '^[A-Za-z0-9_-]+$' });
/* A person's hybrid signature: Ed25519 then ML-DSA-65, 3373 bytes. */
const hybridSignatureSchema = t.String({
    minLength: 4498,
    maxLength: 4498,
    pattern: '^[A-Za-z0-9_-]+$',
});
const nodeEnvelopesSchema = {
    keyEpoch: epochSchema,
    parentKeyEpoch: epochSchema,
    keyEnvelope: keyEnvelopeSchema,
    metadataEnvelope: metadataEnvelopeSchema,
    metadataSignature: signatureSchema,
};
const cursorSchema = t.Optional(uuidSchema);
/* The trash pages on its own order, so its cursor is the last row's place in it, not an id. */
const trashCursorSchema = t.Optional(
    t.String({ maxLength: 64, pattern: driveRepository.TRASH_CURSOR_PATTERN }),
);
const linkTokenSchema = t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' });
/* A link visitor's token travels in a header, never the path: proxies log paths. */
const linkHeadersSchema = t.Object({ [LINK_TOKEN_HEADER]: linkTokenSchema });
const linkSaltSchema = t.String({ minLength: 22, maxLength: 22, pattern: '^[A-Za-z0-9_-]+$' });
// 104 or 136 bytes: 139 or 182 Base64url characters; the server checks the exact lengths.
const linkSecretSchema = t.String({ minLength: 139, maxLength: 182, pattern: '^[A-Za-z0-9_-]+$' });
const uploadNodeSchema = t.Union([
    t.Object({
        existing: t.Literal(false),
        id: uuidSchema,
        idSeed: idSeedSchema,
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

/* The fields every identity version shares: the X25519 and Ed25519 halves under the root. */
const identityCommon = {
    keyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    wrappingSalt: tokenSchema,
    encryptionPublicKey: tokenSchema,
    encryptionPrivateKeyNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedEncryptionPrivateKey: t.String({ minLength: 64, maxLength: 64 }),
    signingPublicKey: tokenSchema,
    signingSeedNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedSigningSeed: t.String({ minLength: 64, maxLength: 64 }),
};
/* A 1184-byte ML-KEM public key and its 80-byte wrapped seed. */
const kemHalf = {
    publicKey: t.String({ minLength: 1579, maxLength: 1579, pattern: '^[A-Za-z0-9_-]+$' }),
    seedNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedSeed: t.String({ minLength: 107, maxLength: 107 }),
};
/*
 * Version 2 (docs/identity-pq-design.md): all four halves and the keys
 * statement, a 3373-byte hybrid signature. Version 1 is accepted only where an
 * existing one is rewrapped (master-key rotation, its history); the domain
 * refuses it anywhere a new identity is stored.
 */
const identitySchema = t.Union([
    t.Object({
        version: t.Literal(2),
        ...identityCommon,
        kem: t.Object(kemHalf),
        mlDsa: t.Object({
            publicKey: t.String({ minLength: 2603, maxLength: 2603, pattern: '^[A-Za-z0-9_-]+$' }),
            seedNonce: t.String({ minLength: 32, maxLength: 32 }),
            encryptedSeed: t.String({ minLength: 64, maxLength: 64 }),
        }),
        keysSignature: hybridSignatureSchema,
    }),
    t.Object({
        version: t.Literal(1),
        ...identityCommon,
        kem: t.Optional(
            t.Nullable(
                t.Object({
                    ...kemHalf,
                    signature: t.Optional(t.Nullable(t.String({ minLength: 86, maxLength: 86 }))),
                }),
            ),
        ),
    }),
]);

/* The settings key wrapped under the account root: a 24-byte nonce and the 48-byte sealed key. */
const settingsKeySchema = t.Object({
    nonce: t.String({ minLength: 32, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' }),
    ciphertext: t.String({ minLength: 64, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }),
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

/* A node of a rotation batch, and a group area root's rotation. */
const rotatedNodeSchema = t.Object({
    id: uuidSchema,
    changeSeq: t.Integer({ minimum: 0 }),
    parentKeyEpoch: epochSchema,
    keyEnvelope: keyEnvelopeSchema,
    rotated: t.Nullable(
        t.Object({
            metadataEnvelope: metadataEnvelopeSchema,
            metadataSignature: signatureSchema,
            versions: t.Array(
                t.Object({
                    id: uuidSchema,
                    contentKeyEnvelope: anyVersionEnvelopeSchema,
                    signature: signatureSchema,
                }),
                { maxItems: 1000 },
            ),
            shares: t.Array(t.Object({ id: uuidSchema, shareEnvelope: shareEnvelopeSchema }), {
                maxItems: 1000,
            }),
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
});

/*
 * Groups (docs/groups-server.md 4). Every field has its exact Base64url length;
 * a statement is at most 4 MiB (5,592,406 characters).
 */
const b64Schema = (length: number) =>
    t.String({ minLength: length, maxLength: length, pattern: '^[A-Za-z0-9_-]+$' });
const versionSchema = t.Integer({ minimum: 1, maximum: 9007199254740991 });
const revisionSchema = t.Integer({ minimum: 1, maximum: 9007199254740991 });
const digestSchema = b64Schema(43);
const signedStatementSchema = t.Object({
    statement: t.String({ minLength: 1, maxLength: 5592406, pattern: '^[A-Za-z0-9_-]+$' }),
    signature: t.Object({ ed25519: b64Schema(86), mlDsa: b64Schema(4412) }),
    signerSignature: hybridSignatureSchema,
});
const groupRoleSchema = t.Union([
    t.Literal('billing'),
    t.Literal('guardian'),
    t.Literal('members'),
]);
const sealSchema = t.Object({
    groupKeyVersion: versionSchema,
    holderUserId: uuidSchema,
    holderKeyVersion: versionSchema,
    rosterVersion: versionSchema,
    rosterDigest: digestSchema,
    envelope: b64Schema(6130),
});
const grantSchema = t.Object({
    workspaceId: uuidSchema,
    workspaceKeyVersion: versionSchema,
    granteeUserId: uuidSchema,
    granteeKeyVersion: versionSchema,
    rosterVersion: versionSchema,
    rosterDigest: digestSchema,
    envelope: b64Schema(6087),
});
const areaRootSchema = t.Object({
    id: uuidSchema,
    idSeed: t.String({ maxLength: 64 }),
    ...nodeEnvelopesSchema,
});
const areaSchema = t.Object({
    workspaceId: uuidSchema,
    idSeed: t.String({ maxLength: 64 }),
    root: areaRootSchema,
    selfGrant: workspaceKeySchema,
});
const rotationSchema = t.Object({
    workspaceId: uuidSchema,
    fromVersion: versionSchema,
    toVersion: versionSchema,
    targetEpoch: epochSchema,
    root: rotatedNodeSchema,
    selfGrant: workspaceKeySchema,
});
const rosterCallFields = {
    expectedRevision: revisionSchema,
    roster: signedStatementSchema,
    succession: t.Optional(signedStatementSchema),
    seals: t.Optional(t.Array(sealSchema, { maxItems: MAX_SEALS_PER_CALL })),
    grants: t.Optional(t.Array(grantSchema, { maxItems: MAX_GRANTS_PER_CALL })),
    rotations: t.Optional(t.Array(rotationSchema, { maxItems: MAX_ROTATIONS_PER_CALL })),
};
const groupParams = t.Object({ id: uuidSchema });
const memberParams = t.Object({ id: uuidSchema, userId: uuidSchema });
const areaParams = t.Object({ id: uuidSchema, workspaceId: uuidSchema });

/* The routes' own GROUPS_ENABLED check, behind the edge's. */
function groupsGate() {
    if (!groups.groupsEnabled())
        throw new groups.GroupError('unsupported', 'This server does not offer groups yet.', 501);
}

/* Every group route: a named client and a session (the edge, group-requests.ts, checked both first). */
async function groupUser(request: Request, sessionToken: string | null) {
    requireClient(request);
    const user = await auth.getSessionUser(sessionToken);
    if (!user) throw new auth.AuthError('Sign in to open your groups.', 401);
    return user;
}

/* The second half of the password exchange removing devices asks for (POST /auth/devices/reauth). */
const deviceRemovalSchema = t.Object({
    attemptToken: tokenSchema,
    finishLoginRequest: opaqueMessage,
});

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
        {
            body: t.Object({
                attemptToken: tokenSchema,
                finishLoginRequest: opaqueMessage,
                // A device key's proof for this attempt (docs/devices-design.md, step 1).
                device: t.Optional(t.Object({ id: uuidSchema, signature: signatureSchema })),
            }),
        },
        async ({ sessionToken, body, set, log }) => {
            const {
                user,
                envelope,
                device,
                newDevice,
                sessionToken: token,
            } = await auth.finishLogin(
                body.attemptToken,
                body.finishLoginRequest,
                sessionToken,
                body.device,
            );
            set.headers['set-cookie'] = authCookie('session', token);
            // A device that came in with the password alone: the account's email hears of it.
            if (newDevice) notifyDevices(log, user.id, 'new-device');
            return { user, envelope, device };
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
                // Every earlier identity, re-wrapped under the new root by a master-key rotation.
                identityHistory: t.Optional(
                    t.Array(identitySchema, { maxItems: authRepository.IDENTITY_HISTORY_LIMIT }),
                ),
                settingsKey: t.Optional(settingsKeySchema),
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
    // The upgrade to a version 2 identity: the same keys, plus ML-DSA and the keys statement.
    .post(
        '/auth/identity/upgrade',
        { body: t.Object({ identity: identitySchema }) },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.upgradeIdentity(sessionToken, body);
        },
    )
    // Identity succession: new keys at the next version, signed by the current identity's hybrid signature.
    .post(
        '/auth/identity/succession',
        {
            body: t.Object({
                identity: identitySchema,
                signature: hybridSignatureSchema,
                // The successor's consent: two hybrid signatures, 6746 bytes.
                consent: t.Optional(
                    t.String({ minLength: 8995, maxLength: 8995, pattern: '^[A-Za-z0-9_-]+$' }),
                ),
            }),
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.succeedIdentity(sessionToken, body);
        },
    )
    .get('/auth/identity/history', ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        return auth.getIdentityHistory(sessionToken);
    })
    .get(
        '/auth/contacts/:userId/succession',
        {
            params: t.Object({ userId: uuidSchema }),
            query: t.Object({ from: t.Numeric({ minimum: 1, maximum: 2147483646 }) }),
        },
        ({ request, sessionToken, params, query }) =>
            auth.contactSuccession(
                sessionToken,
                params.userId,
                query.from,
                requestAddress(request),
            ),
    )
    // A POST so the address is in the body: a query string sits in proxy and access logs.
    .post(
        '/auth/contacts/lookup',
        { body: t.Object({ email: emailSchema }) },
        ({ request, sessionToken, body }) =>
            auth.lookupContact(sessionToken, body.email, requestAddress(request)),
    )
    .get('/auth/settings', ({ sessionToken }) => auth.getSettings(sessionToken))
    .put('/auth/settings-key', { body: settingsKeySchema }, ({ request, sessionToken, body }) => {
        guardAuthMutation(request);
        return auth.putSettingsKey(sessionToken, body);
    })
    .put(
        '/auth/settings',
        {
            body: t.Object({
                expectedVersion: t.Integer({ minimum: 0, maximum: 2147483646 }),
                // 2 is sealed under the settings key and the only version taken; anything
                // else (1, from a client that predates it) is refused with 409, not a bare 400.
                version: t.Optional(t.Integer({ minimum: 1, maximum: 255 })),
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
    // A removed device keeps hearing `removed` until it has cleared what it kept and acknowledges
    // it (POST /auth/session/forget): a wipe cut short is tried again on the next check.
    .get('/auth/session', ({ sessionToken }) => auth.sessionState(sessionToken))
    // The acknowledgement after that wipe: the cookie goes only if it is still the removed one.
    .post(
        '/auth/session/forget',
        { body: t.Object({}) },
        async ({ request, sessionToken, set }) => {
            guardAuthMutation(request);
            const forgotten = await auth.mayForgetSession(sessionToken);
            if (forgotten) set.headers['set-cookie'] = authCookie('session', null);
            return { forgotten };
        },
    )
    .get('/auth/devices', ({ sessionToken, set }) => {
        set.headers['Cache-Control'] = 'no-store';
        return auth.listDevices(sessionToken);
    })
    .post(
        '/auth/devices',
        {
            body: t.Object({
                kind: t.Union([t.Literal('web'), t.Literal('ios'), t.Literal('android')]),
                name: t.String({ minLength: 1, maxLength: 200 }),
                signingPublicKey: t.Optional(
                    t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' }),
                ),
            }),
        },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.registerDevice(sessionToken, body);
        },
    )
    // Removing devices asks for the password again: the first half of that OPAQUE exchange.
    .post(
        '/auth/devices/reauth',
        { body: t.Object({ startLoginRequest: opaqueMessage }) },
        ({ request, sessionToken, body }) => {
            guardAuthMutation(request);
            return auth.startDeviceRemoval(sessionToken, body.startLoginRequest);
        },
    )
    // Static beside the parameter: Elysia prefers it, and the id's pattern refuses "others" anyway.
    .delete(
        '/auth/devices/others',
        { body: deviceRemovalSchema },
        async ({ request, sessionToken, body, log }) => {
            guardAuthMutation(request);
            const { userId, removed } = await auth.removeOtherDevices(sessionToken, body);
            if (removed > 0) notifyDevices(log, userId, 'devices-removed', removed);
            return { removed };
        },
    )
    .put(
        '/auth/devices/:id',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }),
        },
        ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            return auth.renameDevice(sessionToken, params.id, body);
        },
    )
    .delete(
        '/auth/devices/:id',
        { params: t.Object({ id: uuidSchema }), body: deviceRemovalSchema },
        async ({ request, sessionToken, params, body, log }) => {
            guardAuthMutation(request);
            const { userId, removed } = await auth.removeDevice(sessionToken, params.id, body);
            notifyDevices(log, userId, 'device-removed');
            return { removed };
        },
    )
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
                slug: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
                code: t.Optional(t.String({ minLength: 3, maxLength: 32 })),
                percentOff: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
                duration: t.Optional(
                    t.Union([t.Literal('once'), t.Literal('forever'), t.Literal('repeating')]),
                ),
                durationMonths: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 36 }))),
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
    .delete(
        '/billing/affiliates/:id',
        { params: t.Object({ id: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            await auth.requireAdmin(sessionToken);
            return growth.deleteAffiliate(params.id);
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
            body: t.Object({ id: uuidSchema, idSeed: idSeedSchema, ...nodeEnvelopesSchema }),
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
                    t.Object({
                        id: uuidSchema,
                        idSeed: idSeedSchema,
                        parentId: uuidSchema,
                        ...nodeEnvelopesSchema,
                    }),
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
                metadataSignature: signatureSchema,
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
                versionIdSeed: idSeedSchema,
                objectId: uuidSchema,
                objectIdSeed: idSeedSchema,
                contentKeyEnvelope: versionEnvelopeSchema,
                versionSignature: signatureSchema,
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
                        versionSignature: signatureSchema,
                    }),
                    t.Object({
                        mode: t.Literal('sibling'),
                        node: t.Object({
                            id: uuidSchema,
                            idSeed: idSeedSchema,
                            parentId: uuidSchema,
                            ...nodeEnvelopesSchema,
                        }),
                        contentKeyEnvelope: versionEnvelopeSchema,
                        versionSignature: signatureSchema,
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
                node: t.Object({
                    id: uuidSchema,
                    idSeed: idSeedSchema,
                    parentId: uuidSchema,
                    ...nodeEnvelopesSchema,
                }),
                versionId: uuidSchema,
                versionIdSeed: idSeedSchema,
                contentKeyEnvelope: anyVersionEnvelopeSchema,
                versionSignature: signatureSchema,
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
                shareEnvelope: shareEnvelopeSchema,
            }),
        },
        async ({ request, sessionToken, params, body, log }) => {
            const user = await driveMutation(request, sessionToken);
            const result = await drive.shareNode(user.id, body.workspaceId, params.id, body);
            // The person is told by mail; a mail problem is the operator's, not the sharer's.
            void auth
                .notifyShare(user.id, body.granteeUserId, body.role)
                .catch((error: unknown) => {
                    // The class and code only: a mail error's message often names the recipient.
                    log.set({ share: { notify: 'failed', failure: describeFailure(error) } });
                    log.error(new Error('Share notification failed.'));
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
    .put(
        '/drive/shares/:id/envelope',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                workspaceId: uuidSchema,
                keyEpoch: epochSchema,
                shareEnvelope: shareEnvelopeSchema,
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.resealShare(
                (await driveMutation(request, sessionToken)).id,
                body.workspaceId,
                params.id,
                body,
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
                linkIdSeed: idSeedSchema,
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
    // Sealed workspace documents: the tag registry, replaced whole under a version precondition.
    .get(
        '/drive/workspaces/:id/documents/:kind',
        { params: t.Object({ id: uuidSchema, kind: documentKindSchema }) },
        async ({ request, sessionToken, params }) =>
            drive.workspaceDocument(
                (await driveUser(request, sessionToken)).id,
                params.id,
                params.kind,
            ),
    )
    .put(
        '/drive/workspaces/:id/documents/:kind',
        {
            params: t.Object({ id: uuidSchema, kind: documentKindSchema }),
            body: t.Object({
                version: t.Integer({ minimum: 0, maximum: 2147483646 }),
                envelope: documentEnvelopeSchema,
            }),
        },
        async ({ request, sessionToken, params, body }) =>
            drive.putWorkspaceDocument(
                (await driveMutation(request, sessionToken)).id,
                params.id,
                params.kind,
                body,
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
            // Opaque and sealed by the server; absent means from the start of the share.
            query: t.Object({ cursor: t.Optional(t.String({ maxLength: 128 })) }),
        },
        async ({ request, sessionToken, params, query }) =>
            drive.shareChanges(
                (await driveUser(request, sessionToken)).id,
                params.id,
                query.cursor,
            ),
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
                nodes: t.Array(rotatedNodeSchema, { minItems: 1, maxItems: 200 }),
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
    /*
     * The visitor's surface: no session, the token in the x-link-token header names
     * the link (never the path, which reverse proxies log), bounded per address and
     * token. The paths that carried the token answer 410 so an old client says why.
     */
    .get('/drive/links/open', { headers: linkHeadersSchema }, ({ request, headers }) => {
        requireClient(request);
        return drive.openLink(headers[LINK_TOKEN_HEADER], requestAddress(request));
    })
    .get(
        '/drive/links/nodes/:nodeId/children',
        {
            headers: linkHeadersSchema,
            params: t.Object({ nodeId: uuidSchema }),
            query: t.Object({ after: cursorSchema }),
        },
        ({ request, headers, params, query }) => {
            requireClient(request);
            return drive.linkChildren(
                headers[LINK_TOKEN_HEADER],
                requestAddress(request),
                params.nodeId,
                query.after,
            );
        },
    )
    .get(
        '/drive/links/versions/:versionId/url',
        { headers: linkHeadersSchema, params: t.Object({ versionId: uuidSchema }) },
        ({ request, headers, params }) => {
            requireClient(request);
            return drive.linkDownloadUrl(
                headers[LINK_TOKEN_HEADER],
                requestAddress(request),
                params.versionId,
            );
        },
    )
    .post(
        '/drive/links/versions/urls',
        {
            headers: linkHeadersSchema,
            body: t.Object({ versionIds: t.Array(uuidSchema, { minItems: 1, maxItems: 100 }) }),
        },
        ({ request, headers, body }) => {
            requireClient(request);
            return drive.linkDownloadUrls(
                headers[LINK_TOKEN_HEADER],
                requestAddress(request),
                body.versionIds,
            );
        },
    )
    .get(
        '/drive/links/thumbnails',
        {
            headers: linkHeadersSchema,
            query: t.Object({ versions: t.String({ minLength: 36, maxLength: 3700 }) }),
        },
        ({ request, headers, query }) => {
            requireClient(request);
            return drive.linkThumbnailUrls(
                headers[LINK_TOKEN_HEADER],
                requestAddress(request),
                query.versions.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
            );
        },
    )
    .get('/drive/links/:id/open', () => drive.linkPathRetired())
    .get('/drive/links/:id/nodes/:nodeId/children', () => drive.linkPathRetired())
    .get('/drive/links/:id/versions/:versionId/url', () => drive.linkPathRetired())
    .post('/drive/links/:id/versions/urls', () => drive.linkPathRetired())
    .get('/drive/links/:id/thumbnails', () => drive.linkPathRetired())
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
        { params: t.Object({ id: uuidSchema }), query: t.Object({ after: trashCursorSchema }) },
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
                reportIdSeed: idSeedSchema,
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
                keys: t.Array(
                    t.Object({
                        operatorUserId: uuidSchema,
                        keyEnvelope: reportEnvelopeSchema,
                    }),
                    // One envelope per current operator; an instance with more operators than this cannot take reports.
                    { minItems: 1, maxItems: MAX_REPORT_OPERATORS },
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
                        t.Literal('held'),
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
                        keyEnvelope: reportEnvelopeSchema,
                    }),
                    // One envelope per current operator; an instance with more operators than this cannot take reports.
                    { minItems: 1, maxItems: MAX_REPORT_OPERATORS },
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
    // Not UnionEnum: Elysia fills an absent optional UnionEnum query field with its first value.
    .get(
        '/admin/accounts',
        {
            query: t.Object({
                role: t.Optional(t.Union([t.Literal('admin'), t.Literal('member')])),
                q: t.Optional(t.String({ maxLength: 254 })),
                sort: t.Optional(t.Union([t.Literal('joined'), t.Literal('stored')])),
                offset: t.Optional(t.Numeric({ minimum: 0, maximum: 1_000_000 })),
            }),
        },
        async ({ sessionToken, query, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            return auth.listAdminAccounts(sessionToken, {
                role: query.role,
                query: query.q,
                sort: query.sort,
                offset: query.offset,
            });
        },
    )
    .get(
        '/admin/accounts/:id',
        { params: t.Object({ id: uuidSchema }) },
        async ({ sessionToken, params, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            return auth.getAdminAccount(sessionToken, params.id);
        },
    )
    .post(
        '/admin/accounts/:id/suspension',
        { params: t.Object({ id: uuidSchema }), body: t.Object({ suspended: t.Boolean() }) },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            const result = await auth.setAdminAccountSuspended(
                sessionToken,
                params.id,
                body.suspended,
            );
            // There is no audit table yet; the request log is the record of who did it.
            useLogger().set({
                admin: {
                    action: body.suspended ? 'account-suspended' : 'account-reinstated',
                    operatorId: result.operatorId,
                    accountId: params.id,
                },
            });
            return { suspendedAt: result.suspendedAt };
        },
    )
    .post(
        '/admin/accounts/:id/storage',
        {
            params: t.Object({ id: uuidSchema }),
            body: t.Object({
                // Decimal bytes, as every byte count on the wire; the bound is the server's.
                quotaBytes: t.String({ pattern: '^[0-9]{1,20}$' }),
                expiresAt: t.Optional(t.Nullable(t.String({ format: 'date-time' }))),
                note: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
            }),
        },
        async ({ request, sessionToken, params, body }) => {
            guardAuthMutation(request);
            const result = await auth.grantAdminAccountStorage(sessionToken, params.id, body);
            useLogger().set({
                admin: {
                    action: 'storage-granted',
                    operatorId: result.operatorId,
                    accountId: params.id,
                },
            });
            return { entitlementId: result.entitlementId, quotaBytes: result.quotaBytes };
        },
    )
    .post(
        '/admin/accounts/:id/storage/:entitlementId/revoke',
        { params: t.Object({ id: uuidSchema, entitlementId: uuidSchema }), body: t.Object({}) },
        async ({ request, sessionToken, params }) => {
            guardAuthMutation(request);
            const result = await auth.revokeAdminAccountStorage(
                sessionToken,
                params.id,
                params.entitlementId,
            );
            useLogger().set({
                admin: {
                    action: 'storage-revoked',
                    operatorId: result.operatorId,
                    accountId: params.id,
                },
            });
            return { quotaBytes: result.quotaBytes };
        },
    )
    .get(
        '/admin/workspaces',
        {
            query: t.Object({
                sort: t.Optional(t.Union([t.Literal('stored'), t.Literal('created')])),
                offset: t.Optional(t.Numeric({ minimum: 0, maximum: 1_000_000 })),
            }),
        },
        async ({ sessionToken, query, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            return auth.listAdminWorkspaces(sessionToken, query);
        },
    )
    // Groups (docs/groups-server.md 4): served only with GROUPS_ENABLED. The edge
    // (handleGroupRequest) refuses first; this gate holds if a route is ever
    // reached some other way, such as a test or a future mount that skips it.
    .guard({ beforeHandle: groupsGate }, (app) =>
        app
            .post(
                '/groups',
                {
                    body: t.Object({
                        id: uuidSchema,
                        idSeed: t.String({ maxLength: 64 }),
                        kind: t.Union([t.Literal('family'), t.Literal('org')]),
                        name: t.String({ minLength: 1, maxLength: 400 }),
                        groupKey: t.Object({
                            ed25519PublicKey: b64Schema(43),
                            mlDsaPublicKey: b64Schema(2603),
                        }),
                        roster: signedStatementSchema,
                        keySeal: t.Object({ envelope: b64Schema(6130) }),
                        area: t.Object({
                            ...areaSchema.properties,
                            grant: t.Object({ envelope: b64Schema(6087) }),
                        }),
                    }),
                },
                async ({ request, sessionToken, body, set }) => {
                    const result = await groups.createGroup(
                        (await groupUser(request, sessionToken)).id,
                        body,
                    );
                    set.status = result.replayed ? 200 : 201;
                    return { group: result.group };
                },
            )
            .get('/groups', async ({ request, sessionToken }) =>
                groups.listGroups((await groupUser(request, sessionToken)).id),
            )
            .get(
                '/groups/:id',
                { params: groupParams },
                async ({ request, sessionToken, params }) =>
                    groups.getGroup((await groupUser(request, sessionToken)).id, params.id),
            )
            .patch(
                '/groups/:id',
                {
                    params: groupParams,
                    body: t.Object({ name: t.String({ minLength: 1, maxLength: 400 }) }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.renameGroup(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        body,
                    ),
            )
            .get(
                '/groups/:id/rosters',
                {
                    params: groupParams,
                    query: t.Object({
                        after: t.Optional(t.Numeric({ minimum: 0, maximum: 9007199254740991 })),
                        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
                    }),
                },
                async ({ request, sessionToken, params, query }) =>
                    groups.getRosters(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        query,
                    ),
            )
            .get(
                '/groups/:id/identities',
                { params: groupParams, query: t.Object({ after: t.Optional(uuidSchema) }) },
                async ({ request, sessionToken, params, query }) =>
                    groups.getIdentities(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        query.after ?? null,
                    ),
            )
            .post(
                '/groups/:id/rosters',
                { params: groupParams, body: t.Object(rosterCallFields) },
                async ({ request, sessionToken, params, body }) =>
                    groups.postRoster((await groupUser(request, sessionToken)).id, params.id, body),
            )
            .get(
                '/groups/:id/key-seal',
                { params: groupParams },
                async ({ request, sessionToken, params }) =>
                    groups.getKeySeal((await groupUser(request, sessionToken)).id, params.id),
            )
            .put(
                '/groups/:id/key-seals',
                {
                    params: groupParams,
                    body: t.Object({
                        seals: t.Array(sealSchema, { minItems: 1, maxItems: MAX_SEALS_PER_CALL }),
                    }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.putKeySeals(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        body,
                    ),
            )
            .post(
                '/groups/:id/key-successions',
                {
                    params: groupParams,
                    body: t.Object({
                        expectedRevision: revisionSchema,
                        succession: signedStatementSchema,
                        seals: t.Array(sealSchema, { maxItems: MAX_SEALS_PER_CALL }),
                    }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.postSuccession(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        body,
                    ),
            )
            .post(
                '/groups/:id/invitations',
                {
                    params: groupParams,
                    body: t.Object({
                        email: emailSchema,
                        roles: t.Array(groupRoleSchema, { maxItems: 3 }),
                    }),
                },
                async ({ request, sessionToken, params, body, set }) => {
                    const result = await groups.invite(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        body,
                    );
                    set.status = 201;
                    return result;
                },
            )
            .get(
                '/groups/:id/invitations',
                { params: groupParams },
                async ({ request, sessionToken, params }) =>
                    groups.listInvitations((await groupUser(request, sessionToken)).id, params.id),
            )
            .delete(
                '/groups/:id/invitations/:invitationId',
                { params: t.Object({ id: uuidSchema, invitationId: uuidSchema }) },
                async ({ request, sessionToken, params }) =>
                    groups.revokeInvitation(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.invitationId,
                    ),
            )
            .post(
                '/invitations/open',
                { body: t.Object({ token: tokenSchema }) },
                async ({ request, sessionToken, body }) =>
                    groups.openInvitation(
                        (await groupUser(request, sessionToken)).id,
                        body.token,
                        requestAddress(request),
                    ),
            )
            .post(
                '/invitations/accept',
                { body: t.Object({ token: tokenSchema }) },
                async ({ request, sessionToken, body }) =>
                    groups.acceptInvitation(
                        (await groupUser(request, sessionToken)).id,
                        body.token,
                        requestAddress(request),
                    ),
            )
            .get(
                '/groups/:id/pending',
                { params: groupParams },
                async ({ request, sessionToken, params }) =>
                    groups.listPending((await groupUser(request, sessionToken)).id, params.id),
            )
            .post(
                '/groups/:id/members/:userId/admit',
                {
                    params: memberParams,
                    body: t.Object({ ...rosterCallFields, keySeal: t.Optional(sealSchema) }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.admit(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.userId,
                        body,
                    ),
            )
            .patch(
                '/groups/:id/members/:userId',
                {
                    params: memberParams,
                    body: t.Object({ ...rosterCallFields, keySeal: t.Optional(sealSchema) }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.patchMember(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.userId,
                        body,
                    ),
            )
            .post(
                '/groups/:id/members/:userId/remove',
                { params: memberParams, body: t.Object(rosterCallFields) },
                async ({ request, sessionToken, params, body }) =>
                    groups.removeMember(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.userId,
                        body,
                    ),
            )
            .post(
                '/groups/:id/members/:userId/decline',
                { params: memberParams, body: t.Object({}) },
                async ({ request, sessionToken, params }) =>
                    groups.declinePending(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.userId,
                    ),
            )
            .post(
                '/groups/:id/members/:userId/hold',
                { params: memberParams, body: t.Object({}) },
                async ({ request, sessionToken, params }) =>
                    groups.hold(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.userId,
                    ),
            )
            .post(
                '/groups/:id/leave',
                { params: groupParams, body: t.Object({}) },
                async ({ request, sessionToken, params }) =>
                    groups.leave((await groupUser(request, sessionToken)).id, params.id),
            )
            .post(
                '/groups/:id/areas',
                { params: groupParams, body: t.Object({ ...rosterCallFields, area: areaSchema }) },
                async ({ request, sessionToken, params, body }) =>
                    groups.createArea((await groupUser(request, sessionToken)).id, params.id, body),
            )
            .post(
                '/groups/:id/areas/:workspaceId/grants',
                {
                    params: areaParams,
                    body: t.Object({
                        grants: t.Array(grantSchema, {
                            minItems: 1,
                            maxItems: MAX_GRANTS_PER_CALL,
                        }),
                    }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.postGrants(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                        body,
                    ),
            )
            .put(
                '/groups/:id/areas/:workspaceId/self-grant',
                { params: areaParams, body: t.Object({ grant: workspaceKeySchema }) },
                async ({ request, sessionToken, params, body }) =>
                    groups.putSelfGrant(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                        body,
                    ),
            )
            .post(
                '/groups/:id/areas/:workspaceId/rotations',
                {
                    params: areaParams,
                    body: t.Object({ ...rosterCallFields, rotation: rotationSchema }),
                },
                async ({ request, sessionToken, params, body }) =>
                    groups.rotateArea(
                        (await groupUser(request, sessionToken)).id,
                        params.id,
                        params.workspaceId,
                        body,
                    ),
            ),
    )
    // Every space the account can open: their own, and each group's areas once groups are on.
    .get('/drive/spaces', async ({ request, sessionToken }) => {
        const user = await driveUser(request, sessionToken);
        const personal = await drive.getWorkspace(user.id);
        return {
            spaces: [
                {
                    space: { kind: 'personal' as const },
                    areas: [
                        {
                            workspaceId: personal.workspaceId,
                            workspaceKeyVersion: personal.grant?.workspaceKeyVersion ?? 1,
                            selfGrant: personal.grant,
                        },
                    ],
                },
                ...(groups.groupsEnabled() ? await groups.spaces(user.id) : []),
            ],
        };
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
    if (/^\/api\/(groups|invitations)(\/|$)/.test(pathname)) return handleGroupRequest(request);
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
