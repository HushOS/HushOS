import { and, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from './client';
import { personalWorkspaces, workspaceStorage, storageEntitlements, workspaces } from './schema';
import {
    accountEnrollments,
    accountRecoveryKeys,
    accountIdentities,
    accountRecoveryAttempts,
    accountKeys,
    authRateLimits,
    opaqueCredentials,
    opaqueLoginAttempts,
    sessions,
    users,
} from './schema';

const userFields = { id: users.id, name: users.name, email: users.email };

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

        const [workspace] = await tx.insert(workspaces).values({}).returning({ id: workspaces.id });
        if (!workspace) throw new Error('Could not create workspace.');
        await tx.insert(personalWorkspaces).values({ userId: user.id, workspaceId: workspace.id });
        await tx
            .insert(workspaceStorage)
            .values({ workspaceId: workspace.id, baseQuotaBytes: input.initialQuotaBytes });
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
            .select(userFields)
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
        if (!user) return null;

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
        return { user, key: record.key };
    });
}

export async function getSessionUser(tokenHash: Buffer) {
    const [result] = await db
        .select({
            user: { ...userFields, credentialVersion: sessions.credentialVersion },
            sessionId: sessions.id,
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
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())));
    if (!result) return null;
    await db
        .update(sessions)
        .set({ lastSeenAt: new Date() })
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

export async function cleanupExpired() {
    const now = new Date();
    await Promise.all([
        db.delete(accountEnrollments).where(lt(accountEnrollments.expiresAt, now)),
        db.delete(opaqueLoginAttempts).where(lt(opaqueLoginAttempts.expiresAt, now)),
        db.delete(accountRecoveryAttempts).where(lt(accountRecoveryAttempts.expiresAt, now)),
        db.delete(sessions).where(lt(sessions.expiresAt, now)),
        db.delete(authRateLimits).where(lt(authRateLimits.expiresAt, now)),
    ]);
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
        const [user] = await tx
            .select(userFields)
            .from(users)
            .where(eq(users.id, input.userId))
            .for('update');
        if (!user) return null;
        const [enrollment] = await tx
            .select()
            .from(accountEnrollments)
            .where(
                and(
                    eq(accountEnrollments.id, input.enrollmentId),
                    eq(accountEnrollments.enrollmentTokenHash, input.enrollmentTokenHash),
                    eq(accountEnrollments.purpose, 'recover'),
                    eq(accountEnrollments.normalizedEmail, user.email.toLowerCase()),
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
                    eq(accountEnrollments.normalizedEmail, user.email.toLowerCase()),
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
            .select(userFields)
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
            .where(eq(accountEnrollments.normalizedEmail, user.email.toLowerCase()));
        await tx.delete(users).where(eq(users.id, user.id));
        return true;
    });
}

export async function getAccountSetup(userId: string) {
    const [row] = await db
        .select({
            recovery: accountRecoveryKeys.userId,
            identity: accountIdentities.userId,
            workspace: personalWorkspaces.userId,
        })
        .from(users)
        .leftJoin(accountRecoveryKeys, eq(accountRecoveryKeys.userId, users.id))
        .leftJoin(accountIdentities, eq(accountIdentities.userId, users.id))
        .leftJoin(personalWorkspaces, eq(personalWorkspaces.userId, users.id))
        .where(eq(users.id, userId));
    if (!row) return null;
    return { recovery: !row.recovery, identity: !row.identity, workspace: !row.workspace };
}

// Existing accounts can add missing features, but can never overwrite permanent keys here.
export async function initializeAccount(input: {
    userId: string;
    credentialVersion: number;
    sessionTokenHash: Buffer;
    initialQuotaBytes: bigint;
    recovery?: Omit<typeof accountRecoveryKeys.$inferInsert, 'userId'>;
    identity?: Omit<typeof accountIdentities.$inferInsert, 'userId'>;
}) {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select({ id: users.id })
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
            .select({ id: personalWorkspaces.userId })
            .from(personalWorkspaces)
            .where(eq(personalWorkspaces.userId, user.id));
        if (!personal) {
            const [workspace] = await tx
                .insert(workspaces)
                .values({})
                .returning({ id: workspaces.id });
            if (!workspace) throw new Error('Could not create workspace.');
            await tx
                .insert(personalWorkspaces)
                .values({ userId: user.id, workspaceId: workspace.id });
            await tx
                .insert(workspaceStorage)
                .values({ workspaceId: workspace.id, baseQuotaBytes: input.initialQuotaBytes });
        }
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
    return bundles ?? null;
}

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
}) {
    return db.transaction(async (tx) => {
        const [user] = await tx
            .select(userFields)
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
            // Drive has no encrypted objects yet. Do not allow root replacement once
            // stored data exists until its key rewrapping participates in this transaction.
            const [storage] = await tx
                .select({ storage: workspaceStorage })
                .from(personalWorkspaces)
                .innerJoin(
                    workspaceStorage,
                    eq(workspaceStorage.workspaceId, personalWorkspaces.workspaceId),
                )
                .where(eq(personalWorkspaces.userId, user.id))
                .for('update');
            if (
                !storage ||
                storage.storage.usedBytes !== 0n ||
                storage.storage.reservedBytes !== 0n
            )
                return false;
        } else if (input.identity) return false;
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
        await tx.delete(sessions).where(eq(sessions.userId, user.id));
        await tx.delete(opaqueLoginAttempts).where(eq(opaqueLoginAttempts.userId, user.id));
        await tx.delete(accountRecoveryAttempts).where(eq(accountRecoveryAttempts.userId, user.id));
        await tx
            .delete(accountEnrollments)
            .where(
                and(
                    eq(accountEnrollments.normalizedEmail, user.email.toLowerCase()),
                    eq(accountEnrollments.purpose, 'recover'),
                ),
            );
        return true;
    });
}
