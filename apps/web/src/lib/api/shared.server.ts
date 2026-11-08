import '@/lib/server-only';
import { EvlogError, parseError, log as serverLog, sanitizeFailure } from '@hushos/logging';
import { useRequest } from 'nitro/context';
import { Elysia, t, NotFound, ValidationError, ParseError } from 'elysia';
import * as auth from '@hushos/auth/server';
import {
    clientAddress,
    guardAuthMutation,
    readEnrollmentToken,
    readSessionToken,
} from '@hushos/auth/http';
import * as billing from '@hushos/billing/server';
import { enqueue, queues } from '@hushos/jobs/client';
import { driveRepository } from '@hushos/db';
import {
    CLIENT_HEADER,
    LINK_TOKEN_HEADER,
    MAX_TRASH_BATCH,
    checkClient,
    legacyMinimums,
    parseMinimums,
} from '@hushos/drive/protocol';
import * as drive from '@hushos/drive/server';
import * as groups from '@hushos/groups/server';
import {
    GROUP_WRITE_HEADER,
    MAX_GRANTS_PER_CALL,
    MAX_ROTATIONS_PER_CALL,
    MAX_SEALS_PER_CALL,
} from '@hushos/groups/protocol';
import { followsGroupWrites, groupWriteMinimums } from '@/lib/group-write-floor';
import { storageEnv } from '@hushos/env/storage';
import { CANCELLATION_REASONS } from '@hushos/billing/protocol';
import { appEnv } from '@hushos/env/app';
import { useLogger, useRequestId } from '@/lib/logging.server';
// A non-literal status here would erase every response type Eden Treaty infers.
export const ERROR_CODES = [400, 401, 403, 404, 409, 422, 429, 500, 503] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export function errorStatus(value: number): ErrorCode {
    return (ERROR_CODES as readonly number[]).includes(value) ? (value as ErrorCode) : 500;
}

/* Methods that change nothing: every other one is a write. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requestContext = new Elysia({ name: 'hushos-api-context' })
    .derive(({ request }) => ({
        log: useLogger(),
        requestId: useRequestId(),
        // Read once per request; handlers hand the tokens to the auth domain.
        sessionToken: readSessionToken(request),
        enrollmentToken: readEnrollmentToken(request),
    }))
    .onError(({ error, status, request }) => {
        // A response that fails its own schema is this server's bug, never the caller's: logged,
        // and answered as an outage, not as "check your information". Nothing of it is sent.
        if (error instanceof ValidationError && error.type === 'response') {
            // Where it failed (a JSON pointer such as /identity/kem/signature), never the value.
            const first = (
                error.all as Array<{ path?: string; instancePath?: string }> | undefined
            )?.[0];
            useLogger().set({
                api: {
                    failure: 'response-schema',
                    at: (first?.instancePath ?? first?.path ?? '').slice(0, 120),
                },
            });
            useLogger().error(new Error('A response did not match its schema.'));
            return status(500, { message: 'Something went wrong on our side. Please try again.' });
        }
        // A route the API does not define is not an outage: nothing is logged as an error. Drive
        // and admin answer 501, never 404: their clients read a 404 as "this item is gone" and drop
        // what they hold, and an unknown route there means a client newer than this server.
        if (error instanceof NotFound)
            return /^\/api\/(drive|admin|groups|invitations|notifications)(\/|$)/.test(
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
                // A refused refresh is told apart, so the page can wait instead of failing.
                if (error.status === 429)
                    return status(429, { message: error.message, code: 'rate-limited' as const });
                // `in-family`: a personal plan refused while the person's storage is a family's.
                return error instanceof billing.BillingError && error.code
                    ? status(error.status, { message: error.message, code: error.code })
                    : status(error.status, { message: error.message });
            }
            if (error instanceof ValidationError || error instanceof ParseError)
                return status(400, { message: 'Please check your information and try again.' });
            useLogger().set({ billing: { failure: describeFailure(error) } });
            useLogger().error(new Error('Billing request failed.'));
            return status(503, {
                message: 'Billing is temporarily unavailable. Please try again.',
            });
        }
        // Notifications: every refusal with a code a client can act on (sign in again, set the
        // device up, drop a gone event, stop asking on a server with them off).
        if (/^\/api\/notifications(\/|$)/.test(new URL(request.url).pathname)) {
            if (error instanceof auth.AuthError) {
                const code =
                    error.status === 401
                        ? ('signed-out' as const)
                        : error.status === 409
                          ? ('no-device' as const)
                          : error.status === 404
                            ? ('gone' as const)
                            : error.status === 501
                              ? ('off' as const)
                              : ('invalid' as const);
                return status(error.status, { message: error.message, code });
            }
            if (error instanceof ValidationError || error instanceof ParseError)
                return status(400, {
                    message: 'Please check your information and try again.',
                    code: 'invalid' as const,
                });
            useLogger().set({ notifications: { failure: describeFailure(error) } });
            useLogger().error(new Error('Notifications request failed.'));
            return status(503, {
                message: 'Notifications are temporarily unavailable. Please try again.',
                code: 'unavailable' as const,
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
export function notifyDevices(
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
export function describeFailure(error: unknown) {
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
export function requestAddress(request: Request) {
    return clientAddress(request, useRequest().ip);
}

/* A creator's email as the operator typed it, held to the sign-up rule so a pending one can match. */
export function affiliateEmail(email: string | null | undefined) {
    return email?.trim() ? auth.normalizeEmail(email) : null;
}

export function requestCountry(request: Request) {
    const header = appEnv.TRUSTED_COUNTRY_HEADER;
    return header ? request.headers.get(header) : null;
}

/*
 * Every Drive request names its client; one below the operator's minimum for
 * that client is refused with 426 and told how to update, before any work.
 */
export const clientMinimums = parseMinimums(storageEnv.DRIVE_CLIENT_MINIMUMS);
export const legacyClientMinimums = legacyMinimums(clientMinimums);
if (legacyClientMinimums.length > 0)
    serverLog.warn({
        message:
            'DRIVE_CLIENT_MINIMUMS has pre-1.0 protocol floors; they hold only clients from before 1.0.0. Use product versions such as web/1.0.0.',
        drive: { legacyClientMinimums },
    });
export function requireClient(
    request: Request,
    minimums: ReadonlyMap<string, string> = clientMinimums,
) {
    const check = checkClient(request.headers.get(CLIENT_HEADER), minimums);
    if (!check.ok)
        throw new drive.DriveError(
            check.status === 426 ? 'unsupported' : 'invalid',
            check.message,
            check.status,
        );
    return check.client;
}

export const uuidSchema = t.String({
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
export const epochSchema = t.Integer({ minimum: 1, maximum: 2147483646 });
/* The items of a batch trash or restore: drive.trashNodes checks the same again. */
export const nodeBatchSchema = t.Array(uuidSchema, {
    minItems: 1,
    maxItems: MAX_TRASH_BATCH,
    uniqueItems: true,
});
/*
 * The seed a client-made id was derived from. Optional and loose here on
 * purpose: the domain derives the id again and answers a missing, malformed
 * or wrong seed alike, "This id was not made for this workspace".
 */
export const idSeedSchema = t.Optional(t.String({ maxLength: 64 }));
// 72 bytes of nonce || wrapped key is 96 Base64url characters; metadata is bounded by its column.
export const keyEnvelopeSchema = t.String({
    minLength: 96,
    maxLength: 96,
    pattern: '^[A-Za-z0-9_-]+$',
});
export const MAX_REPORT_OPERATORS = 500;
/* A report key envelope: 112 bytes sealed under X25519 alone, or 1224 hybrid. */
export const reportEnvelopeSchema = t.Union([
    t.String({ minLength: 150, maxLength: 150, pattern: '^[A-Za-z0-9_-]+$' }),
    t.String({ minLength: 1632, maxLength: 1632, pattern: '^[A-Za-z0-9_-]+$' }),
]);
/*
 * A share envelope of any suite by length (72, 1160, 1256 or 4565 bytes), so a
 * client still sealing an older suite hears 409 "Update HushOS to share" from
 * the domain rather than a bare 400.
 */
export const shareEnvelopeSchema = t.Union([
    keyEnvelopeSchema,
    t.String({ minLength: 1547, maxLength: 1547, pattern: '^[A-Za-z0-9_-]+$' }),
    t.String({ minLength: 1675, maxLength: 1675, pattern: '^[A-Za-z0-9_-]+$' }),
    t.String({ minLength: 6087, maxLength: 6087, pattern: '^[A-Za-z0-9_-]+$' }),
]);
/* A version envelope of suites 2 and 3 (84 bytes): the content key sealed with the sizes. */
export const versionEnvelopeSchema = t.String({
    minLength: 112,
    maxLength: 112,
    pattern: '^[A-Za-z0-9_-]+$',
});
/* A version envelope of either suite; the domain holds it to the object's. */
export const anyVersionEnvelopeSchema = t.String({
    minLength: 96,
    maxLength: 112,
    pattern: '^[A-Za-z0-9_-]+$',
});
export const metadataEnvelopeSchema = t.String({
    minLength: 56,
    maxLength: 5515,
    pattern: '^[A-Za-z0-9_-]+$',
});
/* A workspace document envelope: 42 bytes at least, 1 MiB and its framing at most, Base64url. */
export const documentEnvelopeSchema = t.String({
    minLength: 56,
    maxLength: 1398155,
    pattern: '^[A-Za-z0-9_-]+$',
});
export const documentKindSchema = t.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' });
/* An Ed25519 signature, 64 bytes; the domain checks it against the writer's current key. */
export const signatureSchema = t.String({
    minLength: 86,
    maxLength: 86,
    pattern: '^[A-Za-z0-9_-]+$',
});
/* A person's hybrid signature: Ed25519 then ML-DSA-65, 3373 bytes. */
export const hybridSignatureSchema = t.String({
    minLength: 4498,
    maxLength: 4498,
    pattern: '^[A-Za-z0-9_-]+$',
});
export const nodeEnvelopesSchema = {
    keyEpoch: epochSchema,
    parentKeyEpoch: epochSchema,
    keyEnvelope: keyEnvelopeSchema,
    metadataEnvelope: metadataEnvelopeSchema,
    metadataSignature: signatureSchema,
};
export const cursorSchema = t.Optional(uuidSchema);
/* The trash pages on its own order, so its cursor is the last row's place in it, not an id. */
export const trashCursorSchema = t.Optional(
    t.String({ maxLength: 64, pattern: driveRepository.TRASH_CURSOR_PATTERN }),
);
export const linkTokenSchema = t.String({
    minLength: 43,
    maxLength: 43,
    pattern: '^[A-Za-z0-9_-]+$',
});
/* A link visitor's token travels in a header, never the path: proxies log paths. */
export const linkHeadersSchema = t.Object({ [LINK_TOKEN_HEADER]: linkTokenSchema });
export const linkSaltSchema = t.String({
    minLength: 22,
    maxLength: 22,
    pattern: '^[A-Za-z0-9_-]+$',
});
// 104 or 136 bytes: 139 or 182 Base64url characters; the server checks the exact lengths.
export const linkSecretSchema = t.String({
    minLength: 139,
    maxLength: 182,
    pattern: '^[A-Za-z0-9_-]+$',
});
export const uploadNodeSchema = t.Union([
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
export const partSchema = t.Object({
    partNumber: t.Integer({ minimum: 1, maximum: 10_000 }),
    etag: t.String({ minLength: 1, maxLength: 256 }),
});

export const cancellationSchema = t.Object({
    reason: t.Optional(t.UnionEnum(CANCELLATION_REASONS)),
    comment: t.Optional(t.String({ maxLength: 500 })),
});

export const emailSchema = t.String({
    minLength: 3,
    maxLength: 254,
    pattern: auth.EMAIL_ADDRESS_PATTERN.source,
});
export const opaqueMessage = t.String({ minLength: 1, maxLength: 4096 });
export const tokenSchema = t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' });
export const envelopeSchema = t.Object({
    envelopeVersion: t.Literal(1),
    keyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    credentialVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    wrappingSalt: tokenSchema,
    wrappingNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedKey: t.String({ minLength: 64, maxLength: 64 }),
});

export const recoverySchema = t.Object({
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
export const identityCommon = {
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
export const kemHalf = {
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
export const identitySchema = t.Union([
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
export const settingsKeySchema = t.Object({
    nonce: t.String({ minLength: 32, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' }),
    ciphertext: t.String({ minLength: 64, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }),
});

export const workspaceIdSchema = t.String({
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
export const workspaceKeySchema = t.Object({
    version: t.Literal(1),
    workspaceId: workspaceIdSchema,
    keyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    workspaceKeyVersion: t.Integer({ minimum: 1, maximum: 2147483646 }),
    wrappingSalt: tokenSchema,
    wrappingNonce: t.String({ minLength: 32, maxLength: 32 }),
    encryptedKey: t.String({ minLength: 64, maxLength: 64 }),
});
export const workspaceSetupSchema = t.Object({ id: workspaceIdSchema, grant: workspaceKeySchema });

/* A re-keyed record's part of a rotation: the origin's wrapped key and the rekeyed statement's signature. */
export const rekeySchema = t.Object({
    originKeyEnvelope: keyEnvelopeSchema,
    signature: signatureSchema,
});
/* A node of a rotation batch, and a group area root's rotation. */
export const rotatedNodeSchema = t.Object({
    id: uuidSchema,
    changeSeq: t.Integer({ minimum: 0 }),
    parentKeyEpoch: epochSchema,
    keyEnvelope: keyEnvelopeSchema,
    rotated: t.Nullable(
        t.Object({
            metadataEnvelope: metadataEnvelopeSchema,
            // Optional beside a re-key (docs/integrity-design.md, "Re-keyed records").
            metadataSignature: t.Optional(t.Nullable(signatureSchema)),
            metadataRekey: t.Optional(t.Nullable(rekeySchema)),
            metadataDropOrigin: t.Optional(t.Boolean()),
            versions: t.Array(
                t.Object({
                    id: uuidSchema,
                    contentKeyEnvelope: anyVersionEnvelopeSchema,
                    signature: t.Optional(t.Nullable(signatureSchema)),
                    rekey: t.Optional(t.Nullable(rekeySchema)),
                    dropOrigin: t.Optional(t.Boolean()),
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
export const b64Schema = (length: number) =>
    t.String({ minLength: length, maxLength: length, pattern: '^[A-Za-z0-9_-]+$' });
export const versionSchema = t.Integer({ minimum: 1, maximum: 9007199254740991 });
export const revisionSchema = t.Integer({ minimum: 1, maximum: 9007199254740991 });
export const digestSchema = b64Schema(43);
export const signedStatementSchema = t.Object({
    statement: t.String({ minLength: 1, maxLength: 5592406, pattern: '^[A-Za-z0-9_-]+$' }),
    signature: t.Object({ ed25519: b64Schema(86), mlDsa: b64Schema(4412) }),
    signerSignature: hybridSignatureSchema,
});
export const groupRoleSchema = t.Union([
    t.Literal('billing'),
    t.Literal('guardian'),
    t.Literal('members'),
]);
export const sealSchema = t.Object({
    groupKeyVersion: versionSchema,
    holderUserId: uuidSchema,
    holderKeyVersion: versionSchema,
    rosterVersion: versionSchema,
    rosterDigest: digestSchema,
    envelope: b64Schema(6130),
});
export const grantSchema = t.Object({
    workspaceId: uuidSchema,
    workspaceKeyVersion: versionSchema,
    granteeUserId: uuidSchema,
    granteeKeyVersion: versionSchema,
    rosterVersion: versionSchema,
    rosterDigest: digestSchema,
    envelope: b64Schema(6087),
});
export const areaRootSchema = t.Object({
    id: uuidSchema,
    idSeed: t.String({ maxLength: 64 }),
    ...nodeEnvelopesSchema,
});
export const areaSchema = t.Object({
    workspaceId: uuidSchema,
    idSeed: t.String({ maxLength: 64 }),
    root: areaRootSchema,
    selfGrant: workspaceKeySchema,
});
export const rotationSchema = t.Object({
    workspaceId: uuidSchema,
    fromVersion: versionSchema,
    toVersion: versionSchema,
    targetEpoch: epochSchema,
    root: rotatedNodeSchema,
    // The root's old key under the new area key (docs/groups-server.md 8).
    previousRootKeyEnvelope: keyEnvelopeSchema,
    selfGrant: workspaceKeySchema,
    /*
     * The area's workspace documents re-sealed under the new key, one per document it holds
     * (docs/groups-server.md 8). No item cap of their own: the body cap counts what the
     * group's areas store, and the repository refuses any kind the area does not hold.
     */
    documents: t.Array(
        t.Object({
            kind: documentKindSchema,
            version: t.Integer({ minimum: 1, maximum: 2147483646 }),
            envelope: documentEnvelopeSchema,
        }),
    ),
});
export const rosterCallFields = {
    expectedRevision: revisionSchema,
    roster: signedStatementSchema,
    succession: t.Optional(signedStatementSchema),
    seals: t.Optional(t.Array(sealSchema, { maxItems: MAX_SEALS_PER_CALL })),
    grants: t.Optional(t.Array(grantSchema, { maxItems: MAX_GRANTS_PER_CALL })),
    rotations: t.Optional(t.Array(rotationSchema, { maxItems: MAX_ROTATIONS_PER_CALL })),
};
export const groupParams = t.Object({ id: uuidSchema });
/* The lapsed plans (subscription ids) a leave or a removal was confirmed to end. */
export const endsLapsedSchema = t.Optional(t.Array(t.String({ maxLength: 100 }), { maxItems: 10 }));
export const memberParams = t.Object({ id: uuidSchema, userId: uuidSchema });
export const areaParams = t.Object({ id: uuidSchema, workspaceId: uuidSchema });

/*
 * A family's scheduled cut that Polar lost to a raise and could not be put back
 * at once goes to the worker's retry queue (pg-boss, with backoff).
 */
billing.setCutRetryQueue((groupId, startAfterSeconds) =>
    enqueue(
        queues.billingReissuePending,
        { groupId },
        { startAfterSeconds, singletonKey: groupId },
    ),
);

/*
 * A pooled member's personal plan is ended by the worker (docs/families-shared-pool.md 5.1):
 * an admission, a webhook or a family's plan going live queues it, one job per person.
 */
billing.setEndPersonalPlanQueue((data) =>
    enqueue(queues.billingEndPersonalPlan, data, { singletonKey: data.userId }),
);

/*
 * A family dissolved with a plan that can still charge has it set to end by the worker
 * (docs/groups-design.md 3.3): the leave route and every reconcile queue it, one job per family.
 */
billing.setDissolveCancelQueue((groupId) =>
    enqueue(queues.billingCancelDissolved, { groupId }, { singletonKey: groupId }),
);

/* The routes' own GROUPS_ENABLED check, behind the edge's. */
export function groupsGate() {
    if (!groups.groupsEnabled())
        throw new groups.GroupError('unsupported', 'This server does not offer groups yet.', 501);
}

/*
 * The routes that let people in, change roles or seal family keys
 * (docs/optional-verification.md 7.3): a client below the family-change floor
 * is refused with 426 before the handler reads or stores anything of the group,
 * so a tab still running code from before the family-write rules changed
 * can't change a family. Every other route keeps serving it
 * (lib/group-write-floor.ts).
 */
export const groupWriteFloor = groupWriteMinimums(
    clientMinimums,
    parseMinimums(storageEnv.GROUP_WRITE_CLIENT_MINIMUMS),
);

/* What a signed-out request to each feature is told. */
const SIGN_IN = {
    drive: 'Sign in to open Drive.',
    billing: 'Sign in to manage billing.',
    groups: 'Sign in to open your groups.',
    notifications: 'Sign in to manage notifications.',
} as const;

/*
 * Each route's checks, declared once on its feature's guard (Elysia macros), not called in every
 * handler. A guard's checks run in the order its options list them, after the body is parsed and
 * validated and before the handler; a route's own options (`groupWrite`) run after its guard's.
 * A route can't be reached without them, and a handler gets what they found (`user`, `operator`,
 * `client`) from its context.
 *
 * - groups: the server offers groups (GROUPS_ENABLED), or 501.
 * - mutation: a write (POST, PUT, PATCH, DELETE) carries this app's Origin and JSON, or 403/400.
 * - client: a named client at or above the server's minimums, or 426.
 * - groupWrite: a client at or above the family-change floor (docs/optional-verification.md 7.3),
 *   or 426, before the handler reads or stores anything.
 * - session: a signed-in account, as `user`, or 401 in the feature's words.
 * - admin: an operator, as `operator`: 401 signed out, 404 to anyone else.
 */
export const guards = new Elysia({ name: 'hushos-api-guards' }).use(requestContext).macro({
    groups: {
        derive: function groupsOffered() {
            groupsGate();
            return {};
        },
    },
    mutation: {
        derive: function sameOrigin({ request }) {
            if (!SAFE_METHODS.has(request.method)) guardAuthMutation(request);
            return {};
        },
    },
    client: {
        derive: function namedClient({ request }) {
            return { client: requireClient(request) };
        },
    },
    groupWrite: {
        derive: function familyChangeFloor({ request }) {
            const client = requireClient(request, groupWriteFloor);
            if (!followsGroupWrites(client.name, request.headers.get(GROUP_WRITE_HEADER)))
                throw new drive.DriveError(
                    'unsupported',
                    'This version of HushOS is out of date. Reload the page to update.',
                    426,
                );
            return {};
        },
    },
    session: (area: keyof typeof SIGN_IN) => ({
        derive: async function signedIn({ sessionToken }) {
            const user = await auth.getSessionUser(sessionToken);
            if (!user) throw new auth.AuthError(SIGN_IN[area], 401);
            return { user };
        },
    }),
    admin: {
        derive: async function operatorOnly({ sessionToken }) {
            return { operator: await auth.requireAdmin(sessionToken) };
        },
    },
});

/* The second half of the password exchange removing devices asks for (POST /auth/devices/reauth). */
export const deviceRemovalSchema = t.Object({
    attemptToken: tokenSchema,
    finishLoginRequest: opaqueMessage,
});

export const securityActionSchema = t.Union([
    t.Literal('password'),
    t.Literal('master-key'),
    t.Literal('recovery-key'),
]);
