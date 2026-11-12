import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { PENDING_FACTOR_SECONDS, sessionIsCurrent, type Tx } from './auth';
import { db } from './client';
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
    type TwoStepMethod,
    type TwoStepPurpose,
    type TwoStepSessionPurpose,
} from './schema';

/*
 * Two-step sign-in, the rows (docs/two-step-design.md). The step is a server rule, and this is
 * where its state lives: the methods, the backup codes, the step tokens and the counts of wrong
 * answers. Nothing here checks a code or opens a secret: the server computes TOTP codes and
 * hashes backup codes under the two-step key, and hands this repository only sealed bytes,
 * hashes and time steps. What this repository guarantees is what must hold whatever the server
 * does around it: a time step or a backup code is accepted once, however many requests race; a
 * token is used once and dies at the fifth wrong answer; a pending method never counts; and
 * nothing reaches another account's rows.
 *
 * Every write that changes an account's step takes the account's row lock first, as the auth
 * repository does. Accepting a time step, spending a backup code, using a token up and
 * recording a success (`advanceTotpStep`, `useBackupCode`, `consumeStepAttempt`,
 * `recordStepSuccess`) take an executor instead, so the transaction that opens the session or
 * commits a security change can run them inside itself.
 */

type Executor = Tx | typeof db;

/* A step token allows this many wrong answers; the last one deletes it. */
export const STEP_TOKEN_FAILURES = 5;
/* From this many wrong answers in a row, the account is told its password is known. */
export const STEP_NOTICE_FAILURES = 5;
/* At this many in a row from sign-ins that proved no device, the authenticator app is frozen for them. */
export const TOTP_FREEZE_FAILURES = 100;
/* A set of backup codes. */
export const BACKUP_CODE_COUNT = 10;

const HOUR_MS = 60 * 60 * 1000;
/* The hour a moment falls in (UTC): what `last_used_at` keeps. */
const hourOf = (moment: Date) => new Date(Math.floor(moment.getTime() / HOUR_MS) * HOUR_MS);

async function lockAccount(tx: Tx, userId: string) {
    const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
    return user !== undefined;
}

async function confirmedFactors(executor: Executor, userId: string) {
    return executor
        .select({ id: twoStepFactors.id, kind: twoStepFactors.kind })
        .from(twoStepFactors)
        .where(and(eq(twoStepFactors.userId, userId), isNotNull(twoStepFactors.confirmedAt)));
}

/* The account's state row, made on first need: the handle and the salt are random and never change. */
async function ensureState(executor: Executor, userId: string) {
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

/* ------------------------------------------------------------------------- */
/* Status                                                                     */
/* ------------------------------------------------------------------------- */

/* Whether the account has the step on: exactly when it has a confirmed method. */
export async function hasTwoStep(userId: string, executor: Executor = db) {
    return (await confirmedFactors(executor, userId)).length > 0;
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
        backupCodesLeft: await countBackupCodes(userId),
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

/*
 * Starts enrolling an authenticator app: a pending factor holding the sealed secret, good for
 * ten minutes. The caller makes the id first, because the seal's associated data names it. An
 * account has one pending app at a time; starting again drops the earlier one, and never
 * touches a confirmed app. Null when the account is gone.
 */
export async function startTotpFactor(input: {
    id: string;
    userId: string;
    keyId: Buffer;
    nonce: Buffer;
    sealedSecret: Buffer;
}) {
    return db.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return null;
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
export async function getTotpFactor(userId: string, executor: Executor = db) {
    const [row] = await executor
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
    | { status: 'session' | 'missing' | 'codes-required' };

/*
 * Confirms a pending app, once the server has checked a current code against its secret.
 * `step` is the time step that code was for: it becomes the app's last used step, so the same
 * code cannot sign in afterwards. Under the account's lock:
 * - the session asking must be the account's own, live and on its current credential;
 * - the factor must be this account's, pending, and younger than ten minutes;
 * - a confirmed app the account already has is deleted in the same transaction (one app per
 *   account), and nothing else about the step changes;
 * - the account's first method turns the step on. That needs `backupCodes` (`codes-required`
 *   without them, with nothing changed), stores them, and stamps the session that enrolled as
 *   having passed the step. A set passed when the step is already on is ignored.
 */
export async function confirmTotpFactor(input: {
    userId: string;
    factorId: string;
    step: number;
    sessionTokenHash: Buffer;
    credentialVersion: number;
    backupCodes?: BackupCodeSet;
}): Promise<ConfirmTotpResult> {
    if (!Number.isSafeInteger(input.step) || input.step <= 0) return { status: 'missing' };
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
        const confirmed = await confirmedFactors(tx, input.userId);
        const turnedOn = confirmed.length === 0;
        if (turnedOn && !codes) return { status: 'codes-required' };
        const replaced = confirmed.some((factor) => factor.kind === 'totp');
        if (replaced)
            await tx
                .delete(twoStepFactors)
                .where(
                    and(
                        eq(twoStepFactors.userId, input.userId),
                        eq(twoStepFactors.kind, 'totp'),
                        isNotNull(twoStepFactors.confirmedAt),
                    ),
                );
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

/*
 * Accepts a code's time step for the account's confirmed app, once: only a step later than
 * the last accepted one moves it. The comparison is in the update itself, so of two requests
 * with the same code exactly one is told yes, and a code used once is refused for anything
 * after. The server calls this only after the code itself checked out.
 */
export async function advanceTotpStep(
    input: { userId: string; factorId: string; step: number },
    executor: Executor = db,
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

export type RemoveFactorResult =
    /* `turnedOff`: it was the last method, so the step is off and its codes, tokens and counts are gone. */
    { status: 'ok'; kind: TwoStepFactorKind; turnedOff: boolean } | { status: 'missing' };

/*
 * Removes one of the account's methods, confirmed or still pending. Removing the last confirmed
 * one turns the step off: the backup codes and every step token of the account are deleted and
 * its counts start over, in the same transaction. Removing the app while other methods stay
 * lifts its freeze, which has nothing left to freeze.
 */
export async function removeFactor(input: {
    userId: string;
    factorId: string;
}): Promise<RemoveFactorResult> {
    return db.transaction(async (tx) => {
        if (!(await lockAccount(tx, input.userId))) return { status: 'missing' };
        const [removed] = await tx
            .delete(twoStepFactors)
            .where(
                and(eq(twoStepFactors.id, input.factorId), eq(twoStepFactors.userId, input.userId)),
            )
            .returning({ kind: twoStepFactors.kind, confirmedAt: twoStepFactors.confirmedAt });
        if (!removed) return { status: 'missing' };
        if (!removed.confirmedAt) return { status: 'ok', kind: removed.kind, turnedOff: false };
        const turnedOff = (await confirmedFactors(tx, input.userId)).length === 0;
        if (turnedOff) {
            await tx.delete(twoStepAttempts).where(eq(twoStepAttempts.userId, input.userId));
            await tx.delete(twoStepBackupCodes).where(eq(twoStepBackupCodes.userId, input.userId));
            await tx
                .update(accountDevices)
                .set({ twoStepFailures: 0 })
                .where(eq(accountDevices.userId, input.userId));
        }
        if (turnedOff || removed.kind === 'totp')
            await tx
                .update(twoStepState)
                .set({
                    totpFrozenAt: null,
                    ...(turnedOff ? { consecutiveFailures: 0 } : {}),
                })
                .where(eq(twoStepState.userId, input.userId));
        return { status: 'ok', kind: removed.kind, turnedOff };
    });
}

/* ------------------------------------------------------------------------- */
/* Backup codes                                                               */
/* ------------------------------------------------------------------------- */

/* How many of the account's backup codes are unused. */
export async function countBackupCodes(userId: string, executor: Executor = db) {
    const [row] = await executor
        .select({ count: count() })
        .from(twoStepBackupCodes)
        .where(and(eq(twoStepBackupCodes.userId, userId), isNull(twoStepBackupCodes.usedAt)));
    return row?.count ?? 0;
}

/*
 * A new set of codes, which replaces the old one whole. Only while the step is on: a set for
 * an account without a method would be a way in that nothing asks for.
 */
export async function replaceBackupCodes(input: { userId: string } & BackupCodeSet) {
    const codes = checkedSet(input);
    return db.transaction(async (tx) => {
        if (
            !(await lockAccount(tx, input.userId)) ||
            (await confirmedFactors(tx, input.userId)).length === 0
        )
            return { status: 'off' as const };
        await writeBackupCodes(tx, input.userId, codes);
        return { status: 'ok' as const };
    });
}

/*
 * What a typed backup code is checked against: the account's salt, and its unused codes with
 * the key each was hashed under. Null for an account that never had the step.
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

/*
 * Marks one of the account's codes used, once: the update only touches an unused row, so of
 * two requests with the same code exactly one gets an answer. Run inside the transaction that
 * opens the session or commits the change, so a code is never spent on a step that then
 * fails. Answers how many codes are left, or null when the code is unknown, already used, or
 * another account's.
 */
export async function useBackupCode(
    input: { userId: string; codeHash: Buffer },
    executor: Executor = db,
) {
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
    return { left: await countBackupCodes(input.userId, executor) };
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
          purpose: 'login';
          /* The device whose key proof `login/finish` verified, or null without one. */
          deviceId: string | null;
          /* The browser's previous session, for the session this step will open. */
          previousTokenHash: Buffer | null;
      }
    | { purpose: 'enrol' }
    | { purpose: TwoStepSessionPurpose; sessionTokenHash: Buffer }
);

/*
 * Stores a step token. A sign-in's device is kept only when it is one of this account's own
 * devices, approved, keyed and not removed; anything else is stored as no device, so a forged
 * proof or another account's device falls into the account's shared count and budget
 * (docs/two-step-design.md 2), and never into a device's.
 */
export async function createStepAttempt(input: StepAttemptInput) {
    const login = input.purpose === 'login' ? input : null;
    const deviceId = login?.deviceId
        ? sql<string>`(select ${accountDevices.id} from ${accountDevices} where ${accountDevices.id} = ${login.deviceId} and ${accountDevices.userId} = ${input.userId} and ${accountDevices.revokedAt} is null and ${accountDevices.approvedAt} is not null and ${accountDevices.signingPublicKey} is not null)`
        : null;
    await db.insert(twoStepAttempts).values({
        tokenHash: input.tokenHash,
        userId: input.userId,
        purpose: input.purpose,
        sessionTokenHash: 'sessionTokenHash' in input ? input.sessionTokenHash : null,
        credentialVersion: input.credentialVersion,
        deviceId,
        previousTokenHash: login?.previousTokenHash ?? null,
        webauthnChallenge: input.webauthnChallenge ?? null,
        expiresAt: input.expiresAt,
    });
}

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
    failures: number;
    expiresAt: Date;
    pool: StepPool;
    /* The authenticator app is frozen for this token: its codes are refused unchecked. */
    totpFrozen: boolean;
};

/*
 * The token's row while it can still pass: not expired, made at the account's current
 * credential version (a password change since ends it), and with what it is bound to still
 * there. A step-up's session must be live and on a device that was not removed; a sign-in's
 * proven device must not have been removed since.
 */
async function readAttempt(executor: Executor, tokenHash: Buffer): Promise<StepAttempt | null> {
    const now = new Date();
    const [row] = await executor
        .select({ attempt: twoStepAttempts, frozenAt: twoStepState.totpFrozenAt })
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
    let deviceId: string | null = null;
    if (attempt.sessionTokenHash) {
        const [session] = await executor
            .select({ deviceId: accountDevices.id })
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
        if (!session) return null;
        deviceId = session.deviceId;
    } else if (attempt.deviceId) {
        const [device] = await executor
            .select({ id: accountDevices.id })
            .from(accountDevices)
            .where(
                and(
                    eq(accountDevices.id, attempt.deviceId),
                    eq(accountDevices.userId, attempt.userId),
                    isNull(accountDevices.revokedAt),
                ),
            );
        if (!device) return null;
        deviceId = device.id;
    }
    const pool: StepPool = deviceId ? { kind: 'device', deviceId } : { kind: 'account' };
    return { ...attempt, pool, totpFrozen: pool.kind === 'account' && row.frozenAt !== null };
}

/* The token's row, to check a proof against, or null once it can no longer pass. Reading spends nothing. */
export async function getStepAttempt(tokenHash: Buffer) {
    return readAttempt(db, tokenHash);
}

/*
 * Uses a token up, once the proof it came with checked out: it is deleted, and its row is
 * answered to exactly one caller however many ask at once. The caller says what it is using
 * the token for; a token made for another purpose, or bound to another session (a sign-in's
 * is bound to none), is refused and left as it was.
 */
export async function consumeStepAttempt(
    input: { tokenHash: Buffer; purpose: TwoStepPurpose; sessionTokenHash: Buffer | null },
    executor: Executor = db,
) {
    const attempt = await readAttempt(executor, input.tokenHash);
    if (!attempt || attempt.purpose !== input.purpose) return null;
    const bound = attempt.sessionTokenHash;
    if (bound ? !input.sessionTokenHash?.equals(bound) : input.sessionTokenHash !== null)
        return null;
    const gone = await executor
        .delete(twoStepAttempts)
        .where(eq(twoStepAttempts.tokenHash, input.tokenHash))
        .returning({ tokenHash: twoStepAttempts.tokenHash });
    return gone.length === 1 ? attempt : null;
}

export type StepFailure =
    | { status: 'gone' }
    | {
          status: 'counted';
          /* Wrong answers the token still allows; 0 when this one ended it. */
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
 * Counts one wrong answer, under the account's lock:
 * - against the token: the fifth deletes it, and the next try needs the password again;
 * - against the pool the token belongs to: the device's own count when the sign-in proved a
 *   device or the step-up came from its session, the account's otherwise. A success in the
 *   same pool resets it (`recordStepSuccess`);
 * - at the hundredth in a row in the account's pool, the authenticator app is frozen for
 *   sign-ins that prove no device (`totpFrozen` on their tokens). A device's count freezes
 *   nothing: known devices keep taking codes.
 * Every kind of wrong answer counts here. The 15-minute budgets, which cover codes only, are
 * rate-limit buckets the server keeps.
 */
export async function recordStepFailure(tokenHash: Buffer): Promise<StepFailure> {
    return db.transaction(async (tx) => {
        const [seen] = await tx
            .select({ userId: twoStepAttempts.userId })
            .from(twoStepAttempts)
            .where(eq(twoStepAttempts.tokenHash, tokenHash));
        if (!seen || !(await lockAccount(tx, seen.userId))) return { status: 'gone' };
        // Read again under the lock: a request that ran first may have used or ended the token.
        const attempt = await readAttempt(tx, tokenHash);
        if (!attempt) return { status: 'gone' };
        const failures = attempt.failures + 1;
        const tokenEnded = failures >= STEP_TOKEN_FAILURES;
        if (tokenEnded)
            await tx.delete(twoStepAttempts).where(eq(twoStepAttempts.tokenHash, tokenHash));
        else
            await tx
                .update(twoStepAttempts)
                .set({ failures })
                .where(eq(twoStepAttempts.tokenHash, tokenHash));

        let consecutiveFailures = 0;
        let froze = false;
        if (attempt.pool.kind === 'device') {
            const [device] = await tx
                .update(accountDevices)
                .set({ twoStepFailures: sql`${accountDevices.twoStepFailures} + 1` })
                .where(
                    and(
                        eq(accountDevices.id, attempt.pool.deviceId),
                        eq(accountDevices.userId, attempt.userId),
                    ),
                )
                .returning({ failures: accountDevices.twoStepFailures });
            consecutiveFailures = device?.failures ?? 0;
        } else {
            await ensureState(tx, attempt.userId);
            const [state] = await tx
                .update(twoStepState)
                .set({ consecutiveFailures: sql`${twoStepState.consecutiveFailures} + 1` })
                .where(eq(twoStepState.userId, attempt.userId))
                .returning({
                    failures: twoStepState.consecutiveFailures,
                    frozenAt: twoStepState.totpFrozenAt,
                });
            consecutiveFailures = state?.failures ?? 0;
            // At or past the limit, not only on it: a freeze lifted from a known device comes
            // back with the next wrong answer here, so lifting it never hands out more guesses.
            if (
                consecutiveFailures >= TOTP_FREEZE_FAILURES &&
                !state?.frozenAt &&
                (await confirmedFactors(tx, attempt.userId)).some(({ kind }) => kind === 'totp')
            ) {
                await tx
                    .update(twoStepState)
                    .set({ totpFrozenAt: new Date() })
                    .where(eq(twoStepState.userId, attempt.userId));
                froze = true;
            }
        }
        return {
            status: 'counted',
            left: STEP_TOKEN_FAILURES - Math.min(failures, STEP_TOKEN_FAILURES),
            tokenEnded,
            pool: attempt.pool.kind,
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
 * answer there (`recordStepFailure`). Run in the transaction that uses the token up.
 */
export async function recordStepSuccess(
    input: { userId: string; pool: StepPool; method: TwoStepMethod },
    executor: Executor = db,
) {
    if (input.pool.kind === 'device')
        await executor
            .update(accountDevices)
            .set({ twoStepFailures: 0 })
            .where(
                and(
                    eq(accountDevices.id, input.pool.deviceId),
                    eq(accountDevices.userId, input.userId),
                ),
            );
    else
        await executor
            .update(twoStepState)
            .set({ consecutiveFailures: 0 })
            .where(eq(twoStepState.userId, input.userId));
    if (input.method === 'totp') return { unfroze: false };
    const lifted = await executor
        .update(twoStepState)
        .set({ totpFrozenAt: null })
        .where(and(eq(twoStepState.userId, input.userId), isNotNull(twoStepState.totpFrozenAt)))
        .returning({ userId: twoStepState.userId });
    return { unfroze: lifted.length === 1 };
}
