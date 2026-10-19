import {
    and,
    asc,
    count,
    desc,
    eq,
    gt,
    gte,
    inArray,
    isNotNull,
    isNull,
    lte,
    ne,
    or,
    sql,
} from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from './client';
import { departAllForDeletion } from './groups';
import { poolName, shownPoolFree, shownPoolUsed, storageFigures } from './pool';
import { pgCode } from './readiness';
import { keyedHash } from './hash-key';
import { personalWorkspaces, workspaceKeys, workspaceStorage, workspaces } from './schema';
import {
    deviceSessionStatement,
    keysStatement,
    successionConsentHolds,
    successionStatement,
    verifyHybrid,
    verifySignature,
} from './signatures';
import {
    accountDevices,
    accountEnrollments,
    accountIntents,
    accountRecoveryKeys,
    accountIdentities,
    accountIdentityHistory,
    accountSettingsKeys,
    accountRecoveryAttempts,
    accountKeys,
    authRateLimits,
    opaqueCredentials,
    opaqueLoginAttempts,
    removedSessionTokens,
    serverSecrets,
    sessions,
    userSettings,
    users,
    type DeviceKind,
} from './schema';

const userFields = { id: users.id, name: users.name, email: users.email, role: users.role };
// For writers that touch enrollments by email; never returned to a client.
const userFieldsWithEmailKey = { ...userFields, normalizedEmail: users.normalizedEmail };

export async function createEnrollment(input: typeof accountEnrollments.$inferInsert) {
    await db.insert(accountEnrollments).values(input);
}

export async function removeEnrollment(verificationTokenHash: Buffer) {
    await db
        .delete(accountEnrollments)
        .where(eq(accountEnrollments.verificationTokenHash, verificationTokenHash));
}

export async function verifyEnrollment(
    verificationTokenHash: Buffer,
    enrollmentTokenHash: Buffer,
    expiresAt: Date,
) {
    const [enrollment] = await db
        .update(accountEnrollments)
        .set({
            verificationTokenHash: null,
            enrollmentTokenHash,
            verifiedAt: new Date(),
            expiresAt,
        })
        .where(
            and(
                eq(accountEnrollments.verificationTokenHash, verificationTokenHash),
                isNull(accountEnrollments.verifiedAt),
                gt(accountEnrollments.expiresAt, new Date()),
            ),
        )
        .returning({
            id: accountEnrollments.id,
            email: accountEnrollments.email,
            purpose: accountEnrollments.purpose,
        });
    return enrollment ?? null;
}

export async function getEnrollment(enrollmentTokenHash: Buffer) {
    const [enrollment] = await db
        .select()
        .from(accountEnrollments)
        .where(
            and(
                eq(accountEnrollments.enrollmentTokenHash, enrollmentTokenHash),
                isNotNull(accountEnrollments.verifiedAt),
                gt(accountEnrollments.expiresAt, new Date()),
            ),
        );
    return enrollment ?? null;
}

export async function registerAccount(input: {
    enrollmentTokenHash: Buffer;
    initialQuotaBytes: bigint;
    name: string;
    registrationRecord: string;
    profileVersion: number;
    serverSetupId: string;
    identity: Omit<typeof accountIdentities.$inferInsert, 'userId'>;
    recovery: Omit<typeof accountRecoveryKeys.$inferInsert, 'userId'>;
    workspace: WorkspaceGrantInput;
    envelope: Pick<
        typeof accountKeys.$inferInsert,
        'envelopeVersion' | 'wrappingSalt' | 'wrappingNonce' | 'encryptedKey'
    >;
}) {
    return db.transaction(async (tx) => {
        const [enrollment] = await tx
            .select()
            .from(accountEnrollments)
            .where(
                and(
                    eq(accountEnrollments.enrollmentTokenHash, input.enrollmentTokenHash),
                    isNotNull(accountEnrollments.verifiedAt),
                    gt(accountEnrollments.expiresAt, new Date()),
                ),
            )
            .for('update');
        if (!enrollment?.verifiedAt || enrollment.purpose !== 'register')
            return { status: 'expired' as const };

        const [user] = await tx
            .insert(users)
            .values({
                id: enrollment.id,
                name: input.name,
                email: enrollment.email,
                normalizedEmail: enrollment.normalizedEmail,
                emailVerifiedAt: enrollment.verifiedAt,
            })
            .onConflictDoNothing({ target: users.normalizedEmail })
            .returning(userFields);
        if (!user) return { status: 'exists' as const };
        if (enrollment.intent && (enrollment.intent.plan || enrollment.intent.referral))
            await tx.insert(accountIntents).values({
                userId: user.id,
                planProductId: enrollment.intent.plan ?? null,
                referralCode: enrollment.intent.referral ?? null,
                source: enrollment.intent.source ?? null,
            });

        // The client chose the workspace id because its grant is bound to it.
        const [workspace] = await tx
            .insert(workspaces)
            .values({ id: input.workspace.id, ownerKind: 'personal' })
            .onConflictDoNothing()
            .returning({ id: workspaces.id });
        if (!workspace) throw new Error('Could not create workspace.');
        await tx.insert(personalWorkspaces).values({ userId: user.id, workspaceId: workspace.id });
        await tx
            .insert(workspaceStorage)
            .values({ workspaceId: workspace.id, baseQuotaBytes: input.initialQuotaBytes });
        await tx
            .insert(workspaceKeys)
            .values({ ...input.workspace.grant, workspaceId: workspace.id, userId: user.id });
        await tx.insert(opaqueCredentials).values({
            userId: user.id,
            registrationRecord: input.registrationRecord,
            profileVersion: input.profileVersion,
            serverSetupId: input.serverSetupId,
        });
        await tx.insert(accountKeys).values({ ...input.envelope, userId: user.id });
        await tx.insert(accountRecoveryKeys).values({ ...input.recovery, userId: user.id });
        await tx.insert(accountIdentities).values({ ...input.identity, userId: user.id });
        await tx.delete(accountEnrollments).where(eq(accountEnrollments.id, enrollment.id));
        return { status: 'created' as const, user };
    });
}

export async function getAccountKeyVersion(userId: string) {
    const [row] = await db
        .select({ keyVersion: accountKeys.keyVersion })
        .from(accountKeys)
        .where(eq(accountKeys.userId, userId));
    return row?.keyVersion ?? null;
}

/*
 * A secret the server keeps for itself, made once: the first caller's value is
 * the one everyone reads afterwards, however many processes start at once, and
 * a value already there is never replaced.
 */
export async function ensureServerSecret(name: string, generate: () => Promise<string> | string) {
    const [existing] = await db
        .select({ value: serverSecrets.value })
        .from(serverSecrets)
        .where(eq(serverSecrets.name, name));
    if (existing) return existing.value;
    await db
        .insert(serverSecrets)
        .values({ name, value: await generate() })
        .onConflictDoNothing({ target: serverSecrets.name });
    const [row] = await db
        .select({ value: serverSecrets.value })
        .from(serverSecrets)
        .where(eq(serverSecrets.name, name));
    if (!row) throw new Error(`The server secret "${name}" could not be stored.`);
    return row.value;
}

export async function hasCredentialsOutside(profileVersion: number, serverSetupId: string) {
    const [row] = await db
        .select({ userId: opaqueCredentials.userId })
        .from(opaqueCredentials)
        .where(
            or(
                ne(opaqueCredentials.profileVersion, profileVersion),
                ne(opaqueCredentials.serverSetupId, serverSetupId),
            ),
        )
        .limit(1);
    return row !== undefined;
}

export async function findCredential(normalizedEmail: string) {
    const [credential] = await db
        .select({
            userId: users.id,
            registrationRecord: opaqueCredentials.registrationRecord,
            version: opaqueCredentials.version,
            profileVersion: opaqueCredentials.profileVersion,
            serverSetupId: opaqueCredentials.serverSetupId,
        })
        .from(users)
        .innerJoin(opaqueCredentials, eq(users.id, opaqueCredentials.userId))
        .where(eq(users.normalizedEmail, normalizedEmail));
    return credential ?? null;
}

export async function createLoginAttempt(input: typeof opaqueLoginAttempts.$inferInsert) {
    await db.insert(opaqueLoginAttempts).values(input);
}

// Commit consumption before protocol verification so a failed finish cannot replay.
export async function consumeLoginAttempt(tokenHash: Buffer) {
    const [attempt] = await db
        .delete(opaqueLoginAttempts)
        .where(eq(opaqueLoginAttempts.tokenHash, tokenHash))
        .returning();
    return attempt ?? null;
}

/*
 * How long after sign-up the first device counts as the one the account was
 * created on (`enrolment`), when the account has no device yet. Registration
 * opens no session, so this is how the first sign-in is told apart.
 */
export const DEVICE_ENROLMENT_SECONDS = 30 * 60;
/* How long a removed device's session tokens are remembered, so it learns it was removed. */
export const REMOVED_TOKEN_SECONDS = 7 * 24 * 60 * 60;
/* A keyed device with no session for this long is revoked; a revoked row this old is deleted. */
export const DEVICE_IDLE_DAYS = 90;
export const DEVICE_REVOKED_DAYS = 90;

export type CreatedDevice = 'enrolment' | 'password';

/*
 * Opens a session, on a device. In one transaction under the account's lock:
 * - a device that proves it holds its key (`device`, a signature over this
 *   attempt) comes back to its own row, keeping how it was approved;
 * - otherwise the browser's previous session, if it is this account's and its
 *   device never got a key, lends its device: holding the cookie is the proof;
 * - otherwise a new device, `enrolment` when the account is fresh and has none,
 *   `password` in every other case.
 * A bad or revoked proof never fails the sign-in; it just makes a new device.
 * The device's other session, if any, ends: one live session per device.
 */
export async function createSession(input: {
    userId: string;
    credentialVersion: number;
    tokenHash: Buffer;
    previousTokenHash: Buffer | null;
    expiresAt: Date;
    device?: { id: string; signature: Buffer; attemptDigest: Buffer };
}) {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select({ ...userFields, suspendedAt: users.suspendedAt, createdAt: users.createdAt })
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
        if (!user) return null;
        if (user.suspendedAt) return { suspended: true as const };

        const [record] = await tx
            .select({ key: accountKeys })
            .from(opaqueCredentials)
            .innerJoin(
                accountKeys,
                and(
                    eq(accountKeys.userId, opaqueCredentials.userId),
                    eq(accountKeys.credentialVersion, opaqueCredentials.version),
                ),
            )
            .where(
                and(
                    eq(opaqueCredentials.userId, user.id),
                    eq(opaqueCredentials.version, input.credentialVersion),
                ),
            );
        if (!record) return null;

        const now = new Date();
        let device: { id: string; registered: boolean } | null = null;
        let created: CreatedDevice | null = null;
        if (input.device && UUID_PATTERN.test(input.device.id)) {
            const [row] = await tx
                .select({ id: accountDevices.id, key: accountDevices.signingPublicKey })
                .from(accountDevices)
                .where(
                    and(
                        eq(accountDevices.id, input.device.id),
                        eq(accountDevices.userId, user.id),
                        isNull(accountDevices.revokedAt),
                        isNotNull(accountDevices.approvedAt),
                        isNotNull(accountDevices.signingPublicKey),
                    ),
                )
                .for('update');
            if (
                row?.key &&
                verifySignature(
                    row.key,
                    deviceSessionStatement({
                        userId: user.id,
                        deviceId: row.id,
                        attemptDigest: input.device.attemptDigest,
                    }),
                    input.device.signature,
                )
            )
                device = { id: row.id, registered: true };
        }
        if (!device && input.previousTokenHash) {
            const [previous] = await tx
                .select({ id: accountDevices.id, kind: accountDevices.kind })
                .from(sessions)
                .innerJoin(accountDevices, eq(accountDevices.id, sessions.deviceId))
                .where(
                    and(
                        eq(sessions.tokenHash, input.previousTokenHash),
                        eq(sessions.userId, user.id),
                        isNull(accountDevices.revokedAt),
                        isNotNull(accountDevices.approvedAt),
                        isNull(accountDevices.signingPublicKey),
                    ),
                )
                .for('update', { of: accountDevices });
            if (previous) device = { id: previous.id, registered: previous.kind !== null };
        }
        const attached = device !== null;
        if (!device) {
            const [existing] = await tx
                .select({ count: count() })
                .from(accountDevices)
                .where(eq(accountDevices.userId, user.id));
            created =
                (existing?.count ?? 0) === 0 &&
                user.createdAt.getTime() > now.getTime() - DEVICE_ENROLMENT_SECONDS * 1000
                    ? 'enrolment'
                    : 'password';
            const [row] = await tx
                .insert(accountDevices)
                .values({
                    userId: user.id,
                    approvedBy: created,
                    approvedAt: now,
                    createdAt: now,
                    lastSeenAt: now,
                })
                .returning({ id: accountDevices.id });
            if (!row) throw new Error('Could not create the device.');
            device = { id: row.id, registered: false };
        } else
            await tx
                .update(accountDevices)
                .set({ lastSeenAt: now })
                .where(eq(accountDevices.id, device.id));

        if (input.previousTokenHash)
            await tx.delete(sessions).where(eq(sessions.tokenHash, input.previousTokenHash));
        await tx.delete(sessions).where(eq(sessions.deviceId, device.id));
        await tx.insert(sessions).values({
            userId: user.id,
            credentialVersion: input.credentialVersion,
            tokenHash: input.tokenHash,
            deviceId: device.id,
            expiresAt: input.expiresAt,
            lastSeenAt: now,
        });
        const { suspendedAt: _suspendedAt, createdAt: _createdAt, ...plain } = user;
        return {
            user: plain,
            key: record.key,
            device: { id: device.id, attached, registered: device.registered, created },
        };
    });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * The session behind a token, with its device, or null. Only a session on a
 * device that is approved and not revoked resolves: removing a device ends its
 * sessions in the same step, and this join is the second line. A session
 * without a device (written by a container of the previous release during a
 * rolling update) does not resolve either; that person signs in again.
 */
export async function getSession(
    tokenHash: Buffer,
    lifetime: { idleSeconds: number; maxSeconds: number },
) {
    const now = new Date();
    const absoluteCutoff = new Date(now.getTime() - lifetime.maxSeconds * 1000);
    const [result] = await db
        .select({
            user: { ...userFields, credentialVersion: sessions.credentialVersion },
            sessionId: sessions.id,
            createdAt: sessions.createdAt,
            deviceId: accountDevices.id,
            deviceKind: accountDevices.kind,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .innerJoin(
            opaqueCredentials,
            and(
                eq(opaqueCredentials.userId, users.id),
                eq(opaqueCredentials.version, sessions.credentialVersion),
            ),
        )
        .innerJoin(
            accountDevices,
            and(
                eq(accountDevices.id, sessions.deviceId),
                eq(accountDevices.userId, sessions.userId),
                isNull(accountDevices.revokedAt),
                isNotNull(accountDevices.approvedAt),
            ),
        )
        .where(
            and(
                eq(sessions.tokenHash, tokenHash),
                gt(sessions.expiresAt, now),
                gt(sessions.createdAt, absoluteCutoff),
                isNull(users.suspendedAt),
            ),
        );
    if (!result) return null;
    // Slide the idle deadline on activity, at most every five minutes, never past the cap; the
    // device's last-seen moves with its own session, and only then.
    const absoluteExpiry = new Date(result.createdAt.getTime() + lifetime.maxSeconds * 1000);
    const idleExpiry = new Date(now.getTime() + lifetime.idleSeconds * 1000);
    const expiresAt = idleExpiry < absoluteExpiry ? idleExpiry : absoluteExpiry;
    const throttle = new Date(now.getTime() - 5 * 60_000);
    await db.execute(sql`
        with touched as (
            update ${sessions}
            set last_seen_at = ${now}, expires_at = ${expiresAt}
            where ${sessions.id} = ${result.sessionId}
              and (${sessions.lastSeenAt} is null or ${sessions.lastSeenAt} < ${throttle})
            returning ${sessions.deviceId} as device_id
        )
        update ${accountDevices} set last_seen_at = ${now}
        where ${accountDevices.id} in (select device_id from touched)
    `);
    return {
        user: result.user,
        device: { id: result.deviceId, registered: result.deviceKind !== null },
    };
}

export async function getSessionUser(
    tokenHash: Buffer,
    lifetime: { idleSeconds: number; maxSeconds: number },
) {
    return (await getSession(tokenHash, lifetime))?.user ?? null;
}

/* Whether this token's session ended because its device was removed, in the last week. */
export async function wasRemoved(tokenHash: Buffer) {
    const [row] = await db
        .select({ tokenHash: removedSessionTokens.tokenHash })
        .from(removedSessionTokens)
        .where(
            and(
                eq(removedSessionTokens.tokenHash, tokenHash),
                gt(removedSessionTokens.expiresAt, new Date()),
            ),
        );
    return row !== undefined;
}

export async function updateUserName(userId: string, name: string) {
    const [user] = await db
        .update(users)
        .set({ name, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning(userFields);
    return user ?? null;
}

/*
 * Signing out: the session's device is revoked with every session it has, so a
 * shared computer keeps nothing tied to the account. A session without a device
 * (the previous release's) just ends.
 */
export async function signOutDevice(tokenHash: Buffer) {
    await db.transaction(async (tx) => {
        const [session] = await tx
            .select({ userId: sessions.userId, deviceId: sessions.deviceId })
            .from(sessions)
            .where(eq(sessions.tokenHash, tokenHash));
        if (!session) return;
        await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, session.userId))
            .for('update');
        if (session.deviceId) {
            await tx
                .update(accountDevices)
                .set({ revokedAt: new Date() })
                .where(
                    and(eq(accountDevices.id, session.deviceId), isNull(accountDevices.revokedAt)),
                );
            await tx.delete(sessions).where(eq(sessions.deviceId, session.deviceId));
        }
        await tx.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    });
}

/* ------------------------------------------------------------------------- */
/* Devices                                                                    */
/* ------------------------------------------------------------------------- */

const deviceFields = {
    id: accountDevices.id,
    kind: accountDevices.kind,
    name: accountDevices.name,
    approvedBy: accountDevices.approvedBy,
    approvedByDeviceId: accountDevices.approvedByDeviceId,
    createdAt: accountDevices.createdAt,
    lastSeenAt: accountDevices.lastSeenAt,
};

/*
 * The account's devices that are not revoked, whether each has a live session,
 * and which one is asking: that one first, then the most recently seen. Only
 * this account's rows, ever.
 */
export async function listDevices(userId: string, currentDeviceId: string) {
    const rows = await db
        .select({
            ...deviceFields,
            // Written out in full: inside a select's field list, column references render unqualified.
            signedIn: sql<boolean>`exists (select 1 from "sessions" as "live" join "opaque_credentials" as "credential" on "credential"."user_id" = "live"."user_id" and "credential"."version" = "live"."credential_version" where "live"."device_id" = "account_devices"."id" and "live"."expires_at" > now())`,
        })
        .from(accountDevices)
        .where(and(eq(accountDevices.userId, userId), isNull(accountDevices.revokedAt)))
        // By the hour the list shows, then by id: the exact order would say which was used last.
        .orderBy(
            desc(sql`date_trunc('hour', ${accountDevices.lastSeenAt})`),
            asc(accountDevices.id),
        );
    const devices = rows.map((row) => ({
        ...row,
        signedIn: Boolean(row.signedIn),
        current: row.id === currentDeviceId,
    }));
    return [...devices.filter((d) => d.current), ...devices.filter((d) => !d.current)];
}

export type RegisterDeviceResult =
    | { status: 'ok'; device: Awaited<ReturnType<typeof listDevices>>[number] }
    | { status: 'session' | 'registered' | 'key-in-use' };

/*
 * The session's own device describes itself: its kind, its name and, when the
 * client could make one, its signing key. Once: a device that already
 * described itself is refused, so a key is set exactly once and only on the
 * device the session belongs to.
 */
export async function registerDevice(input: {
    sessionTokenHash: Buffer;
    kind: DeviceKind;
    name: string;
    signingPublicKey: Buffer | null;
}): Promise<RegisterDeviceResult> {
    return db.transaction(async (tx) => {
        const [session] = await tx
            .select({ userId: sessions.userId, deviceId: sessions.deviceId })
            .from(sessions)
            .where(
                and(
                    eq(sessions.tokenHash, input.sessionTokenHash),
                    gt(sessions.expiresAt, new Date()),
                ),
            );
        if (!session?.deviceId) return { status: 'session' };
        const [device] = await tx
            .select({ kind: accountDevices.kind, revokedAt: accountDevices.revokedAt })
            .from(accountDevices)
            .where(
                and(
                    eq(accountDevices.id, session.deviceId),
                    eq(accountDevices.userId, session.userId),
                ),
            )
            .for('update');
        if (!device || device.revokedAt) return { status: 'session' };
        if (device.kind !== null) return { status: 'registered' };
        if (input.signingPublicKey) {
            const [taken] = await tx
                .select({ id: accountDevices.id })
                .from(accountDevices)
                .where(
                    and(
                        eq(accountDevices.userId, session.userId),
                        eq(accountDevices.signingPublicKey, input.signingPublicKey),
                    ),
                );
            if (taken) return { status: 'key-in-use' };
        }
        const now = new Date();
        const [row] = await tx
            .update(accountDevices)
            .set({
                kind: input.kind,
                name: input.name,
                signingPublicKey: input.signingPublicKey,
                lastSeenAt: now,
            })
            .where(eq(accountDevices.id, session.deviceId))
            .returning(deviceFields);
        if (!row) return { status: 'session' };
        return { status: 'ok', device: { ...row, signedIn: true, current: true } };
    });
}

/* Any of the account's devices, renamed from any of them. Another account's, or a revoked one, is missing. */
export async function renameDevice(input: { userId: string; deviceId: string; name: string }) {
    const [row] = await db
        .update(accountDevices)
        .set({ name: input.name })
        .where(
            and(
                eq(accountDevices.id, input.deviceId),
                eq(accountDevices.userId, input.userId),
                isNull(accountDevices.revokedAt),
            ),
        )
        .returning(deviceFields);
    return row ?? null;
}

/*
 * The acting session's device under the account's lock, read after the lock is
 * held: a device removed by a request that ran first has no session left.
 */
async function actingDevice(tx: Tx, userId: string, sessionTokenHash: Buffer) {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const [acting] = await tx
        .select({ deviceId: accountDevices.id })
        .from(sessions)
        .innerJoin(accountDevices, eq(accountDevices.id, sessions.deviceId))
        .where(
            and(
                eq(sessions.tokenHash, sessionTokenHash),
                eq(sessions.userId, userId),
                gt(sessions.expiresAt, new Date()),
                isNull(accountDevices.revokedAt),
            ),
        );
    return acting?.deviceId ?? null;
}

/* Ends every session of `deviceIds` and remembers their tokens for a week, so the devices learn why. */
async function endDeviceSessions(tx: Tx, deviceIds: string[]) {
    if (deviceIds.length === 0) return;
    const ended = await tx
        .delete(sessions)
        .where(inArray(sessions.deviceId, deviceIds))
        .returning({ tokenHash: sessions.tokenHash });
    if (ended.length === 0) return;
    const expiresAt = new Date(Date.now() + REMOVED_TOKEN_SECONDS * 1000);
    await tx
        .insert(removedSessionTokens)
        .values(ended.map(({ tokenHash }) => ({ tokenHash, expiresAt })))
        .onConflictDoNothing();
}

export type RevokeResult =
    | { status: 'ok'; removed: number }
    | { status: 'session' | 'missing' | 'current' };

/*
 * Removes one of the account's other devices: it is revoked and its sessions
 * end at once. Under the account's lock, so two devices removing each other at
 * the same moment cannot both succeed: the second finds its own device gone.
 * The device asking cannot remove itself (that is signing out).
 */
export async function revokeDevice(input: {
    userId: string;
    deviceId: string;
    sessionTokenHash: Buffer;
}): Promise<RevokeResult> {
    return db.transaction(async (tx) => {
        const acting = await actingDevice(tx, input.userId, input.sessionTokenHash);
        if (!acting) return { status: 'session' };
        if (acting === input.deviceId) return { status: 'current' };
        const [target] = await tx
            .update(accountDevices)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(accountDevices.id, input.deviceId),
                    eq(accountDevices.userId, input.userId),
                    isNull(accountDevices.revokedAt),
                ),
            )
            .returning({ id: accountDevices.id });
        if (!target) return { status: 'missing' };
        await endDeviceSessions(tx, [target.id]);
        return { status: 'ok', removed: 1 };
    });
}

/* Removes every device of the account but the one asking. */
export async function revokeOtherDevices(input: {
    userId: string;
    sessionTokenHash: Buffer;
}): Promise<RevokeResult> {
    return db.transaction(async (tx) => {
        const acting = await actingDevice(tx, input.userId, input.sessionTokenHash);
        if (!acting) return { status: 'session' };
        const revoked = await tx
            .update(accountDevices)
            .set({ revokedAt: new Date() })
            .where(
                and(
                    eq(accountDevices.userId, input.userId),
                    ne(accountDevices.id, acting),
                    isNull(accountDevices.revokedAt),
                ),
            )
            .returning({ id: accountDevices.id });
        await endDeviceSessions(
            tx,
            revoked.map((row) => row.id),
        );
        // Sessions a container of the previous release opened during a rolling update have no
        // device, and that release still accepts them: they end here too, and are told why.
        const deviceless = await tx
            .delete(sessions)
            .where(and(eq(sessions.userId, input.userId), isNull(sessions.deviceId)))
            .returning({ tokenHash: sessions.tokenHash });
        if (deviceless.length > 0) {
            const expiresAt = new Date(Date.now() + REMOVED_TOKEN_SECONDS * 1000);
            await tx
                .insert(removedSessionTokens)
                .values(deviceless.map(({ tokenHash }) => ({ tokenHash, expiresAt })))
                .onConflictDoNothing();
        }
        return { status: 'ok', removed: revoked.length };
    });
}

/*
 * Counts one use of a bucket and says whether it is within the limit. Callers
 * name the bucket by a digest of its key (`auth:address:<ip>` and the like);
 * the row keeps that digest keyed again under the server hash key, so a dump of
 * the table cannot be matched to an address, an email or an account.
 */
export async function consumeRateLimit(bucket: Buffer, limit: number, windowMs: number) {
    const keyHash = keyedHash(bucket);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMs);
    const [row] = await db
        .insert(authRateLimits)
        .values({ keyHash, count: 1, expiresAt })
        .onConflictDoUpdate({
            target: authRateLimits.keyHash,
            set: {
                count: sql`case when ${authRateLimits.expiresAt} <= ${now} then 1 else least(${authRateLimits.count} + 1, ${limit + 1}) end`,
                expiresAt: sql`case when ${authRateLimits.expiresAt} <= ${now} then ${expiresAt} else ${authRateLimits.expiresAt} end`,
            },
        })
        .returning({ count: authRateLimits.count });
    return row !== undefined && row.count <= limit;
}

/*
 * Whether a bucket still has room for one more use, without taking it: for a
 * budget charged only when the thing it bounds actually happens (a group's
 * stored rosters), so refused or replayed calls cost nothing.
 */
export async function rateLimitHasRoom(bucket: Buffer, limit: number) {
    const [row] = await db
        .select({ count: authRateLimits.count })
        .from(authRateLimits)
        .where(
            and(
                eq(authRateLimits.keyHash, keyedHash(bucket)),
                gt(authRateLimits.expiresAt, new Date()),
            ),
        );
    return !row || row.count < limit;
}

/*
 * Takes one use back off a bucket, for a count of things that should have finished and
 * did (a password proof started, then completed). The row goes at zero.
 */
export async function releaseRateLimit(bucket: Buffer) {
    const keyHash = keyedHash(bucket);
    await db.transaction(async (tx) => {
        await tx
            .delete(authRateLimits)
            .where(and(eq(authRateLimits.keyHash, keyHash), lte(authRateLimits.count, 1)));
        await tx
            .update(authRateLimits)
            .set({ count: sql`${authRateLimits.count} - 1` })
            .where(and(eq(authRateLimits.keyHash, keyHash), gt(authRateLimits.count, 1)));
    });
}

/*
 * Removes expired rows in bounded batches so a large backlog never holds a lock or
 * a connection for long. Runs from the background worker, never inside a request.
 */
export async function cleanupExpired(options: { batchSize?: number; signal?: AbortSignal } = {}) {
    const batch = Math.max(1, Math.min(options.batchSize ?? 500, 5_000));
    const now = new Date();
    async function sweep(table: PgTable, key: PgColumn, expiresAt: PgColumn) {
        let total = 0;
        while (!options.signal?.aborted) {
            const result = await db.execute(
                sql`delete from ${table} where ${key} in (select ${key} from ${table} where ${expiresAt} < ${now} limit ${batch})`,
            );
            const deleted = result.rowCount ?? 0;
            total += deleted;
            if (deleted < batch) break;
        }
        return total;
    }
    /* `statement` deletes or updates at most `batch` rows per run; repeated until fewer come back. */
    async function repeat(statement: () => ReturnType<typeof db.execute>) {
        let total = 0;
        while (!options.signal?.aborted) {
            const affected = (await statement()).rowCount ?? 0;
            total += affected;
            if (affected < batch) break;
        }
        return total;
    }
    const sessionsSwept = await sweep(sessions, sessions.id, sessions.expiresAt);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const idleCutoff = new Date(now.getTime() - DEVICE_IDLE_DAYS * 24 * 60 * 60 * 1000);
    const revokedCutoff = new Date(now.getTime() - DEVICE_REVOKED_DAYS * 24 * 60 * 60 * 1000);
    const noSession = sql`not exists (select 1 from ${sessions} where ${sessions.deviceId} = ${accountDevices.id})`;
    return {
        enrollments: await sweep(
            accountEnrollments,
            accountEnrollments.id,
            accountEnrollments.expiresAt,
        ),
        loginAttempts: await sweep(
            opaqueLoginAttempts,
            opaqueLoginAttempts.tokenHash,
            opaqueLoginAttempts.expiresAt,
        ),
        recoveryAttempts: await sweep(
            accountRecoveryAttempts,
            accountRecoveryAttempts.tokenHash,
            accountRecoveryAttempts.expiresAt,
        ),
        sessions: sessionsSwept,
        rateLimits: await sweep(authRateLimits, authRateLimits.keyHash, authRateLimits.expiresAt),
        removedTokens: await sweep(
            removedSessionTokens,
            removedSessionTokens.tokenHash,
            removedSessionTokens.expiresAt,
        ),
        // A device without a key and without a session can never come back: neither a
        // signature nor a cookie leads to it any more. A day's grace for one just made.
        keylessDevices: await repeat(() =>
            db.execute(
                sql`delete from ${accountDevices} where ${accountDevices.id} in (select ${accountDevices.id} from ${accountDevices} where ${accountDevices.signingPublicKey} is null and ${accountDevices.createdAt} < ${dayAgo} and ${noSession} limit ${batch})`,
            ),
        ),
        // A keyed device unseen for 90 days with no session is revoked; it signs in as new.
        idleDevices: await repeat(() =>
            db.execute(
                sql`update ${accountDevices} set revoked_at = ${now} where ${accountDevices.id} in (select ${accountDevices.id} from ${accountDevices} where ${accountDevices.revokedAt} is null and ${accountDevices.signingPublicKey} is not null and ${accountDevices.lastSeenAt} < ${idleCutoff} and ${noSession} limit ${batch})`,
            ),
        ),
        // Revoked rows, with the names they carried, go 90 days after.
        revokedDevices: await repeat(() =>
            db.execute(
                sql`delete from ${accountDevices} where ${accountDevices.id} in (select ${accountDevices.id} from ${accountDevices} where ${accountDevices.revokedAt} < ${revokedCutoff} limit ${batch})`,
            ),
        ),
    };
}

export async function getRecoveryKey(userId: string) {
    const [key] = await db
        .select()
        .from(accountRecoveryKeys)
        .where(eq(accountRecoveryKeys.userId, userId));
    return key ?? null;
}
export async function confirmRecoveryKey(userId: string, recoveryVersion: number) {
    const rows = await db
        .update(accountRecoveryKeys)
        .set({ confirmedAt: new Date() })
        .where(
            and(
                eq(accountRecoveryKeys.userId, userId),
                eq(accountRecoveryKeys.recoveryVersion, recoveryVersion),
            ),
        )
        .returning({ userId: accountRecoveryKeys.userId });
    return rows.length === 1;
}
export async function createRecoveryAttempt(input: typeof accountRecoveryAttempts.$inferInsert) {
    await db.insert(accountRecoveryAttempts).values(input);
}
export async function consumeRecoveryAttempt(tokenHash: Buffer) {
    const [attempt] = await db
        .delete(accountRecoveryAttempts)
        .where(eq(accountRecoveryAttempts.tokenHash, tokenHash))
        .returning();
    return attempt ?? null;
}
export async function resetAccountPassword(input: {
    userId: string;
    enrollmentId: string;
    enrollmentTokenHash: Buffer;
    credentialVersion: number;
    registrationRecord: string;
    profileVersion: number;
    serverSetupId: string;
    envelope: Pick<
        typeof accountKeys.$inferInsert,
        'keyVersion' | 'wrappingSalt' | 'wrappingNonce' | 'encryptedKey'
    >;
    recovery: Omit<typeof accountRecoveryKeys.$inferInsert, 'userId'>;
}) {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .select(userFieldsWithEmailKey)
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
        if (!row) return null;
        const { normalizedEmail, ...user } = row;
        const [enrollment] = await tx
            .select()
            .from(accountEnrollments)
            .where(
                and(
                    eq(accountEnrollments.id, input.enrollmentId),
                    eq(accountEnrollments.enrollmentTokenHash, input.enrollmentTokenHash),
                    eq(accountEnrollments.purpose, 'recover'),
                    eq(accountEnrollments.normalizedEmail, normalizedEmail),
                    isNotNull(accountEnrollments.verifiedAt),
                    gt(accountEnrollments.expiresAt, new Date()),
                ),
            )
            .for('update');
        if (!enrollment) return null;
        const [credential] = await tx
            .select()
            .from(opaqueCredentials)
            .where(
                and(
                    eq(opaqueCredentials.userId, user.id),
                    eq(opaqueCredentials.version, input.credentialVersion),
                ),
            );
        if (!credential) return null;
        const version = input.credentialVersion + 1;
        await tx
            .update(opaqueCredentials)
            .set({
                registrationRecord: input.registrationRecord,
                version,
                profileVersion: input.profileVersion,
                serverSetupId: input.serverSetupId,
                updatedAt: new Date(),
            })
            .where(eq(opaqueCredentials.userId, user.id));
        await tx
            .update(accountKeys)
            .set({ ...input.envelope, credentialVersion: version, updatedAt: new Date() })
            .where(eq(accountKeys.userId, user.id));
        await tx
            .update(accountRecoveryKeys)
            .set({ ...input.recovery, confirmedAt: null, updatedAt: new Date() })
            .where(eq(accountRecoveryKeys.userId, user.id));
        await tx.delete(sessions).where(eq(sessions.userId, user.id));
        await tx.delete(opaqueLoginAttempts).where(eq(opaqueLoginAttempts.userId, user.id));
        await tx.delete(accountRecoveryAttempts).where(eq(accountRecoveryAttempts.userId, user.id));
        await tx
            .delete(accountEnrollments)
            .where(
                and(
                    eq(accountEnrollments.normalizedEmail, normalizedEmail),
                    eq(accountEnrollments.purpose, 'recover'),
                ),
            );
        return user;
    });
}

/*
 * The account's storage, as its meter and the phones show it: its own
 * allowance, or while its files draw from a family's pool
 * (docs/families-shared-pool.md 3.1) the pool's figures and the family, so a
 * shipped phone shows the numbers uploads are checked against without
 * updating. The same rule Drive's free-space check applies (pool.ts).
 */
export async function getStorageAllowance(userId: string) {
    const [personal] = await db
        .select({ workspaceId: personalWorkspaces.workspaceId })
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.userId, userId));
    if (!personal) return null;
    const figures = await storageFigures(db, personal.workspaceId, { lock: false });
    if (!figures) return null;
    const name = figures.pool ? await poolName(db, figures.pool.groupId) : null;
    if (figures.pool && name !== null)
        // The pool's figures as a member may see them (pool.ts shownPoolUsed): whole GiB, and
        // no reserved bytes, which shipped clients still decode, so the field stays as "0".
        return {
            workspaceId: personal.workspaceId,
            quotaBytes: figures.allowance.toString(),
            usedBytes: shownPoolUsed(figures.used).toString(),
            reservedBytes: '0',
            availableBytes: shownPoolFree(figures.free).toString(),
            pool: { groupId: figures.pool.groupId, name },
        };
    return {
        workspaceId: personal.workspaceId,
        quotaBytes: figures.allowance.toString(),
        usedBytes: figures.used.toString(),
        reservedBytes: figures.reserved.toString(),
        availableBytes: (figures.free > 0n ? figures.free : 0n).toString(),
        pool: null,
    };
}

/*
 * Deletes the account and everything hanging off it. Before the account row
 * is locked (the group row comes first in every lock order), the person
 * departs every group they are in as leaving would: their access to the
 * groups' areas ends and holders are told to mark them left. The only
 * `billing` holder, or the last `members` holder of a group with others
 * active, cannot be deleted until they hand over (`group-holder`), and
 * nothing is changed.
 */
export async function deleteAccount(input: {
    userId: string;
    credentialVersion: number;
    sessionTokenHash: Buffer;
}): Promise<boolean | 'group-holder' | 'unavailable'> {
    class Holder extends Error {}
    // Thrown, never returned, so the departures above roll back with it.
    class Refused extends Error {}
    try {
        return await db.transaction(async (tx) => {
            if (!(await sessionIsCurrent(tx, input))) return false;
            if ((await departAllForDeletion(tx, input.userId)).status !== 'ok') throw new Holder();
            if (!(await deleteAccountRow(tx, input))) throw new Refused();
            return true;
        });
    } catch (error) {
        if (error instanceof Holder) return 'group-holder';
        if (error instanceof Refused) return false;
        // It locks groups, areas and the account: a deadlock with a group write is retried.
        const code = pgCode(error);
        if (code === '40P01' || code === '40001') return 'unavailable';
        throw error;
    }
}

async function deleteAccountRow(
    tx: Tx,
    input: { userId: string; credentialVersion: number; sessionTokenHash: Buffer },
) {
    const [user] = await tx
        .select(userFieldsWithEmailKey)
        .from(users)
        .where(eq(users.id, input.userId))
        .for('update');
    if (!user) return false;
    const [session] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(
            opaqueCredentials,
            and(
                eq(opaqueCredentials.userId, sessions.userId),
                eq(opaqueCredentials.version, sessions.credentialVersion),
            ),
        )
        .where(
            and(
                eq(sessions.userId, user.id),
                eq(sessions.tokenHash, input.sessionTokenHash),
                eq(sessions.credentialVersion, input.credentialVersion),
                gt(sessions.expiresAt, new Date()),
            ),
        );
    if (!session) return false;
    const [personal] = await tx
        .select()
        .from(personalWorkspaces)
        .where(eq(personalWorkspaces.userId, user.id));
    if (personal) await tx.delete(workspaces).where(eq(workspaces.id, personal.workspaceId));
    await tx
        .delete(accountEnrollments)
        .where(eq(accountEnrollments.normalizedEmail, user.normalizedEmail));
    await tx.delete(users).where(eq(users.id, user.id));
    return true;
}

export async function getAccountSetup(userId: string) {
    const [row] = await db
        .select({
            recovery: accountRecoveryKeys.userId,
            identity: accountIdentities.userId,
            workspace: personalWorkspaces.workspaceId,
            workspaceKey: workspaceKeys.userId,
        })
        .from(users)
        .leftJoin(accountRecoveryKeys, eq(accountRecoveryKeys.userId, users.id))
        .leftJoin(accountIdentities, eq(accountIdentities.userId, users.id))
        .leftJoin(personalWorkspaces, eq(personalWorkspaces.userId, users.id))
        .leftJoin(
            workspaceKeys,
            and(
                eq(workspaceKeys.userId, users.id),
                eq(workspaceKeys.workspaceId, personalWorkspaces.workspaceId),
            ),
        )
        .where(eq(users.id, userId));
    if (!row) return null;
    return {
        recovery: !row.recovery,
        identity: !row.identity,
        workspace: !row.workspace,
        workspaceKey: !row.workspaceKey,
        workspaceId: row.workspace ?? null,
    };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* Whether the session is live and on the account's current credential: a rotation since ends it. */
async function sessionIsCurrent(
    tx: Tx,
    input: { userId: string; credentialVersion: number; sessionTokenHash: Buffer },
) {
    const [session] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(
            opaqueCredentials,
            and(
                eq(opaqueCredentials.userId, sessions.userId),
                eq(opaqueCredentials.version, sessions.credentialVersion),
            ),
        )
        .where(
            and(
                eq(sessions.userId, input.userId),
                eq(sessions.tokenHash, input.sessionTokenHash),
                eq(sessions.credentialVersion, input.credentialVersion),
                gt(sessions.expiresAt, new Date()),
            ),
        );
    return session !== undefined;
}

// Existing accounts can add missing features, but can never overwrite permanent keys here.
export async function initializeAccount(input: {
    userId: string;
    credentialVersion: number;
    sessionTokenHash: Buffer;
    initialQuotaBytes: bigint;
    recovery?: Omit<typeof accountRecoveryKeys.$inferInsert, 'userId'>;
    identity?: Omit<typeof accountIdentities.$inferInsert, 'userId'>;
    workspace?: WorkspaceGrantInput;
}) {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select({ id: users.id, keyVersion: accountKeys.keyVersion })
            .from(users)
            .innerJoin(accountKeys, eq(accountKeys.userId, users.id))
            .where(eq(users.id, input.userId))
            .for('update', { of: users });
        if (!user) return false;
        const [session] = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .innerJoin(
                opaqueCredentials,
                and(
                    eq(opaqueCredentials.userId, sessions.userId),
                    eq(opaqueCredentials.version, sessions.credentialVersion),
                ),
            )
            .where(
                and(
                    eq(sessions.userId, user.id),
                    eq(sessions.tokenHash, input.sessionTokenHash),
                    eq(sessions.credentialVersion, input.credentialVersion),
                    gt(sessions.expiresAt, new Date()),
                ),
            );
        if (!session) return false;
        if (input.recovery)
            await tx
                .insert(accountRecoveryKeys)
                .values({ ...input.recovery, userId: user.id })
                .onConflictDoNothing();
        if (input.identity)
            await tx
                .insert(accountIdentities)
                .values({ ...input.identity, userId: user.id })
                .onConflictDoNothing();
        const [personal] = await tx
            .select({ workspaceId: personalWorkspaces.workspaceId })
            .from(personalWorkspaces)
            .where(eq(personalWorkspaces.userId, user.id));
        let workspaceId = personal?.workspaceId;
        if (!workspaceId) {
            const [workspace] = await tx
                .insert(workspaces)
                .values({
                    ...(input.workspace ? { id: input.workspace.id } : {}),
                    ownerKind: 'personal',
                })
                .onConflictDoNothing()
                .returning({ id: workspaces.id });
            if (!workspace) throw new Error('Could not create workspace.');
            workspaceId = workspace.id;
            await tx.insert(personalWorkspaces).values({ userId: user.id, workspaceId });
            await tx
                .insert(workspaceStorage)
                .values({ workspaceId, baseQuotaBytes: input.initialQuotaBytes });
        }
        // A grant is bound to its workspace id and root revision; anything else waits for
        // the next setup round, which reports the ids the client should use.
        if (
            input.workspace &&
            input.workspace.id === workspaceId &&
            input.workspace.grant.keyVersion === user.keyVersion
        )
            await tx
                .insert(workspaceKeys)
                .values({ ...input.workspace.grant, workspaceId, userId: user.id })
                .onConflictDoNothing();
        return true;
    });
}

export async function getSecurityBundles(userId: string) {
    const [bundles] = await db
        .select({
            envelope: accountKeys,
            recovery: accountRecoveryKeys,
            identity: accountIdentities,
        })
        .from(accountKeys)
        .innerJoin(accountRecoveryKeys, eq(accountRecoveryKeys.userId, accountKeys.userId))
        .innerJoin(accountIdentities, eq(accountIdentities.userId, accountKeys.userId))
        .where(eq(accountKeys.userId, userId));
    if (!bundles) return null;
    // A group area's self-grant is sealed under its group's context, so a rotation needs
    // the group to rewrap it: the workspace's own group, null for a personal workspace.
    const grants = await db
        .select({ grant: workspaceKeys, groupId: workspaces.groupId })
        .from(workspaceKeys)
        .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
        .where(eq(workspaceKeys.userId, userId))
        .orderBy(workspaceKeys.workspaceId);
    // Earlier identities and the settings key are sealed under the root too: a master-key
    // rotation re-wraps them.
    return {
        ...bundles,
        workspaces: grants.map(({ grant, groupId }) => ({ ...grant, groupId })),
        identityHistory: await listIdentityHistory(userId),
        settingsKey: await getSettingsKey(userId),
    };
}

/* An identity's wrapped halves, as a rotation re-wraps them; the public keys stay. */
export type IdentityWrap = Pick<
    typeof accountIdentities.$inferInsert,
    | 'keyVersion'
    | 'wrappingSalt'
    | 'encryptionPublicKey'
    | 'encryptionPrivateKeyNonce'
    | 'encryptedEncryptionPrivateKey'
    | 'signingPublicKey'
    | 'signingSeedNonce'
    | 'encryptedSigningSeed'
    | 'version'
    | 'kemPublicKey'
    | 'kemSeedNonce'
    | 'encryptedKemSeed'
    | 'mlDsaPublicKey'
    | 'mlDsaSeedNonce'
    | 'encryptedMlDsaSeed'
    | 'keysSignature'
>;
type PublicKeys = {
    encryptionPublicKey: Buffer;
    signingPublicKey: Buffer;
    kemPublicKey?: Buffer | null;
    mlDsaPublicKey?: Buffer | null;
    keysSignature?: Buffer | null;
};
/* The same public identity: every key, and a version 2 identity's keys statement, unchanged. */
function samePublicKeys(a: PublicKeys, b: PublicKeys) {
    const same = (x?: Buffer | null, y?: Buffer | null) => (x ? Boolean(y?.equals(x)) : !y);
    return (
        a.encryptionPublicKey.equals(b.encryptionPublicKey) &&
        a.signingPublicKey.equals(b.signingPublicKey) &&
        same(a.kemPublicKey, b.kemPublicKey) &&
        same(a.mlDsaPublicKey, b.mlDsaPublicKey) &&
        same(a.keysSignature, b.keysSignature)
    );
}

export type WorkspaceGrantInput = {
    id: string;
    grant: Omit<typeof workspaceKeys.$inferInsert, 'userId' | 'workspaceId'>;
};

export async function changeAccountSecurity(input: {
    userId: string;
    action: 'password' | 'master-key' | 'recovery-key';
    sessionTokenHash: Buffer;
    credentialVersion: number;
    registrationRecord: string;
    envelope: Pick<
        typeof accountKeys.$inferInsert,
        'keyVersion' | 'wrappingSalt' | 'wrappingNonce' | 'encryptedKey'
    >;
    recovery?: Omit<typeof accountRecoveryKeys.$inferInsert, 'userId'>;
    identity?: Omit<typeof accountIdentities.$inferInsert, 'userId'>;
    /* Every earlier identity, re-wrapped under the new root at its own key version. */
    identityHistory?: IdentityWrap[];
    /* The settings key re-wrapped under the new root, whenever the account has one. */
    settingsKey?: SettingsKeyInput;
    workspaces?: WorkspaceGrantInput[];
}) {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select(userFieldsWithEmailKey)
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
        if (!user) return false;
        const [current] = await tx
            .select({
                credential: opaqueCredentials,
                envelope: accountKeys,
                recovery: accountRecoveryKeys,
                identity: accountIdentities,
            })
            .from(sessions)
            .innerJoin(
                opaqueCredentials,
                and(
                    eq(opaqueCredentials.userId, sessions.userId),
                    eq(opaqueCredentials.version, sessions.credentialVersion),
                ),
            )
            .innerJoin(accountKeys, eq(accountKeys.userId, sessions.userId))
            .innerJoin(accountRecoveryKeys, eq(accountRecoveryKeys.userId, sessions.userId))
            .innerJoin(accountIdentities, eq(accountIdentities.userId, sessions.userId))
            .where(
                and(
                    eq(sessions.tokenHash, input.sessionTokenHash),
                    eq(sessions.userId, user.id),
                    eq(sessions.credentialVersion, input.credentialVersion),
                    gt(sessions.expiresAt, new Date()),
                ),
            );
        if (
            !current ||
            current.envelope.credentialVersion !== input.credentialVersion ||
            input.envelope.keyVersion !==
                current.envelope.keyVersion + (input.action === 'master-key' ? 1 : 0)
        )
            return false;
        if (
            input.action === 'password'
                ? input.recovery !== undefined
                : !input.recovery ||
                  input.recovery.recoveryVersion !== current.recovery.recoveryVersion + 1 ||
                  input.recovery.keyVersion !== input.envelope.keyVersion
        )
            return false;
        if (input.action === 'master-key') {
            // Public identity survives the rotation: the same X25519, signing and, once
            // it exists, KEM key. A KEM key is added by its own path, never here. The key
            // version stays, or (as clients before succession labelled it) follows the
            // root's when that is higher; it never goes back, which would reuse a version
            // the history or a contact's pin already names.
            // A version 2 identity keeps its key version exactly: the keys statement binds it.
            const identityVersion = input.identity?.keyVersion;
            if (
                !input.identity ||
                (input.identity.version ?? 1) !== current.identity.version ||
                !(
                    identityVersion === current.identity.keyVersion ||
                    (current.identity.version === 1 &&
                        identityVersion === input.envelope.keyVersion &&
                        identityVersion > current.identity.keyVersion)
                ) ||
                !samePublicKeys(current.identity, {
                    encryptionPublicKey: input.identity.encryptionPublicKey,
                    signingPublicKey: input.identity.signingPublicKey,
                    kemPublicKey: input.identity.kemPublicKey ?? null,
                    mlDsaPublicKey: input.identity.mlDsaPublicKey ?? null,
                    keysSignature: input.identity.keysSignature ?? null,
                })
            )
                return false;
            // Each earlier identity follows the root as well, unchanged but for its wrapping.
            const history = await tx
                .select()
                .from(accountIdentityHistory)
                .where(eq(accountIdentityHistory.userId, user.id))
                .for('update');
            const rewrapped = new Map(
                (input.identityHistory ?? []).map((wrap) => [wrap.keyVersion, wrap]),
            );
            if (
                rewrapped.size !== (input.identityHistory ?? []).length ||
                rewrapped.size !== history.length ||
                history.some((row) => {
                    const next = rewrapped.get(row.keyVersion);
                    return (
                        !next ||
                        !samePublicKeys(row, {
                            encryptionPublicKey: next.encryptionPublicKey,
                            signingPublicKey: next.signingPublicKey,
                            kemPublicKey: next.kemPublicKey ?? null,
                            mlDsaPublicKey: next.mlDsaPublicKey ?? null,
                            keysSignature: next.keysSignature ?? null,
                        })
                    );
                })
            )
                return false;
            // Every grant this member holds must follow the root, with its workspace key
            // epoch unchanged; folder and file keys hang off the workspace key, not the root.
            const grants = await tx
                .select({
                    workspaceId: workspaceKeys.workspaceId,
                    workspaceKeyVersion: workspaceKeys.workspaceKeyVersion,
                })
                .from(workspaceKeys)
                .where(eq(workspaceKeys.userId, user.id))
                .for('update');
            const replacements = new Map(input.workspaces?.map((w) => [w.id, w.grant]) ?? []);
            if (
                !input.workspaces ||
                replacements.size !== input.workspaces.length ||
                replacements.size !== grants.length ||
                grants.some((grant) => {
                    const next = replacements.get(grant.workspaceId);
                    return (
                        !next ||
                        next.keyVersion !== input.envelope.keyVersion ||
                        next.workspaceKeyVersion !== grant.workspaceKeyVersion
                    );
                })
            )
                return false;
            // The settings key follows the root; one left behind would seal settings nobody opens.
            const [settingsKey] = await tx
                .select({ userId: accountSettingsKeys.userId })
                .from(accountSettingsKeys)
                .where(eq(accountSettingsKeys.userId, user.id))
                .for('update');
            if (Boolean(settingsKey) !== Boolean(input.settingsKey)) return false;
        } else if (input.identity || input.workspaces || input.identityHistory || input.settingsKey)
            return false;
        const version = input.credentialVersion + 1;
        await tx
            .update(opaqueCredentials)
            .set({ registrationRecord: input.registrationRecord, version, updatedAt: new Date() })
            .where(eq(opaqueCredentials.userId, user.id));
        await tx
            .update(accountKeys)
            .set({ ...input.envelope, credentialVersion: version, updatedAt: new Date() })
            .where(eq(accountKeys.userId, user.id));
        if (input.recovery)
            await tx
                .update(accountRecoveryKeys)
                .set({ ...input.recovery, confirmedAt: null, updatedAt: new Date() })
                .where(eq(accountRecoveryKeys.userId, user.id));
        if (input.identity)
            await tx
                .update(accountIdentities)
                .set(input.identity)
                .where(eq(accountIdentities.userId, user.id));
        if (input.settingsKey)
            await tx
                .update(accountSettingsKeys)
                .set({ ...input.settingsKey, updatedAt: new Date() })
                .where(eq(accountSettingsKeys.userId, user.id));
        for (const wrap of input.identityHistory ?? [])
            await tx
                .update(accountIdentityHistory)
                .set({
                    wrappingSalt: wrap.wrappingSalt,
                    encryptionPrivateKeyNonce: wrap.encryptionPrivateKeyNonce,
                    encryptedEncryptionPrivateKey: wrap.encryptedEncryptionPrivateKey,
                    signingSeedNonce: wrap.signingSeedNonce,
                    encryptedSigningSeed: wrap.encryptedSigningSeed,
                    kemSeedNonce: wrap.kemSeedNonce ?? null,
                    encryptedKemSeed: wrap.encryptedKemSeed ?? null,
                    mlDsaSeedNonce: wrap.mlDsaSeedNonce ?? null,
                    encryptedMlDsaSeed: wrap.encryptedMlDsaSeed ?? null,
                })
                .where(
                    and(
                        eq(accountIdentityHistory.userId, user.id),
                        eq(accountIdentityHistory.keyVersion, wrap.keyVersion!),
                    ),
                );
        for (const workspace of input.workspaces ?? [])
            await tx
                .update(workspaceKeys)
                .set({ ...workspace.grant, updatedAt: new Date() })
                .where(
                    and(
                        eq(workspaceKeys.userId, user.id),
                        eq(workspaceKeys.workspaceId, workspace.id),
                    ),
                );
        await tx.delete(sessions).where(eq(sessions.userId, user.id));
        await tx.delete(opaqueLoginAttempts).where(eq(opaqueLoginAttempts.userId, user.id));
        await tx.delete(accountRecoveryAttempts).where(eq(accountRecoveryAttempts.userId, user.id));
        await tx
            .delete(accountEnrollments)
            .where(
                and(
                    eq(accountEnrollments.normalizedEmail, user.normalizedEmail),
                    eq(accountEnrollments.purpose, 'recover'),
                ),
            );
        return true;
    });
}

/* ------------------------------------------------------------------------- */
/* Identity lookup, settings, and roles                                       */
/* ------------------------------------------------------------------------- */

/* The person's own identity envelope, to open the private keys in the worker. */
export async function getIdentity(userId: string) {
    const [row] = await db
        .select()
        .from(accountIdentities)
        .where(eq(accountIdentities.userId, userId));
    return row ?? null;
}

/* Another person's public identity, by email: what a share is sealed to. */
export async function lookupIdentity(normalizedEmail: string) {
    const [row] = await db
        .select({
            userId: users.id,
            name: users.name,
            email: users.email,
            identityVersion: accountIdentities.version,
            encryptionPublicKey: accountIdentities.encryptionPublicKey,
            signingPublicKey: accountIdentities.signingPublicKey,
            mlDsaPublicKey: accountIdentities.mlDsaPublicKey,
            kemPublicKey: accountIdentities.kemPublicKey,
            keysSignature: accountIdentities.keysSignature,
            keyVersion: accountIdentities.keyVersion,
        })
        .from(users)
        .innerJoin(accountIdentities, eq(accountIdentities.userId, users.id))
        .where(eq(users.normalizedEmail, normalizedEmail));
    return row ?? null;
}

export type SuccessionResult =
    | { status: 'ok'; keyVersion: number }
    | {
          status:
              | 'session'
              | 'no-identity'
              | 'not-upgraded'
              | 'stale'
              | 'unchanged'
              | 'bad-signature'
              | 'history-full';
      };

/*
 * The most earlier identities an account keeps. A master-key rotation carries
 * every one of them re-wrapped in a single request, which is capped to match.
 */
export const IDENTITY_HISTORY_LIMIT = 1000;

/* A version 2 identity as it is stored: every column, the lattice halves present. */
export type IdentityV2 = Omit<typeof accountIdentities.$inferInsert, 'userId'> & {
    version: 2;
    keyVersion: number;
    kemPublicKey: Buffer;
    mlDsaPublicKey: Buffer;
    keysSignature: Buffer;
};

/*
 * Whether a version 2 identity's keys statement holds for `userId`: both
 * halves of its hybrid signature, under the keys it names, over its four
 * public keys and its key version. The server checks it before storing any
 * identity, so a stored one always verifies; clients check again.
 */
export function identityKeysHold(userId: string, identity: IdentityV2) {
    return verifyHybrid(
        { signingPublicKey: identity.signingPublicKey, mlDsaPublicKey: identity.mlDsaPublicKey },
        keysStatement({
            userId,
            keyVersion: identity.keyVersion,
            encryptionPublicKey: identity.encryptionPublicKey,
            signingPublicKey: identity.signingPublicKey,
            mlDsaPublicKey: identity.mlDsaPublicKey,
            kemPublicKey: identity.kemPublicKey,
        }),
        identity.keysSignature,
    );
}

/*
 * Replaces an account's identity with one minted at the next key version and
 * vouched for by the current identity's hybrid signature
 * (docs/identity-pq-design.md 2). Under the account's row lock, so it cannot
 * interleave with a master-key rotation, an upgrade or a second succession:
 * the session must still be current, the current identity must be version 2,
 * the key version must be the next one, the version 2 statement must verify
 * under both current signing keys, and every key must actually change. The
 * replaced identity moves to the history whole, still sealed, with the
 * succession that replaced it.
 */
export async function succeedIdentity(input: {
    userId: string;
    credentialVersion: number;
    sessionTokenHash: Buffer;
    /* The new identity, its keys statement already checked. */
    identity: IdentityV2;
    signature: Buffer;
    /*
     * The successor's consent, both halves (6746 bytes). Optional until every
     * client sends it (docs/groups-server.md 5); one that is sent must hold.
     */
    consent?: Buffer | null;
}): Promise<SuccessionResult> {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
        if (!user || !(await sessionIsCurrent(tx, input))) return { status: 'session' };
        const [current] = await tx
            .select()
            .from(accountIdentities)
            .where(eq(accountIdentities.userId, user.id));
        if (!current) return { status: 'no-identity' };
        if (current.version !== 2 || !current.mlDsaPublicKey) return { status: 'not-upgraded' };
        if (input.identity.keyVersion !== current.keyVersion + 1) return { status: 'stale' };
        const [earlier] = await tx
            .select({ count: count() })
            .from(accountIdentityHistory)
            .where(eq(accountIdentityHistory.userId, user.id));
        if ((earlier?.count ?? 0) >= IDENTITY_HISTORY_LIMIT) return { status: 'history-full' };
        if (
            input.identity.encryptionPublicKey.equals(current.encryptionPublicKey) ||
            input.identity.signingPublicKey.equals(current.signingPublicKey) ||
            input.identity.mlDsaPublicKey.equals(current.mlDsaPublicKey) ||
            (current.kemPublicKey && input.identity.kemPublicKey.equals(current.kemPublicKey))
        )
            return { status: 'unchanged' };
        const link = {
            userId: user.id,
            oldKeyVersion: current.keyVersion,
            newKeyVersion: input.identity.keyVersion,
            oldEncryptionPublicKey: current.encryptionPublicKey,
            oldSigningPublicKey: current.signingPublicKey,
            oldMlDsaPublicKey: current.mlDsaPublicKey,
            newEncryptionPublicKey: input.identity.encryptionPublicKey,
            newSigningPublicKey: input.identity.signingPublicKey,
            newMlDsaPublicKey: input.identity.mlDsaPublicKey,
            newKemPublicKey: input.identity.kemPublicKey,
        };
        if (
            !verifyHybrid(
                {
                    signingPublicKey: current.signingPublicKey,
                    mlDsaPublicKey: current.mlDsaPublicKey,
                },
                successionStatement(link),
                input.signature,
            )
        )
            return { status: 'bad-signature' };
        // Consent, when sent, must hold in both halves: the current keys as "old", the new as "new".
        if (input.consent != null && !successionConsentHolds(link, input.consent))
            return { status: 'bad-signature' };
        const { userId: _userId, ...old } = current;
        await tx.insert(accountIdentityHistory).values({
            ...old,
            userId: user.id,
            replacedByKeyVersion: input.identity.keyVersion,
            newEncryptionPublicKey: input.identity.encryptionPublicKey,
            newSigningPublicKey: input.identity.signingPublicKey,
            newKemPublicKey: input.identity.kemPublicKey,
            newMlDsaPublicKey: input.identity.mlDsaPublicKey,
            successionSignature: input.signature,
            successionConsent: input.consent ?? null,
        });
        await tx
            .update(accountIdentities)
            .set({ ...input.identity, kemSignature: null, createdAt: new Date() })
            .where(eq(accountIdentities.userId, user.id));
        return { status: 'ok', keyVersion: input.identity.keyVersion };
    });
}

export type ConsentBackfillResult =
    /* `stored` is false when the link already had consent: it is never replaced. */
    | { status: 'ok'; stored: boolean }
    | { status: 'session' | 'no-link' | 'not-upgraded' | 'bad-signature' };

/*
 * The successor's consent for one of the account's own earlier successions,
 * made before clients sent it (docs/groups-server.md 5, the backfill). The
 * link is the history row at `oldKeyVersion` of the signed-in account, and
 * the consent must hold for it as /succession checks it: the old identity's
 * hybrid signature as "old", the new identity's as "new". It is stored only
 * where the row has none, so a stored consent is never replaced, by anyone; a
 * second upload that holds answers `stored: false`. Under the account's row
 * lock, as succeedIdentity and master-key rotations take it, and only for a
 * current session. Links from a version 1 identity have no ML-DSA keys to
 * consent with (`not-upgraded`).
 */
export async function backfillSuccessionConsent(input: {
    userId: string;
    credentialVersion: number;
    sessionTokenHash: Buffer;
    oldKeyVersion: number;
    consent: Buffer;
}): Promise<ConsentBackfillResult> {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
        if (!user || !(await sessionIsCurrent(tx, input))) return { status: 'session' };
        const [row] = await tx
            .select()
            .from(accountIdentityHistory)
            .where(
                and(
                    eq(accountIdentityHistory.userId, user.id),
                    eq(accountIdentityHistory.keyVersion, input.oldKeyVersion),
                ),
            );
        if (!row) return { status: 'no-link' };
        if (row.version !== 2 || !row.mlDsaPublicKey || !row.newMlDsaPublicKey)
            return { status: 'not-upgraded' };
        const link = {
            userId: user.id,
            oldKeyVersion: row.keyVersion,
            newKeyVersion: row.replacedByKeyVersion,
            oldEncryptionPublicKey: row.encryptionPublicKey,
            oldSigningPublicKey: row.signingPublicKey,
            oldMlDsaPublicKey: row.mlDsaPublicKey,
            newEncryptionPublicKey: row.newEncryptionPublicKey,
            newSigningPublicKey: row.newSigningPublicKey,
            newMlDsaPublicKey: row.newMlDsaPublicKey,
            newKemPublicKey: row.newKemPublicKey,
        };
        // Checked even when consent is stored already: a forged upload is refused, never "fine".
        if (!successionConsentHolds(link, input.consent)) return { status: 'bad-signature' };
        const stored = await tx
            .update(accountIdentityHistory)
            .set({ successionConsent: input.consent })
            .where(
                and(
                    eq(accountIdentityHistory.userId, user.id),
                    eq(accountIdentityHistory.keyVersion, input.oldKeyVersion),
                    isNull(accountIdentityHistory.successionConsent),
                ),
            )
            .returning({ keyVersion: accountIdentityHistory.keyVersion });
        return { status: 'ok', stored: stored.length > 0 };
    });
}

export type UpgradeResult =
    | { status: 'ok' }
    | { status: 'session' | 'no-identity' | 'mismatch' }
    /* Another device upgraded first: its identity, to adopt. */
    | { status: 'stale'; current: typeof accountIdentities.$inferSelect };

/*
 * The upgrade of a version 1 identity to version 2, in place
 * (docs/identity-pq-design.md 2): the same X25519, Ed25519 and ML-KEM keys
 * (an identity without an ML-KEM key may gain one) and the same key version,
 * plus the ML-DSA key and the keys statement, already checked. No history row
 * and no succession. Under the account's row lock; a device that lost a race
 * is handed the identity that won.
 */
export async function upgradeIdentity(input: {
    userId: string;
    credentialVersion: number;
    sessionTokenHash: Buffer;
    identity: IdentityV2;
}): Promise<UpgradeResult> {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
        if (!user || !(await sessionIsCurrent(tx, input))) return { status: 'session' };
        const [current] = await tx
            .select()
            .from(accountIdentities)
            .where(eq(accountIdentities.userId, user.id));
        if (!current) return { status: 'no-identity' };
        if (current.version === 2) return { status: 'stale', current };
        // Everything the upgrade keeps must be byte for byte what is stored: the public keys
        // and the wrapped private keys with their salt and nonces. A client that sent new
        // wraps of the same public keys could leave the account unable to open its keys.
        // Only an identity that had no ML-KEM key may gain one here.
        const same = (a: Buffer | null | undefined, b: Buffer | null | undefined) =>
            Boolean(a && b && a.equals(b));
        if (
            input.identity.keyVersion !== current.keyVersion ||
            !same(input.identity.encryptionPublicKey, current.encryptionPublicKey) ||
            !same(input.identity.signingPublicKey, current.signingPublicKey) ||
            !same(input.identity.wrappingSalt, current.wrappingSalt) ||
            !same(input.identity.encryptionPrivateKeyNonce, current.encryptionPrivateKeyNonce) ||
            !same(
                input.identity.encryptedEncryptionPrivateKey,
                current.encryptedEncryptionPrivateKey,
            ) ||
            !same(input.identity.signingSeedNonce, current.signingSeedNonce) ||
            !same(input.identity.encryptedSigningSeed, current.encryptedSigningSeed) ||
            (current.kemPublicKey !== null &&
                (!same(input.identity.kemPublicKey, current.kemPublicKey) ||
                    !same(input.identity.kemSeedNonce, current.kemSeedNonce) ||
                    !same(input.identity.encryptedKemSeed, current.encryptedKemSeed)))
        )
            return { status: 'mismatch' };
        await tx
            .update(accountIdentities)
            .set({ ...input.identity, kemSignature: null })
            .where(eq(accountIdentities.userId, user.id));
        return { status: 'ok' };
    });
}

/* How many earlier identities the account keeps: what a master-key rotation carries. */
export async function countIdentityHistory(userId: string) {
    const [row] = await db
        .select({ count: count() })
        .from(accountIdentityHistory)
        .where(eq(accountIdentityHistory.userId, userId));
    return row?.count ?? 0;
}

/* The account's own earlier identities, oldest first: what opens shares sealed to old keys. */
export async function listIdentityHistory(userId: string) {
    return db
        .select()
        .from(accountIdentityHistory)
        .where(eq(accountIdentityHistory.userId, userId))
        .orderBy(asc(accountIdentityHistory.keyVersion));
}

/*
 * The succession links of an account from key version `from` on, in order:
 * each names the identity it replaced, the one that replaced it, and the old
 * signing key's signature. Null when the account has no identity at all.
 */
export async function successionChain(userId: string, from: number) {
    const [identity] = await db
        .select({ keyVersion: accountIdentities.keyVersion })
        .from(accountIdentities)
        .where(eq(accountIdentities.userId, userId));
    if (!identity) return null;
    return db
        .select({
            oldKeyVersion: accountIdentityHistory.keyVersion,
            newKeyVersion: accountIdentityHistory.replacedByKeyVersion,
            oldEncryptionPublicKey: accountIdentityHistory.encryptionPublicKey,
            oldSigningPublicKey: accountIdentityHistory.signingPublicKey,
            oldMlDsaPublicKey: accountIdentityHistory.mlDsaPublicKey,
            newEncryptionPublicKey: accountIdentityHistory.newEncryptionPublicKey,
            newSigningPublicKey: accountIdentityHistory.newSigningPublicKey,
            newMlDsaPublicKey: accountIdentityHistory.newMlDsaPublicKey,
            newKemPublicKey: accountIdentityHistory.newKemPublicKey,
            signature: accountIdentityHistory.successionSignature,
            consent: accountIdentityHistory.successionConsent,
            replacedAt: accountIdentityHistory.replacedAt,
        })
        .from(accountIdentityHistory)
        .where(
            and(
                eq(accountIdentityHistory.userId, userId),
                gte(accountIdentityHistory.keyVersion, from),
            ),
        )
        .orderBy(asc(accountIdentityHistory.keyVersion));
}

/*
 * The person's settings: the document, when it is sealed the only way clients
 * open now (version 2, under the settings key), and the stored sequence number
 * whatever the document is (0 when there is none). A version 1 document (under
 * a key derived from the identity) is served as no document at its sequence:
 * the next save names that sequence and replaces it.
 */
export async function getSettings(userId: string) {
    const [row] = await db
        .select({
            version: userSettings.version,
            settingsVersion: userSettings.settingsVersion,
            nonce: userSettings.nonce,
            ciphertext: userSettings.ciphertext,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));
    return {
        document: row && row.version === 2 ? row : null,
        settingsVersion: row?.settingsVersion ?? 0,
    };
}

/*
 * Compare-and-set: the new document names the stored sequence it was built
 * from (0 when none is stored), and lands only if that is still the stored
 * one, a version 1 document included. It is stored at that sequence plus one,
 * which is the version the client sealed it at (the version is bound into the
 * seal). Only envelope version 2 is taken, and only once the settings key it
 * is sealed under is stored. A conflict reports the stored sequence.
 */
export async function putSettings(input: {
    userId: string;
    expectedVersion: number;
    /* The envelope's version: 2, sealed under the settings key, is the only one taken. */
    version: number;
    nonce: Buffer;
    ciphertext: Buffer;
}) {
    if (input.version !== 2) return { status: 'unsupported' as const, settingsVersion: null };
    return db.transaction(async (tx) => {
        const [current] = await tx
            .select({ settingsVersion: userSettings.settingsVersion })
            .from(userSettings)
            .where(eq(userSettings.userId, input.userId))
            .for('update');
        const stored = current?.settingsVersion ?? 0;
        if (stored !== input.expectedVersion)
            return { status: 'conflict' as const, settingsVersion: stored };
        // Sealed under a settings key the server does not have: no device could open it again.
        if (!(await getSettingsKey(input.userId, tx)))
            return { status: 'no-key' as const, settingsVersion: stored };
        const settingsVersion = input.expectedVersion + 1;
        await tx
            .insert(userSettings)
            .values({
                userId: input.userId,
                version: 2,
                settingsVersion,
                nonce: input.nonce,
                ciphertext: input.ciphertext,
            })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: {
                    version: 2,
                    settingsVersion,
                    nonce: input.nonce,
                    ciphertext: input.ciphertext,
                    updatedAt: new Date(),
                },
            });
        return { status: 'ok' as const, settingsVersion };
    });
}

export type SettingsKeyInput = { nonce: Buffer; ciphertext: Buffer };

/* The wrapped settings key, if the account has one yet. */
export async function getSettingsKey(userId: string, tx: Tx | typeof db = db) {
    const [row] = await tx
        .select({ nonce: accountSettingsKeys.nonce, ciphertext: accountSettingsKeys.ciphertext })
        .from(accountSettingsKeys)
        .where(eq(accountSettingsKeys.userId, userId));
    return row ?? null;
}

/*
 * Stores the wrapped settings key once. A second device that minted its own
 * meanwhile is refused and must use the stored one, or the two would seal
 * settings the other cannot open.
 */
export async function putSettingsKey(input: { userId: string } & SettingsKeyInput) {
    const [row] = await db
        .insert(accountSettingsKeys)
        .values(input)
        .onConflictDoNothing()
        .returning({ userId: accountSettingsKeys.userId });
    return row !== undefined;
}

/* An operator's suspension on a report: sessions stop being served and sign-in is refused until cleared. */
export async function setUserSuspended(userId: string, suspended: boolean) {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .update(users)
            .set({
                suspendedAt: suspended ? sql`coalesce(${users.suspendedAt}, now())` : null,
                updatedAt: new Date(),
            })
            .where(eq(users.id, userId))
            .returning({ id: users.id, email: users.email, suspendedAt: users.suspendedAt });
        if (row && suspended) await tx.delete(sessions).where(eq(sessions.userId, userId));
        return row ?? null;
    });
}

/* Operator roles are granted from the command line only. */
export async function setUserRole(normalizedEmail: string, role: 'member' | 'admin') {
    const [row] = await db
        .update(users)
        .set({ role, updatedAt: new Date() })
        .where(eq(users.normalizedEmail, normalizedEmail))
        .returning({ id: users.id, email: users.email });
    return row ?? null;
}

export async function getUserById(userId: string) {
    const [row] = await db.select(userFields).from(users).where(eq(users.id, userId));
    return row ?? null;
}
