import { and, eq, gt, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from './client';
import {
    personalWorkspaces,
    workspaceKeys,
    workspaceStorage,
    storageEntitlements,
    workspaces,
} from './schema';
import {
    accountEnrollments,
    accountIntents,
    accountRecoveryKeys,
    accountIdentities,
    accountRecoveryAttempts,
    accountKeys,
    authRateLimits,
    opaqueCredentials,
    opaqueLoginAttempts,
    serverSecrets,
    sessions,
    userSettings,
    users,
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
            .values({ id: input.workspace.id })
            .onConflictDoNothing()
            .returning({ id: workspaces.id });
        if (!workspace) throw new Error('Could not create workspace.');
        await tx.insert(personalWorkspaces).values({ userId: user.id, workspaceId: workspace.id });
        await tx
            .insert(workspaceStorage)
            .values({ workspaceId: workspace.id, baseQuotaBytes: input.initialQuotaBytes });
        await tx
            .insert(workspaceKeys)
            .values({ workspaceId: workspace.id, userId: user.id, ...input.workspace.grant });
        await tx.insert(opaqueCredentials).values({
            userId: user.id,
            registrationRecord: input.registrationRecord,
            profileVersion: input.profileVersion,
            serverSetupId: input.serverSetupId,
        });
        await tx.insert(accountKeys).values({ userId: user.id, ...input.envelope });
        await tx.insert(accountRecoveryKeys).values({ userId: user.id, ...input.recovery });
        await tx.insert(accountIdentities).values({ userId: user.id, ...input.identity });
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

export async function createSession(input: {
    userId: string;
    credentialVersion: number;
    tokenHash: Buffer;
    previousTokenHash: Buffer | null;
    expiresAt: Date;
}) {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select({ ...userFields, suspendedAt: users.suspendedAt })
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

        if (input.previousTokenHash) {
            await tx.delete(sessions).where(eq(sessions.tokenHash, input.previousTokenHash));
        }
        await tx.insert(sessions).values({
            userId: user.id,
            credentialVersion: input.credentialVersion,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
            lastSeenAt: new Date(),
        });
        const { suspendedAt: _suspendedAt, ...plain } = user;
        return { user: plain, key: record.key };
    });
}

export async function getSessionUser(
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
        .where(
            and(
                eq(sessions.tokenHash, tokenHash),
                gt(sessions.expiresAt, now),
                gt(sessions.createdAt, absoluteCutoff),
                isNull(users.suspendedAt),
            ),
        );
    if (!result) return null;
    // Slide the idle deadline on activity, at most every five minutes, never past the cap.
    const absoluteExpiry = new Date(result.createdAt.getTime() + lifetime.maxSeconds * 1000);
    const idleExpiry = new Date(now.getTime() + lifetime.idleSeconds * 1000);
    await db
        .update(sessions)
        .set({
            lastSeenAt: now,
            expiresAt: idleExpiry < absoluteExpiry ? idleExpiry : absoluteExpiry,
        })
        .where(
            and(
                eq(sessions.id, result.sessionId),
                or(
                    isNull(sessions.lastSeenAt),
                    lt(sessions.lastSeenAt, new Date(Date.now() - 5 * 60_000)),
                ),
            ),
        );
    return result.user;
}

export async function updateUserName(userId: string, name: string) {
    const [user] = await db
        .update(users)
        .set({ name, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning(userFields);
    return user ?? null;
}

export async function deleteSession(tokenHash: Buffer) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function consumeRateLimit(keyHash: Buffer, limit: number, windowMs: number) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMs);
    const [bucket] = await db
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
    return bucket !== undefined && bucket.count <= limit;
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
        sessions: await sweep(sessions, sessions.id, sessions.expiresAt),
        rateLimits: await sweep(authRateLimits, authRateLimits.keyHash, authRateLimits.expiresAt),
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

export async function getStorageAllowance(userId: string) {
    const [storage] = await db
        .select({
            workspaceId: workspaceStorage.workspaceId,
            baseQuotaBytes: workspaceStorage.baseQuotaBytes,
            usedBytes: workspaceStorage.usedBytes,
            reservedBytes: workspaceStorage.reservedBytes,
        })
        .from(personalWorkspaces)
        .innerJoin(
            workspaceStorage,
            eq(workspaceStorage.workspaceId, personalWorkspaces.workspaceId),
        )
        .where(eq(personalWorkspaces.userId, userId));
    if (!storage) return null;
    const grants = await db
        .select({ quotaBytes: storageEntitlements.quotaBytes })
        .from(storageEntitlements)
        .where(
            and(
                eq(storageEntitlements.workspaceId, storage.workspaceId),
                isNull(storageEntitlements.revokedAt),
                sql`${storageEntitlements.startsAt} <= now()`,
                or(
                    isNull(storageEntitlements.expiresAt),
                    sql`${storageEntitlements.expiresAt} > now()`,
                ),
            ),
        );
    const quota = grants.reduce((sum, grant) => sum + grant.quotaBytes, storage.baseQuotaBytes);
    const remaining = quota - storage.usedBytes - storage.reservedBytes;
    return {
        workspaceId: storage.workspaceId,
        quotaBytes: quota.toString(),
        usedBytes: storage.usedBytes.toString(),
        reservedBytes: storage.reservedBytes.toString(),
        availableBytes: (remaining > 0n ? remaining : 0n).toString(),
    };
}

export async function deleteAccount(input: {
    userId: string;
    credentialVersion: number;
    sessionTokenHash: Buffer;
}) {
    return db.transaction(async (tx) => {
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
    });
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
                .values({ userId: user.id, ...input.recovery })
                .onConflictDoNothing();
        if (input.identity)
            await tx
                .insert(accountIdentities)
                .values({ userId: user.id, ...input.identity })
                .onConflictDoNothing();
        const [personal] = await tx
            .select({ workspaceId: personalWorkspaces.workspaceId })
            .from(personalWorkspaces)
            .where(eq(personalWorkspaces.userId, user.id));
        let workspaceId = personal?.workspaceId;
        if (!workspaceId) {
            const [workspace] = await tx
                .insert(workspaces)
                .values(input.workspace ? { id: input.workspace.id } : {})
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
                .values({ workspaceId, userId: user.id, ...input.workspace.grant })
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
    const grants = await db
        .select()
        .from(workspaceKeys)
        .where(eq(workspaceKeys.userId, userId))
        .orderBy(workspaceKeys.workspaceId);
    return { ...bundles, workspaces: grants };
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
            if (
                !input.identity ||
                input.identity.keyVersion !== input.envelope.keyVersion ||
                !input.identity.encryptionPublicKey.equals(current.identity.encryptionPublicKey) ||
                !input.identity.signingPublicKey.equals(current.identity.signingPublicKey)
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
        } else if (input.identity || input.workspaces) return false;
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
            encryptionPublicKey: accountIdentities.encryptionPublicKey,
            signingPublicKey: accountIdentities.signingPublicKey,
        })
        .from(users)
        .innerJoin(accountIdentities, eq(accountIdentities.userId, users.id))
        .where(eq(users.normalizedEmail, normalizedEmail));
    return row ?? null;
}

export async function getSettings(userId: string) {
    const [row] = await db
        .select({
            settingsVersion: userSettings.settingsVersion,
            nonce: userSettings.nonce,
            ciphertext: userSettings.ciphertext,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));
    return row ?? null;
}

/*
 * Compare-and-set: the new document names the version it was built from, and
 * lands only if that is still the stored one (or none exists and it names 0).
 */
export async function putSettings(input: {
    userId: string;
    expectedVersion: number;
    nonce: Buffer;
    ciphertext: Buffer;
}) {
    return db.transaction(async (tx) => {
        const [current] = await tx
            .select({ settingsVersion: userSettings.settingsVersion })
            .from(userSettings)
            .where(eq(userSettings.userId, input.userId))
            .for('update');
        const stored = current?.settingsVersion ?? 0;
        if (stored !== input.expectedVersion)
            return { status: 'conflict' as const, settingsVersion: stored };
        const settingsVersion = stored + 1;
        await tx
            .insert(userSettings)
            .values({
                userId: input.userId,
                settingsVersion,
                nonce: input.nonce,
                ciphertext: input.ciphertext,
            })
            .onConflictDoUpdate({
                target: userSettings.userId,
                set: {
                    settingsVersion,
                    nonce: input.nonce,
                    ciphertext: input.ciphertext,
                    updatedAt: new Date(),
                },
            });
        return { status: 'ok' as const, settingsVersion };
    });
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
