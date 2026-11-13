import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from './client';
import {
    accountDevices,
    opaqueCredentials,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepDeviceRequests,
    twoStepFactors,
    twoStepState,
    type TwoStepDefaultKind,
    type TwoStepFactorKind,
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
/* How long a line of the security log is kept (docs/two-step-design.md 7). */
export const SECURITY_EVENT_DAYS = 90;
/* How long a second-step method may wait to be confirmed (docs/two-step-design.md 2). */
export const PENDING_FACTOR_SECONDS = 10 * 60;
/* RFC 6238's time step, which the key URI fixes at 30 seconds. */
export const TOTP_PERIOD_SECONDS = 30;
/* How many passkeys and security keys one account may have (docs/two-step-design.md 3). */
export const WEBAUTHN_KEY_LIMIT = 10;

/*
 * The order the kinds of method are offered in (docs/two-step-design.md 12): the account's
 * default first, then passkey, authenticator app, another device. Only kinds the account has a
 * confirmed factor of are in it, so a default whose kind is gone is simply not there: the stored
 * choice is never read on its own. The first entry is the account's usual way.
 */
const KIND_ORDER: readonly TwoStepDefaultKind[] = ['webauthn', 'totp', 'device'];
export function kindOrder(
    confirmed: Iterable<TwoStepFactorKind | TwoStepDefaultKind>,
    defaultKind: TwoStepDefaultKind | null | undefined,
): TwoStepDefaultKind[] {
    const has = new Set<string>(confirmed);
    const order = defaultKind ? [defaultKind, ...KIND_ORDER] : KIND_ORDER;
    return [...new Set(order)].filter((kind) => has.has(kind));
}

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

/*
 * Keeps the account's usual way where it is when a method of another kind is added: an account
 * that never chose a default (its row is from before there was one, or an older container
 * confirmed its app) gets the kind it has been using written down first. `confirmed` is the
 * kinds it had before the new one. The caller holds the account's lock.
 */
export async function settleDefault(
    tx: Tx,
    userId: string,
    confirmed: Iterable<TwoStepFactorKind>,
    turnedOnWith?: TwoStepFactorKind,
) {
    const state = await ensureState(tx, userId);
    const next = turnedOnWith ?? state.defaultKind ?? kindOrder(confirmed, null)[0] ?? null;
    if (next !== state.defaultKind)
        await tx
            .update(twoStepState)
            .set({ defaultKind: next })
            .where(eq(twoStepState.userId, userId));
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
 * Moves a confirmed key's signature counter on, in one statement, by the specification's rule
 * (WebAuthn 6.1.1, docs/two-step-design.md 3): when either the stored counter or the new one
 * is non-zero, the new one must be greater. The comparison is in the update itself, so however
 * many assertions race, the counter only ever goes up, and a clone that answers with a counter
 * the real key has passed is refused. A stored 0 and a new 0 pass: a synced passkey reports 0
 * every time. Answers `counter` when the key is there and the rule refused it, `missing` when
 * the key is not this account's confirmed key (removed since the answer was checked).
 */
async function advanceSignCount(
    executor: Executor,
    input: { userId: string; factorId: string; signCount: number; backedUp: boolean },
): Promise<'ok' | 'counter' | 'missing'> {
    if (!Number.isSafeInteger(input.signCount) || input.signCount < 0) return 'counter';
    const key = and(
        eq(twoStepFactors.id, input.factorId),
        eq(twoStepFactors.userId, input.userId),
        eq(twoStepFactors.kind, 'webauthn'),
        isNotNull(twoStepFactors.confirmedAt),
    );
    const moved = await executor
        .update(twoStepFactors)
        .set({
            signCount: input.signCount,
            backupState: input.backedUp,
            lastUsedAt: hourOf(new Date()),
        })
        .where(
            and(
                key,
                input.signCount === 0
                    ? eq(twoStepFactors.signCount, 0)
                    : sql`${twoStepFactors.signCount} < ${input.signCount}`,
            ),
        )
        .returning({ id: twoStepFactors.id });
    if (moved.length === 1) return 'ok';
    const [there] = await executor
        .select({ id: twoStepFactors.id })
        .from(twoStepFactors)
        .where(key);
    return there ? 'counter' : 'missing';
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
 * One more wrong answer in a row in `pool`: the device's own count, or the account's for
 * sign-ins that proved no device. At the hundredth in a row in the account's pool the
 * authenticator app is frozen for those sign-ins. The caller holds the account's lock.
 */
export async function countPoolFailure(tx: Tx, userId: string, pool: StepPool) {
    let consecutiveFailures = 0;
    let froze = false;
    if (pool.kind === 'device') {
        const [device] = await tx
            .update(accountDevices)
            .set({ twoStepFailures: sql`${accountDevices.twoStepFailures} + 1` })
            .where(and(eq(accountDevices.id, pool.deviceId), eq(accountDevices.userId, userId)))
            .returning({ failures: accountDevices.twoStepFailures });
        consecutiveFailures = device?.failures ?? 0;
    } else {
        const state = await ensureState(tx, userId);
        consecutiveFailures = state.consecutiveFailures + 1;
        // At or past the limit, not only on it: a freeze lifted from a known device comes
        // back with the next wrong answer here, so lifting it never hands out more guesses.
        froze =
            consecutiveFailures >= TOTP_FREEZE_FAILURES &&
            !state.totpFrozenAt &&
            (await confirmedFactors(tx, userId)).some(({ kind }) => kind === 'totp');
        await tx
            .update(twoStepState)
            .set({ consecutiveFailures, ...(froze ? { totpFrozenAt: new Date() } : {}) })
            .where(eq(twoStepState.userId, userId));
    }
    return { consecutiveFailures, froze, notice: consecutiveFailures >= STEP_NOTICE_FAILURES };
}

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

        const { consecutiveFailures, froze } = await countPoolFailure(
            tx,
            answer.userId,
            answer.pool,
        );
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
 * Gives back the slot an answer took, when the answer could not be looked at for a reason of
 * the server's own (a key it no longer has): nothing was guessed, so nothing is used up. Only
 * a slot that is still open goes back; one already counted wrong stays counted.
 */
export async function returnStepAnswer(answer: StepAttempt) {
    await db.transaction(async (tx) => {
        if (!(await lockAccount(tx, answer.userId))) return;
        await tx
            .update(twoStepAttempts)
            .set({ answers: sql`${twoStepAttempts.answers} - 1` })
            .where(
                and(
                    eq(twoStepAttempts.tokenHash, answer.tokenHash),
                    eq(twoStepAttempts.userId, answer.userId),
                    sql`${twoStepAttempts.answers} > ${twoStepAttempts.failures}`,
                ),
            );
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
 * - `phrase`: nothing beyond the token, which the signature was made over;
 * - `webauthn`: the counter the key's assertion carried, on the account's confirmed key, and
 *   whether the key says it is backed up now (a passkey can start syncing later);
 * - `device`: the request another device approved, which must be this token's own.
 */
export type StepSpend =
    | { method: 'totp'; factorId: string; step: number }
    | { method: 'backup'; codeHash: Buffer }
    | { method: 'phrase' }
    | { method: 'webauthn'; factorId: string; signCount: number; backedUp: boolean }
    | { method: 'device'; requestId: string };
/* What spending an answer left behind: how many backup codes the account had left, when one was used. */
export type StepSpent = { backupCodesLeft: number | null };
/*
 * A step token, and what the answer that came with it spends. `spent` is told what the spend
 * left, inside the transaction and before the action it gates has run: the count of backup
 * codes left is read there and nowhere later, because the action may replace or delete the
 * set (new codes, the last method removed), and a count taken afterwards would be of another
 * set. The caller uses what it was told only once the transaction has committed.
 */
export type StepProof = {
    tokenHash: Buffer;
    spend: StepSpend;
    spent?: (left: StepSpent) => void;
};

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
    /*
     * The time step or backup code was already used, or the key's counter did not go up
     * (`counter`): a wrong answer, counted as one.
     */
    | { reason: 'spent'; attempt: StepAttempt; counter?: boolean };

/*
 * What a gated function answers when the step did not pass, with nothing else done. A spent
 * answer has been counted by then, once, and `failure` is that count as `recordStepFailure`
 * answers it: its `notice` and `froze` are the caller's to act on. The caller must not report
 * the same answer again; a second report is answered `gone` while the token still stands.
 */
export type TwoStepRefusal =
    | { status: 'two-step'; reason: 'required' | 'gone' | 'frozen' | 'step' }
    /* `counter`: a key's counter did not go up, which can mean the key was copied. */
    | { status: 'two-step'; reason: 'spent'; failure: StepFailure; counter?: boolean };

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
        ...(refused.counter ? { counter: true } : {}),
    };
}

/*
 * Passes the step inside the caller's transaction, which holds the account's lock: the token
 * is read again, must be this account's, for this purpose and session, and must have an
 * answer slot taken and not yet counted (`takeStepAnswer`); a frozen app is refused, and so is
 * a time step out of the clock's reach, before anything is written; the time step or backup
 * code is spent, or the key's counter moved on; the token is deleted and the success recorded. Any refusal
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
    } else if (spend.method === 'webauthn') {
        const moved = await advanceSignCount(tx, {
            userId: attempt.userId,
            factorId: spend.factorId,
            signCount: spend.signCount,
            backedUp: spend.backedUp,
        });
        if (moved !== 'ok')
            throw new StepRefused({ reason: 'spent', attempt, counter: moved === 'counter' });
    }
    let approverDeviceId: string | null = null;
    if (spend.method === 'device') {
        approverDeviceId = await useDeviceApproval(tx, attempt, spend.requestId);
        if (!approverDeviceId) throw new StepRefused({ reason: 'gone' });
    }
    const gone = await tx
        .delete(twoStepAttempts)
        .where(eq(twoStepAttempts.tokenHash, attempt.tokenHash))
        .returning({ tokenHash: twoStepAttempts.tokenHash });
    if (gone.length !== 1) throw new StepRefused({ reason: 'gone' });
    // The token is used: a request to approve on another device that it still had open ends with
    // it, and is not a failed step. The person passed another way.
    await endDeviceRequests(tx, {
        userId: attempt.userId,
        tokenHash: attempt.tokenHash,
        reason: 'passed',
    });
    await recordSuccess(tx, { userId: attempt.userId, pool: attempt.pool, method: spend.method });
    input.proof.spent?.({ backupCodesLeft });
    return { attempt, method: spend.method, backupCodesLeft, approverDeviceId };
}

/* ------------------------------------------------------------------------- */
/* Approving on another device                                                */
/* ------------------------------------------------------------------------- */

/* A step-up is approved only between devices that have been on the account this long (design 12). */
export const STEP_UP_DEVICE_SECONDS = 7 * 24 * 60 * 60;

/* Whether a purpose is a step-up that both devices must be seven days old for. */
export const agedPurpose = (purpose: TwoStepPurpose) =>
    purpose !== 'login' && purpose !== 'enrol' && purpose !== 'device-approval';

/*
 * The account's devices that may approve a request for `purpose` (docs/two-step-design.md 12):
 * not removed, approved, holding a device key, and with a live session on the account's current
 * credential that passed the step. Never `exceptDeviceId`, the device asking. For a step-up, only
 * a device approved on the account at least seven days ago.
 *
 * `bootstrap`: the account has no confirmed method yet, so no session has passed the step; for
 * the one approval that turns the method on, a live session with a device key is enough.
 */
export async function approvingDevices(
    executor: Executor,
    input: {
        userId: string;
        purpose: TwoStepPurpose;
        exceptDeviceId: string | null;
        bootstrap: boolean;
        onlyDeviceId?: string;
    },
) {
    const now = new Date();
    const aged = new Date(now.getTime() - STEP_UP_DEVICE_SECONDS * 1000);
    const rows = await executor
        .selectDistinct({ id: accountDevices.id })
        .from(accountDevices)
        .innerJoin(
            sessions,
            and(
                eq(sessions.deviceId, accountDevices.id),
                eq(sessions.userId, accountDevices.userId),
                gt(sessions.expiresAt, now),
                input.bootstrap ? undefined : isNotNull(sessions.twoStepAt),
            ),
        )
        .innerJoin(
            opaqueCredentials,
            and(
                eq(opaqueCredentials.userId, sessions.userId),
                eq(opaqueCredentials.version, sessions.credentialVersion),
            ),
        )
        .where(
            and(
                eq(accountDevices.userId, input.userId),
                isNull(accountDevices.revokedAt),
                isNotNull(accountDevices.approvedAt),
                isNotNull(accountDevices.signingPublicKey),
                input.exceptDeviceId ? ne(accountDevices.id, input.exceptDeviceId) : undefined,
                input.onlyDeviceId ? eq(accountDevices.id, input.onlyDeviceId) : undefined,
                agedPurpose(input.purpose)
                    ? sql`${accountDevices.approvedAt} <= ${aged}`
                    : undefined,
            ),
        );
    return rows.map((row) => row.id);
}

/*
 * Ends the account's requests that are still open, or one token's: nothing more can approve
 * them. A request that was replaced by a newer one while its token lived ends with the token
 * too, so it is never counted as left unanswered when the person passed another way.
 */
export async function endDeviceRequests(
    tx: Tx,
    input: { userId: string; tokenHash?: Buffer; reason: 'passed' | 'off' },
) {
    await tx
        .update(twoStepDeviceRequests)
        .set({ state: 'ended', endedReason: input.reason, endedAt: new Date() })
        .where(
            and(
                eq(twoStepDeviceRequests.userId, input.userId),
                input.tokenHash ? eq(twoStepDeviceRequests.tokenHash, input.tokenHash) : undefined,
                eq(twoStepDeviceRequests.counted, false),
                or(
                    ne(twoStepDeviceRequests.state, 'ended'),
                    eq(twoStepDeviceRequests.endedReason, 'replaced'),
                ),
            ),
        );
}

/*
 * Spends another device's approval for the token being passed, under the account's lock: the
 * request must be this account's, made for this very token and purpose, and approved; the
 * device that approved it must still be one that may (not removed since, its session still
 * live); and the account must still have the method. The request ends as used, so an approval
 * passes one token once. Answers the approving device, or null when any of that does not hold.
 */
async function useDeviceApproval(tx: Tx, attempt: StepAttempt, requestId: string) {
    const [request] = await tx
        .select({
            id: twoStepDeviceRequests.id,
            approverDeviceId: twoStepDeviceRequests.approverDeviceId,
            deviceId: twoStepDeviceRequests.deviceId,
        })
        .from(twoStepDeviceRequests)
        .where(
            and(
                eq(twoStepDeviceRequests.id, requestId),
                eq(twoStepDeviceRequests.userId, attempt.userId),
                eq(twoStepDeviceRequests.tokenHash, attempt.tokenHash),
                eq(twoStepDeviceRequests.purpose, attempt.purpose),
                eq(twoStepDeviceRequests.state, 'approved'),
                gt(twoStepDeviceRequests.expiresAt, new Date()),
            ),
        )
        .for('update');
    if (!request?.approverDeviceId) return null;
    const asking = attempt.pool.kind === 'device' ? attempt.pool.deviceId : null;
    // The device the token names now must be the one the request was made for, and never the approver.
    if (request.deviceId !== asking || request.approverDeviceId === asking) return null;
    const [approver] = await approvingDevices(tx, {
        userId: attempt.userId,
        purpose: attempt.purpose,
        exceptDeviceId: asking,
        bootstrap: false,
        onlyDeviceId: request.approverDeviceId,
    });
    if (!approver) return null;
    const used = await tx
        .update(twoStepFactors)
        .set({ lastUsedAt: hourOf(new Date()) })
        .where(
            and(
                eq(twoStepFactors.userId, attempt.userId),
                eq(twoStepFactors.kind, 'device'),
                isNotNull(twoStepFactors.confirmedAt),
            ),
        )
        .returning({ id: twoStepFactors.id });
    if (used.length !== 1) return null;
    await tx
        .update(twoStepDeviceRequests)
        .set({ state: 'ended', endedReason: 'used', endedAt: new Date() })
        .where(eq(twoStepDeviceRequests.id, request.id));
    return approver;
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
