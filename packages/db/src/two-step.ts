import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, gt, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
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
 * that opens the session or commits the change the step authorises
 * (createSession and changeAccountSecurity take the same one; deleteAccount
 * passes the step itself, after its groups). Each locks the account's row
 * first. `steppedChange` is that transaction for a change asked from a
 * session: the step, then the change, both or neither.
 *
 * `enrol` tokens (a first method enrolled at sign-in, under a policy) can be
 * issued and read here, but nothing consumes one until the policy change is
 * built: passStep refuses them, and turning the step on deletes them. Issuing
 * one takes no lock and checks nothing, so one can still be written just after
 * the step was turned on. Whatever comes to consume them must check, under the
 * account's lock, that the token is live and the account has no method yet.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

/* An authenticator app being enrolled is dropped ten minutes after it was made. */
export const PENDING_FACTOR_SECONDS = 10 * 60;
/* A step token lasts five minutes, and five wrong answers. */
export const STEP_TOKEN_SECONDS = 5 * 60;
export const STEP_TOKEN_FAILURES = 5;
/*
 * Wrong codes in a row, in one pool, before the app is frozen there: for every sign-in that
 * proves no device (the account's shared pool), or for one known device alone.
 */
export const TOTP_FREEZE_FAILURES = 100;
/* A device that keeps its session is asked for the step again this long after it last passed it. */
export const STEP_REMEMBERED_DAYS = 30;
export const SECURITY_KEY_LIMIT = 10;
export const BACKUP_CODE_COUNT = 10;
/* The security log keeps 90 days. */
export const SECURITY_EVENT_DAYS = 90;

export type TwoStepFactor = typeof twoStepFactors.$inferSelect;
export type StepAttempt = typeof twoStepAttempts.$inferSelect;
export type BackupCodeInput = { codeHash: Buffer; keyId: Buffer };

/*
 * Why a proof was refused:
 * - `replayed`: a time step not later than the last one taken, or a backup code already used;
 * - `counter`: the key's signature counter did not go up;
 * - `unknown`: not a confirmed factor, or not a backup code, of this account: another
 *   account's, a removed or pending one, or none at all.
 */
export type StepRefusal = 'replayed' | 'counter' | 'unknown';

/* Thrown, never returned, so what a refused pass already wrote (the spent token) rolls back with it. */
class Refused extends Error {
    constructor(
        readonly result: { status: 'frozen' } | { status: 'refused'; reason: StepRefusal },
    ) {
        super(result.status);
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

/*
 * Sets the step on for an account that had no factor, under the account's lock: its codes, the
 * end of its enrol tokens, and the session that enrolled.
 */
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
    // An enrol token stood in for the step while the account had none. It has one now: a second
    // token minted for the same sign-in must not enrol or replace a method without it.
    await tx
        .delete(twoStepAttempts)
        .where(and(eq(twoStepAttempts.userId, input.userId), eq(twoStepAttempts.purpose, 'enrol')));
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
 * - a new app starts unfrozen everywhere, with every count of wrong codes at zero: the
 *   account's shared one and each known device's;
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
        await tx
            .update(accountDevices)
            .set({ twoStepFailures: 0 })
            .where(
                and(eq(accountDevices.userId, input.userId), gt(accountDevices.twoStepFailures, 0)),
            );
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
        // The freeze is the app's: with the app gone there is nothing frozen.
        if (removed.kind === 'totp')
            await tx
                .update(twoStepState)
                .set({ totpFrozenAt: null })
                .where(eq(twoStepState.userId, input.userId));
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

/* Whether the account's credential is still the version the token was issued under. */
async function issuedUnderCurrentPassword(tx: Tx, attempt: StepAttempt) {
    const [credential] = await tx
        .select({ version: opaqueCredentials.version })
        .from(opaqueCredentials)
        .where(eq(opaqueCredentials.userId, attempt.userId));
    return credential?.version === attempt.credentialVersion;
}

/*
 * Which count a token's answers fall under: the device that proved its key at
 * sign-in, the device of the session a change is asked from, or (a null device)
 * the account's shared count for sign-ins that proved no device. A device
 * counts as known only while it is this account's own, approved and not
 * removed; anything else is a sign-in from a new device, whatever the token says.
 * At sign-in it must also hold a signing key, as createSession asks before it
 * takes a proof: a device without one cannot have proved anything. A change is
 * asked from a session, and holding that session is what makes its device known.
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
                attempt.purpose === 'login'
                    ? isNotNull(accountDevices.signingPublicKey)
                    : undefined,
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
          /*
           * Whose answer it was: a known device's, or the account's shared pool for sign-ins that
           * proved none. Null when the session a change was asked from has ended.
           */
          pool: 'account' | 'device' | null;
          deviceId: string | null;
          /*
           * Wrong codes in a row in that pool, this one included. Null for a wrong key assertion
           * or phrase signature: only codes can be guessed, so only codes count here.
           */
          consecutive: number | null;
          /* This failure froze the authenticator app in that pool. */
          froze: boolean;
      };

/*
 * Counts a wrong answer to a live token. The token takes five and is then
 * deleted. A wrong code (authenticator or backup) also adds to the consecutive
 * count of its pool: the device that proved its key, or the account's count
 * for sign-ins that proved none. The hundredth in a row freezes the
 * authenticator app in that pool alone, if the account has one: with keys and
 * backup codes only there is nothing to freeze, and the count just goes on.
 * Every counted failure names its pool, a wrong key assertion or phrase
 * signature too: the caller's notice ("someone has your password") counts
 * them all, while the freeze counts codes.
 *
 * A token issued under a password that has since changed can never pass, so it
 * counts nothing either: it is deleted, and the answer is `missing`.
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
        if (!(await issuedUnderCurrentPassword(tx, known))) {
            await tx.delete(twoStepAttempts).where(eq(twoStepAttempts.tokenHash, known.tokenHash));
            return { status: 'missing' as const };
        }
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

        const { live: bound, deviceId } = await poolOf(tx, attempt, now);
        // A change asked from a session that has since ended: the token can no longer pass at all.
        if (!bound)
            return { ...counted, pool: null, deviceId: null, consecutive: null, froze: false };
        const pool = deviceId ? ('device' as const) : ('account' as const);
        if (input.method !== 'totp' && input.method !== 'backup')
            return { ...counted, pool, deviceId, consecutive: null, froze: false };

        // Only an app can be frozen; under the account's lock, none is confirmed meanwhile.
        const [app] = await tx
            .select({ id: twoStepFactors.id })
            .from(twoStepFactors)
            .where(and(confirmedOf(attempt.userId), eq(twoStepFactors.kind, 'totp')))
            .limit(1);
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
                pool,
                deviceId,
                consecutive: device?.failures ?? null,
                // A device is frozen for as long as its count stands at a hundred or more.
                froze: app !== undefined && device?.failures === TOTP_FREEZE_FAILURES,
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
                    ...(app
                        ? {
                              totpFrozenAt: sql`case when ${twoStepState.totpFrozenAt} is null and ${twoStepState.consecutiveFailures} + 1 >= ${TOTP_FREEZE_FAILURES} then ${now} else ${twoStepState.totpFrozenAt} end`,
                          }
                        : {}),
                },
            })
            .returning({
                failures: twoStepState.consecutiveFailures,
                frozenAt: twoStepState.totpFrozenAt,
            });
        return {
            ...counted,
            pool,
            deviceId: null,
            consecutive: state?.failures ?? null,
            froze: state?.frozenAt?.getTime() === now.getTime(),
        };
    });
}

/*
 * What a caller needs before it checks an answer, read without locking or
 * spending anything: the live token, the pool its answers fall in (see
 * poolOf), and whether the authenticator app is frozen there. A caller refuses
 * a code for a frozen app without checking it, so the refusal never says
 * whether the code was right; passStep decides again under the lock. Null for
 * a token that is not live under this binding, or whose session has ended.
 */
export async function getStepContext(binding: StepBinding, executor: Executor = db) {
    return executor.transaction(async (tx) => {
        const now = new Date();
        const [attempt] = await tx.select().from(twoStepAttempts).where(live(binding, now));
        if (!attempt) return null;
        const pool = await poolOf(tx, attempt, now);
        if (!pool.live) return null;
        return {
            attempt,
            deviceId: pool.deviceId,
            totpFrozen: await frozenIn(tx, attempt.userId, pool.deviceId),
        };
    });
}

/*
 * Whether the authenticator app is frozen in a pool: the account's shared one
 * (a null device) by its mark, a known device by its own count standing at a
 * hundred or more. `lock` when the caller is about to decide on it.
 */
async function frozenIn(tx: Tx, userId: string, deviceId: string | null, lock = false) {
    if (deviceId) {
        const query = tx
            .select({ failures: accountDevices.twoStepFailures })
            .from(accountDevices)
            .where(and(eq(accountDevices.id, deviceId), eq(accountDevices.userId, userId)));
        const [device] = await (lock ? query.for('update') : query);
        return (device?.failures ?? 0) >= TOTP_FREEZE_FAILURES;
    }
    const query = tx
        .select({ frozenAt: twoStepState.totpFrozenAt })
        .from(twoStepState)
        .where(eq(twoStepState.userId, userId));
    const [state] = await (lock ? query.for('update') : query);
    return state?.frozenAt != null;
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
          /* The known device whose pool the answer fell in, or null for the account's shared pool. */
          deviceId: string | null;
          /* When the step was passed: what the new session's two_step_at is set to. */
          at: Date;
          /* After a backup code: how many are left. */
          backupCodesLeft: number | null;
          /* This success unfroze the authenticator app, in the shared pool or on a device. */
          unfroze: boolean;
      }
    /*
     * `missing`: no live token with this binding (spent, expired, ended, another purpose or session,
     * or the session it was bound to is over).
     * `stale`: the password changed since the token was issued; the token is gone.
     * `frozen`: an authenticator code in a pool where the app is frozen: a sign-in that proved no
     * device, or a known device with a hundred wrong codes in a row of its own.
     * `refused`: the proof cannot be used, for `reason`. Nothing is spent, and the token is still
     * there: count it (failStep).
     */
    | { status: 'missing' | 'stale' | 'frozen' }
    | { status: 'refused'; reason: StepRefusal };

/*
 * Passes the step: spends the token and the proof together, or neither. Under
 * the account's lock, in this order:
 * - the token is deleted, so of two requests carrying it one passes;
 * - the credential version it was issued under must still be the account's;
 * - for a change, the session it is bound to must still be live;
 * - the proof is used up: the time step, the backup code or the key's counter,
 *   each through this account's own rows only;
 * - the pool's consecutive count starts again, and a success by anything but
 *   the authenticator app unfreezes it everywhere, on each known device too;
 * - for a change, the session asking is marked as stepped (`two_step_at`) if
 *   it was not: it has now passed the step. A time already there is kept, so a
 *   change never extends the thirty days.
 * Run inside the transaction that creates the session (with `at` and the
 * token's device as createSession's `twoStep.passed`) or commits the change:
 * open one, pass it here as the executor, then pass it to createSession or
 * changeAccountSecurity, and roll it back unless that succeeds (steppedChange
 * does this for a change). The token, the code or step, the counts and any
 * thaw then come back. Their order of locks is this one's, the account's row
 * first. deleteAccount's is not: it locks the person's groups before the
 * account, so it takes the proof and passes the step itself, after them (see
 * there). The rule is general: this locks the account's row, and every group
 * write locks the group first and the person's row second, so anything that
 * locks a group after this has run in the same transaction can deadlock with
 * a group write.
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
        if (error instanceof Refused) return error.result;
        throw error;
    }
}

const refused = (reason: StepRefusal) => new Refused({ status: 'refused', reason });

/* Whether `factorId` is a confirmed factor of that kind on this account: what tells a replay from a stranger's. */
async function ownFactor(tx: Tx, userId: string, factorId: string, kind: TwoStepFactorKind) {
    const [factor] = await tx
        .select({ id: twoStepFactors.id })
        .from(twoStepFactors)
        .where(
            and(
                eq(twoStepFactors.id, factorId),
                confirmedOf(userId),
                eq(twoStepFactors.kind, kind),
            ),
        );
    return factor !== undefined;
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
    if (!(await issuedUnderCurrentPassword(tx, attempt))) return { status: 'stale' as const };
    const pool = await poolOf(tx, attempt, now);
    if (!pool.live) return { status: 'missing' as const };
    const frozenShared = await frozenIn(tx, attempt.userId, null, true);
    const frozenHere = pool.deviceId
        ? await frozenIn(tx, attempt.userId, pool.deviceId, true)
        : frozenShared;

    const { proof } = input;
    let backupCodesLeft: number | null = null;
    if (proof.method === 'totp') {
        if (frozenHere) throw new Refused({ status: 'frozen' });
        const taken = await takeTotpStep(
            { userId: attempt.userId, factorId: proof.factorId, step: proof.step },
            tx,
        );
        if (!taken)
            throw refused(
                (await ownFactor(tx, attempt.userId, proof.factorId, 'totp'))
                    ? 'replayed'
                    : 'unknown',
            );
    } else if (proof.method === 'backup') {
        backupCodesLeft = await spendBackupCode(
            { userId: attempt.userId, codeHash: proof.codeHash },
            tx,
        );
        if (backupCodesLeft === null) {
            const [used] = await tx
                .select({ usedAt: twoStepBackupCodes.usedAt })
                .from(twoStepBackupCodes)
                .where(
                    and(
                        eq(twoStepBackupCodes.userId, attempt.userId),
                        eq(twoStepBackupCodes.codeHash, proof.codeHash),
                    ),
                );
            throw refused(used ? 'replayed' : 'unknown');
        }
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
        if (!taken)
            throw refused(
                (await ownFactor(tx, attempt.userId, proof.factorId, 'webauthn'))
                    ? 'counter'
                    : 'unknown',
            );
    }

    // A success in a device's own pool starts its count again (and with it, its freeze).
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
    // Anything but the app itself thaws it wherever it is frozen: every known device at or past
    // its hundred, and the shared pool.
    const thawed =
        proof.method === 'totp'
            ? []
            : await tx
                  .update(accountDevices)
                  .set({ twoStepFailures: 0 })
                  .where(
                      and(
                          eq(accountDevices.userId, attempt.userId),
                          gte(accountDevices.twoStepFailures, TOTP_FREEZE_FAILURES),
                      ),
                  )
                  .returning({ id: accountDevices.id });
    const unfroze =
        proof.method !== 'totp' &&
        (frozenShared || thawed.length > 0 || (pool.deviceId !== null && frozenHere));
    const thawShared = proof.method !== 'totp' && frozenShared;
    // The account's shared count starts again on a success in its own pool, and with the thaw.
    if (!pool.deviceId || thawShared)
        await tx
            .update(twoStepState)
            .set({
                consecutiveFailures: 0,
                ...(thawShared ? { totpFrozenAt: null } : {}),
            })
            .where(eq(twoStepState.userId, attempt.userId));
    // A change asked from a session that never passed the step: it has now.
    if (attempt.sessionTokenHash)
        await tx
            .update(sessions)
            .set({ twoStepAt: now })
            .where(
                and(
                    eq(sessions.tokenHash, attempt.sessionTokenHash),
                    eq(sessions.userId, attempt.userId),
                    isNull(sessions.twoStepAt),
                ),
            );
    return {
        status: 'ok' as const,
        attempt,
        deviceId: pool.deviceId,
        at: now,
        backupCodesLeft,
        unfroze,
    };
}

/* What a change asked from a session is authorised by: its step token, and the proof the caller checked. */
export type ChangeStep = { tokenHash: Buffer; proof: StepProof };

export type SteppedChange<T> =
    /* `passed` is null when the account has no step: the change needed none. */
    | { status: 'ok'; value: T; passed: Extract<StepPass, { status: 'ok' }> | null }
    /* The account has the step on and the request carried none. Nothing was changed. */
    | { status: 'required' }
    /* The step passed and `change` then refused: everything was put back, the step included. */
    | { status: 'unchanged' }
    | Exclude<StepPass, { status: 'ok' }>;

/* Thrown, never returned, so the step a refused change was authorised by rolls back with it. */
class Unchanged extends Error {}

/*
 * A change asked from a session, behind the step, in one transaction: under
 * the account's lock, an account with the step on must pass it (a token issued
 * to this session for this `purpose`, and the proof the caller checked), and
 * only then does `change` run, in the same transaction. `change` answers null
 * to refuse; the step it was authorised by is then put back with everything
 * else, so a token, a backup code, a time step, a count or a thaw is never
 * spent on a change that did not happen. A step that does not pass comes back
 * as passStep answered it, and after `refused` the caller counts the wrong
 * answer (failStep). An account without the step runs `change` as it is.
 *
 * `change` must not lock a group: the account's row is held here (see passStep).
 */
export async function steppedChange<T>(
    input: {
        userId: string;
        purpose: Exclude<TwoStepPurpose, 'login' | 'enrol'>;
        sessionTokenHash: Buffer;
        step?: ChangeStep | null;
    },
    change: (tx: Tx, passed: Extract<StepPass, { status: 'ok' }> | null) => Promise<T | null>,
): Promise<SteppedChange<T>> {
    try {
        return await db.transaction(async (tx): Promise<SteppedChange<T>> => {
            if (!(await lockAccount(tx, input.userId))) return { status: 'missing' };
            let passed: Extract<StepPass, { status: 'ok' }> | null = null;
            if (await hasTwoStep(input.userId, tx)) {
                if (!input.step) return { status: 'required' };
                const result = await passStep(
                    {
                        tokenHash: input.step.tokenHash,
                        purpose: input.purpose,
                        sessionTokenHash: input.sessionTokenHash,
                        proof: input.step.proof,
                    },
                    tx,
                );
                // Nothing is spent: passStep put its own writes back.
                if (result.status !== 'ok') return result;
                // The token is bound to the session asking, and that session to its account.
                if (result.attempt.userId !== input.userId) throw new Unchanged();
                passed = result;
            }
            const value = await change(tx, passed);
            if (value === null) throw new Unchanged();
            return { status: 'ok', value, passed };
        });
    } catch (error) {
        if (error instanceof Unchanged) return { status: 'unchanged' };
        throw error;
    }
}

export type SteppedTx = Tx;
