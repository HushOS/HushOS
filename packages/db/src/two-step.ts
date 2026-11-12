import { and, asc, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from './client';
import {
    accountDevices,
    accountSecurityEvents,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepFactors,
    twoStepState,
    type accountKeys,
    type TwoStepFactorKind,
    type TwoStepMethod,
    type TwoStepPurpose,
    type TwoStepSessionPurpose,
} from './schema';
import {
    lockAccount,
    lockSignIn,
    provenDevice,
    returningDevice,
    sessionIsCurrent,
    writeSession,
    type DeviceProof,
    type Tx,
} from './sessions';
import {
    BACKUP_CODE_COUNT,
    PENDING_FACTOR_SECONDS,
    SECURITY_EVENT_DAYS,
    STEP_TOKEN_ANSWERS,
    confirmedFactors,
    ensureState,
    hourOf,
    passStep,
    passStepIfOn,
    readAttempt,
    settleRefusal,
    stepIsOn,
    totpStepInReach,
    unusedBackupCodes,
    type StepAttempt,
    type StepFailure,
    type StepProof,
    type StepSpend,
    type TwoStepRefusal,
} from './two-step.core';

/*
 * Two-step sign-in, the rows (docs/two-step-design.md). The step is a server rule, and this is
 * where its state lives: the methods, the backup codes, the step tokens and the counts of wrong
 * answers. Nothing here checks a code or opens a secret: the server computes TOTP codes and
 * hashes backup codes under the two-step key, and hands this repository only sealed bytes,
 * hashes and time steps. What this repository guarantees is what must hold whatever the server
 * does around it:
 * - a time step or a backup code is accepted once, however many requests race;
 * - a token allows five answers, each taken before it is checked, and passes once;
 * - what a right answer spends and what it authorises commit together or not at all: each
 *   gated action is one function here (`openSteppedSession`, `removeFactor`,
 *   `replaceBackupCodes`, `startTotpFactor`) or in the auth repository
 *   (`changeAccountSecurity`, `deleteAccount`), and there is no other way to spend a step;
 * - a pending method never counts, and nothing reaches another account's rows.
 * Every write that changes an account's step takes the account's row lock first.
 *
 * How the server answers a step (docs/two-step-design.md 2, 4), in this order:
 * 1. `takeStepAnswer` takes one of the token's five slots, before anything is checked.
 * 2. For a code (authenticator or backup): `consumeRateLimit` on the pool's 15-minute bucket,
 *    before checking. That budget is charged up front and handed back on success, so
 *    requests racing a nearly spent budget cannot all be checked.
 * 3. Check the answer.
 * 4. Wrong: `recordStepFailure` with what step 1 returned. The bucket stays charged.
 * 5. Right: the gated function, with the token and what the answer spends; then
 *    `releaseRateLimit` on the bucket. If the gated function answers that the code was
 *    already spent (`reason: 'spent'`), it has counted the wrong answer itself, once, and
 *    hands back that count (`failure`, with its `notice` and `froze`): the caller acts on
 *    it, leaves the bucket charged, and does not call `recordStepFailure` for it again.
 */

export {
    BACKUP_CODE_COUNT,
    PENDING_FACTOR_SECONDS,
    SECURITY_EVENT_DAYS,
    STEP_NOTICE_FAILURES,
    STEP_TOKEN_ANSWERS,
    TOTP_FREEZE_FAILURES,
    recordStepFailure,
} from './two-step.core';
export type {
    StepAttempt,
    StepFailure,
    StepPool,
    StepProof,
    StepSpend,
    TwoStepRefusal,
} from './two-step.core';
export { TWO_STEP_REMEMBER_SECONDS } from './sessions';

/* A step-up's proof: the session asking, its step token, and what the answer spends. */
export type SessionStep = StepProof & { sessionTokenHash: Buffer };

/*
 * Runs a gated transaction. A step that did not pass rolls the whole transaction back and is
 * answered as `two-step` with its reason; a spent code is counted as a wrong answer on the
 * way out, and that count is in the answer.
 */
async function gated<T>(run: (tx: Tx) => Promise<T>): Promise<T | TwoStepRefusal> {
    try {
        return await db.transaction(run);
    } catch (error) {
        const refusal = await settleRefusal(error);
        if (!refusal) throw error;
        return refusal;
    }
}

/* ------------------------------------------------------------------------- */
/* Status                                                                     */
/* ------------------------------------------------------------------------- */

/* Whether the account has the step on: exactly when it has a confirmed method. */
export async function hasTwoStep(userId: string) {
    return stepIsOn(db, userId);
}

/*
 * The account's step as its settings show it: the confirmed methods, oldest first, how many
 * backup codes are left, and whether the authenticator app is frozen for new devices. Never a
 * secret, a public key or a credential id.
 */
export async function getTwoStep(userId: string) {
    const methods = await db
        .select({
            id: twoStepFactors.id,
            kind: twoStepFactors.kind,
            name: twoStepFactors.name,
            createdAt: twoStepFactors.createdAt,
            lastUsedAt: twoStepFactors.lastUsedAt,
            synced: twoStepFactors.backupState,
        })
        .from(twoStepFactors)
        .where(and(eq(twoStepFactors.userId, userId), isNotNull(twoStepFactors.confirmedAt)))
        .orderBy(asc(twoStepFactors.createdAt), asc(twoStepFactors.id));
    const [state] = await db
        .select({ totpFrozenAt: twoStepState.totpFrozenAt })
        .from(twoStepState)
        .where(eq(twoStepState.userId, userId));
    return {
        on: methods.length > 0,
        methods: methods.map((method) => ({ ...method, synced: method.synced === true })),
        backupCodesLeft: await unusedBackupCodes(db, userId),
        totpFrozen: Boolean(state?.totpFrozenAt),
    };
}

/*
 * The account's WebAuthn user handle and backup-code salt, made at random on the first call
 * and the same ever after. The server needs the salt before it can hash a set of codes.
 */
export async function ensureTwoStepState(userId: string) {
    const state = await ensureState(db, userId);
    return { webauthnUserHandle: state.webauthnUserHandle, backupCodeSalt: state.backupCodeSalt };
}

/* ------------------------------------------------------------------------- */
/* Authenticator apps                                                         */
/* ------------------------------------------------------------------------- */

const totpFields = {
    id: twoStepFactors.id,
    keyId: twoStepFactors.totpKeyId,
    nonce: twoStepFactors.totpNonce,
    sealedSecret: twoStepFactors.totpSecret,
    lastStep: twoStepFactors.totpLastStep,
};
type TotpRow = {
    id: string;
    keyId: Buffer | null;
    nonce: Buffer | null;
    sealedSecret: Buffer | null;
    lastStep: number | null;
};
/* A TOTP row's columns, which the table's check keeps present on every `totp` row. */
function totpOf(row: TotpRow | undefined) {
    if (!row || !row.keyId || !row.nonce || !row.sealedSecret || row.lastStep === null) return null;
    return {
        id: row.id,
        keyId: row.keyId,
        nonce: row.nonce,
        sealedSecret: row.sealedSecret,
        lastStep: row.lastStep,
    };
}

export type StartTotpResult =
    | { status: 'ok'; id: string; expiresAt: Date }
    | { status: 'missing' }
    | TwoStepRefusal;

/*
 * Starts enrolling an authenticator app: a pending factor holding the sealed secret, good for
 * ten minutes. The caller makes the id first, because the seal's associated data names it. An
 * account has one pending app at a time; starting again drops the earlier one, and never
 * touches a confirmed app. While the account has the step on, adding a method needs the step
 * (`step`, a token for `two-step` from the session asking): without one that passes, nothing
 * is stored. `missing` when the account is gone.
 */
export async function startTotpFactor(input: {
    id: string;
    userId: string;
    keyId: Buffer;
    nonce: Buffer;
    sealedSecret: Buffer;
    step?: SessionStep;
}): Promise<StartTotpResult> {
    return gated<StartTotpResult>(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return { status: 'missing' };
        await passStepIfOn(tx, {
            userId: input.userId,
            purpose: 'two-step',
            sessionTokenHash: input.step?.sessionTokenHash ?? null,
            proof: input.step,
        });
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
            createdAt: now,
            totpKeyId: input.keyId,
            totpNonce: input.nonce,
            totpSecret: input.sealedSecret,
            totpLastStep: 0,
        });
        return {
            status: 'ok',
            id: input.id,
            expiresAt: new Date(now.getTime() + PENDING_FACTOR_SECONDS * 1000),
        };
    });
}

/* The account's pending app, while its ten minutes last: what the confirming code is checked against. */
export async function getPendingTotpFactor(input: { userId: string; factorId: string }) {
    const cutoff = new Date(Date.now() - PENDING_FACTOR_SECONDS * 1000);
    const [row] = await db
        .select(totpFields)
        .from(twoStepFactors)
        .where(
            and(
                eq(twoStepFactors.id, input.factorId),
                eq(twoStepFactors.userId, input.userId),
                eq(twoStepFactors.kind, 'totp'),
                isNull(twoStepFactors.confirmedAt),
                gt(twoStepFactors.createdAt, cutoff),
            ),
        );
    return totpOf(row);
}

/* The account's confirmed app: what a code is checked against. A pending app is never served here. */
export async function getTotpFactor(userId: string) {
    const [row] = await db
        .select(totpFields)
        .from(twoStepFactors)
        .where(
            and(
                eq(twoStepFactors.userId, userId),
                eq(twoStepFactors.kind, 'totp'),
                isNotNull(twoStepFactors.confirmedAt),
            ),
        );
    return totpOf(row);
}

export type BackupCodeSet = { keyId: Buffer; hashes: Buffer[] };

function checkedSet(set: BackupCodeSet) {
    const distinct = new Set(set.hashes.map((hash) => hash.toString('hex')));
    if (set.hashes.length !== BACKUP_CODE_COUNT || distinct.size !== BACKUP_CODE_COUNT)
        throw new Error(`A set of backup codes is ${BACKUP_CODE_COUNT} different hashes.`);
    return set;
}

/* Replaces the account's codes with `set`: the old ones, used or not, go in the same transaction. */
async function writeBackupCodes(tx: Tx, userId: string, set: BackupCodeSet) {
    await ensureState(tx, userId);
    await tx.delete(twoStepBackupCodes).where(eq(twoStepBackupCodes.userId, userId));
    const createdAt = new Date();
    await tx
        .insert(twoStepBackupCodes)
        .values(set.hashes.map((codeHash) => ({ userId, codeHash, keyId: set.keyId, createdAt })));
}

export type ConfirmTotpResult =
    /* `turnedOn`: this was the account's first method, so the step is now on and the codes were stored. */
    | { status: 'ok'; turnedOn: boolean; replaced: boolean }
    | { status: 'session' | 'missing' | 'codes-required' | 'step' };

/*
 * Confirms a pending app, once the server has checked a current code against its secret.
 * `step` is the time step that code was for: it becomes the app's last used step, so the same
 * code cannot sign in afterwards. A step later than the one after the current step is
 * refused (`step`): stored, it would lock the app out until the clock caught up. The clock
 * is this process's, the one the server's window comes from. Under the
 * account's lock:
 * - the session asking must be the account's own, live and on its current credential;
 * - the factor must be this account's, pending, and younger than ten minutes;
 * - a confirmed app the account already has is deleted in the same transaction (one app per
 *   account), and with it that app's freeze; nothing else about the step changes;
 * - the account's first method turns the step on. That needs `backupCodes` (`codes-required`
 *   without them, with nothing changed), stores them, stamps the session that enrolled as
 *   having passed the step, and deletes every other pending method of the account: one
 *   started while the step was off could otherwise be confirmed later without the step. A
 *   set passed when the step is already on is ignored.
 * Once the step is on, a pending app exists only because `startTotpFactor` passed the step.
 */
export async function confirmTotpFactor(input: {
    userId: string;
    factorId: string;
    step: number;
    sessionTokenHash: Buffer;
    credentialVersion: number;
    backupCodes?: BackupCodeSet;
}): Promise<ConfirmTotpResult> {
    if (!Number.isSafeInteger(input.step) || input.step <= 0) return { status: 'step' };
    const codes = input.backupCodes ? checkedSet(input.backupCodes) : null;
    return db.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId)) || !(await sessionIsCurrent(tx, input)))
            return { status: 'session' };
        const now = new Date();
        const cutoff = new Date(now.getTime() - PENDING_FACTOR_SECONDS * 1000);
        const [pending] = await tx
            .select({ id: twoStepFactors.id })
            .from(twoStepFactors)
            .where(
                and(
                    eq(twoStepFactors.id, input.factorId),
                    eq(twoStepFactors.userId, input.userId),
                    eq(twoStepFactors.kind, 'totp'),
                    isNull(twoStepFactors.confirmedAt),
                    gt(twoStepFactors.createdAt, cutoff),
                ),
            )
            .for('update');
        if (!pending) return { status: 'missing' };
        // Asked before anything is written, so a refused step leaves a replaced app in place.
        if (!totpStepInReach(input.step)) return { status: 'step' };
        const confirmed = await confirmedFactors(tx, input.userId);
        const turnedOn = confirmed.length === 0;
        if (turnedOn && !codes) return { status: 'codes-required' };
        const replaced = confirmed.some((factor) => factor.kind === 'totp');
        if (replaced) {
            await tx
                .delete(twoStepFactors)
                .where(
                    and(
                        eq(twoStepFactors.userId, input.userId),
                        eq(twoStepFactors.kind, 'totp'),
                        isNotNull(twoStepFactors.confirmedAt),
                    ),
                );
            // The freeze was the old app's; the new secret starts without it, as after a removal.
            await tx
                .update(twoStepState)
                .set({ totpFrozenAt: null })
                .where(eq(twoStepState.userId, input.userId));
        }
        await tx
            .update(twoStepFactors)
            .set({ confirmedAt: now, totpLastStep: input.step, lastUsedAt: hourOf(now) })
            .where(eq(twoStepFactors.id, pending.id));
        if (turnedOn && codes) {
            await writeBackupCodes(tx, input.userId, codes);
            // A fresh start: counts from an earlier time the step was on mean nothing now.
            await tx
                .update(twoStepState)
                .set({ consecutiveFailures: 0, totpFrozenAt: null })
                .where(eq(twoStepState.userId, input.userId));
            await tx
                .delete(twoStepFactors)
                .where(
                    and(
                        eq(twoStepFactors.userId, input.userId),
                        isNull(twoStepFactors.confirmedAt),
                        ne(twoStepFactors.id, pending.id),
                    ),
                );
            await tx
                .update(sessions)
                .set({ twoStepAt: sql`coalesce(${sessions.twoStepAt}, ${now})` })
                .where(
                    and(
                        eq(sessions.tokenHash, input.sessionTokenHash),
                        eq(sessions.userId, input.userId),
                    ),
                );
        }
        return { status: 'ok', turnedOn, replaced };
    });
}

export type RemoveFactorResult =
    /* `turnedOff`: it was the last method, so the step is off and its codes, tokens and counts are gone. */
    | { status: 'ok'; kind: TwoStepFactorKind; turnedOff: boolean }
    | { status: 'missing' }
    | TwoStepRefusal;

/*
 * Removes one of the account's methods. A confirmed one needs the step (`step`, a token for
 * `two-step` from the session asking), passed by any method, the one being removed included:
 * what the answer spends and the removal commit together. A pending one is the person's own
 * unfinished enrolment and needs none. Removing the last confirmed method turns the step off:
 * the backup codes and every step token of the account are deleted, its counts start over,
 * and its sessions lose their stamp.
 * Removing the app while other methods stay lifts its freeze, which has nothing left to freeze.
 */
export async function removeFactor(input: {
    userId: string;
    factorId: string;
    step?: SessionStep;
}): Promise<RemoveFactorResult> {
    return gated<RemoveFactorResult>(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return { status: 'missing' };
        const [factor] = await tx
            .select({ kind: twoStepFactors.kind, confirmedAt: twoStepFactors.confirmedAt })
            .from(twoStepFactors)
            .where(
                and(eq(twoStepFactors.id, input.factorId), eq(twoStepFactors.userId, input.userId)),
            )
            .for('update');
        if (!factor) return { status: 'missing' };
        if (factor.confirmedAt)
            await passStepIfOn(tx, {
                userId: input.userId,
                purpose: 'two-step',
                sessionTokenHash: input.step?.sessionTokenHash ?? null,
                proof: input.step,
            });
        await tx.delete(twoStepFactors).where(eq(twoStepFactors.id, input.factorId));
        if (!factor.confirmedAt) return { status: 'ok', kind: factor.kind, turnedOff: false };
        const turnedOff = !(await stepIsOn(tx, input.userId));
        if (turnedOff) {
            await tx.delete(twoStepAttempts).where(eq(twoStepAttempts.userId, input.userId));
            await tx.delete(twoStepBackupCodes).where(eq(twoStepBackupCodes.userId, input.userId));
            await tx
                .update(accountDevices)
                .set({ twoStepFailures: 0 })
                .where(eq(accountDevices.userId, input.userId));
            // No session keeps its stamp past the step it was for: turned on again later, the
            // step is asked of every device, not waved through on a stamp from the old one.
            await tx
                .update(sessions)
                .set({ twoStepAt: null })
                .where(and(eq(sessions.userId, input.userId), isNotNull(sessions.twoStepAt)));
        }
        if (turnedOff || factor.kind === 'totp')
            await tx
                .update(twoStepState)
                .set({
                    totpFrozenAt: null,
                    ...(turnedOff ? { consecutiveFailures: 0 } : {}),
                })
                .where(eq(twoStepState.userId, input.userId));
        return { status: 'ok', kind: factor.kind, turnedOff };
    });
}

/* ------------------------------------------------------------------------- */
/* Backup codes                                                               */
/* ------------------------------------------------------------------------- */

/* How many of the account's backup codes are unused. */
export async function countBackupCodes(userId: string) {
    return unusedBackupCodes(db, userId);
}

/*
 * A new set of codes, which replaces the old one whole. Only while the step is on (`off`
 * otherwise: a set for an account without a method would be a way in that nothing asks for),
 * and only with the step (`step`, a token for `two-step` from the session asking): what the
 * answer spends and the new set commit together.
 */
export async function replaceBackupCodes(
    input: { userId: string; step?: SessionStep } & BackupCodeSet,
): Promise<{ status: 'ok' | 'off' } | TwoStepRefusal> {
    const codes = checkedSet(input);
    return gated<{ status: 'ok' | 'off' }>(async (tx) => {
        if (!(await lockAccount(tx, input.userId)) || !(await stepIsOn(tx, input.userId)))
            return { status: 'off' };
        await passStepIfOn(tx, {
            userId: input.userId,
            purpose: 'two-step',
            sessionTokenHash: input.step?.sessionTokenHash ?? null,
            proof: input.step,
        });
        await writeBackupCodes(tx, input.userId, codes);
        return { status: 'ok' };
    });
}

/*
 * What a typed backup code is checked against: the account's salt, and its unused codes with
 * the key each was hashed under. Null for an account that has no state yet: its salt is made
 * the first time it is needed.
 */
export async function getBackupCodes(userId: string) {
    const [state] = await db
        .select({ salt: twoStepState.backupCodeSalt })
        .from(twoStepState)
        .where(eq(twoStepState.userId, userId));
    if (!state) return null;
    const codes = await db
        .select({ codeHash: twoStepBackupCodes.codeHash, keyId: twoStepBackupCodes.keyId })
        .from(twoStepBackupCodes)
        .where(and(eq(twoStepBackupCodes.userId, userId), isNull(twoStepBackupCodes.usedAt)));
    return { salt: state.salt, codes };
}

/* ------------------------------------------------------------------------- */
/* Step tokens                                                                */
/* ------------------------------------------------------------------------- */

export type StepAttemptInput = {
    tokenHash: Buffer;
    userId: string;
    credentialVersion: number;
    webauthnChallenge?: Buffer | null;
    expiresAt: Date;
} & (
    | {
          /* `enrol`: a member a policy requires the step of, who has no method yet. */
          purpose: 'login' | 'enrol';
          /* The device key's proof `login/finish` was sent, if any: checked here, not trusted. */
          device?: DeviceProof | null;
          /* The browser's previous session, for the session this step will open. */
          previousTokenHash: Buffer | null;
      }
    | { purpose: TwoStepSessionPurpose; sessionTokenHash: Buffer }
);

/*
 * Stores a step token. A sign-in's device proof is verified here, under the account's lock,
 * by the check `createSession` makes: the device is kept only when it is this account's own,
 * approved, keyed and not removed, and the signature is its key's over this sign-in. Anything
 * else is stored as no device, so a forged proof or another account's device falls into the
 * account's shared count and budget (docs/two-step-design.md 2), never into a device's. The
 * session the step opens later attaches to the device stored here. Answers that device, or
 * null when the account is gone.
 */
export async function createStepAttempt(input: StepAttemptInput) {
    return db.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return null;
        const opening = input.purpose === 'login' || input.purpose === 'enrol' ? input : null;
        const deviceId = opening ? await provenDevice(tx, input.userId, opening.device) : null;
        await tx.insert(twoStepAttempts).values({
            tokenHash: input.tokenHash,
            userId: input.userId,
            purpose: input.purpose,
            sessionTokenHash: 'sessionTokenHash' in input ? input.sessionTokenHash : null,
            credentialVersion: input.credentialVersion,
            deviceId,
            previousTokenHash: opening?.previousTokenHash ?? null,
            webauthnChallenge: input.webauthnChallenge ?? null,
            expiresAt: input.expiresAt,
        });
        return { deviceId };
    });
}

/* The token's row, or null once it can no longer pass. Reading takes no slot and spends nothing. */
export async function getStepAttempt(tokenHash: Buffer) {
    return readAttempt(db, tokenHash);
}

export type StepAnswer =
    /* `left`: slots the token still has after this one. */
    { status: 'ok'; attempt: StepAttempt; left: number } | { status: 'gone' | 'frozen' };

/*
 * Takes one of the token's five answer slots, under the account's lock, before the answer is
 * checked. However many requests arrive at once for one token, five get a slot and only those
 * are checked: the rest are `gone` without a look at what they sent. The caller then checks
 * the answer and either reports it wrong (`recordStepFailure`, with the attempt answered
 * here) or passes it to the gated function, which uses the token up. A right answer in the
 * fifth slot still passes: taking the last slot does not end the token, five wrong answers do.
 *
 * The token must be for `purpose` and bound to `sessionTokenHash` (null for a sign-in); one
 * that is not is `gone` and keeps its slots. An authenticator code for a token the app is
 * frozen for is `frozen`, unchecked, and takes no slot either.
 */
export async function takeStepAnswer(input: {
    tokenHash: Buffer;
    purpose: TwoStepPurpose;
    sessionTokenHash: Buffer | null;
    method: TwoStepMethod;
}): Promise<StepAnswer> {
    return db.transaction(async (tx) => {
        const [seen] = await tx
            .select({ userId: twoStepAttempts.userId })
            .from(twoStepAttempts)
            .where(eq(twoStepAttempts.tokenHash, input.tokenHash));
        if (!seen || !(await lockAccount(tx, seen.userId))) return { status: 'gone' };
        // Read under the lock: the slots are counted here and nowhere else.
        const attempt = await readAttempt(tx, input.tokenHash);
        const bound = attempt?.sessionTokenHash ?? null;
        if (
            !attempt ||
            attempt.purpose !== input.purpose ||
            (bound ? !input.sessionTokenHash?.equals(bound) : input.sessionTokenHash !== null) ||
            attempt.answers >= STEP_TOKEN_ANSWERS
        )
            return { status: 'gone' };
        if (input.method === 'totp' && attempt.totpFrozen) return { status: 'frozen' };
        const answers = attempt.answers + 1;
        await tx
            .update(twoStepAttempts)
            .set({ answers })
            .where(eq(twoStepAttempts.tokenHash, input.tokenHash));
        return {
            status: 'ok',
            attempt: { ...attempt, answers },
            left: STEP_TOKEN_ANSWERS - answers,
        };
    });
}

export type SteppedSession =
    | {
          status: 'ok';
          user: { id: string; name: string; email: string; role: 'member' | 'admin' };
          key: typeof accountKeys.$inferSelect;
          device: Awaited<ReturnType<typeof writeSession>>;
          method: StepSpend['method'];
          /* How many backup codes are left, when one was just used. */
          backupCodesLeft: number | null;
      }
    /*
     * `gone`: the token cannot pass. `frozen`: the app is frozen for it. `step`: the time step
     * is one no code could be for yet. None of the three is counted.
     */
    | { status: 'gone' | 'frozen' | 'step' | 'suspended' }
    /* The code was already used. It was counted as a wrong answer, once: `failure` is that count. */
    | { status: 'spent'; failure: StepFailure };

/*
 * Opens the session a sign-in's step token was made for, once the server has checked the
 * answer that came with it. One transaction under the account's lock: the token is read
 * again and must have an answer slot taken; a frozen app is refused; the time step or backup
 * code is spent; the token is deleted and the success recorded; and the session is written,
 * stamped as having passed the step now, on the device the token names (the one whose key
 * proof was verified when the token was made, else the one the browser's previous session
 * lends, else a new one). If any of it fails, none of it happened: a code is never spent on
 * a sign-in that got no session. Answers what `createSession` does: the user, the password
 * envelope and the device.
 */
export async function openSteppedSession(input: {
    tokenHash: Buffer;
    spend: StepSpend;
    session: { tokenHash: Buffer; expiresAt: Date };
}): Promise<SteppedSession> {
    try {
        return await db.transaction(async (tx): Promise<SteppedSession> => {
            const [seen] = await tx
                .select({
                    userId: twoStepAttempts.userId,
                    credentialVersion: twoStepAttempts.credentialVersion,
                })
                .from(twoStepAttempts)
                .where(eq(twoStepAttempts.tokenHash, input.tokenHash));
            if (!seen) return { status: 'gone' };
            const account = await lockSignIn(tx, seen.userId, seen.credentialVersion);
            if (!account) return { status: 'gone' };
            if (account.suspended) return { status: 'suspended' };
            const passed = await passStep(tx, {
                userId: seen.userId,
                purpose: 'login',
                sessionTokenHash: null,
                proof: { tokenHash: input.tokenHash, spend: input.spend },
            });
            const { attempt } = passed;
            const device = await writeSession(tx, {
                user: account.user,
                credentialVersion: attempt.credentialVersion,
                tokenHash: input.session.tokenHash,
                previousTokenHash: attempt.previousTokenHash,
                expiresAt: input.session.expiresAt,
                device: await returningDevice(tx, {
                    userId: attempt.userId,
                    provenDeviceId: attempt.deviceId,
                    previousTokenHash: attempt.previousTokenHash,
                }),
                twoStepAt: new Date(),
            });
            const { createdAt: _createdAt, ...user } = account.user;
            return {
                status: 'ok',
                user,
                key: account.key,
                device,
                method: passed.method,
                backupCodesLeft: passed.backupCodesLeft,
            };
        });
    } catch (error) {
        const refusal = await settleRefusal(error);
        if (!refusal) throw error;
        if (refusal.reason === 'spent') return { status: 'spent', failure: refusal.failure };
        return { status: refusal.reason === 'required' ? 'gone' : refusal.reason };
    }
}

/* ------------------------------------------------------------------------- */
/* The security log                                                           */
/* ------------------------------------------------------------------------- */

/*
 * What the log records so far: a sign-in that passed the step, a failed step after a correct
 * password, and each change to the step. A line carries a kind of event and a kind of
 * method, never a name, an address or a browser.
 */
export const SECURITY_EVENT_KINDS = [
    'sign-in',
    'step-failed',
    'two-step-on',
    'two-step-off',
    'method-added',
    'method-removed',
    'backup-codes-made',
    'backup-code-used',
    'phrase-used',
    'totp-frozen',
] as const;
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

/*
 * Writes one line. The device is linked, with its kind as it stands now, only when it is one
 * of this account's own: a line never points at another account's device.
 */
export async function recordSecurityEvent(input: {
    userId: string;
    kind: SecurityEventKind;
    method?: TwoStepMethod | null;
    deviceId?: string | null;
}) {
    const [device] = input.deviceId
        ? await db
              .select({ id: accountDevices.id, kind: accountDevices.kind })
              .from(accountDevices)
              .where(
                  and(
                      eq(accountDevices.id, input.deviceId),
                      eq(accountDevices.userId, input.userId),
                  ),
              )
        : [];
    await db.insert(accountSecurityEvents).values({
        userId: input.userId,
        kind: input.kind,
        method: input.method ?? null,
        deviceId: device?.id ?? null,
        deviceKind: device?.kind ?? null,
    });
}

/* The account's log for the last 90 days, newest first: every session of the account may read it. */
export async function listSecurityEvents(userId: string, limit = 200) {
    const since = new Date(Date.now() - SECURITY_EVENT_DAYS * 24 * 60 * 60 * 1000);
    return db
        .select({
            id: accountSecurityEvents.id,
            kind: accountSecurityEvents.kind,
            method: accountSecurityEvents.method,
            deviceId: accountSecurityEvents.deviceId,
            deviceKind: accountSecurityEvents.deviceKind,
            createdAt: accountSecurityEvents.createdAt,
        })
        .from(accountSecurityEvents)
        .where(
            and(
                eq(accountSecurityEvents.userId, userId),
                gt(accountSecurityEvents.createdAt, since),
            ),
        )
        .orderBy(desc(accountSecurityEvents.createdAt), desc(accountSecurityEvents.id))
        .limit(Math.max(1, Math.min(limit, 500)));
}
