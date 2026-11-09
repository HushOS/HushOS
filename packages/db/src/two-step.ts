import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from './client';
import { pgCode } from './readiness';
import {
    accountDevices,
    opaqueCredentials,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepFactors,
    twoStepState,
    users,
    type TwoStepFactorKind,
    type TwoStepPurpose,
} from './schema';

/*
 * Two-step sign-in, the rows (docs/two-step-design.md). This module keeps what
 * must hold whatever the code above it does: a time step or a backup code is
 * taken once, a step token passes once, a factor is reached only through its
 * own account, and the counters lock where the design says. It checks no code,
 * signature or assertion: the caller proves the answer, and says here which
 * step, code hash or counter it proved.
 *
 * Every write takes an executor, so a caller can run it inside the transaction
 * that opens the session or commits the change the step authorises.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

/* An authenticator app being enrolled is dropped ten minutes after it was made. */
export const PENDING_FACTOR_SECONDS = 10 * 60;
/* A step token lasts five minutes, and five wrong answers. */
export const STEP_TOKEN_SECONDS = 5 * 60;
export const STEP_TOKEN_FAILURES = 5;
/* Wrong codes in a row before the app is frozen for sign-ins that prove no device. */
export const TOTP_FREEZE_FAILURES = 100;
export const SECURITY_KEY_LIMIT = 10;
export const BACKUP_CODE_COUNT = 10;
/* The security log keeps 90 days. */
export const SECURITY_EVENT_DAYS = 90;

export type TwoStepFactor = typeof twoStepFactors.$inferSelect;
export type StepAttempt = typeof twoStepAttempts.$inferSelect;
export type BackupCodeInput = { codeHash: Buffer; keyId: Buffer };

/* Thrown, never returned, so what a refused pass already wrote (the spent token) rolls back with it. */
class Refused extends Error {
    constructor(readonly status: 'frozen' | 'refused') {
        super(status);
    }
}

/* Last-used times are kept to the hour, never finer. */
function toHour(date: Date) {
    return new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000);
}

/* The account's lock, as every other account write takes it. False when the account is gone. */
async function lockAccount(tx: Tx, userId: string) {
    const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
    return user !== undefined;
}

const confirmedOf = (userId: string) =>
    and(eq(twoStepFactors.userId, userId), isNotNull(twoStepFactors.confirmedAt));

/* Whether the account has the step on: exactly when it has a confirmed factor. */
export async function hasTwoStep(userId: string, executor: Executor = db) {
    const [factor] = await executor
        .select({ id: twoStepFactors.id })
        .from(twoStepFactors)
        .where(confirmedOf(userId))
        .limit(1);
    return factor !== undefined;
}

/*
 * The account's WebAuthn user handle and backup-code salt, made at random the
 * first time and never changed. Null when the account is gone.
 */
export async function ensureState(userId: string, executor: Executor = db) {
    try {
        // A savepoint, so an account deleted meanwhile does not abort the caller's transaction.
        return await executor.transaction(async (tx) => {
            await tx
                .insert(twoStepState)
                .values({
                    userId,
                    webauthnUserHandle: randomBytes(32),
                    backupCodeSalt: randomBytes(16),
                })
                .onConflictDoNothing({ target: twoStepState.userId });
            const [state] = await tx
                .select()
                .from(twoStepState)
                .where(eq(twoStepState.userId, userId));
            return state ?? null;
        });
    } catch (error) {
        if (pgCode(error) === '23503') return null;
        throw error;
    }
}

/*
 * What the account's step is made of: its confirmed factors (oldest first, with
 * the sealed secret and the public key the server checks answers against), its
 * state, and the backup codes not used yet. An enrolment nobody finished is not
 * here: a pending factor never answers the step.
 */
export async function getTwoStep(userId: string, executor: Executor = db) {
    const factors = await executor
        .select()
        .from(twoStepFactors)
        .where(confirmedOf(userId))
        .orderBy(asc(twoStepFactors.createdAt), asc(twoStepFactors.id));
    const [state] = await executor
        .select()
        .from(twoStepState)
        .where(eq(twoStepState.userId, userId));
    const backupCodes = await executor
        .select({ codeHash: twoStepBackupCodes.codeHash, keyId: twoStepBackupCodes.keyId })
        .from(twoStepBackupCodes)
        .where(and(eq(twoStepBackupCodes.userId, userId), isNull(twoStepBackupCodes.usedAt)));
    return { on: factors.length > 0, factors, state: state ?? null, backupCodes };
}

/* ------------------------------------------------------------------------- */
/* Factors                                                                    */
/* ------------------------------------------------------------------------- */

/*
 * Starts enrolling an authenticator app: a pending factor holding the sealed
 * secret, good for ten minutes. The caller makes the id first, because the
 * seal's associated data names it. An earlier enrolment the account never
 * finished is dropped, so one account holds one pending secret at a time. Null
 * when the account is gone.
 */
export async function createPendingTotp(
    input: {
        id: string;
        userId: string;
        name: string;
        keyId: Buffer;
        nonce: Buffer;
        secret: Buffer;
    },
    executor: Executor = db,
) {
    return executor.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return null;
        await ensureState(input.userId, tx);
        await tx
            .delete(twoStepFactors)
            .where(
                and(
                    eq(twoStepFactors.userId, input.userId),
                    eq(twoStepFactors.kind, 'totp'),
                    isNull(twoStepFactors.confirmedAt),
                ),
            );
        const now = new Date();
        await tx.insert(twoStepFactors).values({
            id: input.id,
            userId: input.userId,
            kind: 'totp',
            name: input.name,
            createdAt: now,
            totpKeyId: input.keyId,
            totpNonce: input.nonce,
            totpSecret: input.secret,
            totpLastStep: 0,
        });
        return { expiresAt: new Date(now.getTime() + PENDING_FACTOR_SECONDS * 1000) };
    });
}

const pendingTotp = (userId: string, factorId: string, now: Date) =>
    and(
        eq(twoStepFactors.id, factorId),
        eq(twoStepFactors.userId, userId),
        eq(twoStepFactors.kind, 'totp'),
        isNull(twoStepFactors.confirmedAt),
        gt(twoStepFactors.createdAt, new Date(now.getTime() - PENDING_FACTOR_SECONDS * 1000)),
    );

/* The account's own pending authenticator app, while its ten minutes last, to check a code against. */
export async function getPendingTotp(
    input: { userId: string; factorId: string },
    executor: Executor = db,
) {
    const [factor] = await executor
        .select()
        .from(twoStepFactors)
        .where(pendingTotp(input.userId, input.factorId, new Date()));
    return factor ?? null;
}

/* Sets the step on for an account that had no factor: its codes, and the session that enrolled. */
async function turnOn(
    tx: Tx,
    input: { userId: string; backupCodes: BackupCodeInput[]; sessionTokenHash?: Buffer },
    now: Date,
) {
    await tx.delete(twoStepBackupCodes).where(eq(twoStepBackupCodes.userId, input.userId));
    await tx.insert(twoStepBackupCodes).values(
        input.backupCodes.map((code) => ({
            userId: input.userId,
            codeHash: code.codeHash,
            keyId: code.keyId,
            createdAt: now,
        })),
    );
    // Enrolling with the password is this session's step; the account's others never passed one.
    if (input.sessionTokenHash)
        await tx
            .update(sessions)
            .set({ twoStepAt: now })
            .where(
                and(
                    eq(sessions.tokenHash, input.sessionTokenHash),
                    eq(sessions.userId, input.userId),
                ),
            );
}

function aSet(codes: BackupCodeInput[] | undefined): codes is BackupCodeInput[] {
    return codes !== undefined && codes.length === BACKUP_CODE_COUNT;
}

export type ConfirmTotpResult =
    | { status: 'ok'; turnedOn: boolean; replaced: boolean }
    /* `missing`: no such pending factor of this account, or its ten minutes are over.
       `codes`: this would turn the step on, and that needs a set of ten backup codes. */
    | { status: 'missing' | 'codes' };

/*
 * Confirms a pending authenticator app, once the caller has checked a code for
 * `step` against its secret. That step becomes the factor's last used one, so
 * the same code cannot answer a sign-in afterwards. Under the account's lock:
 * - the account's earlier app, if any, is removed in the same transaction;
 * - a new app starts unfrozen, with the count of wrong codes from new devices at zero;
 * - if the account had no factor, the step is now on: `backupCodes` (ten, hashed
 *   by the caller under the account's salt) are stored, and `sessionTokenHash`,
 *   the session that enrolled, is marked as having passed the step. Otherwise
 *   both are ignored, and the caller shows no codes (`turnedOn` is false).
 */
export async function confirmTotp(
    input: {
        userId: string;
        factorId: string;
        step: number;
        backupCodes?: BackupCodeInput[];
        sessionTokenHash?: Buffer;
    },
    executor: Executor = db,
): Promise<ConfirmTotpResult> {
    return executor.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return { status: 'missing' as const };
        const now = new Date();
        const [pending] = await tx
            .select({ id: twoStepFactors.id })
            .from(twoStepFactors)
            .where(pendingTotp(input.userId, input.factorId, now))
            .for('update');
        if (!pending) return { status: 'missing' as const };
        const wasOn = await hasTwoStep(input.userId, tx);
        if (!wasOn && !aSet(input.backupCodes)) return { status: 'codes' as const };
        // Before the new one is confirmed: one confirmed app per account.
        const replaced = await tx
            .delete(twoStepFactors)
            .where(and(confirmedOf(input.userId), eq(twoStepFactors.kind, 'totp')))
            .returning({ id: twoStepFactors.id });
        await tx
            .update(twoStepFactors)
            .set({ confirmedAt: now, totpLastStep: input.step })
            .where(eq(twoStepFactors.id, pending.id));
        await tx
            .update(twoStepState)
            .set({ consecutiveFailures: 0, totpFrozenAt: null })
            .where(eq(twoStepState.userId, input.userId));
        if (!wasOn && aSet(input.backupCodes))
            await turnOn(
                tx,
                {
                    userId: input.userId,
                    backupCodes: input.backupCodes,
                    sessionTokenHash: input.sessionTokenHash,
                },
                now,
            );
        return { status: 'ok' as const, turnedOn: !wasOn, replaced: replaced.length > 0 };
    });
}

/*
 * Takes a time step for the account's confirmed authenticator app: true exactly
 * once per step, and only for a step later than the last one taken. The update
 * is conditional, so two requests carrying the same code race to one success,
 * and a code used at sign-in cannot authorise a change a minute later.
 */
export async function takeTotpStep(
    input: { userId: string; factorId: string; step: number },
    executor: Executor = db,
) {
    const taken = await executor
        .update(twoStepFactors)
        .set({ totpLastStep: input.step, lastUsedAt: toHour(new Date()) })
        .where(
            and(
                eq(twoStepFactors.id, input.factorId),
                confirmedOf(input.userId),
                eq(twoStepFactors.kind, 'totp'),
                lt(twoStepFactors.totpLastStep, input.step),
            ),
        )
        .returning({ id: twoStepFactors.id });
    return taken.length === 1;
}

export type AddSecurityKeyResult =
    | { status: 'ok'; id: string; turnedOn: boolean }
    /* `limit`: the account has ten keys. `duplicate`: this credential is already on it.
       `codes`: this would turn the step on, and that needs a set of ten backup codes. */
    | { status: 'missing' | 'limit' | 'duplicate' | 'codes' };

/*
 * Adds a security key the caller has just verified the registration of. Up to
 * ten per account, and never the same credential twice. If the account had no
 * factor, the step is now on, as confirmTotp describes.
 */
export async function addSecurityKey(
    input: {
        userId: string;
        name: string;
        credentialId: Buffer;
        publicKey: Buffer;
        signCount: number;
        transports: string[];
        backupEligible: boolean;
        backupState: boolean;
        backupCodes?: BackupCodeInput[];
        sessionTokenHash?: Buffer;
    },
    executor: Executor = db,
): Promise<AddSecurityKeyResult> {
    return executor.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return { status: 'missing' as const };
        await ensureState(input.userId, tx);
        const keys = await tx
            .select({ credentialId: twoStepFactors.credentialId })
            .from(twoStepFactors)
            .where(
                and(eq(twoStepFactors.userId, input.userId), eq(twoStepFactors.kind, 'webauthn')),
            );
        if (keys.some((key) => key.credentialId?.equals(input.credentialId)))
            return { status: 'duplicate' as const };
        if (keys.length >= SECURITY_KEY_LIMIT) return { status: 'limit' as const };
        const wasOn = await hasTwoStep(input.userId, tx);
        if (!wasOn && !aSet(input.backupCodes)) return { status: 'codes' as const };
        const now = new Date();
        const [key] = await tx
            .insert(twoStepFactors)
            .values({
                userId: input.userId,
                kind: 'webauthn',
                name: input.name,
                createdAt: now,
                confirmedAt: now,
                credentialId: input.credentialId,
                publicKey: input.publicKey,
                signCount: input.signCount,
                transports: input.transports,
                backupEligible: input.backupEligible,
                backupState: input.backupState,
            })
            .returning({ id: twoStepFactors.id });
        if (!key) throw new Error('Could not add the security key.');
        if (!wasOn && aSet(input.backupCodes))
            await turnOn(
                tx,
                {
                    userId: input.userId,
                    backupCodes: input.backupCodes,
                    sessionTokenHash: input.sessionTokenHash,
                },
                now,
            );
        return { status: 'ok' as const, id: key.id, turnedOn: !wasOn };
    });
}

/*
 * Records an assertion by one of the account's keys: true when the signature
 * counter obeys the specification's rule (WebAuthn 6.1.1): if the stored
 * counter or the new one is non-zero, the new one must be greater. A key that
 * always reports zero, as every synced passkey does, passes. The update is
 * conditional, so two assertions carrying the same counter race to one success.
 */
export async function takeKeyCounter(
    input: { userId: string; factorId: string; signCount: number; backupState: boolean },
    executor: Executor = db,
) {
    const taken = await executor
        .update(twoStepFactors)
        .set({
            signCount: input.signCount,
            backupState: input.backupState,
            lastUsedAt: toHour(new Date()),
        })
        .where(
            and(
                eq(twoStepFactors.id, input.factorId),
                confirmedOf(input.userId),
                eq(twoStepFactors.kind, 'webauthn'),
                // Nothing is below zero, so a new zero passes only over a stored zero.
                input.signCount === 0
                    ? eq(twoStepFactors.signCount, 0)
                    : lt(twoStepFactors.signCount, input.signCount),
            ),
        )
        .returning({ id: twoStepFactors.id });
    return taken.length === 1;
}

/* Renames one of the account's own methods. The name is not encrypted. */
export async function renameFactor(
    input: { userId: string; factorId: string; name: string },
    executor: Executor = db,
) {
    const renamed = await executor
        .update(twoStepFactors)
        .set({ name: input.name })
        .where(and(eq(twoStepFactors.id, input.factorId), confirmedOf(input.userId)))
        .returning({ id: twoStepFactors.id });
    return renamed.length === 1;
}

export type RemoveFactorResult =
    | { status: 'ok'; kind: TwoStepFactorKind; turnedOff: boolean }
    | { status: 'missing' };

/*
 * Removes one of the account's own methods. Removing the last one turns the
 * step off: the backup codes are deleted, the lockout counts start again, and
 * step tokens still out are dropped, since there is no step for them to answer.
 */
export async function removeFactor(
    input: { userId: string; factorId: string },
    executor: Executor = db,
): Promise<RemoveFactorResult> {
    return executor.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return { status: 'missing' as const };
        const [removed] = await tx
            .delete(twoStepFactors)
            .where(and(eq(twoStepFactors.id, input.factorId), confirmedOf(input.userId)))
            .returning({ kind: twoStepFactors.kind });
        if (!removed) return { status: 'missing' as const };
        const turnedOff = !(await hasTwoStep(input.userId, tx));
        if (turnedOff) {
            await tx.delete(twoStepBackupCodes).where(eq(twoStepBackupCodes.userId, input.userId));
            await tx.delete(twoStepAttempts).where(eq(twoStepAttempts.userId, input.userId));
            await tx
                .update(twoStepState)
                .set({ consecutiveFailures: 0, totpFrozenAt: null })
                .where(eq(twoStepState.userId, input.userId));
            await tx
                .update(accountDevices)
                .set({ twoStepFailures: 0 })
                .where(
                    and(
                        eq(accountDevices.userId, input.userId),
                        gt(accountDevices.twoStepFailures, 0),
                    ),
                );
        }
        return { status: 'ok' as const, kind: removed.kind, turnedOff };
    });
}

/* ------------------------------------------------------------------------- */
/* Backup codes                                                               */
/* ------------------------------------------------------------------------- */

/*
 * Replaces the account's backup codes with a new set of ten: every old code,
 * used or not, stops working in the same transaction. False when the step is
 * off (an account without a factor has no codes) or the account is gone.
 */
export async function replaceBackupCodes(
    input: { userId: string; codes: BackupCodeInput[] },
    executor: Executor = db,
) {
    if (!aSet(input.codes)) throw new Error(`A set is ${BACKUP_CODE_COUNT} backup codes.`);
    return executor.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return false;
        if (!(await hasTwoStep(input.userId, tx))) return false;
        const now = new Date();
        await tx.delete(twoStepBackupCodes).where(eq(twoStepBackupCodes.userId, input.userId));
        await tx.insert(twoStepBackupCodes).values(
            input.codes.map((code) => ({
                userId: input.userId,
                codeHash: code.codeHash,
                keyId: code.keyId,
                createdAt: now,
            })),
        );
        return true;
    });
}

/*
 * Spends one of the account's own backup codes: the number of codes left, or
 * null when this hash is not an unused code of this account. The update is
 * conditional, so two requests carrying one code give one success.
 */
export async function spendBackupCode(
    input: { userId: string; codeHash: Buffer },
    executor: Executor = db,
) {
    return executor.transaction(async (tx) => {
        const spent = await tx
            .update(twoStepBackupCodes)
            .set({ usedAt: new Date() })
            .where(
                and(
                    eq(twoStepBackupCodes.userId, input.userId),
                    eq(twoStepBackupCodes.codeHash, input.codeHash),
                    isNull(twoStepBackupCodes.usedAt),
                ),
            )
            .returning({ userId: twoStepBackupCodes.userId });
        if (spent.length !== 1) return null;
        const [left] = await tx
            .select({ count: count() })
            .from(twoStepBackupCodes)
            .where(
                and(eq(twoStepBackupCodes.userId, input.userId), isNull(twoStepBackupCodes.usedAt)),
            );
        return left?.count ?? 0;
    });
}

/* ------------------------------------------------------------------------- */
/* Step tokens                                                                */
/* ------------------------------------------------------------------------- */

/* What a token was issued for: its purpose, and the session it is bound to (none at sign-in). */
export type StepBinding = {
    tokenHash: Buffer;
    purpose: TwoStepPurpose;
    sessionTokenHash: Buffer | null;
};

const live = (binding: StepBinding, now: Date) =>
    and(
        eq(twoStepAttempts.tokenHash, binding.tokenHash),
        eq(twoStepAttempts.purpose, binding.purpose),
        binding.sessionTokenHash
            ? eq(twoStepAttempts.sessionTokenHash, binding.sessionTokenHash)
            : isNull(twoStepAttempts.sessionTokenHash),
        gt(twoStepAttempts.expiresAt, now),
        lt(twoStepAttempts.failures, STEP_TOKEN_FAILURES),
    );

/*
 * Issues a step token, kept by its hash for five minutes. A sign-in's token
 * (`login`) has no session; it carries the device that proved its key at
 * `login/finish`, if one did, and the browser's previous session token. Every
 * other purpose but `enrol` is bound to the session asking.
 */
export async function createStepAttempt(
    input: {
        tokenHash: Buffer;
        userId: string;
        purpose: TwoStepPurpose;
        sessionTokenHash: Buffer | null;
        credentialVersion: number;
        deviceId?: string | null;
        previousTokenHash?: Buffer | null;
        webauthnChallenge?: Buffer | null;
    },
    executor: Executor = db,
) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STEP_TOKEN_SECONDS * 1000);
    await executor.insert(twoStepAttempts).values({
        tokenHash: input.tokenHash,
        userId: input.userId,
        purpose: input.purpose,
        sessionTokenHash: input.sessionTokenHash,
        credentialVersion: input.credentialVersion,
        deviceId: input.deviceId ?? null,
        previousTokenHash: input.previousTokenHash ?? null,
        webauthnChallenge: input.webauthnChallenge ?? null,
        createdAt: now,
        expiresAt,
    });
    return { expiresAt };
}

/*
 * A live step token, read without spending it: the caller needs its account
 * and challenge to check the answer. Null for a token that expired, took its
 * fifth wrong answer, or was issued for another purpose or another session.
 */
export async function getStepAttempt(binding: StepBinding, executor: Executor = db) {
    const [attempt] = await executor
        .select()
        .from(twoStepAttempts)
        .where(live(binding, new Date()));
    return attempt ?? null;
}

/*
 * Which count a token's answers fall under: the device that proved its key at
 * sign-in, the device of the session a change is asked from, or (a null device)
 * the account's shared count for sign-ins that proved no device. A device
 * counts as known only while it is this account's own, approved and not
 * removed; anything else is a sign-in from a new device, whatever the token says.
 * `live` is false when the session a change was asked from has ended.
 */
async function poolOf(tx: Tx, attempt: StepAttempt, now: Date) {
    let deviceId = attempt.deviceId;
    if (attempt.purpose !== 'login' && attempt.purpose !== 'enrol') {
        if (!attempt.sessionTokenHash) return { live: false, deviceId: null };
        const [session] = await tx
            .select({ deviceId: sessions.deviceId })
            .from(sessions)
            .where(
                and(
                    eq(sessions.tokenHash, attempt.sessionTokenHash),
                    eq(sessions.userId, attempt.userId),
                    gt(sessions.expiresAt, now),
                ),
            );
        if (!session) return { live: false, deviceId: null };
        deviceId = session.deviceId;
    }
    if (!deviceId) return { live: true, deviceId: null };
    const [device] = await tx
        .select({ id: accountDevices.id })
        .from(accountDevices)
        .where(
            and(
                eq(accountDevices.id, deviceId),
                eq(accountDevices.userId, attempt.userId),
                isNull(accountDevices.revokedAt),
                isNotNull(accountDevices.approvedAt),
            ),
        );
    return { live: true, deviceId: device?.id ?? null };
}

export type StepFailure =
    | { status: 'missing' }
    | {
          status: 'counted';
          userId: string;
          /* Wrong answers this token has left; at zero it is gone. */
          left: number;
          /* Null for a wrong key assertion or phrase signature: only codes can be guessed. */
          pool: 'account' | 'device' | null;
          deviceId: string | null;
          /* Wrong codes in a row in that pool, this one included. */
          consecutive: number | null;
          /* This failure froze the authenticator app for sign-ins that prove no device. */
          froze: boolean;
      };

/*
 * Counts a wrong answer to a live token. The token takes five and is then
 * deleted. A wrong code (authenticator or backup) also adds to the consecutive
 * count of its pool: the device that proved its key, or the account's count
 * for sign-ins that proved none, where the hundredth freezes the authenticator
 * app for such sign-ins. The caller sends the notice at five.
 */
export async function failStep(
    input: StepBinding & { method: 'totp' | 'backup' | 'webauthn' | 'phrase' },
    executor: Executor = db,
): Promise<StepFailure> {
    // Read first only to learn whose lock to take; the update below is what counts.
    const known = await getStepAttempt(input, executor);
    if (!known) return { status: 'missing' };
    return executor.transaction(async (tx) => {
        // The account's lock first, as passStep takes it, so the two never wait on each other.
        if (!(await lockAccount(tx, known.userId))) return { status: 'missing' as const };
        const now = new Date();
        const [attempt] = await tx
            .update(twoStepAttempts)
            .set({ failures: sql`${twoStepAttempts.failures} + 1` })
            .where(live(input, now))
            .returning();
        if (!attempt) return { status: 'missing' as const };
        const left = STEP_TOKEN_FAILURES - attempt.failures;
        if (left <= 0)
            await tx
                .delete(twoStepAttempts)
                .where(eq(twoStepAttempts.tokenHash, attempt.tokenHash));
        const counted = { status: 'counted' as const, userId: attempt.userId, left };
        if (input.method !== 'totp' && input.method !== 'backup')
            return { ...counted, pool: null, deviceId: null, consecutive: null, froze: false };

        const { live: bound, deviceId } = await poolOf(tx, attempt, now);
        // A change asked from a session that has since ended: the token can no longer pass at all.
        if (!bound)
            return { ...counted, pool: null, deviceId: null, consecutive: null, froze: false };
        if (deviceId) {
            const [device] = await tx
                .update(accountDevices)
                .set({ twoStepFailures: sql`${accountDevices.twoStepFailures} + 1` })
                .where(
                    and(eq(accountDevices.id, deviceId), eq(accountDevices.userId, attempt.userId)),
                )
                .returning({ failures: accountDevices.twoStepFailures });
            return {
                ...counted,
                pool: 'device' as const,
                deviceId,
                consecutive: device?.failures ?? null,
                froze: false,
            };
        }
        // The state row is made with the first factor; made here too, so a count is never lost.
        const [state] = await tx
            .insert(twoStepState)
            .values({
                userId: attempt.userId,
                webauthnUserHandle: randomBytes(32),
                backupCodeSalt: randomBytes(16),
                consecutiveFailures: 1,
            })
            .onConflictDoUpdate({
                target: twoStepState.userId,
                set: {
                    consecutiveFailures: sql`${twoStepState.consecutiveFailures} + 1`,
                    totpFrozenAt: sql`case when ${twoStepState.totpFrozenAt} is null and ${twoStepState.consecutiveFailures} + 1 >= ${TOTP_FREEZE_FAILURES} then ${now} else ${twoStepState.totpFrozenAt} end`,
                },
            })
            .returning({
                failures: twoStepState.consecutiveFailures,
                frozenAt: twoStepState.totpFrozenAt,
            });
        return {
            ...counted,
            pool: 'account' as const,
            deviceId: null,
            consecutive: state?.failures ?? null,
            froze: state?.frozenAt?.getTime() === now.getTime(),
        };
    });
}

/* What the caller proved, and what of it may be used only once. */
export type StepProof =
    | { method: 'totp'; factorId: string; step: number }
    | { method: 'backup'; codeHash: Buffer }
    | { method: 'webauthn'; factorId: string; signCount: number; backupState: boolean }
    | { method: 'phrase' };

export type StepPass =
    | {
          status: 'ok';
          /* The token as it was issued: the account, and for a sign-in the device and previous session. */
          attempt: StepAttempt;
          /* When the step was passed: what the new session's two_step_at is set to. */
          at: Date;
          /* After a backup code: how many are left. */
          backupCodesLeft: number | null;
          /* This success unfroze the authenticator app. */
          unfroze: boolean;
      }
    /*
     * `missing`: no live token with this binding (spent, expired, ended, another purpose or session,
     * or the session it was bound to is over).
     * `stale`: the password changed since the token was issued; the token is gone.
     * `frozen`: an authenticator code from a sign-in that proved no device, while the app is frozen.
     * `refused`: the proof cannot be used: a time step not later than the last, a backup code that is
     * not an unused code of this account, a key counter that did not go up, or a factor that is not a
     * confirmed one of this account. Nothing is spent, and the token is still there: count it (failStep).
     */
    | { status: 'missing' | 'stale' | 'frozen' | 'refused' };

/*
 * Passes the step: spends the token and the proof together, or neither. Under
 * the account's lock, in this order:
 * - the token is deleted, so of two requests carrying it one passes;
 * - the credential version it was issued under must still be the account's;
 * - for a change, the session it is bound to must still be live;
 * - the proof is used up: the time step, the backup code or the key's counter,
 *   each through this account's own rows only;
 * - the pool's consecutive count starts again, and a success by anything but
 *   the authenticator app unfreezes it.
 * Run inside the transaction that creates the session (with `at` as its
 * two_step_at) or commits the change, by passing that transaction as the
 * executor: then a failure there puts the token, code and counter back.
 * An `enrol` token is never passed here: only confirming a first method answers it.
 */
export async function passStep(
    input: StepBinding & { proof: StepProof },
    executor: Executor = db,
): Promise<StepPass> {
    if (input.purpose === 'enrol') return { status: 'missing' };
    // Read first only to learn whose lock to take; the delete below is what decides.
    const known = await getStepAttempt(input, executor);
    if (!known) return { status: 'missing' };
    try {
        return await executor.transaction((tx) => pass(tx, known.userId, input));
    } catch (error) {
        if (error instanceof Refused) return { status: error.status };
        throw error;
    }
}

/* passStep's transaction: a Refused thrown here puts the token back. */
async function pass(
    tx: Tx,
    userId: string,
    input: StepBinding & { proof: StepProof },
): Promise<StepPass> {
    if (!(await lockAccount(tx, userId))) return { status: 'missing' as const };
    const now = new Date();
    const [attempt] = await tx.delete(twoStepAttempts).where(live(input, now)).returning();
    if (!attempt) return { status: 'missing' as const };
    const [credential] = await tx
        .select({ version: opaqueCredentials.version })
        .from(opaqueCredentials)
        .where(eq(opaqueCredentials.userId, attempt.userId));
    if (credential?.version !== attempt.credentialVersion) return { status: 'stale' as const };
    const pool = await poolOf(tx, attempt, now);
    if (!pool.live) return { status: 'missing' as const };
    const [state] = await tx
        .select({ frozenAt: twoStepState.totpFrozenAt })
        .from(twoStepState)
        .where(eq(twoStepState.userId, attempt.userId))
        .for('update');
    const frozen = state?.frozenAt != null;

    const { proof } = input;
    let backupCodesLeft: number | null = null;
    if (proof.method === 'totp') {
        if (frozen && !pool.deviceId) throw new Refused('frozen');
        const taken = await takeTotpStep(
            { userId: attempt.userId, factorId: proof.factorId, step: proof.step },
            tx,
        );
        if (!taken) throw new Refused('refused');
    } else if (proof.method === 'backup') {
        backupCodesLeft = await spendBackupCode(
            { userId: attempt.userId, codeHash: proof.codeHash },
            tx,
        );
        if (backupCodesLeft === null) throw new Refused('refused');
    } else if (proof.method === 'webauthn') {
        const taken = await takeKeyCounter(
            {
                userId: attempt.userId,
                factorId: proof.factorId,
                signCount: proof.signCount,
                backupState: proof.backupState,
            },
            tx,
        );
        if (!taken) throw new Refused('refused');
    }

    const unfroze = frozen && proof.method !== 'totp';
    if (pool.deviceId)
        await tx
            .update(accountDevices)
            .set({ twoStepFailures: 0 })
            .where(
                and(
                    eq(accountDevices.id, pool.deviceId),
                    eq(accountDevices.userId, attempt.userId),
                ),
            );
    // The account's shared count starts again on a success in its own pool, and with the thaw.
    if (!pool.deviceId || unfroze)
        await tx
            .update(twoStepState)
            .set({
                consecutiveFailures: 0,
                ...(unfroze ? { totpFrozenAt: null } : {}),
            })
            .where(eq(twoStepState.userId, attempt.userId));
    return { status: 'ok' as const, attempt, at: now, backupCodesLeft, unfroze };
}
