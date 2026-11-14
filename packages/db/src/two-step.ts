import {
    and,
    asc,
    count,
    countDistinct,
    desc,
    eq,
    gt,
    isNotNull,
    isNull,
    lt,
    ne,
    sql,
} from 'drizzle-orm';
import { db } from './client';
import {
    accountDevices,
    accountSecurityEvents,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepFactors,
    twoStepKeyReaders,
    twoStepKeyRegistrations,
    twoStepState,
    type accountKeys,
    type TwoStepDefaultKind,
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
import { endRequestsOfRemovedMethod } from './two-step.approvals';
import {
    BACKUP_CODE_COUNT,
    PENDING_FACTOR_SECONDS,
    SECURITY_EVENT_DAYS,
    STEP_TOKEN_ANSWERS,
    WEBAUTHN_KEY_LIMIT,
    confirmedFactors,
    ensureState,
    hourOf,
    kindOrder,
    passStep,
    passStepIfOn,
    readAttempt,
    settleDefault,
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
 *   `replaceBackupCodes`, `startTotpFactor`, `startKeyRegistration`) or in the auth repository
 *   (`changeAccountSecurity`, `deleteAccount`), and there is no other way to spend a step;
 * - a pending method never counts, and nothing reaches another account's rows.
 * Every write that changes an account's step takes the account's row lock first.
 *
 * How the server answers a step (docs/two-step-design.md 2, 4), in this order:
 * 1. `takeStepAnswer` takes one of the token's five slots, before anything is checked.
 * 2. For a code (authenticator or backup): `consumeRateLimit` on the pool's 15-minute bucket,
 *    before checking. That budget is charged up front and handed back on success, so
 *    requests racing a nearly spent budget cannot all be checked.
 * 3. Check the answer. An answer refused before it is checked (the budget is spent, or the
 *    server has no key for the row) used nothing: `returnStepAnswer` gives its slot back, so
 *    the token's remaining answers are still there for a method that can be checked.
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
    WEBAUTHN_KEY_LIMIT,
    kindOrder,
    recordStepFailure,
    returnStepAnswer,
} from './two-step.core';
export type {
    StepAttempt,
    StepFailure,
    StepPool,
    StepProof,
    StepSpend,
    StepSpent,
    TwoStepRefusal,
} from './two-step.core';
export { REPLACEMENT_SESSION_SECONDS, TWO_STEP_REMEMBER_SECONDS } from './sessions';
export { STEP_UP_DEVICE_SECONDS } from './two-step.core';
export {
    CHANGE_REQUESTS_A_DAY,
    DEVICE_REQUESTS_A_DAY,
    approveDeviceRequest,
    canAddDeviceStep,
    confirmDeviceFactor,
    createDeviceRequest,
    denyDeviceRequest,
    deviceStepUsable,
    endRequestsOfToken,
    getDeviceRequest,
    listApprovalPrompts,
    listDeviceStepApprovers,
    openDeviceRequest,
    revealDeviceRequest,
    settleDeviceRequests,
    startDeviceFactor,
} from './two-step.approvals';
export type {
    ApprovalPrompt,
    ConfirmDeviceFactorResult,
    CountedRequest,
    CreateRequestResult,
    RequestStatus,
    StartDeviceFactorResult,
} from './two-step.approvals';

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
 * backup codes are left, whether the authenticator app is frozen for new devices, and the kind
 * that is offered first (`defaultKind`: the person's choice while a factor of that kind is
 * confirmed, else the first kind there is; null with the step off). Never a secret, a public
 * key or a credential id.
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
        .select({
            totpFrozenAt: twoStepState.totpFrozenAt,
            defaultKind: twoStepState.defaultKind,
        })
        .from(twoStepState)
        .where(eq(twoStepState.userId, userId));
    return {
        on: methods.length > 0,
        methods: methods.map((method) => ({ ...method, synced: method.synced === true })),
        backupCodesLeft: await unusedBackupCodes(db, userId),
        totpFrozen: Boolean(state?.totpFrozenAt),
        defaultKind:
            kindOrder(
                methods.map((method) => method.kind),
                state?.defaultKind,
            )[0] ?? null,
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
 *   having passed the step, makes the app the account's default, and deletes every other
 *   pending method of the account, a key being added included: one started while the step
 *   was off could otherwise be confirmed later without the step. A set passed when the step
 *   is already on is ignored.
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
        // The first method turned on is the default; a later one never moves it.
        await settleDefault(
            tx,
            input.userId,
            confirmed.map((factor) => factor.kind),
            turnedOn ? 'totp' : undefined,
        );
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
            // And every key being added: its registration was handed out without the step.
            await tx
                .delete(twoStepKeyRegistrations)
                .where(eq(twoStepKeyRegistrations.userId, input.userId));
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
    /*
     * `turnedOff`: it was the last method, so the step is off and its codes, tokens and counts
     * are gone. `defaultKind`: the kind offered first from now on, when removing the last
     * method of the default's kind moved it; absent when the default stayed where it was.
     */
    | {
          status: 'ok';
          kind: TwoStepFactorKind;
          turnedOff: boolean;
          defaultKind?: TwoStepDefaultKind;
      }
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
 * Removing the last method of the default's kind clears the default in the same transaction,
 * so an old choice never comes back when that kind is added again (docs/two-step-design.md 12).
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
        // No request outlives the method it was for, nor the token that would have confirmed it.
        if (factor.kind === 'device') await endRequestsOfRemovedMethod(tx, input.userId);
        if (!factor.confirmedAt) return { status: 'ok', kind: factor.kind, turnedOff: false };
        const left = (await confirmedFactors(tx, input.userId)).map(({ kind }) => kind);
        const turnedOff = left.length === 0;
        // The default goes with the last method of its kind. What is offered first moves
        // whenever the kind that was first has no method left, chosen or not.
        const [state] = await tx
            .select({ defaultKind: twoStepState.defaultKind })
            .from(twoStepState)
            .where(eq(twoStepState.userId, input.userId));
        const was = kindOrder([...left, factor.kind], state?.defaultKind)[0];
        const now = kindOrder(left, null)[0];
        const kindGone = !left.includes(factor.kind);
        if (kindGone && state?.defaultKind === factor.kind)
            await tx
                .update(twoStepState)
                .set({ defaultKind: null })
                .where(eq(twoStepState.userId, input.userId));
        const moved = kindGone && was === factor.kind && now ? { defaultKind: now } : {};
        if (turnedOff) {
            await endRequestsOfRemovedMethod(tx, input.userId);
            await tx.delete(twoStepAttempts).where(eq(twoStepAttempts.userId, input.userId));
            await tx
                .delete(twoStepKeyRegistrations)
                .where(eq(twoStepKeyRegistrations.userId, input.userId));
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
        return { status: 'ok', kind: factor.kind, turnedOff, ...moved };
    });
}

/* ------------------------------------------------------------------------- */
/* Passkeys and security keys                                                 */
/* ------------------------------------------------------------------------- */

const methodFields = {
    id: twoStepFactors.id,
    kind: twoStepFactors.kind,
    name: twoStepFactors.name,
    createdAt: twoStepFactors.createdAt,
    lastUsedAt: twoStepFactors.lastUsedAt,
    synced: twoStepFactors.backupState,
};

/*
 * The account's confirmed keys as an assertion is checked against them: the credential id, the
 * COSE public key, the counter and the transports. Served to the server only; a client is told
 * the ids and transports after the password, and never the keys.
 */
export async function listWebauthnCredentials(userId: string) {
    const rows = await db
        .select({
            id: twoStepFactors.id,
            credentialId: twoStepFactors.credentialId,
            publicKey: twoStepFactors.publicKey,
            signCount: twoStepFactors.signCount,
            transports: twoStepFactors.transports,
        })
        .from(twoStepFactors)
        .where(
            and(
                eq(twoStepFactors.userId, userId),
                eq(twoStepFactors.kind, 'webauthn'),
                isNotNull(twoStepFactors.confirmedAt),
            ),
        )
        .orderBy(asc(twoStepFactors.createdAt), asc(twoStepFactors.id));
    // The table's check keeps these present on every `webauthn` row.
    return rows.flatMap((row) =>
        row.credentialId && row.publicKey && row.signCount !== null
            ? [
                  {
                      id: row.id,
                      credentialId: row.credentialId,
                      publicKey: row.publicKey,
                      signCount: row.signCount,
                      transports: row.transports ?? [],
                  },
              ]
            : [],
    );
}

export type StartKeyResult = { status: 'ok' } | { status: 'missing' | 'limit' } | TwoStepRefusal;

/*
 * Starts adding a key: stores the registration token's hash and the challenge the key must
 * sign, for five minutes, bound to the session that asked. While the account has the step on,
 * adding a method needs the step (`step`, a token for `two-step` from that session): without
 * one that passes, nothing is stored. `limit` once the account has ten keys. A session has one
 * registration at a time; starting again drops its earlier one.
 */
export async function startKeyRegistration(input: {
    tokenHash: Buffer;
    userId: string;
    sessionTokenHash: Buffer;
    credentialVersion: number;
    challenge: Buffer;
    expiresAt: Date;
    step?: SessionStep;
}): Promise<StartKeyResult> {
    return gated<StartKeyResult>(async (tx) => {
        if (!(await lockAccount(tx, input.userId)) || !(await sessionIsCurrent(tx, input)))
            return { status: 'missing' };
        const keys = (await confirmedFactors(tx, input.userId)).filter(
            ({ kind }) => kind === 'webauthn',
        );
        if (keys.length >= WEBAUTHN_KEY_LIMIT) return { status: 'limit' };
        await passStepIfOn(tx, {
            userId: input.userId,
            purpose: 'two-step',
            sessionTokenHash: input.step?.sessionTokenHash ?? null,
            proof: input.step,
        });
        await tx
            .delete(twoStepKeyRegistrations)
            .where(
                and(
                    eq(twoStepKeyRegistrations.userId, input.userId),
                    eq(twoStepKeyRegistrations.sessionTokenHash, input.sessionTokenHash),
                ),
            );
        await tx.insert(twoStepKeyRegistrations).values({
            tokenHash: input.tokenHash,
            userId: input.userId,
            sessionTokenHash: input.sessionTokenHash,
            credentialVersion: input.credentialVersion,
            challenge: input.challenge,
            expiresAt: input.expiresAt,
        });
        return { status: 'ok' };
    });
}

const registrationOf = (input: { tokenHash: Buffer; userId: string; sessionTokenHash: Buffer }) =>
    and(
        eq(twoStepKeyRegistrations.tokenHash, input.tokenHash),
        eq(twoStepKeyRegistrations.userId, input.userId),
        eq(twoStepKeyRegistrations.sessionTokenHash, input.sessionTokenHash),
        gt(twoStepKeyRegistrations.expiresAt, new Date()),
    );

/*
 * The challenge a key's registration must have signed, while its token can still be used: the
 * token must be this account's, from this session, and not expired. Reading uses nothing up.
 */
export async function getKeyRegistration(input: {
    tokenHash: Buffer;
    userId: string;
    sessionTokenHash: Buffer;
}) {
    const [row] = await db
        .select({ challenge: twoStepKeyRegistrations.challenge })
        .from(twoStepKeyRegistrations)
        .where(registrationOf(input));
    return row ?? null;
}

/* Ends a registration whose answer did not verify: a token is good for one answer. */
export async function dropKeyRegistration(tokenHash: Buffer) {
    await db
        .delete(twoStepKeyRegistrations)
        .where(eq(twoStepKeyRegistrations.tokenHash, tokenHash));
}

export type WebauthnCredential = {
    credentialId: Buffer;
    publicKey: Buffer;
    signCount: number;
    transports: string[];
    backupEligible: boolean;
    backupState: boolean;
};
type StoredMethod = {
    id: string;
    kind: TwoStepFactorKind;
    name: string | null;
    createdAt: Date;
    lastUsedAt: Date | null;
    synced: boolean;
};
export type AddKeyResult =
    /* `turnedOn`: this was the account's first method, so the step is now on and the codes were stored. */
    | { status: 'ok'; turnedOn: boolean; method: StoredMethod }
    | { status: 'session' | 'missing' | 'codes-required' | 'limit' | 'exists' };

/*
 * Adds a key, once the server has verified its registration against the challenge of
 * `registrationTokenHash`. Under the account's lock:
 * - the session asking must be the account's own, live and on its current credential;
 * - the registration must still be there, this account's and this session's: it is deleted
 *   here, so it adds one key and no more, however many requests carry it. One that anything
 *   else ended (the step turned on or off meanwhile, five minutes) is `missing`;
 * - the account has at most ten keys (`limit`), and never the same credential twice (`exists`);
 * - the account's first method turns the step on, exactly as an app's does: it needs
 *   `backupCodes` (`codes-required` without them, with nothing changed and the registration
 *   kept), stores them, stamps the session, makes the key the account's default and deletes
 *   every other pending method.
 * The key is confirmed as it is stored: its registration was the proof it answers.
 */
export async function addWebauthnFactor(
    input: {
        userId: string;
        sessionTokenHash: Buffer;
        credentialVersion: number;
        registrationTokenHash: Buffer;
        name: string;
        backupCodes?: BackupCodeSet;
    } & WebauthnCredential,
): Promise<AddKeyResult> {
    const codes = input.backupCodes ? checkedSet(input.backupCodes) : null;
    return db.transaction(async (tx): Promise<AddKeyResult> => {
        if (!(await lockAccount(tx, input.userId)) || !(await sessionIsCurrent(tx, input)))
            return { status: 'session' };
        const registration = registrationOf({ ...input, tokenHash: input.registrationTokenHash });
        const [pending] = await tx
            .select({ tokenHash: twoStepKeyRegistrations.tokenHash })
            .from(twoStepKeyRegistrations)
            .where(registration)
            .for('update');
        if (!pending) return { status: 'missing' };
        const confirmed = await confirmedFactors(tx, input.userId);
        const turnedOn = confirmed.length === 0;
        if (turnedOn && !codes) return { status: 'codes-required' };
        await tx.delete(twoStepKeyRegistrations).where(registration);
        if (confirmed.filter(({ kind }) => kind === 'webauthn').length >= WEBAUTHN_KEY_LIMIT)
            return { status: 'limit' };
        const [same] = await tx
            .select({ id: twoStepFactors.id })
            .from(twoStepFactors)
            .where(
                and(
                    eq(twoStepFactors.userId, input.userId),
                    eq(twoStepFactors.credentialId, input.credentialId),
                ),
            );
        if (same) return { status: 'exists' };
        const now = new Date();
        const [method] = await tx
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
            .returning(methodFields);
        if (!method) throw new Error('The key could not be stored.');
        await settleDefault(
            tx,
            input.userId,
            confirmed.map((factor) => factor.kind),
            turnedOn ? 'webauthn' : undefined,
        );
        if (turnedOn && codes) {
            await writeBackupCodes(tx, input.userId, codes);
            // A fresh start, as when an app turns the step on.
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
                    ),
                );
            await tx
                .delete(twoStepKeyRegistrations)
                .where(eq(twoStepKeyRegistrations.userId, input.userId));
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
        return { status: 'ok', turnedOn, method: { ...method, synced: method.synced === true } };
    });
}

/*
 * Renames one of the account's keys. Any session of the account may: a name is a label, shown
 * only to the account, and not encrypted. An app has no name, and a pending method none to
 * change. Answers the method as the list shows it, or null when it is not this account's key.
 */
export async function renameFactor(input: { userId: string; factorId: string; name: string }) {
    const [method] = await db
        .update(twoStepFactors)
        .set({ name: input.name })
        .where(
            and(
                eq(twoStepFactors.id, input.factorId),
                eq(twoStepFactors.userId, input.userId),
                eq(twoStepFactors.kind, 'webauthn'),
                isNotNull(twoStepFactors.confirmedAt),
            ),
        )
        .returning(methodFields);
    return method ? { ...method, synced: method.synced === true } : null;
}

/* ------------------------------------------------------------------------- */
/* The default                                                                */
/* ------------------------------------------------------------------------- */

export type SetDefaultResult =
    /* `changed`: false when that kind was already what the account is offered first. */
    { status: 'ok'; changed: boolean } | { status: 'session' | 'step' | 'missing' };

/*
 * Chooses the kind of method the account is offered first (docs/two-step-design.md 12). It
 * changes only an order, so it asks for no password and no fresh step. But the session asking
 * must have passed the step itself (`step` otherwise): one that signed in before the step was
 * turned on never did. The account must have a confirmed method of that kind (`missing`).
 */
export async function setDefaultKind(input: {
    userId: string;
    kind: TwoStepDefaultKind;
    sessionTokenHash: Buffer;
    credentialVersion: number;
}): Promise<SetDefaultResult> {
    return db.transaction(async (tx): Promise<SetDefaultResult> => {
        if (!(await lockAccount(tx, input.userId)) || !(await sessionIsCurrent(tx, input)))
            return { status: 'session' };
        const [session] = await tx
            .select({ twoStepAt: sessions.twoStepAt })
            .from(sessions)
            .where(
                and(
                    eq(sessions.tokenHash, input.sessionTokenHash),
                    eq(sessions.userId, input.userId),
                ),
            );
        if (!session?.twoStepAt) return { status: 'step' };
        const kinds = (await confirmedFactors(tx, input.userId)).map(({ kind }) => kind);
        if (!kinds.some((kind) => kind === input.kind)) return { status: 'missing' };
        const state = await ensureState(tx, input.userId);
        const changed = kindOrder(kinds, state.defaultKind)[0] !== input.kind;
        if (state.defaultKind !== input.kind)
            await tx
                .update(twoStepState)
                .set({ defaultKind: input.kind })
                .where(eq(twoStepState.userId, input.userId));
        return { status: 'ok', changed };
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
    /*
     * The code was already used, or a key's counter did not go up (`counter`: found here,
     * under the lock, when another answer of the same key moved it first). It was counted as a
     * wrong answer, once: `failure` is that count.
     */
    | { status: 'spent'; failure: StepFailure; counter?: boolean };

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
    spent?: StepProof['spent'];
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
                proof: { tokenHash: input.tokenHash, spend: input.spend, spent: input.spent },
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
                approvedByDeviceId: passed.approverDeviceId,
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
        if (refusal.reason === 'spent')
            return {
                status: 'spent',
                failure: refusal.failure,
                // Carried on: the account is told its key may have been copied only if this is.
                ...(refusal.counter ? { counter: true } : {}),
            };
        return { status: refusal.reason === 'required' ? 'gone' : refusal.reason };
    }
}

/* ------------------------------------------------------------------------- */
/* Re-sealing after a key rotation                                            */
/* ------------------------------------------------------------------------- */

/*
 * After the two-step key is rotated, the worker moves each authenticator secret to the
 * current key (docs/two-step-design.md 8). The repository still opens nothing: the worker
 * reads sealed rows here, opens and seals them itself, and hands back sealed bytes. What is
 * guaranteed here is that a row is replaced only if it is still, byte for byte, the row that
 * was read, and that nothing but its seal changes.
 */

/* An authenticator secret as stored: what the seal's associated data names, and the sealed bytes. */
export type SealedTotp = {
    id: string;
    userId: string;
    keyId: Buffer;
    nonce: Buffer;
    sealedSecret: Buffer;
};
type Seal = Pick<SealedTotp, 'keyId' | 'nonce' | 'sealedSecret'>;

/* The most rows one page hands over. */
export const RESEAL_PAGE_LIMIT = 500;

/*
 * A page of the authenticator secrets sealed under any key but `keyId`, in id order, after
 * `after`. Pending apps are included: one confirmed a minute later would otherwise stay
 * under the old key. The caller walks the whole table once by passing the last id it got, so
 * a row it could not move (no key for it) is passed, not met again and again.
 */
export async function listTotpSealedOutside(input: {
    keyId: Buffer;
    after?: string | null;
    limit?: number;
}): Promise<SealedTotp[]> {
    const limit = Math.max(1, Math.min(input.limit ?? RESEAL_PAGE_LIMIT, RESEAL_PAGE_LIMIT));
    const rows = await db
        .select({
            id: twoStepFactors.id,
            userId: twoStepFactors.userId,
            keyId: twoStepFactors.totpKeyId,
            nonce: twoStepFactors.totpNonce,
            sealedSecret: twoStepFactors.totpSecret,
        })
        .from(twoStepFactors)
        .where(
            and(
                eq(twoStepFactors.kind, 'totp'),
                ne(twoStepFactors.totpKeyId, input.keyId),
                input.after ? gt(twoStepFactors.id, input.after) : undefined,
            ),
        )
        .orderBy(asc(twoStepFactors.id))
        .limit(limit);
    return rows.flatMap((row) =>
        row.keyId && row.nonce && row.sealedSecret
            ? [{ ...row, keyId: row.keyId, nonce: row.nonce, sealedSecret: row.sealedSecret }]
            : [],
    );
}

/*
 * Replaces one secret's seal: `to` is written only while the row still holds exactly `from`
 * (its key id, nonce and sealed bytes), in one statement. So a row that was re-sealed by
 * another run, replaced by a new app, removed, or changed by anything else since it was read
 * is left as it is, and the answer says so (`false`). Only the three columns of the seal are
 * written: the last accepted time step is never touched, so a re-seal cannot make a used code
 * good again, and a sign-in that accepts a code at the same moment loses nothing.
 */
export async function resealTotpSecret(input: { id: string; from: Seal; to: Seal }) {
    const moved = await db
        .update(twoStepFactors)
        .set({
            totpKeyId: input.to.keyId,
            totpNonce: input.to.nonce,
            totpSecret: input.to.sealedSecret,
        })
        .where(
            and(
                eq(twoStepFactors.id, input.id),
                eq(twoStepFactors.kind, 'totp'),
                eq(twoStepFactors.totpKeyId, input.from.keyId),
                eq(twoStepFactors.totpNonce, input.from.nonce),
                eq(twoStepFactors.totpSecret, input.from.sealedSecret),
            ),
        )
        .returning({ id: twoStepFactors.id });
    return moved.length === 1;
}

/*
 * How much is sealed or hashed under each key, by key id: authenticator secrets (pending ones
 * too), and the accounts that still have an unused backup code under it. It is what tells an
 * operator when an old key can go: backup codes are never re-keyed, so a set stays under the
 * key it was made with until its owner makes a new one or uses it up.
 */
export async function sealedUnder() {
    const [totp, backupCodes] = await Promise.all([
        db
            .select({ keyId: twoStepFactors.totpKeyId, secrets: count() })
            .from(twoStepFactors)
            .where(eq(twoStepFactors.kind, 'totp'))
            .groupBy(twoStepFactors.totpKeyId),
        db
            .select({
                keyId: twoStepBackupCodes.keyId,
                accounts: countDistinct(twoStepBackupCodes.userId),
            })
            .from(twoStepBackupCodes)
            .where(isNull(twoStepBackupCodes.usedAt))
            .groupBy(twoStepBackupCodes.keyId),
    ]);
    return {
        totp: totp.flatMap((row) =>
            row.keyId ? [{ keyId: row.keyId, secrets: row.secrets }] : [],
        ),
        backupCodes,
    };
}

/* A web process counts as running while it has been seen in this long. */
export const KEY_READER_LIVE_SECONDS = 5 * 60;
/* A row not seen for this long is deleted. */
export const KEY_READER_KEPT_SECONDS = 60 * 60;

/* A web process as the worker sees it: key ids in hex, never a key. */
export type KeyReader = {
    instanceId: string;
    sealingKeyId: string;
    readableKeyIds: string[];
    sealingSince: Date;
    seenAt: Date;
};

const keyIdHex = (keyId: Buffer) => {
    // 8 bytes is an id. Anything longer could be a key, and must never be written here.
    if (keyId.length !== 8) throw new Error('A two-step key id is 8 bytes.');
    return keyId.toString('hex');
};

/*
 * A web process's word on its keys, said again at every readiness check: the key it seals
 * new secrets under, and every key it can read, by id. The first word starts
 * `sealing_since`; each later one only moves `seen_at`, unless the process now seals under
 * another key (it cannot, short of a restart), which starts `sealing_since` again. Times are
 * the database's clock, so web processes and the worker on different hosts agree on them.
 */
export async function reportKeyReader(input: {
    instanceId: string;
    sealingKeyId: Buffer;
    readableKeyIds: Buffer[];
    now?: Date;
}) {
    const sealingKeyId = keyIdHex(input.sealingKeyId);
    const readableKeyIds = [...new Set(input.readableKeyIds.map(keyIdHex))].sort();
    const now = input.now ?? sql<Date>`now()`;
    await db
        .insert(twoStepKeyReaders)
        .values({
            instanceId: input.instanceId,
            sealingKeyId,
            readableKeyIds,
            sealingSince: now,
            seenAt: now,
        })
        .onConflictDoUpdate({
            target: twoStepKeyReaders.instanceId,
            set: {
                sealingKeyId,
                readableKeyIds,
                sealingSince: sql`case when ${twoStepKeyReaders.sealingKeyId} = excluded.sealing_key_id then ${twoStepKeyReaders.sealingSince} else excluded.sealing_since end`,
                seenAt: sql`greatest(${twoStepKeyReaders.seenAt}, excluded.seen_at)`,
            },
        });
}

/*
 * The web processes seen in the last five minutes, and the moment that was read at, by the
 * database's clock. A process that stopped saying so (it exited, or cannot reach the
 * database) is no reader any more once those five minutes have passed.
 */
export async function liveKeyReaders(at?: Date): Promise<{ now: Date; readers: KeyReader[] }> {
    const now =
        at ?? new Date((await db.execute<{ now: Date }>(sql`select now() as now`)).rows[0]!.now);
    const readers = await db
        .select()
        .from(twoStepKeyReaders)
        .where(
            gt(twoStepKeyReaders.seenAt, new Date(now.getTime() - KEY_READER_LIVE_SECONDS * 1000)),
        )
        .orderBy(asc(twoStepKeyReaders.instanceId));
    return { now, readers };
}

/* Deletes the rows of processes not seen for an hour; how many went. */
export async function dropStaleKeyReaders(at?: Date) {
    const cutoff = at
        ? new Date(at.getTime() - KEY_READER_KEPT_SECONDS * 1000)
        : sql<Date>`now() - make_interval(secs => ${KEY_READER_KEPT_SECONDS})`;
    const gone = await db
        .delete(twoStepKeyReaders)
        .where(lt(twoStepKeyReaders.seenAt, cutoff))
        .returning({ instanceId: twoStepKeyReaders.instanceId });
    return gone.length;
}

/* ------------------------------------------------------------------------- */
/* The security log                                                           */
/* ------------------------------------------------------------------------- */

/*
 * What the log records so far: a sign-in that passed the step, a failed step after a correct
 * password, each change to the step (the default among them, with the kind it moved to as its
 * method), and a key whose counter did not go up. A line carries a kind of event and a kind of
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
    'default-changed',
    'key-counter',
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
