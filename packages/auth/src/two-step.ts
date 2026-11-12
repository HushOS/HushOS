import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
    formatBackupCode,
    normalizeBackupCode,
    verifyTwoStepPhrase,
} from '@hushos/crypto/two-step';
import {
    base32,
    deriveTwoStepKey,
    generateBackupCodes,
    generateTotpSecret,
    hashBackupCode,
    openTotpSecret,
    sealTotpSecret,
    totpMatches,
    totpUri,
    twoStepKeyId,
} from '@hushos/crypto/two-step/server';
import { authRepository, twoStepRepository } from '@hushos/db';
import type { TwoStepMethod, TwoStepSessionPurpose } from '@hushos/db/schema';
import { sendSecurityNotice, type SecurityNoticeKind } from '@hushos/emails/server';
import { authEnv } from '@hushos/env/auth';
import { twoStepEnv } from '@hushos/env/two-step';
import { log as serverLog } from '@hushos/logging';
import { hash, noticeWhen, randomToken, serverSetup } from './internal';
import { consumeBoundAttempt, requireSession, startLogin } from './server';
import { AuthError, SESSION_IDLE_SECONDS, TOKEN_PATTERN } from './tokens';

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

type Keyring = { current: { key: Uint8Array; id: Buffer }; byId: Map<string, Uint8Array> };
let keyring: Promise<Keyring> | undefined;

/*
 * The key new secrets and codes are made under, and every key older rows may name: the
 * operator's TWO_STEP_KEY when set, its predecessor during a rotation, and always the key
 * derived from the OPAQUE server setup, which is what an instance used before it set one.
 */
function keys() {
    keyring ??= (async () => {
        const decode = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
        const derived = await deriveTwoStepKey(
            new Uint8Array(Buffer.from(await serverSetup(), 'base64url')),
        );
        const explicit = twoStepEnv.TWO_STEP_KEY ? decode(twoStepEnv.TWO_STEP_KEY) : null;
        const previous = twoStepEnv.TWO_STEP_PREVIOUS_KEY
            ? decode(twoStepEnv.TWO_STEP_PREVIOUS_KEY)
            : null;
        const byId = new Map<string, Uint8Array>();
        for (const key of [derived, previous, explicit])
            if (key) byId.set(Buffer.from(await twoStepKeyId(key)).toString('hex'), key);
        const current = explicit ?? derived;
        return { current: { key: current, id: Buffer.from(await twoStepKeyId(current)) }, byId };
    })().catch((error: unknown) => {
        keyring = undefined;
        throw error;
    });
    return keyring;
}

async function keyFor(keyId: Buffer) {
    return (await keys()).byId.get(keyId.toString('hex')) ?? null;
}

/* ------------------------------------------------------------------------- */
/* Notices and the security log                                               */
/* ------------------------------------------------------------------------- */

type StepNotice = Exclude<
    SecurityNoticeKind,
    'new-device' | 'device-removed' | 'devices-removed' | 'password-attempts'
>;

/*
 * A security notice about the step, by email, sent after the action and never awaited: the
 * action already happened, and a mail problem is the operator's. Changes to the step are
 * never dropped: each needs the password and the step, so nobody can flood them. Only the
 * failed-step notice has a budget, its own (one an hour), so a run of failures cannot use up
 * anything a later "step turned off" would need. It names the kind of method and the time,
 * never a name anyone chose.
 */
function notice(userId: string, kind: StepNotice, extra: { count?: number; method?: string } = {}) {
    void (async () => {
        const user = await authRepository.getUserById(userId);
        if (!user) return;
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

/* What a counted wrong answer sets off: a log line, the notice from the fifth on, the freeze notice. */
async function afterFailure(
    attempt: twoStepRepository.StepAttempt,
    failure: twoStepRepository.StepFailure,
    method: TwoStepMethod,
) {
    if (failure.status !== 'counted') return;
    const { userId } = attempt;
    await record({ userId, kind: 'step-failed', method, deviceId: poolDevice(attempt) });
    if (
        failure.notice &&
        (await authRepository.consumeRateLimit(
            hash(`auth:two-step:failed-notice:${userId}`),
            1,
            60 * 60_000,
        ))
    )
        notice(userId, 'step-failed');
    if (failure.froze) {
        await record({ userId, kind: 'totp-frozen', method: 'totp' });
        notice(userId, 'totp-frozen');
    }
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
            'Your authenticator app is paused on new devices. Use a backup code or your recovery phrase.',
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

/* The app's secret, opened under whichever known key sealed it; null when none does. */
async function totpSecret(
    userId: string,
    factor: { id: string; keyId: Buffer; nonce: Buffer; sealedSecret: Buffer },
) {
    const key = await keyFor(factor.keyId);
    if (!key) return null;
    return openTotpSecret({
        sealed: factor.sealedSecret,
        nonce: factor.nonce,
        key,
        userId,
        factorId: factor.id,
    });
}

/* What a right answer spends, or null for a wrong one. Nothing is written here. */
async function rightAnswer(
    attempt: twoStepRepository.StepAttempt,
    proof: StepAnswer,
): Promise<twoStepRepository.StepSpend | null> {
    const { userId } = attempt;
    if (proof.kind === 'totp') {
        const factor = await twoStepRepository.getTotpFactor(userId);
        const secret = factor ? await totpSecret(userId, factor) : null;
        if (!factor || !secret) return null;
        const steps = await totpMatches(secret, proof.code);
        secret.fill(0);
        if (steps.length === 0) return null;
        // The earliest step not yet used; a code whose every step is used goes on as a replay,
        // which the repository refuses and counts.
        const unused = steps.filter((step) => step > factor.lastStep);
        const step = unused.length > 0 ? Math.min(...unused) : Math.max(...steps);
        return { method: 'totp', factorId: factor.id, step };
    }
    if (proof.kind === 'backup') {
        const code = normalizeBackupCode(proof.code);
        const stored = code ? await twoStepRepository.getBackupCodes(userId) : null;
        if (!code || !stored) return null;
        // Hashed once for each key the unused codes were made under: one, outside a rotation.
        const hashes = new Map<string, Uint8Array>();
        for (const candidate of stored.codes) {
            const id = candidate.keyId.toString('hex');
            if (!hashes.has(id)) {
                const key = await keyFor(candidate.keyId);
                if (!key) continue;
                hashes.set(id, await hashBackupCode({ code, key, salt: stored.salt }));
            }
            const hashed = hashes.get(id);
            if (hashed && timingSafeEqual(hashed, candidate.codeHash))
                return { method: 'backup', codeHash: candidate.codeHash };
        }
        return null;
    }
    const recovery = await authRepository.getRecoveryKey(userId);
    if (!recovery) return null;
    const signed = await verifyTwoStepPhrase(
        { userId, tokenDigest: attempt.tokenHash.toString('base64url') },
        proof.signature,
        recovery.publicKey.toString('base64url'),
    );
    return signed ? { method: 'phrase' } : null;
}

type Checked = {
    attempt: twoStepRepository.StepAttempt;
    proof: twoStepRepository.StepProof;
    method: Exclude<TwoStepMethod, 'webauthn'>;
    flow: Flow;
    /* The code budget this answer was charged to, to hand back when the step passes. */
    bucket: Buffer | null;
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
    if (bucket && !(await authRepository.consumeRateLimit(bucket, CODE_BUDGET, CODE_BUDGET_MS)))
        throw refusals.limited();
    const spend = await rightAnswer(attempt, proof);
    if (!spend) {
        const failure = await twoStepRepository.recordStepFailure(attempt);
        await afterFailure(attempt, failure, proof.kind);
        throw refusals.wrong(
            flow,
            proof.kind,
            failure.status === 'counted' ? failure.tokenEnded : true,
        );
    }
    return { attempt, proof: { tokenHash, spend }, method: proof.kind, flow, bucket };
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
    passed: { backupCodesLeft?: number | null; deviceId?: string | null; signIn?: boolean } = {},
) {
    const { attempt, method, flow } = checked;
    if (refusal) {
        if (refusal.reason === 'spent') {
            await afterFailure(attempt, refusal.failure, method);
            throw refusals.wrong(
                flow,
                method,
                refusal.failure.status === 'counted' ? refusal.failure.tokenEnded : true,
            );
        }
        if (refusal.reason === 'frozen') throw refusals.frozen();
        if (refusal.reason === 'required') throw refusals.required();
        throw refusal.reason === 'step'
            ? refusals.wrong(flow, method, false)
            : refusals.expired(flow);
    }
    if (checked.bucket) await authRepository.releaseRateLimit(checked.bucket);
    const { userId } = attempt;
    const deviceId = passed.deviceId ?? poolDevice(attempt);
    if (method === 'backup') {
        const left = passed.backupCodesLeft ?? (await twoStepRepository.countBackupCodes(userId));
        if (!passed.signIn) await record({ userId, kind: 'backup-code-used', method, deviceId });
        notice(userId, 'backup-code-used', { count: left });
    }
    if (method === 'phrase') {
        if (!passed.signIn) await record({ userId, kind: 'phrase-used', method, deviceId });
        notice(userId, 'phrase-used');
    }
}

/* Gives a right answer's budget back when the action failed for a reason of its own: nothing was guessed. */
async function release(checked: Checked | null) {
    if (checked?.bucket) await authRepository.releaseRateLimit(checked.bucket);
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
        backupCodesLeft: result.backupCodesLeft,
        deviceId: device.id,
        signIn: true,
    });
    return {
        user,
        envelope: {
            envelopeVersion: 1 as const,
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
export async function settleChangeStep(checked: Checked | null, result: unknown, done: boolean) {
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
    return settle(checked, null);
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
    const checked = await checkChangeStep({
        userId: user.id,
        sessionToken: token,
        purpose: 'two-step',
        step: input.twoStep,
    });
    const secret = generateTotpSecret();
    const id = randomUUID();
    const { current } = await keys();
    const sealed = await sealTotpSecret({
        secret,
        key: current.key,
        userId: user.id,
        factorId: id,
    });
    const started = await twoStepRepository.startTotpFactor({
        id,
        userId: user.id,
        keyId: Buffer.from(sealed.keyId),
        nonce: Buffer.from(sealed.nonce),
        sealedSecret: Buffer.from(sealed.sealed),
        step: checked ? { sessionTokenHash: hash(token), ...checked.proof } : undefined,
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

async function freshBackupCodes(userId: string) {
    const { current } = await keys();
    const { backupCodeSalt } = await twoStepRepository.ensureTwoStepState(userId);
    const codes = generateBackupCodes();
    const hashes = [];
    for (const code of codes)
        hashes.push(
            Buffer.from(await hashBackupCode({ code, key: current.key, salt: backupCodeSalt })),
        );
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
    const pending = await twoStepRepository.getPendingTotpFactor({ userId: user.id, factorId });
    const secret = pending ? await totpSecret(user.id, pending) : null;
    if (!pending || !secret) throw new AuthError('This setup timed out. Start again.', 404);
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
    return result.turnedOn && fresh ? { backupCodes: fresh.codes } : {};
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
    const confirmed = (await twoStepRepository.getTwoStep(user.id)).methods.some(
        (method) => method.id === factorId,
    );
    // A pending method is the person's own unfinished setup and needs no step.
    const checked = await checkChangeStep({
        userId: user.id,
        sessionToken: token,
        purpose: 'two-step',
        step: input.twoStep,
        optional: !confirmed,
    });
    const removed = await twoStepRepository.removeFactor({
        userId: user.id,
        factorId,
        step: checked ? { sessionTokenHash: hash(token), ...checked.proof } : undefined,
    });
    await settleChangeStep(checked, removed, removed.status === 'ok');
    if (removed.status !== 'ok') throw new AuthError('This method isn’t on your account.', 404);
    if (removed.turnedOff) {
        await record({ userId: user.id, kind: 'two-step-off', method: removed.kind });
        notice(user.id, 'two-step-off');
    } else if (confirmed) {
        await record({ userId: user.id, kind: 'method-removed', method: removed.kind });
        notice(user.id, 'two-step-app-removed');
    }
    return { removed: true, on: await twoStepRepository.hasTwoStep(user.id) };
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
    const fresh = await freshBackupCodes(user.id);
    const replaced = await twoStepRepository.replaceBackupCodes({
        userId: user.id,
        ...fresh.set,
        step: { sessionTokenHash: hash(token), ...checked.proof },
    });
    await settleChangeStep(checked, replaced, replaced.status === 'ok');
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
