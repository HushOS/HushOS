import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
import type {
    TwoStepDefaultKind,
    TwoStepFactorKind,
    TwoStepMethod,
    TwoStepSessionPurpose,
} from '@hushos/db/schema';
import { sendSecurityNotice, type SecurityNoticeKind } from '@hushos/emails/server';
import { authEnv } from '@hushos/env/auth';
import { twoStepEnv } from '@hushos/env/two-step';
import { log as serverLog } from '@hushos/logging';
import { hash, noticeWhen, randomToken, serverSetup, supportedEnvelope } from './internal';
import { notify } from './notifications';
import { consumeBoundAttempt, normalizeDeviceName, requireSession, startLogin } from './server';
import { AuthError, SESSION_IDLE_SECONDS, TOKEN_PATTERN } from './tokens';
import { twoStepKeyringFromEnv, type TwoStepKeyring } from './two-step-keys';
import {
    keyCreationOptions,
    keyRequestOptions,
    verifyKeyAssertion,
    verifyKeyRegistration,
    type KeyRequestOptions,
} from './webauthn';

/*
 * Two-step sign-in, the server's rule (docs/two-step-design.md). After the password, an
 * account that has the step on gets no session, no cookie and no envelope until the step
 * passes: a passkey or security key, a code from an authenticator app, a backup code, or a
 * signature made with the recovery phrase. The same step is asked before a security change, account deletion and any
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

/* What a client sends as its answer to a step. `response` is a key's assertion, as WebAuthn's JSON has it. */
export type StepAnswer =
    | { kind: 'totp'; code: string }
    | { kind: 'backup'; code: string }
    | { kind: 'phrase'; signature: string }
    | { kind: 'webauthn'; response: unknown };
export type StepInput = { token: string; proof: StepAnswer };

/* What a client is told when it must answer a step: nothing a stranger to the password sees. */
export type StepChallenge = {
    token: string;
    /* What this client can answer this step with, in the order to offer it: the usual way first. */
    methods: TwoStepMethod[];
    expiresAt: string;
    /* What the device needs to sign with the recovery phrase (docs/two-step-design.md 5). */
    phrase?: { userId: string; recoveryVersion: number; wrappingSalt: string };
    /* What a passkey or security key is asked: this token's challenge, and the account's keys. */
    webauthn?: KeyRequestOptions;
    /* A way to answer was left out because this client did not say it can use it. */
    withheld?: true;
    /* The account's usual way is not first, or not there: it can't be used for this step. */
    defaultUnavailable?: true;
};

/*
 * The kinds of method a client says it can answer beyond the ones every client can (the app's
 * code, a backup code, the phrase): `twoStepMethods` in its request (docs/two-step-design.md
 * 12). Null from a client that sent none, which is a client from before passkeys: it is told
 * nothing it does not know. A name this server does not know is ignored.
 */
export type ClientMethods = readonly string[] | null | undefined;

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

/*
 * A key answered with a counter that did not go up (docs/two-step-design.md 3): the answer was
 * refused and counted, and the account is told its key may have been copied, with a line in
 * its log. Once an hour: only the key itself, or a copy of it, can set this off.
 */
async function counterWentBack(attempt: twoStepRepository.StepAttempt) {
    const { userId } = attempt;
    await quietly('key-counter', async () => {
        if (
            !(await authRepository.consumeRateLimit(
                hash(`auth:two-step:key-counter:${userId}`),
                1,
                60 * 60_000,
            ))
        )
            return;
        await record({
            userId,
            kind: 'key-counter',
            method: 'webauthn',
            deviceId: poolDevice(attempt),
        });
        notice(userId, 'key-counter');
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
                  : method === 'webauthn'
                    ? 'That passkey or security key didn’t work. Try again, or use another way.'
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
 * `counter` is a key's answer that verified in everything but its counter: wrong, and told.
 */
async function rightAnswer(
    attempt: twoStepRepository.StepAttempt,
    proof: StepAnswer,
): Promise<(twoStepRepository.StepSpend & { freshPhrase?: boolean }) | 'counter' | null> {
    const { userId } = attempt;
    if (proof.kind === 'webauthn') {
        // The challenge is this token's own: an assertion made for another token signs another.
        if (!attempt.webauthnChallenge) return null;
        const id = (proof.response as { id?: unknown } | null)?.id;
        const key =
            typeof id === 'string'
                ? (await twoStepRepository.listWebauthnCredentials(userId)).find(
                      (candidate) => candidate.credentialId.toString('base64url') === id,
                  )
                : undefined;
        // Not one of this account's confirmed keys: another account's, or one removed since.
        if (!key) return null;
        const verified = await verifyKeyAssertion({
            response: proof.response,
            challenge: attempt.webauthnChallenge,
            key,
        });
        if (!verified.ok) return verified.counter ? 'counter' : null;
        return {
            method: 'webauthn',
            factorId: key.id,
            signCount: verified.signCount,
            backedUp: verified.backedUp,
        };
    }
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
    method: TwoStepMethod;
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
    // Only what can be guessed has a budget: a key and the phrase are never refused for a spent one.
    const bucket =
        proof.kind === 'phrase' || proof.kind === 'webauthn' ? null : codeBucket(attempt);
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
    if (!right || right === 'counter') {
        const failure = await twoStepRepository.recordStepFailure(attempt);
        if (right === 'counter') await counterWentBack(attempt);
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
         * The action left none of the backup codes the answer could have come from: it made
         * a new set, or turned the step off and deleted the set. A code that answered the
         * step was one of those, so "a backup code was used, N are left" would count codes
         * that no longer work. The action's own notice says what happened ("new backup codes
         * were made", "two-step sign-in is off"); the use is still written to the security log.
         */
        codesGone?: boolean;
    } = {},
) {
    const { attempt, method, flow, freshPhrase } = checked;
    if (refusal) {
        if (refusal.reason === 'spent') {
            if (refusal.counter) await counterWentBack(attempt);
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
            if (passed.codesGone) return;
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

/* The kinds of factor this server can check an answer of. Approving on another device is not built yet. */
const ANSWERABLE: ReadonlySet<TwoStepDefaultKind> = new Set(['webauthn', 'totp']);
/* The kinds every client that answers a step can answer; the others it must name. */
const EVERY_CLIENT: ReadonlySet<TwoStepDefaultKind> = new Set(['totp']);

/*
 * What can answer the token, in the order to offer it (docs/two-step-design.md 12): the
 * account's kinds of method, default first, then a backup code while any is left, then the
 * phrase.
 * - A kind is listed only when this sign-in can use it: the app is left out while it is frozen
 *   for the token, a key only when the token carries a challenge for it.
 * - And only when the client can answer it: every client answers the app's code, a backup
 *   code and the phrase; anything else it must have named (`names`). An account always has
 *   backup codes and a phrase, so no client is locked out.
 * - `withheld` says a usable kind was left out because the client did not name it, and
 *   `defaultUnavailable` that the account's usual way is not the first one listed, whatever
 *   the reason: the client says one generic line, and learns nothing more. Neither is sent to
 *   a client that named nothing, which is one from before they existed.
 */
async function challenge(
    token: string,
    userId: string,
    expiresAt: Date,
    names: ClientMethods,
): Promise<StepChallenge> {
    const [status, attempt, recovery, keys] = await Promise.all([
        twoStepRepository.getTwoStep(userId),
        twoStepRepository.getStepAttempt(hash(token)),
        authRepository.getRecoveryKey(userId),
        twoStepRepository.listWebauthnCredentials(userId),
    ]);
    const named = new Set(names ?? []);
    const order = twoStepRepository.kindOrder(
        status.methods.map((method) => method.kind),
        status.defaultKind,
    );
    const usable = (kind: TwoStepDefaultKind) =>
        ANSWERABLE.has(kind) &&
        (kind === 'totp'
            ? !attempt?.totpFrozen
            : kind === 'webauthn'
              ? keys.length > 0 && Boolean(attempt?.webauthnChallenge)
              : false);
    const answers = (kind: TwoStepDefaultKind) => EVERY_CLIENT.has(kind) || named.has(kind);
    const methods: TwoStepMethod[] = order.filter(
        (kind): kind is TwoStepFactorKind => usable(kind) && answers(kind),
    );
    const first = methods[0];
    if (status.backupCodesLeft > 0) methods.push('backup');
    if (recovery) methods.push('phrase');
    const withheld = order.some((kind) => usable(kind) && !answers(kind));
    const webauthn =
        methods.includes('webauthn') && attempt?.webauthnChallenge
            ? await keyRequestOptions({
                  challenge: attempt.webauthnChallenge,
                  credentials: keys,
              })
            : null;
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
        ...(webauthn ? { webauthn } : {}),
        ...(names && withheld ? { withheld: true as const } : {}),
        ...(names && order[0] !== first ? { defaultUnavailable: true as const } : {}),
    };
}

/*
 * A fresh challenge for a key to sign, kept with the step token: made whenever the account has
 * a key, whatever the client says it can answer, so what a token can pass with does not depend
 * on what was asked for it.
 */
async function keyChallenge(userId: string) {
    return (await twoStepRepository.listWebauthnCredentials(userId)).length > 0
        ? randomBytes(32)
        : null;
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
    methods?: ClientMethods;
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
        webauthnChallenge: await keyChallenge(input.userId),
        expiresAt,
    });
    return challenge(token, input.userId, expiresAt, input.methods);
}

/* How a notice says a sign-in was made: the password and the kind of second step. */
const SIGNED_IN_WITH = {
    webauthn: 'Your password and a passkey or security key',
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
    methods?: ClientMethods,
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
        webauthnChallenge: await keyChallenge(user.id),
        expiresAt,
    });
    return challenge(stepToken, user.id, expiresAt, methods);
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
    options: { accountGone?: boolean; codesGone?: boolean } = {},
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

type Method = Awaited<ReturnType<typeof twoStepRepository.getTwoStep>>['methods'][number];
const encodeMethod = (method: Method) => ({
    ...method,
    createdAt: method.createdAt.toISOString(),
    lastUsedAt: iso(method.lastUsedAt),
});

/*
 * The account's step as its settings show it. Any session of the account.
 *
 * `names` is the kinds of method the client says it knows (`?methods=`, docs/two-step-design.md
 * 12). The list holds the authenticator app and those kinds, and nothing else: a client from
 * before passkeys names none, sees only its app with the step shown as on, and so can never
 * remove a method it does not know about. Only a client that names kinds is told the default.
 */
export async function getTwoStep(sessionToken: string | null, names?: ClientMethods) {
    requireEnabled();
    const { user } = await requireSession(sessionToken, 'Sign in to see two-step sign-in.');
    const { defaultKind, ...status } = await twoStepRepository.getTwoStep(user.id);
    const named = new Set(names ?? []);
    return {
        ...status,
        methods: status.methods
            .filter((method) => EVERY_CLIENT.has(method.kind) || named.has(method.kind))
            .map(encodeMethod),
        ...(names ? { defaultKind } : {}),
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
    await settleChangeStep(checked, removed, removed.status === 'ok', {
        codesGone: removed.status === 'ok' && removed.turnedOff,
    });
    if (removed.status !== 'ok') throw new AuthError('This method isn’t on your account.', 404);
    if (removed.turnedOff) {
        await record({ userId: user.id, kind: 'two-step-off', method: removed.kind });
        notice(user.id, 'two-step-off');
    } else if (confirmed) {
        await record({ userId: user.id, kind: 'method-removed', method: removed.kind });
        notice(
            user.id,
            removed.kind === 'webauthn' ? 'two-step-key-removed' : 'two-step-app-removed',
        );
        // The default went with the last method of its kind: the log says what comes first now.
        if (removed.defaultKind) await recordDefault(user.id, removed.defaultKind);
    }
    // Read before the removal: nothing is asked of the database once the method is gone.
    return { removed: true, on: before.on && !removed.turnedOff };
}

/* A line of the log for the default moving. `device` has no factor yet, and so is never the kind here. */
async function recordDefault(userId: string, kind: TwoStepDefaultKind) {
    if (kind !== 'device') await record({ userId, kind: 'default-changed', method: kind });
}

/* ------------------------------------------------------------------------- */
/* Passkeys and security keys                                                 */
/* ------------------------------------------------------------------------- */

const KEY_REGISTRATION_MS = 5 * 60_000;
const keyLimit = () =>
    new AuthError(
        `You can have up to ${twoStepRepository.WEBAUTHN_KEY_LIMIT} passkeys and security keys. Remove one first.`,
        409,
        { code: 'limit' },
    );
const setupOver = () => new AuthError('This setup timed out. Start again.', 404);

/*
 * Starts adding a passkey or security key: the password again and, once the step is on, the
 * step. Answers what `navigator.credentials.create` is given, and a registration token that
 * carries the challenge: one use, five minutes, for this session only.
 */
export async function startKeyEnrolment(sessionToken: string | null, input: TwoStepChange) {
    const { user, token } = await requireChange(sessionToken, input);
    await requireRecoveryKey(user.id);
    const checked = await checkChangeStep({
        userId: user.id,
        sessionToken: token,
        purpose: 'two-step',
        step: input.twoStep,
    });
    const registrationToken = randomToken();
    const challenge = randomBytes(32);
    const expiresAt = new Date(Date.now() + KEY_REGISTRATION_MS);
    const { options, started } = await beforeSpending(checked, async () => {
        const [state, exclude] = await Promise.all([
            twoStepRepository.ensureTwoStepState(user.id),
            twoStepRepository.listWebauthnCredentials(user.id),
        ]);
        const options = await keyCreationOptions({
            email: user.email,
            userHandle: state.webauthnUserHandle,
            challenge,
            exclude,
        });
        const started = await twoStepRepository.startKeyRegistration({
            tokenHash: hash(registrationToken),
            userId: user.id,
            sessionTokenHash: hash(token),
            credentialVersion: user.credentialVersion,
            challenge,
            expiresAt,
            step: checked ? { sessionTokenHash: hash(token), ...checked.proof } : undefined,
        });
        return { options, started };
    });
    await settleChangeStep(checked, started, started.status === 'ok');
    if (started.status === 'limit') throw keyLimit();
    if (started.status !== 'ok') throw new AuthError('Sign in to change two-step sign-in.', 401);
    return { registrationToken, options, expiresAt: expiresAt.toISOString() };
}

/*
 * Adds the key that answered: its registration is verified against the token's challenge, and
 * the key is stored confirmed. The account's first method turns the step on, and its backup
 * codes are made here and returned once. A token is good for one answer: one that does not
 * verify ends it, and the person starts again with their password.
 */
export async function finishKeyEnrolment(
    sessionToken: string | null,
    input: { registrationToken: string; name?: string; response: unknown },
) {
    requireEnabled();
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in to change two-step sign-in.',
    );
    if (
        !(await authRepository.consumeRateLimit(
            hash(`auth:two-step:confirm:${hash(token).toString('hex')}`),
            20,
            15 * 60_000,
        ))
    )
        throw new AuthError('Too many attempts. Please try again in 15 minutes.', 429);
    await requireRecoveryKey(user.id);
    // A name that will not do is said before the key's one answer is used up on it.
    const chosen = input.name === undefined ? null : normalizeDeviceName(input.name);
    if (!TOKEN_PATTERN.test(input.registrationToken)) throw setupOver();
    const registrationTokenHash = hash(input.registrationToken);
    const sessionTokenHash = hash(token);
    const registration = await twoStepRepository.getKeyRegistration({
        tokenHash: registrationTokenHash,
        userId: user.id,
        sessionTokenHash,
    });
    if (!registration) throw setupOver();
    const key = await verifyKeyRegistration({
        response: input.response,
        challenge: registration.challenge,
    });
    if (!key) {
        await quietly('key-registration', () =>
            twoStepRepository.dropKeyRegistration(registrationTokenHash),
        );
        throw new AuthError('That passkey or security key couldn’t be added. Start again.', 400, {
            code: 'key-refused',
        });
    }
    const add = (backupCodes?: { keyId: Buffer; hashes: Buffer[] }) =>
        twoStepRepository.addWebauthnFactor({
            userId: user.id,
            sessionTokenHash,
            credentialVersion: user.credentialVersion,
            registrationTokenHash,
            // Synced, it is a passkey; bound to one device or key, a security key.
            name: chosen ?? (key.backupState ? 'Passkey' : 'Security key'),
            backupCodes,
            ...key,
        });
    let fresh = (await twoStepRepository.hasTwoStep(user.id))
        ? null
        : await freshBackupCodes(user.id);
    let result = await add(fresh?.set);
    // The last method went between the look and the answer: this one turns the step on after all.
    if (result.status === 'codes-required') {
        fresh = await freshBackupCodes(user.id);
        result = await add(fresh.set);
    }
    switch (result.status) {
        case 'ok':
            break;
        case 'session':
            throw new AuthError('Sign in to change two-step sign-in.', 401);
        case 'limit':
            throw keyLimit();
        case 'exists':
            throw new AuthError('This passkey or security key is already on your account.', 409, {
                code: 'exists',
            });
        default:
            throw setupOver();
    }
    if (result.turnedOn) {
        await record({ userId: user.id, kind: 'two-step-on', method: 'webauthn' });
        notice(user.id, 'two-step-on', { method: 'A passkey or security key' });
    } else {
        await record({ userId: user.id, kind: 'method-added', method: 'webauthn' });
        notice(user.id, 'two-step-key-added');
    }
    return {
        method: encodeMethod(result.method),
        ...(result.turnedOn && fresh ? { backupCodes: fresh.codes } : {}),
    };
}

/* How many times an hour an account's keys can be renamed, or its default changed. */
async function limitSettings(userId: string) {
    if (
        !(await authRepository.consumeRateLimit(
            hash(`auth:two-step:settings:${userId}`),
            30,
            60 * 60_000,
        ))
    )
        throw new AuthError('Too many changes. Please try again in an hour.', 429);
}

/*
 * Renames a key. Any session of the account may, as with a device's name, and by the same
 * rules: the name is a label only the account sees, stored as typed and not encrypted.
 */
export async function renameTwoStepMethod(
    sessionToken: string | null,
    factorId: string,
    input: { name: string },
) {
    requireEnabled();
    const { user } = await requireSession(sessionToken, 'Sign in to change two-step sign-in.');
    await limitSettings(user.id);
    const method = await twoStepRepository.renameFactor({
        userId: user.id,
        factorId,
        name: normalizeDeviceName(input.name),
    });
    // Another account's key, an app and a method that never existed are the same answer.
    if (!method) throw new AuthError('This method isn’t on your account.', 404);
    return { method: encodeMethod(method) };
}

/*
 * Chooses the kind of method the account is offered first (docs/two-step-design.md 12). It
 * changes only an order, so it asks for no password; but only a session that passed the step
 * itself may, and the change is a line in the log.
 */
export async function setTwoStepDefault(
    sessionToken: string | null,
    kind: Exclude<TwoStepDefaultKind, 'device'>,
) {
    requireEnabled();
    const { user, token } = await requireSession(
        sessionToken,
        'Sign in to change two-step sign-in.',
    );
    await limitSettings(user.id);
    const result = await twoStepRepository.setDefaultKind({
        userId: user.id,
        kind,
        sessionTokenHash: hash(token),
        credentialVersion: user.credentialVersion,
    });
    switch (result.status) {
        case 'ok':
            break;
        case 'session':
            throw new AuthError('Sign in to change two-step sign-in.', 401);
        case 'step':
            // This session signed in before the step was on, and never passed it.
            throw new AuthError(
                'Sign out and sign in again on this device to change your default.',
                403,
            );
        default:
            throw new AuthError('Add that method first.', 404);
    }
    if (result.changed) await recordDefault(user.id, kind);
    return { defaultKind: kind };
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
    await settleChangeStep(checked, replaced, replaced.status === 'ok', { codesGone: true });
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
