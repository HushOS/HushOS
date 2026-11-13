import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
    formatBackupCode,
    normalizeBackupCode,
    verifyTwoStepPhrase,
} from '@hushos/crypto/two-step';
import {
    base32,
    generateBackupCodes,
    generateTotpSecret,
    hashBackupCode,
    openTotpSecret,
    sealTotpSecret,
    totpMatches,
    totpUri,
} from '@hushos/crypto/two-step/server';
import { authRepository, twoStepRepository } from '@hushos/db';
import type { TwoStepMethod, TwoStepSessionPurpose } from '@hushos/db/schema';
import { sendSecurityNotice, type SecurityNoticeKind } from '@hushos/emails/server';
import { authEnv } from '@hushos/env/auth';
import { twoStepEnv } from '@hushos/env/two-step';
import { log as serverLog } from '@hushos/logging';
import { hash, noticeWhen, randomToken, serverSetup, supportedEnvelope } from './internal';
import { notify } from './notifications';
import { consumeBoundAttempt, requireSession, startLogin } from './server';
import { AuthError, SESSION_IDLE_SECONDS, TOKEN_PATTERN } from './tokens';
import { twoStepKeyringFromEnv, type TwoStepKeyring } from './two-step-keys';

/*
 * Two-step sign-in, the server's rule (docs/two-step-design.md). After the password, an
 * account that has the step on gets no session, no cookie and no envelope until the step
 * passes: a code from an authenticator app, a backup code, or a signature made with the
 * recovery phrase. The same step is asked before a security change, account deletion and any
 * change to the step itself.
 *
 * The repository (`twoStepRepository`) holds the lines that must not depend on this module:
 * codes and tokens are used once, and what an answer spends commits with what it authorises.
 * This module does what the repository cannot: it holds the two-step key, computes codes and
 * hashes, checks an answer, and tells the account what happened. Every answer is handled in
 * the repository's order: a slot is taken, a code's 15-minute budget is charged, the answer
 * is checked, a wrong one is counted once, and a right one is handed to the function that
 * spends it with the action.
 *
 * TWO_STEP_ENABLED decides only who can turn the step on. Off, the routes that set the step
 * up or manage it answer 501; an account that already has the step is still asked for it.
 */

export function twoStepEnabled() {
    return twoStepEnv.TWO_STEP_ENABLED;
}

function requireEnabled() {
    if (!twoStepEnabled())
        throw new AuthError('Two-step sign-in isn’t available on this server.', 501);
}

/* What a client sends as its answer to a step. */
export type StepAnswer =
    | { kind: 'totp'; code: string }
    | { kind: 'backup'; code: string }
    | { kind: 'phrase'; signature: string };
export type StepInput = { token: string; proof: StepAnswer };

/* What a client is told when it must answer a step: nothing a stranger to the password sees. */
export type StepChallenge = {
    token: string;
    methods: Exclude<TwoStepMethod, 'webauthn'>[];
    expiresAt: string;
    /* What the device needs to sign with the recovery phrase (docs/two-step-design.md 5). */
    phrase?: { userId: string; recoveryVersion: number; wrappingSalt: string };
};

const STEP_TOKEN_MS = 5 * 60_000;
const CODE_BUDGET = 10;
const CODE_BUDGET_MS = 15 * 60_000;

/* ------------------------------------------------------------------------- */
/* The two-step key                                                           */
/* ------------------------------------------------------------------------- */

let keyring: Promise<TwoStepKeyring> | undefined;
/* This server's keys, built once. */
function keys() {
    keyring ??= (async () => {
        const ring = await twoStepKeyringFromEnv(await serverSetup());
        // With a setup there is always a key: the derived one, when the operator set none.
        if (!ring) throw new Error('This server has no two-step key.');
        return ring;
    })().catch((error: unknown) => {
        keyring = undefined;
        throw error;
    });
    return keyring;
}

/* This process, as the worker tells one web process from another: new at every start. */
const INSTANCE_ID = randomUUID();

/*
 * Says which key this process seals new secrets under and which keys it can read (their ids,
 * never the keys), and that it is running now. The web service calls it at its readiness
 * checks for as long as it runs: the worker re-seals older secrets towards a key only when
 * every web process seen lately seals under it and has for a while
 * (docs/two-step-design.md 8), so a process that is still on the old key, or back on it, is
 * never handed a secret it cannot open. It throws when the word could not be written.
 */
export async function reportTwoStepKeys() {
    const ring = await keys();
    await twoStepRepository.reportKeyReader({
        instanceId: INSTANCE_ID,
        sealingKeyId: ring.current.id,
        readableKeyIds: [...ring.byId.keys()].map((id) => Buffer.from(id, 'hex')),
    });
}

async function keyFor(keyId: Buffer) {
    return (await keys()).byId.get(keyId.toString('hex')) ?? null;
}

/*
 * A stored row that no key this server has will open: sealed or hashed under a key that was
 * rotated away, or damaged. That is the server's fault, never a wrong answer: the request is
 * answered 503, nothing is counted, and the operator's log names the key the row wants.
 */
class KeyUnavailable extends Error {
    constructor(
        readonly keyId: Buffer,
        readonly row: 'totp' | 'backup-codes',
    ) {
        super('No two-step key this server has opens a stored row.');
        this.name = 'TwoStepKeyUnavailable';
    }
}

function unavailable(error: KeyUnavailable) {
    // `sealedWith` is the key's id, the first bytes of a hash of the key: not a secret, and
    // named so that the log's redaction of anything called a key leaves it readable.
    serverLog.error({
        message: 'A two-step row names a key this server does not have, or does not open under it.',
        twoStep: { row: error.row, sealedWith: error.keyId.toString('hex') },
    });
    return new AuthError(
        'Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later.',
        503,
        // The server's own 503, told apart by its code from one a proxy sends: this one says
        // nothing was looked at and nothing changed.
        { code: 'step-unavailable' },
    );
}

/*
 * Bookkeeping that runs after the action it belongs to has committed, or been refused: a
 * budget handed back, a log line, a count read for a notice. A database blip there must not
 * turn a finished action into an error, so it is logged and the request goes on.
 */
async function quietly(what: string, run: () => Promise<unknown>) {
    try {
        await run();
    } catch (error) {
        serverLog.error({
            message: 'Two-step bookkeeping failed.',
            twoStep: { what, failure: error instanceof Error ? error.name : typeof error },
        });
    }
}

/* ------------------------------------------------------------------------- */
/* Notices and the security log                                               */
/* ------------------------------------------------------------------------- */

type StepNotice = Exclude<
    SecurityNoticeKind,
    'new-device' | 'device-removed' | 'devices-removed' | 'password-attempts'
>;

/*
 * A security notice about the step, by email and to the account's devices
 * (docs/two-step-design.md 7), sent after the action and never awaited: the action already
 * happened, and a mail or push problem is the operator's. Changes to the step are never
 * dropped: each needs the password and the step, so nobody can flood them. Only the
 * failed-step notice has a budget, its own (one an hour), so a run of failures cannot use up
 * anything a later "step turned off" would need. It names the kind of method and the time,
 * never a name anyone chose.
 *
 * The push names an event of the same kind as the email, and carries nothing else: each
 * device fetches the event over its own session and writes the words itself. Like every
 * security notice it cannot be turned off. A device the action signed out (a reset signs out
 * all of them) has no registration left, so it hears by email alone.
 */
function notice(userId: string, kind: StepNotice, extra: { count?: number; method?: string } = {}) {
    void (async () => {
        const user = await authRepository.getUserById(userId);
        if (!user) return;
        // A push problem is never the mail's, and the mail does not wait for it.
        const pushed =
            kind === 'backup-code-used'
                ? notify(userId, kind, { left: extra.count ?? 0 })
                : notify(userId, kind, {});
        void pushed.catch((error: unknown) =>
            serverLog.error({
                message: 'Two-step notice push failed.',
                notifications: {
                    kind,
                    failure: error instanceof Error ? error.name : typeof error,
                },
            }),
        );
        await sendSecurityNotice(user.email, {
            kind,
            when: noticeWhen(),
            accountUrl: new URL('/app/account', authEnv.APP_ORIGIN).href,
            ...extra,
        });
    })().catch((error: unknown) =>
        serverLog.error({
            message: 'Two-step notice failed.',
            auth: { notice: kind, failure: error instanceof Error ? error.name : typeof error },
        }),
    );
}

/* The notice a rotation sends of itself: the phrase replaced, or the account key rotated with it. */
export function noticeOfRotation(userId: string, action: 'recovery-key' | 'master-key') {
    notice(userId, action === 'master-key' ? 'account-key-rotated' : 'phrase-replaced');
}
/*
 * The notice a reset sends of itself: the password and the phrase replaced with the old
 * phrase, and every session ended. Whoever did it could open the address's mail and had the
 * phrase; the owner, if that was someone else, hears of it here and nowhere else.
 */
export function noticeOfReset(userId: string) {
    notice(userId, 'password-reset');
}

/* One line of the account's security log. A log problem never undoes what it records. */
async function record(input: Parameters<typeof twoStepRepository.recordSecurityEvent>[0]) {
    try {
        await twoStepRepository.recordSecurityEvent(input);
    } catch (error) {
        serverLog.error({
            message: 'Security log write failed.',
            auth: {
                event: input.kind,
                failure: error instanceof Error ? error.name : typeof error,
            },
        });
    }
}

const poolDevice = (attempt: twoStepRepository.StepAttempt) =>
    attempt.pool.kind === 'device' ? attempt.pool.deviceId : null;

/* How many failed-step lines one account's log takes in an hour. */
const FAILED_LINES_AN_HOUR = 10;

/*
 * What a counted wrong answer sets off:
 * - a log line, up to ten an hour for an account. Wrong phrase answers have no budget, so
 *   without the cap whoever has the password could bury every other line under these;
 * - from the fifth in a row, the notice, once an hour for each of its two forms: a sign-in
 *   that failed says nobody got in; a change that failed came from a session that is in;
 * - the freeze notice, when this failure froze the app.
 */
async function afterFailure(
    attempt: twoStepRepository.StepAttempt,
    failure: twoStepRepository.StepFailure,
    method: TwoStepMethod,
    flow: Flow,
) {
    if (failure.status !== 'counted') return;
    const { userId } = attempt;
    await quietly('failed-step', async () => {
        if (
            await authRepository.consumeRateLimit(
                hash(`auth:two-step:failed-log:${userId}`),
                FAILED_LINES_AN_HOUR,
                60 * 60_000,
            )
        )
            await record({ userId, kind: 'step-failed', method, deviceId: poolDevice(attempt) });
        const kind = flow === 'sign-in' ? 'step-failed' : 'change-step-failed';
        if (
            failure.notice &&
            (await authRepository.consumeRateLimit(
                hash(`auth:two-step:failed-notice:${kind}:${userId}`),
                1,
                60 * 60_000,
            ))
        )
            notice(userId, kind);
        if (failure.froze) {
            await record({ userId, kind: 'totp-frozen', method: 'totp' });
            notice(userId, 'totp-frozen');
        }
    });
}

/* ------------------------------------------------------------------------- */
/* Answering a step                                                           */
/* ------------------------------------------------------------------------- */

type Flow = 'sign-in' | 'change';

/*
 * How each refusal is answered. A sign-in has no session to lose, so its wrong answers are
 * 401; a signed-in session's are 403, which no client reads as "signed out".
 */
const refusals = {
    wrong(flow: Flow, method: TwoStepMethod, ended: boolean) {
        if (ended)
            return new AuthError(
                flow === 'sign-in'
                    ? 'Too many wrong answers. Enter your password again.'
                    : 'Too many wrong answers. Start again.',
                flow === 'sign-in' ? 401 : 403,
                { code: 'step-expired' },
            );
        const message =
            method === 'totp'
                ? 'That code didn’t work. Codes change every 30 seconds.'
                : method === 'backup'
                  ? 'That backup code didn’t work. Each code works once.'
                  : 'That recovery phrase didn’t work. Check each word and try again.';
        return new AuthError(message, flow === 'sign-in' ? 401 : 403, { code: 'step-wrong' });
    },
    expired: (flow: Flow) =>
        new AuthError(
            flow === 'sign-in'
                ? 'This sign-in timed out. Enter your password again.'
                : 'This confirmation timed out. Start again.',
            flow === 'sign-in' ? 401 : 403,
            { code: 'step-expired' },
        ),
    frozen: () =>
        new AuthError(
            'Your authenticator app is paused on this device. Use a backup code or your recovery phrase.',
            403,
            { code: 'step-frozen' },
        ),
    limited: () =>
        new AuthError(
            'Too many wrong codes. Try again in 15 minutes, or use your recovery phrase.',
            429,
            { code: 'step-limited' },
        ),
    required: () => new AuthError('This needs your second step.', 403, { code: 'two-step' }),
};

/* The 15-minute budget a code is charged to: the device's own, or the account's for sign-ins that proved none. */
function codeBucket(attempt: twoStepRepository.StepAttempt) {
    return hash(
        attempt.pool.kind === 'device'
            ? `auth:two-step:codes:device:${attempt.pool.deviceId}`
            : `auth:two-step:codes:account:${attempt.userId}`,
    );
}

/* The app's secret, opened under whichever known key sealed it. */
async function totpSecret(
    userId: string,
    factor: { id: string; keyId: Buffer; nonce: Buffer; sealedSecret: Buffer },
) {
    const key = await keyFor(factor.keyId);
    const secret = key
        ? await openTotpSecret({
              sealed: factor.sealedSecret,
              nonce: factor.nonce,
              key,
              userId,
              factorId: factor.id,
          })
        : null;
    if (!secret) throw new KeyUnavailable(factor.keyId, 'totp');
    return secret;
}

/*
 * What a right answer spends, or null for a wrong one. Nothing is written here. A code the
 * app really shows but that was already used is a wrong answer here, and is counted as one
 * by the caller: whatever the action does before it reaches the repository (a deletion stops
 * what is billed first) must not happen for a replay. The repository refuses a replay again.
 */
async function rightAnswer(
    attempt: twoStepRepository.StepAttempt,
    proof: StepAnswer,
): Promise<(twoStepRepository.StepSpend & { freshPhrase?: boolean }) | null> {
    const { userId } = attempt;
    if (proof.kind === 'totp') {
        const factor = await twoStepRepository.getTotpFactor(userId);
        if (!factor) return null;
        const secret = await totpSecret(userId, factor);
        const steps = await totpMatches(secret, proof.code);
        secret.fill(0);
        // The earliest matching step not yet used; none left is a replay.
        const unused = steps.filter((step) => step > factor.lastStep);
        if (unused.length === 0) return null;
        return { method: 'totp', factorId: factor.id, step: Math.min(...unused) };
    }
    if (proof.kind === 'backup') {
        const code = normalizeBackupCode(proof.code);
        const stored = code ? await twoStepRepository.getBackupCodes(userId) : null;
        if (!code || !stored) return null;
        // Hashed once for each key the unused codes were made under: one, outside a rotation.
        const hashes = new Map<string, Uint8Array>();
        let unknown: Buffer | null = null;
        let compared = 0;
        for (const candidate of stored.codes) {
            const id = candidate.keyId.toString('hex');
            if (!hashes.has(id)) {
                const key = await keyFor(candidate.keyId);
                if (!key) {
                    unknown = candidate.keyId;
                    continue;
                }
                hashes.set(id, await hashBackupCode({ code, key, salt: stored.salt }));
            }
            const hashed = hashes.get(id);
            if (!hashed) continue;
            compared++;
            if (timingSafeEqual(hashed, candidate.codeHash))
                return { method: 'backup', codeHash: candidate.codeHash };
        }
        // With no code this server could compare, the answer cannot be told right from wrong.
        // With some, it matched none of them, and that is a wrong answer like any other.
        if (unknown && compared === 0) throw new KeyUnavailable(unknown, 'backup-codes');
        return null;
    }
    const recovery = await authRepository.getRecoveryKey(userId);
    if (!recovery) return null;
    const signed = await verifyTwoStepPhrase(
        { userId, tokenDigest: attempt.tokenHash.toString('base64url') },
        proof.signature,
        recovery.publicKey.toString('base64url'),
    );
    if (!signed) return null;
    // Noted now, of the key that answered: by the time the action has run, a rotation has
    // replaced it, and a key read then is the new one, not the one this answer used. A reset
    // or a rotation made it in the last fifteen minutes, or not; an account's first key
    // (version 1) was made at sign-up, by neither.
    const freshPhrase =
        recovery.recoveryVersion > 1 && Date.now() - recovery.updatedAt.getTime() < FRESH_PHRASE_MS;
    return { method: 'phrase', freshPhrase };
}

/* How long after a reset or a rotation its new phrase answers a step without a notice of its own. */
const FRESH_PHRASE_MS = 15 * 60_000;

type Checked = {
    attempt: twoStepRepository.StepAttempt;
    proof: twoStepRepository.StepProof;
    method: Exclude<TwoStepMethod, 'webauthn'>;
    flow: Flow;
    /* The code budget this answer was charged to, to hand back when the step passes. */
    bucket: Buffer | null;
    /*
     * The recovery phrase answered, and the key it is the phrase of was made by a reset or a
     * rotation in the last fifteen minutes: said of the key as it was when the answer was
     * checked, before whatever the answer authorises replaces it.
     */
    freshPhrase: boolean;
    /*
     * What spending the answer left, as the repository said it while it spent it (`proof.spent`):
     * how many backup codes the account had left then. Null until the answer is spent.
     */
    spent: twoStepRepository.StepSpent | null;
};

/*
 * Takes a slot on the token, charges a code's budget, and checks the answer, in that order:
 * however many requests arrive at once, only five are ever checked for a token, and a
 * budget that is nearly spent is not checked past. A wrong answer is counted, the account is
 * told as the design has it, and the refusal is thrown. A right one is returned unspent: the
 * caller hands it to the repository function that spends it with the action (`settle`).
 */
async function checkAnswer(input: {
    step: StepInput;
    purpose: 'login' | TwoStepSessionPurpose;
    sessionTokenHash: Buffer | null;
}): Promise<Checked> {
    const flow: Flow = input.purpose === 'login' ? 'sign-in' : 'change';
    const { token, proof } = input.step;
    if (!TOKEN_PATTERN.test(token)) throw refusals.expired(flow);
    const tokenHash = hash(token);
    const taken = await twoStepRepository.takeStepAnswer({
        tokenHash,
        purpose: input.purpose,
        sessionTokenHash: input.sessionTokenHash,
        method: proof.kind,
    });
    if (taken.status !== 'ok')
        throw taken.status === 'frozen' ? refusals.frozen() : refusals.expired(flow);
    const { attempt } = taken;
    // Only what can be guessed has a budget: the phrase is never refused for a spent one.
    const bucket = proof.kind === 'phrase' ? null : codeBucket(attempt);
    if (bucket && !(await authRepository.consumeRateLimit(bucket, CODE_BUDGET, CODE_BUDGET_MS))) {
        // Refused unchecked, so the slot goes back: the refusal says the phrase still works,
        // and on a token's last slot it would not if this one stayed taken.
        await quietly('limited', () => twoStepRepository.returnStepAnswer(attempt));
        throw refusals.limited();
    }
    let right: Awaited<ReturnType<typeof rightAnswer>>;
    try {
        right = await rightAnswer(attempt, proof);
    } catch (error) {
        if (!(error instanceof KeyUnavailable)) throw error;
        // Nothing was looked at, so nothing is used up: the budget and the slot go back.
        await quietly('unavailable', async () => {
            if (bucket) await authRepository.releaseRateLimit(bucket);
            await twoStepRepository.returnStepAnswer(attempt);
        });
        throw unavailable(error);
    }
    if (!right) {
        const failure = await twoStepRepository.recordStepFailure(attempt);
        await afterFailure(attempt, failure, proof.kind, flow);
        throw refusals.wrong(
            flow,
            proof.kind,
            failure.status === 'counted' ? failure.tokenEnded : true,
        );
    }
    const { freshPhrase = false, ...spend } = right;
    const checked: Checked = {
        attempt,
        proof: { tokenHash, spend, spent: (left) => (checked.spent = left) },
        method: proof.kind,
        flow,
        bucket,
        freshPhrase,
        spent: null,
    };
    return checked;
}

/*
 * After the gated function ran. Passed: the code's budget is handed back, and a backup code or
 * the phrase is logged and told to the account. Refused: the reason the repository gave is
 * answered; a code it found already used was counted there, once, and its count is acted on
 * here without counting again.
 */
async function settle(
    checked: Checked,
    refusal: twoStepRepository.TwoStepRefusal | null,
    passed: {
        deviceId?: string | null;
        signIn?: boolean;
        /* The action deleted the account: nobody is left to log for or to tell. */
        accountGone?: boolean;
        /*
         * The action replaced the account's backup codes: a code that answered the step was
         * one of the set that is gone now, so "a backup code was used, N are left" would
         * count codes that no longer work. The "new backup codes were made" notice says what
         * happened; the use is still written to the security log.
         */
        codesReplaced?: boolean;
    } = {},
) {
    const { attempt, method, flow, freshPhrase } = checked;
    if (refusal) {
        if (refusal.reason === 'spent') {
            await afterFailure(attempt, refusal.failure, method, flow);
            throw refusals.wrong(
                flow,
                method,
                refusal.failure.status === 'counted' ? refusal.failure.tokenEnded : true,
            );
        }
        // The answer was right and nothing was counted: its budget goes back.
        await release(checked);
        if (refusal.reason === 'frozen') throw refusals.frozen();
        if (refusal.reason === 'required') throw refusals.required();
        throw refusal.reason === 'step'
            ? refusals.wrong(flow, method, false)
            : refusals.expired(flow);
    }
    // The action is done. Nothing below may undo that for the caller.
    await release(checked);
    if (passed.accountGone) return;
    await quietly('passed', async () => {
        const { userId } = attempt;
        const deviceId = passed.deviceId ?? poolDevice(attempt);
        if (method === 'backup') {
            if (!passed.signIn)
                await record({ userId, kind: 'backup-code-used', method, deviceId });
            if (passed.codesReplaced) return;
            // How many were left when the code was spent, as the repository counted it in that
            // transaction. Never counted again here: the action the code authorised may have
            // made a new set (ten) or deleted the set, and that would be another set's count.
            const left = checked.spent?.backupCodesLeft;
            if (typeof left !== 'number')
                throw new Error(
                    'A backup code passed the step and its count did not come with it.',
                );
            notice(userId, 'backup-code-used', { count: left });
        }
        if (method === 'phrase') {
            if (!passed.signIn) await record({ userId, kind: 'phrase-used', method, deviceId });
            // The sign-in that follows a reset or a rotation answers with the new words on the
            // person's behalf: a mail a minute later saying their phrase was used would only
            // alarm, about something they did themselves. So none is sent when the key that
            // answered (not whatever key the account has by now) was made by such a change
            // in the last fifteen minutes. The log line above is written all the same.
            if (!freshPhrase) notice(userId, 'phrase-used');
        }
    });
}

/*
 * Gives a right answer's budget back when the step passed, or when the action stopped for a
 * reason of its own: nothing was guessed, so nothing stays charged.
 */
async function release(checked: Checked | null) {
    const bucket = checked?.bucket;
    if (bucket) await quietly('release', () => authRepository.releaseRateLimit(bucket));
}

/*
 * Runs what stands between a right answer and the repository function that spends it: billing
 * stopped before a deletion, an envelope decoded, a secret sealed. If that throws, the action
 * stopped for a reason of its own, and the answer's budget goes back.
 */
export async function beforeSpending<T>(checked: Checked | null, run: () => Promise<T>) {
    try {
        return await run();
    } catch (error) {
        await release(checked);
        throw error;
    }
}

/* ------------------------------------------------------------------------- */
/* The step at sign-in                                                        */
/* ------------------------------------------------------------------------- */

/* What can answer the token: the app unless it is frozen for it, a backup code while any is left, the phrase. */
async function challenge(token: string, userId: string, expiresAt: Date): Promise<StepChallenge> {
    const [status, attempt, recovery] = await Promise.all([
        twoStepRepository.getTwoStep(userId),
        twoStepRepository.getStepAttempt(hash(token)),
        authRepository.getRecoveryKey(userId),
    ]);
    const methods: StepChallenge['methods'] = [];
    if (status.methods.some((method) => method.kind === 'totp') && !attempt?.totpFrozen)
        methods.push('totp');
    if (status.backupCodesLeft > 0) methods.push('backup');
    if (recovery) methods.push('phrase');
    return {
        token,
        methods,
        expiresAt: expiresAt.toISOString(),
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
 * The password was right and the account asks for the step: a step token in place of the
 * session, carrying the device the session would attach to (its proof is checked again where
 * the token is stored) and the browser's previous session. No session, no cookie, no envelope.
 */
export async function startLoginStep(input: {
    userId: string;
    credentialVersion: number;
    previousTokenHash: Buffer | null;
    device?: { id: string; signature: Buffer; attemptDigest: Buffer };
}): Promise<StepChallenge> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + STEP_TOKEN_MS);
    await twoStepRepository.createStepAttempt({
        purpose: 'login',
        tokenHash: hash(token),
        userId: input.userId,
        credentialVersion: input.credentialVersion,
        device: input.device ?? null,
        previousTokenHash: input.previousTokenHash,
        expiresAt,
    });
    return challenge(token, input.userId, expiresAt);
}

/* How a notice says a sign-in was made: the password and the kind of second step. */
const SIGNED_IN_WITH = {
    totp: 'Your password and an authenticator code',
    backup: 'Your password and a backup code',
    phrase: 'Your password and your recovery phrase',
} as const;

/*
 * Answers a sign-in's step. On a right answer the session is opened by the repository in the
 * transaction that spends the answer, and what `finishLogin` returns today is returned: the
 * user, the envelope, the device and the session token.
 */
export async function finishLoginStep(input: StepInput) {
    const checked = await checkAnswer({ step: input, purpose: 'login', sessionTokenHash: null });
    const sessionToken = randomToken();
    const result = await twoStepRepository.openSteppedSession({
        ...checked.proof,
        session: {
            tokenHash: hash(sessionToken),
            expiresAt: new Date(Date.now() + SESSION_IDLE_SECONDS * 1000),
        },
    });
    if (result.status === 'suspended') {
        await release(checked);
        throw new AuthError('This account is suspended. Contact whoever runs this instance.', 403);
    }
    if (result.status !== 'ok') {
        await settle(
            checked,
            result.status === 'spent'
                ? { status: 'two-step', reason: 'spent', failure: result.failure }
                : { status: 'two-step', reason: result.status },
        );
        throw refusals.expired('sign-in');
    }
    const { user, key, device } = result;
    await record({ userId: user.id, kind: 'sign-in', method: checked.method, deviceId: device.id });
    await settle(checked, null, {
        deviceId: device.id,
        signIn: true,
    });
    return {
        user,
        envelope: {
            envelopeVersion: supportedEnvelope(key.envelopeVersion),
            keyVersion: key.keyVersion,
            credentialVersion: key.credentialVersion,
            wrappingSalt: key.wrappingSalt.toString('base64url'),
            wrappingNonce: key.wrappingNonce.toString('base64url'),
            encryptedKey: key.encryptedKey.toString('base64url'),
        },
        device: { id: device.id, attached: device.attached, registered: device.registered },
        newDevice: device.created === 'password',
        signedInWith: SIGNED_IN_WITH[checked.method],
        sessionToken,
    };
}

/* ------------------------------------------------------------------------- */
/* The step before a change                                                   */
/* ------------------------------------------------------------------------- */

/*
 * A step token for a signed-in session and one purpose (docs/two-step-design.md 4): the
 * action's own request then carries the token and the answer. An account without the step
 * has nothing to ask.
 */
export async function startStepChallenge(
    sessionToken: string | null,
    purpose: TwoStepSessionPurpose,
) {
    const { user, token } = await requireSession(sessionToken, 'Sign in to continue.');
    if (!(await twoStepRepository.hasTwoStep(user.id)))
        throw new AuthError('Two-step sign-in is off for this account.', 409);
    const sessionTokenHash = hash(token);
    if (
        !(await authRepository.consumeRateLimit(
            hash(`auth:two-step:challenge:${sessionTokenHash.toString('hex')}`),
            30,
            15 * 60_000,
        ))
    )
        throw new AuthError('Too many attempts. Please try again in 15 minutes.', 429);
    const stepToken = randomToken();
    const expiresAt = new Date(Date.now() + STEP_TOKEN_MS);
    await twoStepRepository.createStepAttempt({
        purpose,
        tokenHash: hash(stepToken),
        userId: user.id,
        credentialVersion: user.credentialVersion,
        sessionTokenHash,
        expiresAt,
    });
    return challenge(stepToken, user.id, expiresAt);
}

/*
 * The step for a change a session is making, checked before anything is written. Null when
 * the account has no step. With the step on and no answer sent it is refused here, unless the
 * action may turn out not to need one (`optional`: the repository then decides).
 */
export async function checkChangeStep(input: {
    userId: string;
    sessionToken: string;
    purpose: TwoStepSessionPurpose;
    step: StepInput | undefined;
    optional?: boolean;
}): Promise<Checked | null> {
    if (!(await twoStepRepository.hasTwoStep(input.userId))) return null;
    if (!input.step) {
        if (input.optional) return null;
        throw refusals.required();
    }
    return checkAnswer({
        step: input.step,
        purpose: input.purpose,
        sessionTokenHash: hash(input.sessionToken),
    });
}

/* After a gated change: `result` is whatever the repository answered. */
export async function settleChangeStep(
    checked: Checked | null,
    result: unknown,
    done: boolean,
    options: { accountGone?: boolean; codesReplaced?: boolean } = {},
) {
    const refusal =
        typeof result === 'object' &&
        result !== null &&
        'status' in result &&
        result.status === 'two-step'
            ? (result as twoStepRepository.TwoStepRefusal)
            : null;
    if (!checked) {
        // The step was turned on between the check and the change, or an action that looked
        // as if it needed none did: the repository held the line.
        if (refusal) throw refusals.required();
        return;
    }
    if (refusal) return settle(checked, refusal);
    if (!done) return release(checked);
    return settle(checked, null, options);
}

/* ------------------------------------------------------------------------- */
/* Setting the step up and managing it                                        */
/* ------------------------------------------------------------------------- */

const iso = (value: Date | null) => value?.toISOString() ?? null;

/* The account's step as its settings show it. Any session of the account. */
export async function getTwoStep(sessionToken: string | null) {
    requireEnabled();
    const { user } = await requireSession(sessionToken, 'Sign in to see two-step sign-in.');
    const status = await twoStepRepository.getTwoStep(user.id);
    return {
        ...status,
        methods: status.methods.map((method) => ({
            ...method,
            createdAt: method.createdAt.toISOString(),
            lastUsedAt: iso(method.lastUsedAt),
        })),
    };
}

/* Changing the step asks for the password again: the first half of that OPAQUE exchange. */
export async function startTwoStepReauth(sessionToken: string | null, startLoginRequest: string) {
    requireEnabled();
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in to change two-step sign-in.',
    );
    return startLogin(user.email, startLoginRequest, {
        purpose: 'two-step',
        sessionTokenHash: hash(token),
        userId: user.id,
    });
}

export type TwoStepChange = {
    attemptToken: string;
    finishLoginRequest: string;
    twoStep?: StepInput;
};

async function requireChange(sessionToken: string | null, input: TwoStepChange) {
    requireEnabled();
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in to change two-step sign-in.',
    );
    await consumeBoundAttempt(
        'two-step',
        user,
        token,
        input,
        () => new AuthError('That password isn’t right. Check it and try again.', 403),
    );
    return { user, token };
}

/* The issuer an authenticator app shows: a self-hosted server's names its host. */
function issuer() {
    const host = new URL(authEnv.APP_ORIGIN).host;
    return /^(?:www\.)?hushos\.com$/.test(host) ? 'HushOS' : `HushOS (${host})`;
}

/*
 * Starts enrolling an authenticator app: the password again and, once the step is on, the
 * step. The secret is made here, sealed, stored pending for ten minutes, and returned once.
 */
export async function startTotpEnrolment(sessionToken: string | null, input: TwoStepChange) {
    const { user, token } = await requireChange(sessionToken, input);
    await requireRecoveryKey(user.id);
    const checked = await checkChangeStep({
        userId: user.id,
        sessionToken: token,
        purpose: 'two-step',
        step: input.twoStep,
    });
    const secret = generateTotpSecret();
    const id = randomUUID();
    const started = await beforeSpending(checked, async () => {
        const { current } = await keys();
        const sealed = await sealTotpSecret({
            secret,
            key: current.key,
            userId: user.id,
            factorId: id,
        });
        return twoStepRepository.startTotpFactor({
            id,
            userId: user.id,
            keyId: Buffer.from(sealed.keyId),
            nonce: Buffer.from(sealed.nonce),
            sealedSecret: Buffer.from(sealed.sealed),
            step: checked ? { sessionTokenHash: hash(token), ...checked.proof } : undefined,
        });
    });
    await settleChangeStep(checked, started, started.status === 'ok');
    if (started.status !== 'ok') throw new AuthError('Sign in to change two-step sign-in.', 401);
    return {
        id,
        secret: base32(secret),
        uri: totpUri({ secret, email: user.email, issuer: issuer() }),
        expiresAt: started.expiresAt.toISOString(),
    };
}

/*
 * The recovery phrase passes the step, so the step is turned on only for an account that
 * already has its recovery key. One that has none yet finishes account setup first: a key
 * added afterwards, from a session alone, would be a second step nobody was asked for.
 */
async function requireRecoveryKey(userId: string) {
    if (!(await authRepository.getRecoveryKey(userId)))
        throw new AuthError('Finish setting up your account first.', 409, {
            code: 'setup-required',
        });
}

async function freshBackupCodes(userId: string) {
    const { current } = await keys();
    const { backupCodeSalt } = await twoStepRepository.ensureTwoStepState(userId);
    const codes = generateBackupCodes();
    const hashes = [];
    for (const code of codes) {
        hashes.push(
            Buffer.from(await hashBackupCode({ code, key: current.key, salt: backupCodeSalt })),
        );
        // Each hash is some 25 ms of Argon2id on this thread. Between two, the event loop
        // gets a turn, so ten in a row never hold every other request for a quarter second.
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { codes: codes.map(formatBackupCode), set: { keyId: current.id, hashes } };
}

/*
 * Confirms the pending app with a current code. The account's first method turns the step
 * on: its backup codes are made here and returned once.
 */
export async function confirmTotpEnrolment(
    sessionToken: string | null,
    factorId: string,
    code: string,
) {
    requireEnabled();
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in to change two-step sign-in.',
    );
    const wrong = () =>
        new AuthError('That code didn’t work. Codes change every 30 seconds.', 400, {
            code: 'step-wrong',
        });
    if (
        !(await authRepository.consumeRateLimit(
            hash(`auth:two-step:confirm:${hash(token).toString('hex')}`),
            20,
            15 * 60_000,
        ))
    )
        throw new AuthError('Too many attempts. Please try again in 15 minutes.', 429);
    await requireRecoveryKey(user.id);
    const pending = await twoStepRepository.getPendingTotpFactor({ userId: user.id, factorId });
    if (!pending) throw new AuthError('This setup timed out. Start again.', 404);
    const secret = await totpSecret(user.id, pending).catch((error: unknown) => {
        throw error instanceof KeyUnavailable ? unavailable(error) : error;
    });
    const steps = await totpMatches(secret, code);
    secret.fill(0);
    if (steps.length === 0) throw wrong();
    const confirm = (backupCodes?: { keyId: Buffer; hashes: Buffer[] }) =>
        twoStepRepository.confirmTotpFactor({
            userId: user.id,
            factorId,
            step: Math.max(...steps),
            sessionTokenHash: hash(token),
            credentialVersion: user.credentialVersion,
            backupCodes,
        });
    let fresh = (await twoStepRepository.hasTwoStep(user.id))
        ? null
        : await freshBackupCodes(user.id);
    let result = await confirm(fresh?.set);
    // The last method went between the look and the confirmation: this one turns the step on after all.
    if (result.status === 'codes-required') {
        fresh = await freshBackupCodes(user.id);
        result = await confirm(fresh.set);
    }
    switch (result.status) {
        case 'ok':
            break;
        case 'session':
            throw new AuthError('Sign in to change two-step sign-in.', 401);
        case 'step':
            throw wrong();
        default:
            throw new AuthError('This setup timed out. Start again.', 404);
    }
    if (result.turnedOn) {
        await record({ userId: user.id, kind: 'two-step-on', method: 'totp' });
        notice(user.id, 'two-step-on', { method: 'An authenticator app' });
    } else {
        await record({ userId: user.id, kind: 'method-added', method: 'totp' });
        notice(user.id, 'two-step-app-added');
    }
    // One of two answers, each saying what happened: the codes when this turned the step on,
    // `replaced` when it took over from an earlier app. Never an empty reply, which a client
    // could not tell from a proxy's.
    return result.turnedOn && fresh ? { backupCodes: fresh.codes } : { replaced: true as const };
}

/*
 * Removes a method: the password and, for a confirmed one, the step, by any method, the one
 * being removed included. Removing the last turns the step off.
 */
export async function removeTwoStepMethod(
    sessionToken: string | null,
    factorId: string,
    input: TwoStepChange,
) {
    const { user, token } = await requireChange(sessionToken, input);
    const before = await twoStepRepository.getTwoStep(user.id);
    const confirmed = before.methods.some((method) => method.id === factorId);
    // A pending method is the person's own unfinished setup and needs no step.
    const checked = await checkChangeStep({
        userId: user.id,
        sessionToken: token,
        purpose: 'two-step',
        step: input.twoStep,
        optional: !confirmed,
    });
    const removed = await beforeSpending(checked, () =>
        twoStepRepository.removeFactor({
            userId: user.id,
            factorId,
            step: checked ? { sessionTokenHash: hash(token), ...checked.proof } : undefined,
        }),
    );
    await settleChangeStep(checked, removed, removed.status === 'ok');
    if (removed.status !== 'ok') throw new AuthError('This method isn’t on your account.', 404);
    if (removed.turnedOff) {
        await record({ userId: user.id, kind: 'two-step-off', method: removed.kind });
        notice(user.id, 'two-step-off');
    } else if (confirmed) {
        await record({ userId: user.id, kind: 'method-removed', method: removed.kind });
        notice(user.id, 'two-step-app-removed');
    }
    // Read before the removal: nothing is asked of the database once the method is gone.
    return { removed: true, on: before.on && !removed.turnedOff };
}

/* A new set of backup codes, which replaces the old one: the password and the step. */
export async function makeBackupCodes(sessionToken: string | null, input: TwoStepChange) {
    const { user, token } = await requireChange(sessionToken, input);
    const checked = await checkChangeStep({
        userId: user.id,
        sessionToken: token,
        purpose: 'two-step',
        step: input.twoStep,
    });
    if (!checked) throw new AuthError('Turn on two-step sign-in first.', 409);
    const { fresh, replaced } = await beforeSpending(checked, async () => {
        const fresh = await freshBackupCodes(user.id);
        const replaced = await twoStepRepository.replaceBackupCodes({
            userId: user.id,
            ...fresh.set,
            step: { sessionTokenHash: hash(token), ...checked.proof },
        });
        return { fresh, replaced };
    });
    await settleChangeStep(checked, replaced, replaced.status === 'ok', { codesReplaced: true });
    if (replaced.status !== 'ok') throw new AuthError('Turn on two-step sign-in first.', 409);
    await record({ userId: user.id, kind: 'backup-codes-made' });
    notice(user.id, 'backup-codes-made');
    return { codes: fresh.codes };
}

/* Recent security activity: the last 90 days, newest first, for every session of the account. */
export async function listSecurityEvents(sessionToken: string | null) {
    requireEnabled();
    const { user } = await requireSession(sessionToken, 'Sign in to see your security activity.');
    const events = await twoStepRepository.listSecurityEvents(user.id);
    return {
        events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
    };
}
