import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyTwoStepPhrase } from '@hushos/crypto/two-step';
import {
    base32,
    deriveTwoStepKey,
    formatBackupCode,
    generateBackupCode,
    generateTotpSecret,
    hashBackupCode,
    matchTotp,
    normalizeBackupCode,
    normalizeTotpCode,
    openTotpSecret,
    sameHash,
    sealTotpSecret,
    totpUri,
    twoStepKeyId,
} from '@hushos/crypto/two-step/server';
import { authRepository, twoStepRepository } from '@hushos/db';
import {
    sendSecurityNotice,
    type SecurityNoticeKind,
    type SecurityNoticeMethod,
} from '@hushos/emails/server';
import { authEnv } from '@hushos/env/auth';
import { twoStepEnv } from '@hushos/env/two-step';
import { log as serverLog } from '@hushos/logging';
import { noticeWhen } from './notice-when';
import { serverSetup } from './server-setup';
import { AuthError, TOKEN_PATTERN } from './tokens';

/*
 * Two-step sign-in, the checks (docs/two-step-design.md). The step is a server
 * rule: it decides whether the server opens a session and hands over the
 * password envelope, and it adds nothing to how files are encrypted. This
 * module holds what the routes share: the two-step key, issuing a step token,
 * checking an answer to one (an authenticator code, a backup code, the
 * recovery phrase's signature), its budgets and lockouts, and the notices.
 * `server.ts` has the routes' own logic; `@hushos/db`'s twoStepRepository keeps
 * the rows and what must hold whatever is above it.
 *
 * Security keys (WebAuthn) are not here yet: registration and assertion come
 * with their own change. Nothing below assumes there are none: a token already
 * carries a challenge column, methods are listed from the account's factors,
 * and a proof is one of a union this file checks by `kind`.
 */

type StepBinding = twoStepRepository.StepBinding;
type StepProof = twoStepRepository.StepProof;
type PassedStep = Extract<twoStepRepository.StepPass, { status: 'ok' }>;
type FailedPass = Exclude<twoStepRepository.StepPass, { status: 'ok' }>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function hash(value: string) {
    return createHash('sha256').update(value).digest();
}

/* Whether accounts on this server may turn the step on and manage it (TWO_STEP_ENABLED). */
export function twoStepEnabled() {
    return twoStepEnv.TWO_STEP_ENABLED;
}

/*
 * The routes that set the step up or change it answer 501 while the server
 * does not offer it. Sign-in and the changes the step guards never ask this:
 * an account that has a method is held to it whatever the flag says.
 */
export function requireTwoStepEnabled() {
    if (!twoStepEnabled())
        throw new AuthError('This server does not offer two-step sign-in yet.', 501, {
            code: 'unsupported',
        });
}

/* ------------------------------------------------------------------------- */
/* The two-step key                                                           */
/* ------------------------------------------------------------------------- */

type RingKey = { id: Buffer; key: Uint8Array };

async function named(key: Uint8Array): Promise<RingKey> {
    return { id: Buffer.from(await twoStepKeyId(key)), key };
}

/*
 * The keys TOTP secrets are sealed under and backup codes hashed under
 * (section 8). New rows use `current`: the operator's TWO_STEP_KEY, or without
 * one the key derived from the OPAQUE server setup, wherever that is kept. A
 * row records the id of the key it was made under and is opened by that key:
 * the derived key is always in the ring, so setting TWO_STEP_KEY for the first
 * time strands nothing, and TWO_STEP_PREVIOUS_KEY keeps what an earlier
 * explicit key made.
 */
let ring: Promise<{ current: RingKey; keys: RingKey[] }> | undefined;
export function twoStepKeys() {
    ring ??= (async () => {
        const derived = await named(
            await deriveTwoStepKey(Buffer.from(await serverSetup(), 'base64url')),
        );
        const fromEnv = (value: string | undefined) =>
            value ? named(Buffer.from(value, 'base64url')) : null;
        const explicit = await fromEnv(twoStepEnv.TWO_STEP_KEY);
        const previous = await fromEnv(twoStepEnv.TWO_STEP_PREVIOUS_KEY);
        return {
            current: explicit ?? derived,
            keys: [explicit, previous, derived].filter((key) => key !== null),
        };
    })().catch((error: unknown) => {
        ring = undefined;
        throw error;
    });
    return ring;
}

/*
 * A row names a key this server does not have: the operator took away a key that rows still
 * need. An outage to fix (503), never a wrong answer: nothing is counted for it.
 */
function keyMissing() {
    return new AuthError('Two-step sign-in is unavailable. Please try again later.', 503, {
        cause: Object.assign(new Error('A two-step key that rows were made under is not set.'), {
            name: 'ConfigurationError',
            code: 'TWO_STEP_KEY_MISSING',
        }),
    });
}

/* The key a row names, or a 503. */
async function keyNamed(id: Buffer) {
    const key = (await twoStepKeys()).keys.find((entry) => entry.id.equals(id));
    if (!key) throw keyMissing();
    return key;
}

/* ------------------------------------------------------------------------- */
/* Authenticator apps and backup codes                                        */
/* ------------------------------------------------------------------------- */

type TotpRow = Pick<
    twoStepRepository.TwoStepFactor,
    'id' | 'userId' | 'totpKeyId' | 'totpNonce' | 'totpSecret'
>;

/* The secret of an authenticator app's row, opened under the key it names. The caller wipes it. */
async function openApp(row: TotpRow) {
    if (!row.totpKeyId || !row.totpNonce || !row.totpSecret)
        throw new Error('Not an authenticator app.');
    const key = await keyNamed(row.totpKeyId);
    return openTotpSecret(row.totpSecret, row.totpNonce, key.key, {
        userId: row.userId,
        factorId: row.id,
        keyId: key.id,
    });
}

/*
 * The time steps `code` (six digits, as `readTotpCode` reads them) answers for this app's
 * secret, oldest first: none for a wrong code.
 */
export async function appSteps(row: TotpRow, code: string) {
    const secret = await openApp(row);
    try {
        return await matchTotp(secret, code);
    } finally {
        secret.fill(0);
    }
}

/* On hushos.com the entry reads `HushOS`; on any other server it names the host too. */
const HUSHOS_ORIGIN = 'https://hushos.com';
function issuer() {
    return authEnv.APP_ORIGIN === HUSHOS_ORIGIN
        ? 'HushOS'
        : `HushOS (${new URL(authEnv.APP_ORIGIN).host})`;
}

/*
 * A new authenticator app for an account, not stored yet: its row (the secret
 * sealed under the current key, bound to the account and the factor's id) and
 * what the person is shown once, the secret as base32 and the key URI the QR
 * code encodes.
 */
export async function newTotp(user: { id: string; email: string }) {
    const { current } = await twoStepKeys();
    const id = randomUUID();
    const secret = generateTotpSecret();
    try {
        const { nonce, sealed } = await sealTotpSecret(secret, current.key, {
            userId: user.id,
            factorId: id,
            keyId: current.id,
        });
        return {
            row: {
                id,
                userId: user.id,
                name: 'Authenticator app',
                keyId: current.id,
                nonce: Buffer.from(nonce),
                secret: Buffer.from(sealed),
            },
            shown: {
                id,
                secret: base32(secret),
                uri: totpUri({ issuer: issuer(), email: user.email, secret }),
            },
        };
    } finally {
        secret.fill(0);
    }
}

/*
 * A new set of ten backup codes for an account: as the person sees them, once,
 * and as they are stored, each a keyed, slow hash under the account's salt.
 * Null when the account is gone.
 */
export async function newBackupCodes(userId: string) {
    const state = await twoStepRepository.ensureState(userId);
    if (!state) return null;
    const { current } = await twoStepKeys();
    const codes = new Set<string>();
    while (codes.size < twoStepRepository.BACKUP_CODE_COUNT) codes.add(generateBackupCode());
    const stored: twoStepRepository.BackupCodeInput[] = [];
    for (const code of codes)
        stored.push({
            codeHash: Buffer.from(await hashBackupCode(code, current.key, state.backupCodeSalt)),
            keyId: current.id,
        });
    return { shown: [...codes].map(formatBackupCode), stored };
}

/* ------------------------------------------------------------------------- */
/* Step tokens                                                                */
/* ------------------------------------------------------------------------- */

export type StepMethod = 'webauthn' | 'totp' | 'backup' | 'phrase';

/*
 * What can answer the step for this account now, in the order a client offers
 * them, and what the phrase needs to sign its statement: the account's id,
 * which the statement names, and the recovery envelope's salt and version,
 * since the signing key depends on the salt. A device that has lost everything
 * but the password and the phrase knows none of them, and that is the case the
 * phrase is for. None is secret (the server serves the id and the salt with
 * the recovery envelope at `/auth/recover/start`), and here they go only to
 * someone who has just proved the password. A security key is listed once its
 * assertion can be checked here.
 */
async function stepOffer(userId: string) {
    const two = await twoStepRepository.getTwoStep(userId);
    const recovery = await authRepository.getRecoveryKey(userId);
    const methods: StepMethod[] = [];
    if (two.factors.some((factor) => factor.kind === 'totp')) methods.push('totp');
    if (two.backupCodes.length > 0) methods.push('backup');
    if (recovery) methods.push('phrase');
    return {
        methods,
        ...(recovery
            ? {
                  phrase: {
                      userId,
                      recoveryVersion: recovery.recoveryVersion,
                      wrappingSalt: recovery.wrappingSalt.toString('base64url'),
                  },
              }
            : {}),
    };
}

/*
 * Issues a step token: 32 random bytes, kept by their hash for five minutes,
 * bound to the account and its credential version, and to a session and a
 * purpose for a change. A sign-in's token records the device that proved its
 * key at `login/finish` and the browser's previous session, for the session
 * the step will open.
 */
export async function issueStepToken(input: {
    userId: string;
    purpose: twoStepRepository.StepBinding['purpose'];
    sessionTokenHash: Buffer | null;
    credentialVersion: number;
    deviceId?: string | null;
    previousTokenHash?: Buffer | null;
}) {
    const token = randomBytes(32).toString('base64url');
    const { expiresAt } = await twoStepRepository.createStepAttempt({
        ...input,
        tokenHash: hash(token),
    });
    return { token, expiresAt: expiresAt.toISOString(), ...(await stepOffer(input.userId)) };
}

/* ------------------------------------------------------------------------- */
/* Answers                                                                    */
/* ------------------------------------------------------------------------- */

/* An answer to the step as a client sends it. `webauthn` joins this union with security keys. */
export type StepAnswer =
    | { kind: 'totp'; code: string }
    | { kind: 'backup'; code: string }
    | { kind: 'phrase'; signature: string };
export type StepSubmission = { token: string; proof: StepAnswer };

/* At sign-in a refusal is a 401, as a wrong password is; at a change from a live session, a 403. */
type Where = 'sign-in' | 'change';

const WRONG: Record<StepAnswer['kind'], string> = {
    totp: 'That code didn’t work. Codes change every 30 seconds.',
    backup: 'That backup code didn’t work. Each code works once.',
    phrase: 'That recovery phrase doesn’t match this account. Check each word and try again.',
};

/* The token is gone: timed out, out of wrong answers, or from before a password change. */
function expired(where: Where) {
    return where === 'sign-in'
        ? new AuthError('Your sign-in timed out. Sign in again.', 401, {
              code: 'two-step-expired',
          })
        : new AuthError('That took too long. Try again.', 403, { code: 'two-step-expired' });
}

/*
 * A wrong answer. Which kind of wrong is never said: a code that was already
 * used, one for another account and one that was never a code read the same.
 */
function wrong(where: Where, kind: StepAnswer['kind'], left: number) {
    if (left <= 0)
        return where === 'sign-in'
            ? new AuthError('Too many wrong answers. Sign in again.', 401, {
                  code: 'two-step-expired',
              })
            : new AuthError('Too many wrong answers. Try again.', 403, {
                  code: 'two-step-expired',
              });
    return new AuthError(WRONG[kind], where === 'sign-in' ? 401 : 403, { code: 'two-step' });
}

/* The account has the step on and the request carried no answer to it. */
export function stepRequired() {
    return new AuthError('Confirm it’s you with your second step.', 403, { code: 'two-step' });
}

/*
 * A code as the person typed it, read: an authenticator code with its spaces
 * and hyphens ignored, a backup code normalised. What is still not six digits,
 * or not a backup code's ten characters, is a slip of the hand or the wrong
 * field, never a guess: it is answered 400 and counted nowhere, not against
 * the token, the budgets, the notice or the freeze.
 */
export function readTotpCode(typed: string) {
    const code = normalizeTotpCode(typed);
    if (!code) throw new AuthError('Enter the six digits your authenticator app shows.', 400);
    return code;
}

function readBackupCode(typed: string) {
    const code = normalizeBackupCode(typed);
    if (!code)
        throw new AuthError('Enter a backup code as it was shown: ten letters and numbers.', 400);
    return code;
}

function frozen() {
    return new AuthError(
        'Authenticator codes are paused here after too many wrong ones. Use a backup code or your recovery phrase.',
        403,
        { code: 'totp-frozen' },
    );
}

/*
 * The budget for wrong codes (section 2): ten in 15 minutes for a known
 * device, and ten in 15 minutes for the whole account across every sign-in
 * that proved no device, whatever address it came from. Only what can be
 * guessed is counted, authenticator and backup codes; a key and the phrase are
 * never refused for a spent budget. An answer takes its place before it is
 * checked and gives it back only when it passes, so requests sent at once
 * cannot guess past the budget; with it spent, a code is refused unchecked.
 */
const CODE_BUDGET = { limit: 10, windowMs: 15 * MINUTE_MS } as const;

async function chargeCodeBudget(userId: string, deviceId: string | null) {
    const bucket = hash(
        deviceId ? `two-step:codes:device:${deviceId}` : `two-step:codes:account:${userId}`,
    );
    if (!(await authRepository.consumeRateLimit(bucket, CODE_BUDGET.limit, CODE_BUDGET.windowMs)))
        throw new AuthError(
            'Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.',
            429,
        );
    return bucket;
}

/*
 * "Someone signed in with your password but did not pass the second step": the
 * notice counts every failed step after a correct password, in the pool it
 * came from (a known device, or every sign-in that proved none): wrong codes,
 * wrong backup codes, failed key assertions and failed phrase signatures. The
 * fifth since the pool's last success sends it, and it is sent at most once an
 * hour for an account, from a budget of its own, so failures can never use up
 * the notices that say the step was changed. (Only wrong codes count toward
 * the freeze; the repository keeps that count.)
 */
const FAILED_NOTICE = { at: 5, windowMs: 30 * DAY_MS, everyMs: HOUR_MS } as const;
const failedBucket = (userId: string, deviceId: string | null) =>
    hash(`two-step:failed:${userId}:${deviceId ?? 'new'}`);

type CountedFailure = Extract<twoStepRepository.StepFailure, { status: 'counted' }>;

/* What follows a counted failure: the notices. Never raised: the answer is refused either way. */
async function afterFailure(failure: CountedFailure) {
    try {
        if (failure.pool) {
            const within = await authRepository.consumeRateLimit(
                failedBucket(failure.userId, failure.deviceId),
                FAILED_NOTICE.at - 1,
                FAILED_NOTICE.windowMs,
            );
            if (
                !within &&
                (await authRepository.consumeRateLimit(
                    hash(`two-step:failed-noticed:${failure.userId}`),
                    1,
                    FAILED_NOTICE.everyMs,
                ))
            )
                notifyTwoStep(failure.userId, 'two-step-failed');
        }
        if (failure.froze)
            notifyTwoStep(
                failure.userId,
                failure.pool === 'device' ? 'totp-frozen-device' : 'totp-frozen',
            );
    } catch (error) {
        logFailure('Counting a failed second step failed.', error);
    }
}

/* An answer that was checked and is right, with what to do once the step it is spent on commits. */
export type CheckedStep = {
    binding: StepBinding;
    proof: StepProof;
    kind: StepAnswer['kind'];
    userId: string;
    where: Where;
    /* The code budget this answer took a place in; given back when the step passes. */
    budget: Buffer | null;
};

/* Counts a wrong answer and refuses it. */
async function stepFailed(step: Omit<CheckedStep, 'proof'>): Promise<never> {
    const failure = await twoStepRepository.failStep({ ...step.binding, method: step.kind });
    if (failure.status !== 'counted') throw expired(step.where);
    await afterFailure(failure);
    throw wrong(step.where, step.kind, failure.left);
}

/*
 * A code is a proof only for a time step the app has not taken yet. One that
 * matches a step already taken is a replay and is no proof here, before
 * anything is done on its strength: a caller may act between this check and
 * the lock (deletion stops billing), and a used code must never get that far.
 * The repository refuses a replay again under the account's lock, for two
 * requests that carry one fresh code at the same moment.
 */
async function totpProof(userId: string, code: string): Promise<StepProof | null> {
    const { factors } = await twoStepRepository.getTwoStep(userId);
    const app = factors.find((factor) => factor.kind === 'totp');
    if (!app) return null;
    const steps = await appSteps(app, code);
    const step = steps.find((candidate) => candidate > (app.totpLastStep ?? 0));
    return step === undefined ? null : { method: 'totp', factorId: app.id, step };
}

/*
 * The input is hashed once for each key the account's unused codes were made
 * under (one, unless the operator changed the key since) and compared with
 * every one of them, so a wrong code costs the server one slow hash. Codes
 * made under a key this server no longer has cannot be checked at all: unless
 * the input matched under a key it does have, that is an outage (503), as it
 * is for an authenticator app, and not a wrong code.
 */
async function backupProof(userId: string, code: string): Promise<StepProof | null> {
    const two = await twoStepRepository.getTwoStep(userId);
    if (!two.state || two.backupCodes.length === 0) return null;
    const { keys } = await twoStepKeys();
    let found: Buffer | null = null;
    for (const key of keys) {
        const under = two.backupCodes.filter((stored) => stored.keyId.equals(key.id));
        if (under.length === 0) continue;
        const hashed = Buffer.from(await hashBackupCode(code, key.key, two.state.backupCodeSalt));
        for (const stored of under) if (await sameHash(stored.codeHash, hashed)) found = hashed;
    }
    if (found) return { method: 'backup', codeHash: found };
    if (two.backupCodes.some((stored) => !keys.some((key) => key.id.equals(stored.keyId))))
        throw keyMissing();
    return null;
}

async function phraseProof(
    userId: string,
    stepToken: string,
    signature: string,
): Promise<StepProof | null> {
    const recovery = await authRepository.getRecoveryKey(userId);
    if (!recovery) return null;
    const holds = await verifyTwoStepPhrase(
        { userId, stepToken },
        signature,
        recovery.publicKey.toString('base64url'),
    );
    return holds ? { method: 'phrase' } : null;
}

/*
 * Checks an answer against a live step token, spending nothing. A right answer
 * comes back as the proof the repository takes (passStep), to be passed in the
 * transaction that opens the session or commits the change; the caller then
 * reports how that went with stepPassed or stepNotPassed. A wrong answer is
 * counted against the token and its pool and refused here. A token that is not
 * live under this purpose and session is `two-step-expired`.
 *
 * A code for an app that is frozen in this pool is refused before it is
 * checked, and so is any code once the pool's budget is spent, so neither
 * refusal says whether the code was right. Input that is not a code at all is
 * a 400 before anything is read or counted (readTotpCode), and an answer the
 * server cannot check (a key the operator removed) gives its place in the
 * budget back and counts nothing.
 */
export async function checkStepAnswer(
    bound: Pick<StepBinding, 'purpose' | 'sessionTokenHash'>,
    submission: StepSubmission,
    where: Where,
): Promise<CheckedStep> {
    const answer = submission.proof;
    // Before the token is looked at: what is not a code is not an answer.
    const code =
        answer.kind === 'totp'
            ? readTotpCode(answer.code)
            : answer.kind === 'backup'
              ? readBackupCode(answer.code)
              : null;
    if (!TOKEN_PATTERN.test(submission.token)) throw expired(where);
    const binding: StepBinding = { ...bound, tokenHash: hash(submission.token) };
    const context = await twoStepRepository.getStepContext(binding);
    if (!context) throw expired(where);
    const userId = context.attempt.userId;
    let budget: Buffer | null = null;
    let proof: StepProof | null;
    if (answer.kind === 'phrase')
        proof = await phraseProof(userId, submission.token, answer.signature);
    else {
        if (answer.kind === 'totp' && context.totpFrozen) throw frozen();
        budget = await chargeCodeBudget(userId, context.deviceId);
        try {
            proof =
                answer.kind === 'totp'
                    ? await totpProof(userId, code!)
                    : await backupProof(userId, code!);
        } catch (error) {
            // Not checked, so not a guess: the place it took goes back.
            await authRepository.releaseRateLimit(budget);
            throw error;
        }
    }
    const step = { binding, kind: answer.kind, userId, where, budget };
    if (!proof) return stepFailed(step);
    return { ...step, proof };
}

/*
 * The step did not pass under the lock, though the answer had checked out: the
 * token went meanwhile (`two-step-expired`), the app froze, or the proof was
 * used up by a request that landed first, which is a wrong answer and counted
 * as one. A client is never told which of those a refused proof was.
 */
export async function stepNotPassed(step: CheckedStep, result: FailedPass): Promise<never> {
    if (result.status === 'refused') return stepFailed(step);
    if (result.status === 'frozen') throw frozen();
    throw expired(step.where);
}

/*
 * The step passed and what it authorised is committed: the answer's place in
 * the code budget is given back, the pool's count of failed steps starts
 * again, and the uses the account must hear of are sent. Never raised: the
 * sign-in or the change already happened.
 */
export async function stepPassed(step: CheckedStep, passed: PassedStep) {
    try {
        if (step.budget) await authRepository.releaseRateLimit(step.budget);
        await authRepository.clearRateLimit(failedBucket(step.userId, passed.deviceId));
    } catch (error) {
        logFailure('Settling a passed second step failed.', error);
    }
    if (step.kind === 'backup')
        notifyTwoStep(step.userId, 'backup-code-used', { count: passed.backupCodesLeft ?? 0 });
    if (step.kind === 'phrase') notifyTwoStep(step.userId, 'phrase-used');
}

/* The answer checked out but no step was asked for after all: its place in the budget goes back. */
export async function stepUnused(step: CheckedStep) {
    try {
        if (step.budget) await authRepository.releaseRateLimit(step.budget);
    } catch (error) {
        logFailure('Settling an unused second step failed.', error);
    }
}

/* ------------------------------------------------------------------------- */
/* Notices                                                                    */
/* ------------------------------------------------------------------------- */

export type TwoStepNotice = Extract<
    SecurityNoticeKind,
    | 'two-step-on'
    | 'two-step-off'
    | 'two-step-method-added'
    | 'two-step-method-removed'
    | 'backup-codes-new'
    | 'backup-code-used'
    | 'phrase-used'
    | 'two-step-failed'
    | 'totp-frozen'
    | 'totp-frozen-device'
>;

function logFailure(message: string, error: unknown) {
    serverLog.error({
        message,
        auth: { failure: { name: error instanceof Error ? error.name : typeof error } },
    });
}

const sending = new Set<Promise<void>>();

/*
 * A security notice about the second step, to the account's email (section 7).
 * It cannot be turned off and is not drawn from the devices' budget of ten an
 * hour: a change to the step needs the password and the step, so it cannot be
 * flooded, and the one notice anyone with the password alone can cause (a
 * failed step) has a budget of its own. It names the kind of method and the
 * time, never a method's or a device's name, an address or a browser. Sent
 * after the action and never awaited: the action already happened, and a mail
 * problem is the operator's to see in the log.
 */
export function notifyTwoStep(
    userId: string,
    kind: TwoStepNotice,
    detail: { count?: number; method?: SecurityNoticeMethod } = {},
) {
    const sent = (async () => {
        const user = await authRepository.getUserById(userId);
        if (!user) return;
        await sendSecurityNotice(user.email, {
            kind,
            when: noticeWhen(),
            ...detail,
            accountUrl: new URL('/app/account#two-step', authEnv.APP_ORIGIN).href,
        });
    })()
        .catch((error: unknown) => logFailure('Security notice failed.', error))
        .finally(() => sending.delete(sent));
    sending.add(sent);
}

/* Resolves once every notice sent so far has gone out or failed: for a shutdown, and for tests. */
export async function twoStepNoticesSettled() {
    while (sending.size > 0) await Promise.all(sending);
}
