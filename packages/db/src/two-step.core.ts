import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './client';
import {
    accountDevices,
    opaqueCredentials,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepFactors,
    twoStepState,
    type TwoStepMethod,
    type TwoStepPurpose,
} from './schema';
import { lockAccount, type Executor, type Tx } from './sessions';

/*
 * The pieces of the second step that only a repository transaction may run: reading a step
 * token, accepting a time step, spending a backup code, and passing the step. Not exported
 * from the package. The server reaches them only through the functions that gate one action
 * each (`openSteppedSession`, `removeFactor`, `replaceBackupCodes`, `startTotpFactor` in
 * two-step.ts; `changeAccountSecurity` and `deleteAccount` in auth.ts), so what a step spends
 * and what it authorises always commit, or roll back, together.
 */

/* A step token allows this many answers; a slot is taken before each one is checked. */
export const STEP_TOKEN_ANSWERS = 5;
/* From this many wrong answers in a row, the account is told its password is known. */
export const STEP_NOTICE_FAILURES = 5;
/* At this many in a row from sign-ins that proved no device, the authenticator app is frozen for them. */
export const TOTP_FREEZE_FAILURES = 100;
/* A set of backup codes. */
export const BACKUP_CODE_COUNT = 10;
/* How long a second-step method may wait to be confirmed (docs/two-step-design.md 2). */
export const PENDING_FACTOR_SECONDS = 10 * 60;
/* RFC 6238's time step, which the key URI fixes at 30 seconds. */
export const TOTP_PERIOD_SECONDS = 30;

const HOUR_MS = 60 * 60 * 1000;
/* The hour a moment falls in (UTC): what `last_used_at` keeps. */
export const hourOf = (moment: Date) => new Date(Math.floor(moment.getTime() / HOUR_MS) * HOUR_MS);

/*
 * Whether `step` is a time step the server could have accepted a code for by now: none later
 * than the one after the current step, by this process's clock. That is the clock the
 * server's window of T-1, T and T+1 comes from, so a code the server accepted is never out of
 * reach here, whatever the database's clock says. A later step can only be a mistake above
 * this repository, and stored it would refuse every real code until the clock caught up.
 */
export function totpStepInReach(step: number, now = Date.now()) {
    return (
        Number.isSafeInteger(step) &&
        step > 0 &&
        step <= Math.floor(now / (TOTP_PERIOD_SECONDS * 1000)) + 1
    );
}

export async function confirmedFactors(executor: Executor, userId: string) {
    return executor
        .select({ id: twoStepFactors.id, kind: twoStepFactors.kind })
        .from(twoStepFactors)
        .where(and(eq(twoStepFactors.userId, userId), isNotNull(twoStepFactors.confirmedAt)));
}

/* Whether the account has the step on: exactly when it has a confirmed method. */
export async function stepIsOn(executor: Executor, userId: string) {
    return (await confirmedFactors(executor, userId)).length > 0;
}

/* The account's state row, made on first need: the handle and the salt are random and never change. */
export async function ensureState(executor: Executor, userId: string) {
    await executor
        .insert(twoStepState)
        .values({ userId, webauthnUserHandle: randomBytes(32), backupCodeSalt: randomBytes(16) })
        .onConflictDoNothing({ target: twoStepState.userId });
    const [state] = await executor
        .select()
        .from(twoStepState)
        .where(eq(twoStepState.userId, userId));
    if (!state) throw new Error('The two-step state could not be stored.');
    return state;
}

/* How many of the account's backup codes are unused. */
export async function unusedBackupCodes(executor: Executor, userId: string) {
    const [row] = await executor
        .select({ count: count() })
        .from(twoStepBackupCodes)
        .where(and(eq(twoStepBackupCodes.userId, userId), isNull(twoStepBackupCodes.usedAt)));
    return row?.count ?? 0;
}

/*
 * Moves a confirmed app's last accepted time step on, in one statement. The comparison is in
 * the update itself: only a step later than the last accepted one moves it. So a code is
 * accepted once however many requests carry it, and a code used once is refused for anything
 * after. The caller has checked the step is within the clock's reach (`totpStepInReach`).
 */
async function advanceTotpStep(
    executor: Executor,
    input: { userId: string; factorId: string; step: number },
) {
    if (!Number.isSafeInteger(input.step) || input.step <= 0) return false;
    const moved = await executor
        .update(twoStepFactors)
        .set({ totpLastStep: input.step, lastUsedAt: hourOf(new Date()) })
        .where(
            and(
                eq(twoStepFactors.id, input.factorId),
                eq(twoStepFactors.userId, input.userId),
                eq(twoStepFactors.kind, 'totp'),
                isNotNull(twoStepFactors.confirmedAt),
                sql`${twoStepFactors.totpLastStep} < ${input.step}`,
            ),
        )
        .returning({ id: twoStepFactors.id });
    return moved.length === 1;
}

/*
 * Marks one of the account's codes used, once: the update only touches an unused row. Answers
 * how many codes are left, or null when the code is unknown, already used, or another account's.
 */
async function useBackupCode(executor: Executor, input: { userId: string; codeHash: Buffer }) {
    const used = await executor
        .update(twoStepBackupCodes)
        .set({ usedAt: new Date() })
        .where(
            and(
                eq(twoStepBackupCodes.userId, input.userId),
                eq(twoStepBackupCodes.codeHash, input.codeHash),
                isNull(twoStepBackupCodes.usedAt),
            ),
        )
        .returning({ codeHash: twoStepBackupCodes.codeHash });
    if (used.length !== 1) return null;
    return { left: await unusedBackupCodes(executor, input.userId) };
}

/* ------------------------------------------------------------------------- */
/* Step tokens                                                                */
/* ------------------------------------------------------------------------- */

/* Whose count a wrong answer goes to: the device's, or the account's for sign-ins that proved none. */
export type StepPool = { kind: 'account' } | { kind: 'device'; deviceId: string };

export type StepAttempt = {
    tokenHash: Buffer;
    userId: string;
    purpose: TwoStepPurpose;
    sessionTokenHash: Buffer | null;
    credentialVersion: number;
    deviceId: string | null;
    previousTokenHash: Buffer | null;
    webauthnChallenge: Buffer | null;
    /* Answer slots taken so far, of five. */
    answers: number;
    /* Slots that turned out wrong. */
    failures: number;
    expiresAt: Date;
    pool: StepPool;
    /* Wrong answers in a row in that pool, as it stood when this was read. */
    poolFailures: number;
    /* The authenticator app is frozen for this token: its codes are refused unchecked. */
    totpFrozen: boolean;
};

/*
 * The token's row while it can still pass: not expired, made at the account's current
 * credential version (a password change since ends it), and with what it is bound to still
 * there. A step-up's session must be live and on a device that was not removed; a sign-in's
 * proven device must not have been removed since.
 */
export async function readAttempt(
    executor: Executor,
    tokenHash: Buffer,
): Promise<StepAttempt | null> {
    const now = new Date();
    const [row] = await executor
        .select({
            attempt: twoStepAttempts,
            frozenAt: twoStepState.totpFrozenAt,
            accountFailures: twoStepState.consecutiveFailures,
        })
        .from(twoStepAttempts)
        .innerJoin(
            opaqueCredentials,
            and(
                eq(opaqueCredentials.userId, twoStepAttempts.userId),
                eq(opaqueCredentials.version, twoStepAttempts.credentialVersion),
            ),
        )
        .leftJoin(twoStepState, eq(twoStepState.userId, twoStepAttempts.userId))
        .where(and(eq(twoStepAttempts.tokenHash, tokenHash), gt(twoStepAttempts.expiresAt, now)));
    if (!row) return null;
    const { createdAt: _createdAt, ...attempt } = row.attempt;
    let device: { id: string; failures: number } | undefined;
    if (attempt.sessionTokenHash) {
        [device] = await executor
            .select({ id: accountDevices.id, failures: accountDevices.twoStepFailures })
            .from(sessions)
            .innerJoin(
                accountDevices,
                and(
                    eq(accountDevices.id, sessions.deviceId),
                    eq(accountDevices.userId, sessions.userId),
                    isNull(accountDevices.revokedAt),
                ),
            )
            .where(
                and(
                    eq(sessions.tokenHash, attempt.sessionTokenHash),
                    eq(sessions.userId, attempt.userId),
                    eq(sessions.credentialVersion, attempt.credentialVersion),
                    gt(sessions.expiresAt, now),
                ),
            );
        if (!device) return null;
    } else if (attempt.deviceId) {
        [device] = await executor
            .select({ id: accountDevices.id, failures: accountDevices.twoStepFailures })
            .from(accountDevices)
            .where(
                and(
                    eq(accountDevices.id, attempt.deviceId),
                    eq(accountDevices.userId, attempt.userId),
                    isNull(accountDevices.revokedAt),
                ),
            );
        if (!device) return null;
    }
    const pool: StepPool = device ? { kind: 'device', deviceId: device.id } : { kind: 'account' };
    return {
        ...attempt,
        pool,
        poolFailures: device ? device.failures : (row.accountFailures ?? 0),
        totpFrozen: pool.kind === 'account' && row.frozenAt != null,
    };
}

export type StepFailure =
    | { status: 'gone' }
    | {
          status: 'counted';
          /* Answers the token still allows; 0 when it has ended. */
          left: number;
          tokenEnded: boolean;
          pool: StepPool['kind'];
          /* Wrong answers in a row in that pool, this one included. */
          consecutiveFailures: number;
          /* From the fifth in a row on: the caller's hourly budget decides which notices go out. */
          notice: boolean;
          /* This failure froze the authenticator app for sign-ins that prove no device. */
          froze: boolean;
      };

/*
 * Counts the wrong answer that was checked in a slot `takeStepAnswer` handed out, under the
 * account's lock:
 * - against the token, if it is still there: the fifth wrong answer deletes it;
 * - against the pool the slot was taken in, always, the device's own count or the account's
 *   for sign-ins that proved no device. The token may be gone by now (another slot's right
 *   answer used it, or it expired): the answer was still checked, so it still counts;
 * - at the hundredth in a row in the account's pool, the authenticator app is frozen for
 *   sign-ins that prove no device. A device's count freezes nothing here; it is served on
 *   the token (`poolFailures`) for the server to act on.
 * Every kind of wrong answer counts. A token whose slots all turned out to be counted
 * already (nothing was taken for this answer) is `gone`, and nothing is charged.
 */
export async function recordStepFailure(answer: StepAttempt): Promise<StepFailure> {
    return db.transaction(async (tx) => {
        if (!(await lockAccount(tx, answer.userId))) return { status: 'gone' };
        const [row] = await tx
            .select({ answers: twoStepAttempts.answers, failures: twoStepAttempts.failures })
            .from(twoStepAttempts)
            .where(
                and(
                    eq(twoStepAttempts.tokenHash, answer.tokenHash),
                    eq(twoStepAttempts.userId, answer.userId),
                ),
            );
        let left = 0;
        if (row) {
            if (row.failures >= row.answers) return { status: 'gone' };
            const failures = row.failures + 1;
            if (failures >= STEP_TOKEN_ANSWERS)
                await tx
                    .delete(twoStepAttempts)
                    .where(eq(twoStepAttempts.tokenHash, answer.tokenHash));
            else {
                await tx
                    .update(twoStepAttempts)
                    .set({ failures })
                    .where(eq(twoStepAttempts.tokenHash, answer.tokenHash));
                left = STEP_TOKEN_ANSWERS - row.answers;
            }
        }

        let consecutiveFailures = 0;
        let froze = false;
        if (answer.pool.kind === 'device') {
            const [device] = await tx
                .update(accountDevices)
                .set({ twoStepFailures: sql`${accountDevices.twoStepFailures} + 1` })
                .where(
                    and(
                        eq(accountDevices.id, answer.pool.deviceId),
                        eq(accountDevices.userId, answer.userId),
                    ),
                )
                .returning({ failures: accountDevices.twoStepFailures });
            consecutiveFailures = device?.failures ?? 0;
        } else {
            const state = await ensureState(tx, answer.userId);
            consecutiveFailures = state.consecutiveFailures + 1;
            // At or past the limit, not only on it: a freeze lifted from a known device comes
            // back with the next wrong answer here, so lifting it never hands out more guesses.
            froze =
                consecutiveFailures >= TOTP_FREEZE_FAILURES &&
                !state.totpFrozenAt &&
                (await confirmedFactors(tx, answer.userId)).some(({ kind }) => kind === 'totp');
            await tx
                .update(twoStepState)
                .set({ consecutiveFailures, ...(froze ? { totpFrozenAt: new Date() } : {}) })
                .where(eq(twoStepState.userId, answer.userId));
        }
        return {
            status: 'counted',
            left,
            tokenEnded: left === 0,
            pool: answer.pool.kind,
            consecutiveFailures,
            notice: consecutiveFailures >= STEP_NOTICE_FAILURES,
            froze,
        };
    });
}

/*
 * A step passed: the count of the pool it came from starts over, and a success with anything
 * but the authenticator app, from any device, lifts the app's freeze. The app's own code from
 * a known device does not: that is the frozen method. The account's count is reset only by a
 * success in the account's pool, so a freeze lifted from a device returns with the next wrong
 * answer there.
 */
async function recordSuccess(
    tx: Tx,
    input: { userId: string; pool: StepPool; method: TwoStepMethod },
) {
    if (input.pool.kind === 'device')
        await tx
            .update(accountDevices)
            .set({ twoStepFailures: 0 })
            .where(
                and(
                    eq(accountDevices.id, input.pool.deviceId),
                    eq(accountDevices.userId, input.userId),
                ),
            );
    else
        await tx
            .update(twoStepState)
            .set({ consecutiveFailures: 0 })
            .where(eq(twoStepState.userId, input.userId));
    if (input.method === 'totp') return;
    await tx
        .update(twoStepState)
        .set({ totpFrozenAt: null })
        .where(and(eq(twoStepState.userId, input.userId), isNotNull(twoStepState.totpFrozenAt)));
}

/* ------------------------------------------------------------------------- */
/* Passing the step                                                           */
/* ------------------------------------------------------------------------- */

/*
 * What a right answer uses up, once the server has checked it:
 * - `totp`: the time step the code was for, on the account's confirmed app;
 * - `backup`: the code's hash, as stored;
 * - `phrase`: nothing beyond the token, which the signature was made over.
 * A security key's assertion joins these with the security-key release.
 */
export type StepSpend =
    | { method: 'totp'; factorId: string; step: number }
    | { method: 'backup'; codeHash: Buffer }
    | { method: 'phrase' };
/* A step token, and what the answer that came with it spends. */
export type StepProof = { tokenHash: Buffer; spend: StepSpend };

/* Why a step did not pass, as a gated transaction throws it. */
type Refused =
    /* The account has the step on and the action came without a proof. */
    | { reason: 'required' }
    /* The token cannot pass: unknown, expired, for another purpose or session, or with no slot taken. */
    | { reason: 'gone' }
    /* The authenticator app is frozen for this token: refused unchecked, and not counted. */
    | { reason: 'frozen' }
    /* The time step is one no code could be for yet: a mistake above the repository, not counted. */
    | { reason: 'step' }
    /* The time step or backup code was already used: a wrong answer, counted as one. */
    | { reason: 'spent'; attempt: StepAttempt };

/*
 * What a gated function answers when the step did not pass, with nothing else done. A spent
 * answer has been counted by then, once, and `failure` is that count as `recordStepFailure`
 * answers it: its `notice` and `froze` are the caller's to act on. The caller must not report
 * the same answer again; a second report is answered `gone` while the token still stands.
 */
export type TwoStepRefusal =
    | { status: 'two-step'; reason: 'required' | 'gone' | 'frozen' | 'step' }
    | { status: 'two-step'; reason: 'spent'; failure: StepFailure };

/* Thrown inside a gated transaction, so everything it did so far rolls back with the refusal. */
export class StepRefused extends Error {
    constructor(readonly refused: Refused) {
        super(`The second step did not pass: ${refused.reason}.`);
        this.name = 'StepRefused';
    }
}

/*
 * For the `catch` around a gated transaction: the refusal an error carries, or null when the
 * error is something else and must be thrown on. A spent answer is counted as the wrong
 * answer it is, here, after the transaction that refused it has rolled back, and the count
 * goes back with the refusal.
 */
export async function settleRefusal(error: unknown): Promise<TwoStepRefusal | null> {
    if (!(error instanceof StepRefused)) return null;
    const { refused } = error;
    if (refused.reason !== 'spent') return { status: 'two-step', reason: refused.reason };
    return {
        status: 'two-step',
        reason: 'spent',
        failure: await recordStepFailure(refused.attempt),
    };
}

/*
 * Passes the step inside the caller's transaction, which holds the account's lock: the token
 * is read again, must be this account's, for this purpose and session, and must have an
 * answer slot taken and not yet counted (`takeStepAnswer`); a frozen app is refused, and so is
 * a time step out of the clock's reach, before anything is written; the time step or backup
 * code is spent; the token is deleted and the success recorded. Any refusal
 * is thrown (`StepRefused`), so the caller's transaction rolls back whole. What this wrote
 * commits only if the caller's action does.
 */
export async function passStep(
    tx: Tx,
    input: {
        userId: string;
        purpose: TwoStepPurpose;
        sessionTokenHash: Buffer | null;
        proof: StepProof;
    },
) {
    const { spend } = input.proof;
    const attempt = await readAttempt(tx, input.proof.tokenHash);
    const bound = attempt?.sessionTokenHash ?? null;
    if (
        !attempt ||
        attempt.userId !== input.userId ||
        attempt.purpose !== input.purpose ||
        (bound ? !input.sessionTokenHash?.equals(bound) : input.sessionTokenHash !== null) ||
        attempt.answers <= attempt.failures
    )
        throw new StepRefused({ reason: 'gone' });
    if (spend.method === 'totp' && attempt.totpFrozen) throw new StepRefused({ reason: 'frozen' });
    if (spend.method === 'totp' && !totpStepInReach(spend.step))
        throw new StepRefused({ reason: 'step' });

    let backupCodesLeft: number | null = null;
    if (spend.method === 'totp') {
        const moved = await advanceTotpStep(tx, {
            userId: attempt.userId,
            factorId: spend.factorId,
            step: spend.step,
        });
        if (!moved) throw new StepRefused({ reason: 'spent', attempt });
    } else if (spend.method === 'backup') {
        const used = await useBackupCode(tx, {
            userId: attempt.userId,
            codeHash: spend.codeHash,
        });
        if (!used) throw new StepRefused({ reason: 'spent', attempt });
        backupCodesLeft = used.left;
    }
    const gone = await tx
        .delete(twoStepAttempts)
        .where(eq(twoStepAttempts.tokenHash, attempt.tokenHash))
        .returning({ tokenHash: twoStepAttempts.tokenHash });
    if (gone.length !== 1) throw new StepRefused({ reason: 'gone' });
    await recordSuccess(tx, { userId: attempt.userId, pool: attempt.pool, method: spend.method });
    return { attempt, method: spend.method, backupCodesLeft };
}

/*
 * The step, where an action needs it only while the account has it on: nothing is asked of an
 * account without a confirmed method (null), and one with the step on must bring a proof
 * that passes. The caller holds the account's lock.
 */
export async function passStepIfOn(
    tx: Tx,
    input: {
        userId: string;
        purpose: TwoStepPurpose;
        sessionTokenHash: Buffer | null;
        proof: StepProof | undefined;
    },
) {
    if (!(await stepIsOn(tx, input.userId))) return null;
    if (!input.proof) throw new StepRefused({ reason: 'required' });
    return passStep(tx, { ...input, proof: input.proof });
}
