import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { bytes, registered, registration, sha256 } from '../test/accounts';
import { closeDatabase, lockObserver, resetDatabase, signingKeyFromSeed } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import {
    accountDevices,
    accountRecoveryKeys,
    accountSecurityEvents,
    opaqueCredentials,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepFactors,
    twoStepState,
    users,
    type TwoStepMethod,
    type TwoStepPurpose,
} from './schema';
import { deviceSessionStatement } from './signatures';
import * as twoStep from './two-step';

/*
 * Two-step sign-in, the rows (docs/two-step-design.md 2, 4, 10): a pending app never counts and
 * expires; a time step and a backup code are accepted once, however many requests race; a step
 * token allows five answers, each taken before it is checked, and passes once; what an answer
 * spends and what it authorises commit together or not at all; wrong answers count per pool
 * and freeze the app for new devices at the hundredth; and nothing reaches another account's
 * rows. The repository checks no code and opens no secret, so secrets and hashes here are
 * fixed bytes of the right length, and every step is passed the way the server will pass it:
 * a token, a slot, then the gated function.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const fixed = (label: string, length: number) =>
    createHash('sha512').update(`hushos-two-step-test:${label}`).digest().subarray(0, length);
/* A sealed TOTP secret as the server stores it: key id, nonce, and 20 bytes with the tag. */
const sealed = (label: string) => ({
    keyId: fixed(`${label}:key`, 8),
    nonce: fixed(`${label}:nonce`, 24),
    sealedSecret: fixed(`${label}:secret`, 36),
});
const codeSet = (label: string) => ({
    keyId: fixed(`${label}:key`, 8),
    hashes: Array.from({ length: 10 }, (_, index) => fixed(`${label}:code:${index}`, 32)),
});
const PHRASE = { method: 'phrase' } as const;

type Signer = ReturnType<typeof signingKeyFromSeed>;
type Session = { token: Buffer; deviceId: string };
type Keyed = Session & { signer: Signer };
type Binding = { purpose: TwoStepPurpose; sessionTokenHash: Buffer | null };
const LOGIN: Binding = { purpose: 'login', sessionTokenHash: null };

/* A sign-in with the password alone: what an account without the step gets. */
async function passwordSignIn(userId: string): Promise<Session> {
    const token = sha256(randomUUID());
    const result = await auth.createSession({
        userId,
        credentialVersion: 1,
        tokenHash: token,
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + HOUR),
    });
    if (!result || 'suspended' in result || 'twoStep' in result) throw new Error('No session.');
    return { token, deviceId: result.device.id };
}

/* A device key's proof for one sign-in, as the client signs it. */
function proofOf(userId: string, device: Keyed, signedBy: Signer = device.signer) {
    const attemptDigest = sha256(randomUUID());
    return {
        id: device.deviceId,
        attemptDigest,
        signature: signedBy.sign(
            deviceSessionStatement({ userId, deviceId: device.deviceId, attemptDigest }),
        ),
    };
}

/* What `login/finish` stores for a sign-in that must pass the step. */
async function loginToken(
    userId: string,
    options: { device?: Keyed | null; previous?: Buffer | null; purpose?: 'login' | 'enrol' } = {},
) {
    const tokenHash = sha256(randomUUID());
    await twoStep.createStepAttempt({
        purpose: options.purpose ?? 'login',
        tokenHash,
        userId,
        credentialVersion: 1,
        device: options.device ? proofOf(userId, options.device) : null,
        previousTokenHash: options.previous ?? null,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    return tokenHash;
}

/* A step-up's token, bound to the session asking. */
async function sessionToken(
    userId: string,
    sessionTokenHash: Buffer,
    purpose: 'password' | 'delete' | 'two-step' = 'two-step',
) {
    const tokenHash = sha256(randomUUID());
    await twoStep.createStepAttempt({
        purpose,
        tokenHash,
        userId,
        credentialVersion: 1,
        sessionTokenHash,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    return tokenHash;
}

/* One of the token's answer slots, or an error when it has none to give. */
async function take(tokenHash: Buffer, method: TwoStepMethod = 'backup', binding = LOGIN) {
    const taken = await twoStep.takeStepAnswer({ tokenHash, method, ...binding });
    if (taken.status !== 'ok') throw new Error(`No slot: ${taken.status}.`);
    return taken.attempt;
}

const newSession = () => ({
    tokenHash: sha256(randomUUID()),
    expiresAt: new Date(Date.now() + HOUR),
});

/* Answers a sign-in's token: a slot, then the gated function. Whatever it answers. */
async function answer(tokenHash: Buffer, spend: twoStep.StepSpend = PHRASE) {
    await take(tokenHash, spend.method);
    const session = newSession();
    return { session, result: await twoStep.openSteppedSession({ tokenHash, spend, session }) };
}

/* A sign-in that passes the step: by default with the phrase, which spends nothing but the token. */
async function steppedSignIn(
    userId: string,
    options: { device?: Keyed; previous?: Buffer; spend?: twoStep.StepSpend } = {},
): Promise<Session> {
    const { session, result } = await answer(await loginToken(userId, options), options.spend);
    if (result.status !== 'ok') throw new Error(`Step ${result.status}.`);
    return { token: session.tokenHash, deviceId: result.device.id };
}

/* A step-up from `session`, ready for a gated change: its token with a slot taken, and what the answer spends. */
async function stepUp(
    userId: string,
    session: Session,
    purpose: 'password' | 'delete' | 'two-step' = 'two-step',
    spend: twoStep.StepSpend = PHRASE,
): Promise<twoStep.SessionStep> {
    const tokenHash = await sessionToken(userId, session.token, purpose);
    await take(tokenHash, spend.method, { purpose, sessionTokenHash: session.token });
    return { sessionTokenHash: session.token, tokenHash, spend };
}

async function startApp(userId: string, label: string, step?: twoStep.SessionStep) {
    const id = randomUUID();
    const started = await twoStep.startTotpFactor({ id, userId, ...sealed(label), step });
    if (started.status !== 'ok') throw new Error(`Start ${started.status}.`);
    return id;
}

/* An account with the step on: one confirmed app whose last step is `step`, and its ten codes. */
async function withApp(label: string, step = 1_000) {
    const { user } = await registered();
    const session = await passwordSignIn(user.id);
    const factorId = await startApp(user.id, label);
    const codes = codeSet(label);
    const result = await twoStep.confirmTotpFactor({
        userId: user.id,
        factorId,
        step,
        sessionTokenHash: session.token,
        credentialVersion: 1,
        backupCodes: codes,
    });
    if (result.status !== 'ok') throw new Error(`Confirmation ${result.status}.`);
    return { userId: user.id, session, factorId, codes, step };
}

/* One of the account's devices with a key of its own, signed in through the step. */
async function keyedDevice(userId: string, label: string): Promise<Keyed> {
    const session = await steppedSignIn(userId);
    const signer = signingKeyFromSeed(fixed(`${userId}:${label}:device`, 32));
    const result = await auth.registerDevice({
        sessionTokenHash: session.token,
        kind: 'web',
        name: label,
        signingPublicKey: signer.publicKey,
    });
    if (result.status !== 'ok') throw new Error(`Device ${result.status}.`);
    return { ...session, signer };
}

/* A security key's row, as the key release will write it. */
async function securityKey(userId: string, label: string) {
    const [row] = await db
        .insert(twoStepFactors)
        .values({
            userId,
            kind: 'webauthn',
            name: 'Security key',
            confirmedAt: new Date(),
            credentialId: fixed(`${label}:credential`, 32),
            publicKey: fixed(`${label}:public`, 64),
            signCount: 0,
            transports: ['usb'],
            backupEligible: false,
            backupState: false,
        })
        .returning({ id: twoStepFactors.id });
    return row!.id;
}

/* `times` wrong answers from sign-ins that proved `device` (none: the account's pool), on as many tokens as that takes. */
async function fail(userId: string, times: number, device: Keyed | null = null) {
    const results: Extract<twoStep.StepFailure, { status: 'counted' }>[] = [];
    let token: Buffer | null = null;
    for (let index = 0; index < times; index++) {
        token ??= await loginToken(userId, { device });
        const result = await twoStep.recordStepFailure(await take(token));
        if (result.status !== 'counted') throw new Error('The answer was not counted.');
        results.push(result);
        if (result.tokenEnded) token = null;
    }
    return results;
}

/*
 * Pins this process's clock ten minutes ahead of the real one, and so of the database's: the
 * server's clock is the one a code's window comes from, and the database's may lag it. Answers
 * the time step the pinned clock is in. `beforeEach` puts the real clock back.
 */
function pinClockAhead() {
    const now = Date.now() + 10 * MINUTE;
    vi.useFakeTimers({ now, toFake: ['Date'] });
    return Math.floor(now / 30_000);
}

const factorRow = async (id: string) =>
    (await db.select().from(twoStepFactors).where(eq(twoStepFactors.id, id)))[0];
const stateRow = async (userId: string) =>
    (await db.select().from(twoStepState).where(eq(twoStepState.userId, userId)))[0];
const deviceFailures = async (deviceId: string) =>
    (
        await db
            .select({ failures: accountDevices.twoStepFailures })
            .from(accountDevices)
            .where(eq(accountDevices.id, deviceId))
    )[0]?.failures;
const sessionRow = async (token: Buffer) =>
    (await db.select().from(sessions).where(eq(sessions.tokenHash, token)))[0];
const stampOf = async (token: Buffer) => (await sessionRow(token))?.twoStepAt;
const unusedHashes = async (userId: string) =>
    (await twoStep.getBackupCodes(userId))!.codes
        .map(({ codeHash }) => codeHash.toString('hex'))
        .sort();
const hex = (hashes: Buffer[]) => hashes.map((hash) => hash.toString('hex')).sort();

beforeEach(async () => {
    vi.useRealTimers();
    await resetDatabase();
});
afterAll(closeDatabase);

describe('enrolling an authenticator app', () => {
    test('a pending app is not the step: the account stays off, no secret is served for sign-in, and its code passes nothing', async () => {
        const { user } = await registered();
        const factorId = await startApp(user.id, 'maya');
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        expect(await twoStep.getTwoStep(user.id)).toEqual({
            on: false,
            methods: [],
            backupCodesLeft: 0,
            totpFrozen: false,
        });
        expect(await twoStep.getTotpFactor(user.id)).toBeNull();
        // A step token answered with the pending app's code: refused, and no session.
        const { session, result } = await answer(await loginToken(user.id), {
            method: 'totp',
            factorId,
            step: 1_000,
        });
        expect(result).toMatchObject({ status: 'spent' });
        expect(await sessionRow(session.tokenHash)).toBeUndefined();
        expect((await factorRow(factorId))!.totpLastStep).toBe(0);
        expect(await twoStep.replaceBackupCodes({ userId: user.id, ...codeSet('maya') })).toEqual({
            status: 'off',
        });
        expect(await db.select().from(twoStepBackupCodes)).toHaveLength(0);
        // The sealed secret is served only to confirm it, as stored.
        expect(await twoStep.getPendingTotpFactor({ userId: user.id, factorId })).toEqual({
            id: factorId,
            ...sealed('maya'),
            lastStep: 0,
        });
    });

    test('confirming turns the step on, stores the ten codes, stamps the session that enrolled, and spends the confirming code', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        const other = await passwordSignIn(user.id);
        const factorId = await startApp(user.id, 'maya');
        const before = Date.now();
        expect(
            await twoStep.confirmTotpFactor({
                userId: user.id,
                factorId,
                step: 57_000_000,
                sessionTokenHash: enrolling.token,
                credentialVersion: 1,
                backupCodes: codeSet('maya'),
            }),
        ).toEqual({ status: 'ok', turnedOn: true, replaced: false });

        const status = await twoStep.getTwoStep(user.id);
        expect(status).toMatchObject({ on: true, backupCodesLeft: 10, totpFrozen: false });
        expect(status.methods).toMatchObject([
            { id: factorId, kind: 'totp', name: null, synced: false },
        ]);
        expect(await twoStep.getTotpFactor(user.id)).toEqual({
            id: factorId,
            ...sealed('maya'),
            lastStep: 57_000_000,
        });
        // Only the session that enrolled passed anything; the other device's never did.
        expect((await stampOf(enrolling.token))!.getTime()).toBeGreaterThanOrEqual(before);
        expect(await stampOf(other.token)).toBeNull();
        // The code that confirmed the app cannot sign in afterwards; the next one can.
        const signIn = async (step: number) =>
            (await answer(await loginToken(user.id), { method: 'totp', factorId, step })).result
                .status;
        expect(await signIn(57_000_000)).toBe('spent');
        expect(await signIn(57_000_001)).toBe('ok');
        // Confirmed, it is no longer served as pending, and cannot be confirmed again.
        expect(await twoStep.getPendingTotpFactor({ userId: user.id, factorId })).toBeNull();
        expect(
            await twoStep.confirmTotpFactor({
                userId: user.id,
                factorId,
                step: 57_000_002,
                sessionTokenHash: enrolling.token,
                credentialVersion: 1,
                backupCodes: codeSet('again'),
            }),
        ).toEqual({ status: 'missing' });
        expect((await factorRow(factorId))!.totpLastStep).toBe(57_000_001);
    });

    test('the first method needs its backup codes: without them nothing is confirmed', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        const factorId = await startApp(user.id, 'maya');
        const confirm = (backupCodes?: twoStep.BackupCodeSet) =>
            twoStep.confirmTotpFactor({
                userId: user.id,
                factorId,
                step: 1_000,
                sessionTokenHash: session.token,
                credentialVersion: 1,
                backupCodes,
            });
        expect(await confirm()).toEqual({ status: 'codes-required' });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        expect((await factorRow(factorId))!.confirmedAt).toBeNull();
        expect(await stampOf(session.token)).toBeNull();
        // Nine codes, or one twice, is not a set.
        const set = codeSet('maya');
        await expect(confirm({ ...set, hashes: set.hashes.slice(1) })).rejects.toThrow(
            /10 different/,
        );
        await expect(
            confirm({ ...set, hashes: [...set.hashes.slice(1), set.hashes[1]!] }),
        ).rejects.toThrow(/10 different/);
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        expect(await confirm(set)).toMatchObject({ status: 'ok', turnedOn: true });
    });

    test('a time step the clock has not reached is refused at confirmation, and nothing is replaced for it', async () => {
        const maya = await withApp('first', 1_000);
        const now = pinClockAhead();
        const next = await startApp(maya.userId, 'second', await stepUp(maya.userId, maya.session));
        const confirm = (step: number) =>
            twoStep.confirmTotpFactor({
                userId: maya.userId,
                factorId: next,
                step,
                sessionTokenHash: maya.session.token,
                credentialVersion: 1,
            });
        // Stored, a far step would refuse every real code until the clock caught up with it.
        for (const step of [now + 2, now + 1_000_000, Number.MAX_SAFE_INTEGER])
            expect(await confirm(step)).toEqual({ status: 'step' });
        for (const step of [0, -1, 1.5, Number.NaN])
            expect(await confirm(step)).toEqual({ status: 'step' });
        // The app it would have replaced is still the app.
        expect((await twoStep.getTotpFactor(maya.userId))!.id).toBe(maya.factorId);
        expect((await factorRow(next))!.confirmedAt).toBeNull();
        // The step after the clock's is the latest code the server accepts: taken, though the
        // database's clock is twenty steps behind it.
        expect(await confirm(now + 1)).toEqual({ status: 'ok', turnedOn: false, replaced: true });
    });

    test('a pending app cannot be confirmed after ten minutes, and the sweep deletes it and only it', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        const stale = await startApp(user.id, 'stale');
        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - 10 * MINUTE - 1_000) })
            .where(eq(twoStepFactors.id, stale));
        expect(await twoStep.getPendingTotpFactor({ userId: user.id, factorId: stale })).toBeNull();
        expect(
            await twoStep.confirmTotpFactor({
                userId: user.id,
                factorId: stale,
                step: 1_000,
                sessionTokenHash: session.token,
                credentialVersion: 1,
                backupCodes: codeSet('stale'),
            }),
        ).toEqual({ status: 'missing' });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);

        // Beside it: another account's pending app with a minute to go, and a confirmed app made long ago.
        const { user: sam } = await registered();
        const fresh = await startApp(sam.id, 'fresh');
        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - 9 * MINUTE) })
            .where(eq(twoStepFactors.id, fresh));
        const old = await withApp('old');
        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - 90 * 24 * HOUR) })
            .where(eq(twoStepFactors.id, old.factorId));
        expect((await auth.cleanupExpired()).pendingFactors).toBe(1);
        expect(await factorRow(stale)).toBeUndefined();
        expect(await factorRow(fresh)).toBeDefined();
        expect(await factorRow(old.factorId)).toBeDefined();
    });

    test('the sweep leaves an app that was confirmed while the sweep waited on its row', async () => {
        const { user } = await registered();
        const factorId = await startApp(user.id, 'maya');
        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - 11 * MINUTE) })
            .where(eq(twoStepFactors.id, factorId));
        // A confirmation that began inside the ten minutes and has not committed yet.
        const confirming = lockObserver();
        try {
            await confirming.query('begin');
            await confirming.query(
                'update two_step_factors set confirmed_at = now(), totp_last_step = 1000 where id = $1',
                [factorId],
            );
            const sweeping = auth.cleanupExpired();
            await expect
                .poll(() => confirming.waitingOn('two_step_factors'), { timeout: 10_000 })
                .toBe(true);
            await confirming.query('commit');
            expect((await sweeping).pendingFactors).toBe(0);
        } finally {
            await confirming.end();
        }
        expect((await factorRow(factorId))!.confirmedAt).not.toBeNull();
        expect(await twoStep.hasTwoStep(user.id)).toBe(true);
    });

    test('confirming needs the account’s own live session on its current credential', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        const { user: sam } = await registered();
        const sams = await passwordSignIn(sam.id);
        const factorId = await startApp(user.id, 'maya');
        const confirm = (sessionTokenHash: Buffer, credentialVersion = 1) =>
            twoStep.confirmTotpFactor({
                userId: user.id,
                factorId,
                step: 1_000,
                sessionTokenHash,
                credentialVersion,
                backupCodes: codeSet('maya'),
            });
        expect(await confirm(sams.token)).toEqual({ status: 'session' });
        expect(await confirm(session.token, 2)).toEqual({ status: 'session' });
        await db
            .update(sessions)
            .set({
                createdAt: new Date(Date.now() - 2 * HOUR),
                expiresAt: new Date(Date.now() - HOUR),
            })
            .where(eq(sessions.tokenHash, session.token));
        expect(await confirm(session.token)).toEqual({ status: 'session' });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        expect(await stampOf(sams.token)).toBeNull();
    });

    test('with the step on, starting another app needs the step, and stores nothing without it', async () => {
        const maya = await withApp('first');
        const start = (step?: twoStep.SessionStep) =>
            twoStep.startTotpFactor({
                id: randomUUID(),
                userId: maya.userId,
                ...sealed('next'),
                step,
            });
        expect(await start()).toEqual({ status: 'two-step', reason: 'required' });
        // A sign-in's token, another session's step-up, and a step-up made for a password change.
        const other = await steppedSignIn(maya.userId);
        const login = await loginToken(maya.userId);
        await take(login);
        expect(
            await start({ sessionTokenHash: maya.session.token, tokenHash: login, spend: PHRASE }),
        ).toEqual({ status: 'two-step', reason: 'gone' });
        const others = await stepUp(maya.userId, other);
        expect(await start({ ...others, sessionTokenHash: maya.session.token })).toEqual({
            status: 'two-step',
            reason: 'gone',
        });
        expect(await start(await stepUp(maya.userId, maya.session, 'password'))).toEqual({
            status: 'two-step',
            reason: 'gone',
        });
        expect(await db.select().from(twoStepFactors)).toHaveLength(1);
        // The refusals used nothing up: the other session's step-up still passes for that session.
        expect(await start(others)).toMatchObject({ status: 'ok' });
        expect(await twoStep.getStepAttempt(others.tokenHash)).toBeNull();
    });

    test('a second app replaces the first in one step, and leaves the codes and the session’s stamp alone', async () => {
        const maya = await withApp('first', 1_000);
        const stamped = await stampOf(maya.session.token);
        await steppedSignIn(maya.userId, {
            spend: { method: 'backup', codeHash: maya.codes.hashes[0]! },
        });
        const next = await startApp(maya.userId, 'second', await stepUp(maya.userId, maya.session));
        // Until the new app is confirmed, the old one is the app.
        expect((await twoStep.getTotpFactor(maya.userId))!.id).toBe(maya.factorId);
        expect(
            await twoStep.confirmTotpFactor({
                userId: maya.userId,
                factorId: next,
                step: 2_000,
                sessionTokenHash: maya.session.token,
                credentialVersion: 1,
                backupCodes: codeSet('second'),
            }),
        ).toEqual({ status: 'ok', turnedOn: false, replaced: true });
        expect(await twoStep.getTotpFactor(maya.userId)).toEqual({
            id: next,
            ...sealed('second'),
            lastStep: 2_000,
        });
        expect((await twoStep.getTwoStep(maya.userId)).methods.map(({ id }) => id)).toEqual([next]);
        // The old secret's row is gone, so a code from the old app passes nothing.
        expect(await factorRow(maya.factorId)).toBeUndefined();
        const old = await answer(await loginToken(maya.userId), {
            method: 'totp',
            factorId: maya.factorId,
            step: 9_000,
        });
        expect(old.result).toMatchObject({ status: 'spent' });
        // The set passed with a replacement is ignored: the old codes stand, the used one stays used.
        expect(await unusedHashes(maya.userId)).toEqual(hex(maya.codes.hashes.slice(1)));
        expect(await stampOf(maya.session.token)).toEqual(stamped);
    });

    test('replacing a frozen app lifts the freeze: it was the old secret’s', async () => {
        const maya = await withApp('first', 1_000);
        await fail(maya.userId, 100);
        expect((await twoStep.getTwoStep(maya.userId)).totpFrozen).toBe(true);
        // The step for the replacement, passed with the old app's code from the device that
        // enrolled it: a known device still takes it, and the frozen method lifts nothing.
        const next = await startApp(
            maya.userId,
            'second',
            await stepUp(maya.userId, maya.session, 'two-step', {
                method: 'totp',
                factorId: maya.factorId,
                step: 1_001,
            }),
        );
        expect((await stateRow(maya.userId))!.totpFrozenAt).not.toBeNull();
        expect(
            await twoStep.confirmTotpFactor({
                userId: maya.userId,
                factorId: next,
                step: 2_000,
                sessionTokenHash: maya.session.token,
                credentialVersion: 1,
            }),
        ).toMatchObject({ status: 'ok', replaced: true });
        expect((await twoStep.getTwoStep(maya.userId)).totpFrozen).toBe(false);
        // A sign-in that proves no device takes the new app's code again.
        expect(
            (
                await answer(await loginToken(maya.userId), {
                    method: 'totp',
                    factorId: next,
                    step: 2_001,
                })
            ).result.status,
        ).toBe('ok');
    }, 60_000);

    test('starting again drops the earlier pending app, never the confirmed one', async () => {
        const maya = await withApp('confirmed');
        const first = await startApp(maya.userId, 'first', await stepUp(maya.userId, maya.session));
        const second = await startApp(
            maya.userId,
            'second',
            await stepUp(maya.userId, maya.session),
        );
        expect(await factorRow(first)).toBeUndefined();
        expect(await factorRow(second)).toBeDefined();
        expect((await twoStep.getTotpFactor(maya.userId))!.id).toBe(maya.factorId);
        // Another account's pending app is not this account's to drop.
        const { user: sam } = await registered();
        const sams = await startApp(sam.id, 'sam');
        await startApp(maya.userId, 'third', await stepUp(maya.userId, maya.session));
        expect(await factorRow(sams)).toBeDefined();
    });

    test('turning the step on deletes the account’s other pending methods, so none started without the step can be confirmed after', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        const { user: sam } = await registered();
        const sams = await startApp(sam.id, 'sam');
        const first = await startApp(user.id, 'first');
        // A second pending method, started while the step was off, as another road to the
        // step (a security key's registration) leaves one beside the app's.
        const [stray] = await db
            .insert(twoStepFactors)
            .values({
                userId: user.id,
                kind: 'totp',
                totpKeyId: fixed('stray:key', 8),
                totpNonce: fixed('stray:nonce', 24),
                totpSecret: fixed('stray:secret', 36),
                totpLastStep: 0,
            })
            .returning({ id: twoStepFactors.id });
        const confirm = (factorId: string) =>
            twoStep.confirmTotpFactor({
                userId: user.id,
                factorId,
                step: 1_000,
                sessionTokenHash: session.token,
                credentialVersion: 1,
                backupCodes: codeSet('maya'),
            });
        expect(await confirm(first)).toMatchObject({ status: 'ok', turnedOn: true });
        expect(await factorRow(stray!.id)).toBeUndefined();
        // Had it stayed, this would replace the app with a secret nobody passed the step for.
        expect(await confirm(stray!.id)).toEqual({ status: 'missing' });
        expect((await twoStep.getTotpFactor(user.id))!.id).toBe(first);
        expect(await factorRow(sams)).toBeDefined();
    });

    test('two confirmations of one pending app at once: one wins', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        const factorId = await startApp(user.id, 'maya');
        const results = await Promise.all(
            [1_000, 1_001, 1_002, 1_003].map((step) =>
                twoStep.confirmTotpFactor({
                    userId: user.id,
                    factorId,
                    step,
                    sessionTokenHash: session.token,
                    credentialVersion: 1,
                    backupCodes: codeSet(`set-${step}`),
                }),
            ),
        );
        expect(results.map((result) => result.status).sort()).toEqual([
            'missing',
            'missing',
            'missing',
            'ok',
        ]);
        expect(await twoStep.countBackupCodes(user.id)).toBe(10);
    });

    test('another account cannot read, confirm, spend or remove a factor', async () => {
        const maya = await withApp('maya', 1_000);
        const pending = await startApp(
            maya.userId,
            'pending',
            await stepUp(maya.userId, maya.session),
        );
        const sam = await withApp('sam', 1_000);
        expect(
            await twoStep.getPendingTotpFactor({ userId: sam.userId, factorId: pending }),
        ).toBeNull();
        expect(
            await twoStep.confirmTotpFactor({
                userId: sam.userId,
                factorId: pending,
                step: 2_000,
                sessionTokenHash: sam.session.token,
                credentialVersion: 1,
            }),
        ).toEqual({ status: 'missing' });
        // Sam's own sign-in, answered with a code for Maya's app.
        const crossed = await answer(await loginToken(sam.userId), {
            method: 'totp',
            factorId: maya.factorId,
            step: 5_000,
        });
        expect(crossed.result).toMatchObject({ status: 'spent' });
        // Sam's own step, used to remove Maya's methods.
        for (const factorId of [maya.factorId, pending])
            expect(
                await twoStep.removeFactor({
                    userId: sam.userId,
                    factorId,
                    step: await stepUp(sam.userId, sam.session),
                }),
            ).toEqual({ status: 'missing' });
        // Maya's rows are as they were.
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_000);
        expect((await factorRow(pending))!.confirmedAt).toBeNull();
        expect(await twoStep.countBackupCodes(maya.userId)).toBe(10);
        expect((await twoStep.getTotpFactor(sam.userId))!.id).toBe(sam.factorId);
    });
});

describe('a code’s time step', () => {
    test('is accepted once: the same step and earlier ones are refused, a later one is accepted', async () => {
        const maya = await withApp('maya', 1_000);
        const signIn = async (step: number) =>
            (
                await answer(await loginToken(maya.userId), {
                    method: 'totp',
                    factorId: maya.factorId,
                    step,
                })
            ).result.status;
        expect(await signIn(1_001)).toBe('ok');
        expect(await signIn(1_001)).toBe('spent');
        // The step before is still inside the 90-second window, and already behind the last one used.
        expect(await signIn(1_000)).toBe('spent');
        expect(await signIn(999)).toBe('spent');
        expect(await signIn(1_002)).toBe('ok');
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_002);
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(0);
        // Each replay was a wrong answer, and was counted as one.
        expect(await signIn(1_002)).toBe('spent');
        expect(await signIn(1_001)).toBe('spent');
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(2);
    });

    test('eight sign-ins with the same code race to one session', async () => {
        const maya = await withApp('maya', 1_000);
        const tokens = await Promise.all(Array.from({ length: 8 }, () => loginToken(maya.userId)));
        for (const tokenHash of tokens) await take(tokenHash, 'totp');
        const spend = { method: 'totp', factorId: maya.factorId, step: 1_001 } as const;
        const results = await Promise.all(
            tokens.map((tokenHash) =>
                twoStep.openSteppedSession({ tokenHash, spend, session: newSession() }),
            ),
        );
        expect(results.map((result) => result.status).sort()).toEqual([
            'ok',
            ...Array.from({ length: 7 }, () => 'spent'),
        ]);
        // One session beside the one that enrolled.
        expect(await db.select().from(sessions)).toHaveLength(2);
    });

    test('a code used at sign-in is refused for a security change in the same step', async () => {
        const maya = await withApp('maya', 1_000);
        const spend = { method: 'totp', factorId: maya.factorId, step: 1_001 } as const;
        const laptop = await steppedSignIn(maya.userId, { spend });
        expect(
            await twoStep.removeFactor({
                userId: maya.userId,
                factorId: maya.factorId,
                step: await stepUp(maya.userId, laptop, 'two-step', spend),
            }),
        ).toMatchObject({
            status: 'two-step',
            reason: 'spent',
            failure: { status: 'counted', pool: 'device', consecutiveFailures: 1 },
        });
        expect(await twoStep.hasTwoStep(maya.userId)).toBe(true);
        // The replay was counted against the device that tried it.
        expect(await deviceFailures(laptop.deviceId)).toBe(1);
    });

    test('a step no code could be for yet is refused uncounted, and the server’s clock decides, not the database’s', async () => {
        const maya = await withApp('maya', 1_000);
        const now = pinClockAhead();
        const signIn = async (step: number) =>
            (
                await answer(await loginToken(maya.userId), {
                    method: 'totp',
                    factorId: maya.factorId,
                    step,
                })
            ).result;
        // A mistake above the repository, not a guess: refused, not counted, and nothing stored.
        for (const step of [
            now + 2,
            now * 1000,
            0,
            -1,
            1.5,
            Number.NaN,
            Number.MAX_SAFE_INTEGER + 1,
        ])
            expect(await signIn(step)).toEqual({ status: 'step' });
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_000);
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(0);
        // The codes the server accepts are taken: this step's and the next one's, by its own
        // clock, though the database's is twenty steps behind.
        expect((await signIn(now)).status).toBe('ok');
        expect((await signIn(now + 1)).status).toBe('ok');
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(now + 1);
        // At a step-up the same refusal carries its reason, and spends nothing.
        const step = await stepUp(maya.userId, maya.session, 'two-step', {
            method: 'totp',
            factorId: maya.factorId,
            step: now + 2,
        });
        expect(
            await twoStep.removeFactor({ userId: maya.userId, factorId: maya.factorId, step }),
        ).toEqual({ status: 'two-step', reason: 'step' });
        expect(await deviceFailures(maya.session.deviceId)).toBe(0);
        expect(await twoStep.getStepAttempt(step.tokenHash)).toMatchObject({
            answers: 1,
            failures: 0,
        });
    });

    test('when the app was last used is kept to the hour, and the table refuses anything finer', async () => {
        const maya = await withApp('maya', 1_000);
        await steppedSignIn(maya.userId, {
            spend: { method: 'totp', factorId: maya.factorId, step: 1_001 },
        });
        const used = (await factorRow(maya.factorId))!.lastUsedAt!;
        expect(used.getTime() % HOUR).toBe(0);
        expect(Date.now() - used.getTime()).toBeLessThan(HOUR);
        expect(Date.now() - used.getTime()).toBeGreaterThanOrEqual(0);
        await expect(
            db
                .update(twoStepFactors)
                .set({ lastUsedAt: new Date(used.getTime() + MINUTE) })
                .where(eq(twoStepFactors.id, maya.factorId)),
        ).rejects.toMatchObject({
            cause: { code: '23514', constraint: 'two_step_factors_times_valid' },
        });
    });
});

describe('backup codes', () => {
    test('a code works once, including under eight sign-ins at once', async () => {
        const maya = await withApp('maya');
        const codeHash = maya.codes.hashes[3]!;
        const tokens = await Promise.all(Array.from({ length: 8 }, () => loginToken(maya.userId)));
        for (const tokenHash of tokens) await take(tokenHash);
        const results = await Promise.all(
            tokens.map((tokenHash) =>
                twoStep.openSteppedSession({
                    tokenHash,
                    spend: { method: 'backup', codeHash },
                    session: newSession(),
                }),
            ),
        );
        const passed = results.filter((result) => result.status === 'ok');
        expect(passed).toMatchObject([{ method: 'backup', backupCodesLeft: 9 }]);
        expect(results.filter((result) => result.status === 'spent')).toHaveLength(7);
        expect(
            (await answer(await loginToken(maya.userId), { method: 'backup', codeHash })).result,
        ).toMatchObject({ status: 'spent' });
        expect(await twoStep.countBackupCodes(maya.userId)).toBe(9);
        // The used code is no longer among those a typed code is compared with.
        expect(await unusedHashes(maya.userId)).toEqual(
            hex(maya.codes.hashes.filter((hash) => !hash.equals(codeHash))),
        );
        // A hash nobody stored is no code.
        expect(
            (
                await answer(await loginToken(maya.userId), {
                    method: 'backup',
                    codeHash: fixed('unknown', 32),
                })
            ).result,
        ).toMatchObject({ status: 'spent' });
    });

    test('a code is spent for its own account only, even when another account stores the same bytes', async () => {
        const maya = await withApp('shared');
        const sam = await withApp('shared');
        const spend = { method: 'backup', codeHash: maya.codes.hashes[0]! } as const;
        await steppedSignIn(maya.userId, { spend });
        expect(await twoStep.countBackupCodes(maya.userId)).toBe(9);
        expect(await twoStep.countBackupCodes(sam.userId)).toBe(10);
        await steppedSignIn(sam.userId, { spend });
        expect(await twoStep.countBackupCodes(sam.userId)).toBe(9);
        // An account without the step has no codes to answer with, whatever is typed.
        const { user: noor } = await registered();
        expect(await twoStep.getBackupCodes(noor.id)).toBeNull();
        expect((await answer(await loginToken(noor.id), spend)).result).toMatchObject({
            status: 'spent',
        });
        expect(await twoStep.countBackupCodes(noor.id)).toBe(0);
    });

    test('a new set needs the step, and replaces the old one whole: old codes stop working, and the salt stays', async () => {
        const maya = await withApp('old');
        const salt = (await twoStep.getBackupCodes(maya.userId))!.salt;
        const next = codeSet('new');
        // Without the step, or with another session's, the old set stands.
        expect(await twoStep.replaceBackupCodes({ userId: maya.userId, ...next })).toEqual({
            status: 'two-step',
            reason: 'required',
        });
        const other = await steppedSignIn(maya.userId);
        expect(
            await twoStep.replaceBackupCodes({
                userId: maya.userId,
                ...next,
                step: {
                    ...(await stepUp(maya.userId, other)),
                    sessionTokenHash: maya.session.token,
                },
            }),
        ).toEqual({ status: 'two-step', reason: 'gone' });
        expect(await unusedHashes(maya.userId)).toEqual(hex(maya.codes.hashes));

        // With the step, passed by one of the old codes: that code and the new set commit together.
        expect(
            await twoStep.replaceBackupCodes({
                userId: maya.userId,
                ...next,
                step: await stepUp(maya.userId, maya.session, 'two-step', {
                    method: 'backup',
                    codeHash: maya.codes.hashes[0]!,
                }),
            }),
        ).toEqual({ status: 'ok' });
        expect(await unusedHashes(maya.userId)).toEqual(hex(next.hashes));
        for (const codeHash of maya.codes.hashes.slice(0, 3))
            expect(
                (await answer(await loginToken(maya.userId), { method: 'backup', codeHash }))
                    .result,
            ).toMatchObject({ status: 'spent' });
        await steppedSignIn(maya.userId, {
            spend: { method: 'backup', codeHash: next.hashes[9]! },
        });
        const stored = (await twoStep.getBackupCodes(maya.userId))!;
        expect(stored.salt.equals(salt)).toBe(true);
        expect(stored.codes).toHaveLength(9);
        expect(stored.codes.every((code) => code.keyId.equals(next.keyId))).toBe(true);
        // The salt and the handle are made once; asking again changes neither.
        const state = await twoStep.ensureTwoStepState(maya.userId);
        expect(state.backupCodeSalt.equals(salt)).toBe(true);
        expect(
            (await twoStep.ensureTwoStepState(maya.userId)).webauthnUserHandle.equals(
                state.webauthnUserHandle,
            ),
        ).toBe(true);
        // Another account's salt and handle are its own.
        const sam = await withApp('sam');
        const sams = await twoStep.ensureTwoStepState(sam.userId);
        expect(sams.backupCodeSalt.equals(salt)).toBe(false);
        expect(sams.webauthnUserHandle.equals(state.webauthnUserHandle)).toBe(false);
    });

    test('a set that is not ten different hashes is refused before the step is touched', async () => {
        const maya = await withApp('maya');
        const set = codeSet('short');
        const step = await stepUp(maya.userId, maya.session);
        await expect(
            twoStep.replaceBackupCodes({
                userId: maya.userId,
                ...set,
                hashes: set.hashes.slice(2),
                step,
            }),
        ).rejects.toThrow(/10 different/);
        expect(await unusedHashes(maya.userId)).toEqual(hex(maya.codes.hashes));
        expect(await twoStep.getStepAttempt(step.tokenHash)).not.toBeNull();
    });
});

describe('step tokens', () => {
    test('a token gives out five answer slots, however many requests ask at once', async () => {
        const maya = await withApp('maya');
        const tokenHash = await loginToken(maya.userId);
        const taken = await Promise.all(
            Array.from({ length: 40 }, () =>
                twoStep.takeStepAnswer({ tokenHash, method: 'backup', ...LOGIN }),
            ),
        );
        const slots = taken.filter((result) => result.status === 'ok');
        expect(slots.map((slot) => slot.left).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
        expect(taken.filter((result) => result.status === 'gone')).toHaveLength(35);
        // The thirty-five were never checked, so nothing was counted for them.
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(0);
        // Five wrong answers in those five slots, and the token is over.
        for (const slot of slots) await twoStep.recordStepFailure(slot.attempt);
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(5);
        expect(await twoStep.getStepAttempt(tokenHash)).toBeNull();
        expect(await db.select().from(twoStepAttempts)).toHaveLength(0);
    });

    test('a slot whose answer the server could not look at goes back; one that was counted wrong does not', async () => {
        const maya = await withApp('maya');
        const tokenHash = await loginToken(maya.userId);
        const another = () => twoStep.takeStepAnswer({ tokenHash, method: 'backup', ...LOGIN });
        const answers = async () => (await db.select().from(twoStepAttempts))[0]!.answers;
        // Counted wrong, then handed back: it stays used, or five answers would become six.
        const counted = await take(tokenHash);
        await twoStep.recordStepFailure(counted);
        await twoStep.returnStepAnswer(counted);
        expect(await answers()).toBe(1);
        // Taken and never checked (the server had no key for the row): handed back, it is free again.
        const unchecked = await take(tokenHash);
        expect(await answers()).toBe(2);
        await twoStep.returnStepAnswer(unchecked);
        expect(await answers()).toBe(1);
        // Four are left, as if the unchecked one was never asked; and nothing was counted for it.
        for (let slot = 0; slot < 4; slot++) expect((await another()).status).toBe('ok');
        expect((await another()).status).toBe('gone');
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(1);
        // Another account's token is not touched by a slot that names it.
        const sam = await withApp('sam');
        const theirs = await loginToken(sam.userId);
        await take(theirs);
        await twoStep.returnStepAnswer({ ...unchecked, tokenHash: theirs });
        expect((await twoStep.getStepAttempt(theirs))!.answers).toBe(1);
    });

    test('a token passes once: five right answers at once open one session', async () => {
        const maya = await withApp('maya');
        const tokenHash = await loginToken(maya.userId);
        for (let slot = 0; slot < 5; slot++) await take(tokenHash, 'phrase');
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                twoStep.openSteppedSession({ tokenHash, spend: PHRASE, session: newSession() }),
            ),
        );
        expect(results.map((result) => result.status).sort()).toEqual([
            'gone',
            'gone',
            'gone',
            'gone',
            'ok',
        ]);
        expect(results.find((result) => result.status === 'ok')).toMatchObject({
            user: { id: maya.userId },
            method: 'phrase',
            backupCodesLeft: null,
        });
        expect(await db.select().from(sessions)).toHaveLength(2);
        expect(await twoStep.getStepAttempt(tokenHash)).toBeNull();
    });

    test('a right answer needs a slot: without one taken, the gated function refuses it', async () => {
        const maya = await withApp('maya');
        const tokenHash = await loginToken(maya.userId);
        const open = () =>
            twoStep.openSteppedSession({ tokenHash, spend: PHRASE, session: newSession() });
        expect(await open()).toEqual({ status: 'gone' });
        // A slot whose answer was already counted wrong is not a slot for another answer.
        await twoStep.recordStepFailure(await take(tokenHash));
        expect(await open()).toEqual({ status: 'gone' });
        expect(await db.select().from(sessions)).toHaveLength(1);
        await take(tokenHash);
        expect((await open()).status).toBe('ok');
    });

    test('a right answer in the fifth slot passes, after four wrong ones and while the fourth is still being counted', async () => {
        const maya = await withApp('maya');
        const first = await loginToken(maya.userId);
        for (let wrong = 0; wrong < 4; wrong++) await twoStep.recordStepFailure(await take(first));
        expect(await twoStep.getStepAttempt(first)).toMatchObject({ answers: 4, failures: 4 });
        expect((await answer(first)).result.status).toBe('ok');

        // The fourth and fifth slots in flight together: the wrong one cannot end the token under the right one.
        for (let round = 0; round < 5; round++) {
            const tokenHash = await loginToken(maya.userId);
            for (let wrong = 0; wrong < 3; wrong++)
                await twoStep.recordStepFailure(await take(tokenHash));
            const fourth = await take(tokenHash);
            await take(tokenHash, 'phrase');
            const [counted, opened] = await Promise.all([
                twoStep.recordStepFailure(fourth),
                twoStep.openSteppedSession({ tokenHash, spend: PHRASE, session: newSession() }),
            ]);
            expect(counted.status).toBe('counted');
            expect(opened.status).toBe('ok');
        }
    });

    test('a right and a wrong answer racing for the last slot: one is checked, and the other never is', async () => {
        const maya = await withApp('maya');
        const outcomes = [];
        for (let round = 0; round < 8; round++) {
            const tokenHash = await loginToken(maya.userId);
            for (let wrong = 0; wrong < 4; wrong++)
                await twoStep.recordStepFailure(await take(tokenHash));
            const request = async (right: boolean) => {
                const taken = await twoStep.takeStepAnswer({
                    tokenHash,
                    method: 'phrase',
                    ...LOGIN,
                });
                if (taken.status !== 'ok') return 'unchecked';
                if (!right) return (await twoStep.recordStepFailure(taken.attempt)).status;
                const opened = await twoStep.openSteppedSession({
                    tokenHash,
                    spend: PHRASE,
                    session: newSession(),
                });
                return opened.status === 'ok' ? 'session' : opened.status;
            };
            const pair = await Promise.all([request(true), request(false)]);
            outcomes.push(pair.sort().join('+'));
            // Whichever won, the token is over.
            expect(await twoStep.getStepAttempt(tokenHash)).toBeNull();
        }
        // Never a session and a counted fifth failure from the same last slot.
        expect(
            outcomes.filter(
                (outcome) => !/^(session\+unchecked|counted\+unchecked)$/.test(outcome),
            ),
        ).toEqual([]);
    }, 30_000);

    test('a wrong answer is counted even when its token has just ended', async () => {
        const maya = await withApp('maya');
        // Ended by a right answer in another slot.
        const used = await loginToken(maya.userId);
        const wrong = await take(used);
        expect((await answer(used)).result.status).toBe('ok');
        expect(await twoStep.recordStepFailure(wrong)).toEqual({
            status: 'counted',
            left: 0,
            tokenEnded: true,
            pool: 'account',
            consecutiveFailures: 1,
            notice: false,
            froze: false,
        });
        // Ended by its five minutes, between the slot and the count.
        const expired = await loginToken(maya.userId);
        const late = await take(expired);
        await db
            .update(twoStepAttempts)
            .set({
                createdAt: new Date(Date.now() - 5 * MINUTE - 1_000),
                expiresAt: new Date(Date.now() - 1_000),
            })
            .where(eq(twoStepAttempts.tokenHash, expired));
        expect(await twoStep.recordStepFailure(late)).toMatchObject({
            status: 'counted',
            consecutiveFailures: 2,
        });
        // Ended by a password change.
        const stale = await loginToken(maya.userId);
        const staleAnswer = await take(stale);
        await db
            .update(opaqueCredentials)
            .set({ version: 2 })
            .where(eq(opaqueCredentials.userId, maya.userId));
        expect(await twoStep.recordStepFailure(staleAnswer)).toMatchObject({
            status: 'counted',
            consecutiveFailures: 3,
        });
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(3);
        // The same answer is not counted twice while its token still shows what was taken.
        expect(await twoStep.recordStepFailure(late)).toEqual({ status: 'gone' });
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(3);
    });

    test('twenty wrong answers counted at once lose none: each token ends, and the count is exact', async () => {
        const maya = await withApp('maya');
        // As ninety-five wrong answers in a row leave it.
        await db
            .update(twoStepState)
            .set({ consecutiveFailures: 95 })
            .where(eq(twoStepState.userId, maya.userId));
        const answers = [];
        for (let token = 0; token < 4; token++) {
            const tokenHash = await loginToken(maya.userId);
            for (let slot = 0; slot < 5; slot++) answers.push(await take(tokenHash));
        }
        const results = await Promise.all(answers.map((taken) => twoStep.recordStepFailure(taken)));
        const counted = results.filter((result) => result.status === 'counted');
        expect(counted.map((result) => result.consecutiveFailures).sort((a, b) => a - b)).toEqual(
            Array.from({ length: 20 }, (_, index) => 96 + index),
        );
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(115);
        // Every token saw all five of its failures, and is gone.
        expect(await db.select().from(twoStepAttempts)).toHaveLength(0);
        // The app was frozen by the hundredth, once.
        const froze = counted.filter((result) => result.froze);
        expect(froze.map((result) => result.consecutiveFailures)).toEqual([100]);
    });

    test('a token is refused once its five minutes are over, and the sweep deletes it', async () => {
        const maya = await withApp('maya');
        const expired = await loginToken(maya.userId);
        const live = await loginToken(maya.userId);
        await take(expired);
        await db
            .update(twoStepAttempts)
            .set({
                createdAt: new Date(Date.now() - 5 * MINUTE - 1_000),
                expiresAt: new Date(Date.now() - 1_000),
            })
            .where(eq(twoStepAttempts.tokenHash, expired));
        expect(await twoStep.getStepAttempt(expired)).toBeNull();
        expect(
            await twoStep.takeStepAnswer({ tokenHash: expired, method: 'backup', ...LOGIN }),
        ).toEqual({ status: 'gone' });
        // The slot taken in time does not outlive the token.
        expect(
            await twoStep.openSteppedSession({
                tokenHash: expired,
                spend: PHRASE,
                session: newSession(),
            }),
        ).toEqual({ status: 'gone' });
        expect((await auth.cleanupExpired()).stepAttempts).toBe(1);
        expect(await db.select().from(twoStepAttempts)).toHaveLength(1);
        expect(await twoStep.getStepAttempt(live)).not.toBeNull();
    });

    test('a token made for one purpose or session gives no slot and passes nothing for another, and survives the refusal', async () => {
        const maya = await withApp('maya');
        const other = await steppedSignIn(maya.userId);
        const tokenHash = await sessionToken(maya.userId, maya.session.token, 'password');
        const slot = (purpose: TwoStepPurpose, sessionTokenHash: Buffer | null) =>
            twoStep.takeStepAnswer({ tokenHash, method: 'phrase', purpose, sessionTokenHash });
        for (const [purpose, session] of [
            ['delete', maya.session.token],
            ['two-step', maya.session.token],
            ['password', other.token],
            ['password', null],
            ['login', null],
            ['enrol', null],
        ] as const)
            expect(await slot(purpose, session)).toEqual({ status: 'gone' });
        expect(await twoStep.getStepAttempt(tokenHash)).toMatchObject({ answers: 0 });

        // With a slot properly taken, the gated functions hold the same line.
        expect((await slot('password', maya.session.token)).status).toBe('ok');
        const proof = { tokenHash, spend: PHRASE };
        // As a sign-in.
        expect(await twoStep.openSteppedSession({ ...proof, session: newSession() })).toEqual({
            status: 'gone',
        });
        // As a two-step change from its own session, and as a password change from another.
        expect(
            await twoStep.removeFactor({
                userId: maya.userId,
                factorId: maya.factorId,
                step: { ...proof, sessionTokenHash: maya.session.token },
            }),
        ).toEqual({ status: 'two-step', reason: 'gone' });
        const change = (session: Session, action: 'password' | 'recovery-key' = 'password') =>
            auth.changeAccountSecurity({
                userId: maya.userId,
                action,
                sessionTokenHash: session.token,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: {
                    keyVersion: 1,
                    wrappingSalt: bytes(32),
                    wrappingNonce: bytes(24),
                    encryptedKey: bytes(48),
                },
                twoStep: proof,
            });
        expect(await change(other)).toEqual({ status: 'two-step', reason: 'gone' });
        expect(await twoStep.hasTwoStep(maya.userId)).toBe(true);
        expect(await twoStep.getStepAttempt(tokenHash)).toMatchObject({ answers: 1, failures: 0 });
        // For what it was made for, from the session it was made for, it passes.
        expect(await change(maya.session)).toBe(true);
    });

    test('a sign-in’s token cannot authorise a security change, and an enrolment’s token is not a sign-in’s', async () => {
        const maya = await withApp('maya');
        const login = await loginToken(maya.userId);
        const enrol = await loginToken(maya.userId, { purpose: 'enrol' });
        await take(login);
        await take(enrol, 'backup', { purpose: 'enrol', sessionTokenHash: null });
        for (const tokenHash of [login, enrol]) {
            const step = { sessionTokenHash: maya.session.token, tokenHash, spend: PHRASE };
            expect(
                await twoStep.removeFactor({ userId: maya.userId, factorId: maya.factorId, step }),
            ).toEqual({ status: 'two-step', reason: 'gone' });
            expect(
                await twoStep.replaceBackupCodes({ userId: maya.userId, ...codeSet('new'), step }),
            ).toEqual({ status: 'two-step', reason: 'gone' });
            expect(
                await auth.deleteAccount({
                    userId: maya.userId,
                    credentialVersion: 1,
                    sessionTokenHash: maya.session.token,
                    twoStep: step,
                }),
            ).toEqual({ status: 'two-step', reason: 'gone' });
        }
        // `enrol` is refused as `login`, and `login` as `enrol`.
        expect(
            await twoStep.takeStepAnswer({ tokenHash: enrol, method: 'phrase', ...LOGIN }),
        ).toEqual({ status: 'gone' });
        expect(
            await twoStep.takeStepAnswer({
                tokenHash: login,
                method: 'phrase',
                purpose: 'enrol',
                sessionTokenHash: null,
            }),
        ).toEqual({ status: 'gone' });
        expect(
            await twoStep.openSteppedSession({
                tokenHash: enrol,
                spend: PHRASE,
                session: newSession(),
            }),
        ).toEqual({ status: 'gone' });
        expect(await db.select().from(sessions)).toHaveLength(1);
        expect(await twoStep.hasTwoStep(maya.userId)).toBe(true);
        // The sign-in's token still does what it is for.
        expect(
            (
                await twoStep.openSteppedSession({
                    tokenHash: login,
                    spend: PHRASE,
                    session: newSession(),
                })
            ).status,
        ).toBe('ok');
    });

    test('a token from before a password change is refused after it', async () => {
        const maya = await withApp('maya');
        const login = await loginToken(maya.userId);
        const stepUpToken = await sessionToken(maya.userId, maya.session.token);
        await take(login);
        await take(stepUpToken, 'phrase', {
            purpose: 'two-step',
            sessionTokenHash: maya.session.token,
        });
        // What a password change does to the credential (changeAccountSecurity, resetAccountPassword).
        await db
            .update(opaqueCredentials)
            .set({ version: 2 })
            .where(eq(opaqueCredentials.userId, maya.userId));
        expect(await twoStep.getStepAttempt(login)).toBeNull();
        expect(
            await twoStep.takeStepAnswer({ tokenHash: login, method: 'phrase', ...LOGIN }),
        ).toEqual({ status: 'gone' });
        expect(
            await twoStep.openSteppedSession({
                tokenHash: login,
                spend: PHRASE,
                session: newSession(),
            }),
        ).toEqual({ status: 'gone' });
        expect(
            await twoStep.removeFactor({
                userId: maya.userId,
                factorId: maya.factorId,
                step: {
                    sessionTokenHash: maya.session.token,
                    tokenHash: stepUpToken,
                    spend: PHRASE,
                },
            }),
        ).toEqual({ status: 'two-step', reason: 'gone' });
        expect(await twoStep.hasTwoStep(maya.userId)).toBe(true);
    });

    test('a step-up’s token dies with its session', async () => {
        const maya = await withApp('maya');
        const other = await steppedSignIn(maya.userId);
        const step = await stepUp(maya.userId, other);
        expect(await twoStep.getStepAttempt(step.tokenHash)).not.toBeNull();
        await auth.signOutDevice(other.token);
        expect(await twoStep.getStepAttempt(step.tokenHash)).toBeNull();
        expect(
            await twoStep.removeFactor({ userId: maya.userId, factorId: maya.factorId, step }),
        ).toEqual({ status: 'two-step', reason: 'gone' });
        expect(await twoStep.hasTwoStep(maya.userId)).toBe(true);
    });

    test('only a valid proof from the account’s own keyed device selects a device’s count; anything else is the shared one', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const sam = await withApp('sam');
        const samsLaptop = await keyedDevice(sam.userId, 'laptop');
        const store = async (device: twoStep.StepAttemptInput & { purpose: 'login' }) => {
            const stored = await twoStep.createStepAttempt(device);
            return { stored, attempt: await twoStep.getStepAttempt(device.tokenHash) };
        };
        const login = (device: ReturnType<typeof proofOf> | null) => ({
            purpose: 'login' as const,
            tokenHash: sha256(randomUUID()),
            userId: maya.userId,
            credentialVersion: 1,
            device,
            previousTokenHash: null,
            expiresAt: new Date(Date.now() + 5 * MINUTE),
        });

        const own = login(proofOf(maya.userId, laptop));
        expect(await store(own)).toMatchObject({
            stored: { deviceId: laptop.deviceId },
            attempt: {
                deviceId: laptop.deviceId,
                pool: { kind: 'device', deviceId: laptop.deviceId },
                poolFailures: 0,
            },
        });
        const valid = proofOf(maya.userId, laptop);
        const refused = [
            // The right device, signed by another key.
            proofOf(maya.userId, laptop, samsLaptop.signer),
            // A valid signature over another attempt.
            { ...valid, attemptDigest: sha256(randomUUID()) },
            // Another account's device, with that device's own valid signature for its own account.
            proofOf(sam.userId, samsLaptop),
            // Another account's device, signed as if it were Maya's.
            proofOf(maya.userId, samsLaptop),
            // A device of Maya's that never had a key.
            { ...valid, id: maya.session.deviceId },
            // An id that is no device, and one that is no id: no proof, not an error.
            { ...valid, id: randomUUID() },
            { ...valid, id: 'laptop' },
            { ...valid, id: laptop.deviceId.toUpperCase() },
        ];
        for (const device of refused) {
            const input = login(device);
            expect(await store(input)).toMatchObject({
                stored: { deviceId: null },
                attempt: { deviceId: null, pool: { kind: 'account' } },
            });
            await twoStep.recordStepFailure(await take(input.tokenHash));
        }
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(refused.length);
        expect(await deviceFailures(samsLaptop.deviceId)).toBe(0);
        expect(await deviceFailures(laptop.deviceId)).toBe(0);
        expect(await twoStep.getStepAttempt(own.tokenHash)).toMatchObject({ poolFailures: 0 });

        // A device removed after the token was made: the token is dead, not moved to the shared count.
        await take(own.tokenHash);
        await auth.revokeDevice({
            userId: maya.userId,
            deviceId: laptop.deviceId,
            sessionTokenHash: maya.session.token,
        });
        expect(await twoStep.getStepAttempt(own.tokenHash)).toBeNull();
        expect(
            await twoStep.openSteppedSession({
                tokenHash: own.tokenHash,
                spend: PHRASE,
                session: newSession(),
            }),
        ).toEqual({ status: 'gone' });
    });

    test('the session a step opens sits on the token’s device: the proven one, the one the cookie lends, or a new one', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const devices = async () => (await db.select().from(accountDevices)).length;
        const before = await devices();

        // The device whose key proof the token carries: its own row, and its old session ends.
        const proven = await answer(await loginToken(maya.userId, { device: laptop }));
        expect(proven.result).toMatchObject({
            status: 'ok',
            device: { id: laptop.deviceId, attached: true, registered: true, created: null },
        });
        expect(await sessionRow(laptop.token)).toBeUndefined();
        expect(await sessionRow(proven.session.tokenHash)).toMatchObject({
            deviceId: laptop.deviceId,
            userId: maya.userId,
            credentialVersion: 1,
        });
        expect(await devices()).toBe(before);

        // A keyless browser's previous session lends its device, and is retired.
        const lent = await answer(await loginToken(maya.userId, { previous: maya.session.token }));
        expect(lent.result).toMatchObject({
            status: 'ok',
            device: { id: maya.session.deviceId, attached: true, created: null },
        });
        expect(await sessionRow(maya.session.token)).toBeUndefined();
        expect(await devices()).toBe(before);

        // Neither: a new device, made with the password and the step.
        const fresh = await answer(await loginToken(maya.userId));
        expect(fresh.result).toMatchObject({
            status: 'ok',
            device: { attached: false, registered: false, created: 'password' },
        });
        expect(await devices()).toBe(before + 1);

        // Another account's session as the cookie lends nothing: Maya's session is on a device of
        // her own. (The cookie's session is retired with the cookie, as at any sign-in.)
        const sam = await withApp('sam');
        const crossed = await answer(
            await loginToken(maya.userId, { previous: sam.session.token }),
        );
        expect(crossed.result).toMatchObject({ status: 'ok', device: { attached: false } });
        const [samsDevice] = await db
            .select()
            .from(accountDevices)
            .where(eq(accountDevices.id, sam.session.deviceId));
        expect(samsDevice).toMatchObject({ userId: sam.userId });
        expect((await sessionRow(crossed.session.tokenHash))!.deviceId).not.toBe(
            sam.session.deviceId,
        );
    });

    test('the stamp is the moment the step was passed, set by the repository', async () => {
        const maya = await withApp('maya');
        const before = Date.now();
        const signedIn = await steppedSignIn(maya.userId);
        const stamp = (await stampOf(signedIn.token))!.getTime();
        expect(stamp).toBeGreaterThanOrEqual(before);
        expect(stamp).toBeLessThanOrEqual(Date.now());
    });
});

describe('a step and what it authorises commit together', () => {
    test('a sign-in whose session cannot be written spends neither the code nor the token', async () => {
        const maya = await withApp('maya', 1_000);
        const totp = { method: 'totp', factorId: maya.factorId, step: 1_001 } as const;
        const backup = { method: 'backup', codeHash: maya.codes.hashes[0]! } as const;
        const spent = async () => ({
            lastStep: (await factorRow(maya.factorId))!.totpLastStep,
            codes: await twoStep.countBackupCodes(maya.userId),
            failures: (await stateRow(maya.userId))!.consecutiveFailures,
            sessions: (await db.select().from(sessions)).length,
        });
        for (const spend of [totp, backup]) {
            await fail(maya.userId, 2);
            const before = await spent();
            expect(before.failures).toBe(2);
            const tokenHash = await loginToken(maya.userId);
            await take(tokenHash, spend.method);
            // The new session's token is one that already exists: the insert fails.
            await expect(
                twoStep.openSteppedSession({
                    tokenHash,
                    spend,
                    session: {
                        tokenHash: maya.session.token,
                        expiresAt: new Date(Date.now() + HOUR),
                    },
                }),
            ).rejects.toMatchObject({ cause: { code: '23505' } });
            // Nothing the step did survived: the code, the token and the count are as they were.
            expect(await spent()).toEqual(before);
            expect(await twoStep.getStepAttempt(tokenHash)).toMatchObject({
                answers: 1,
                failures: 0,
            });
            // The same code, on the same token, then signs in.
            expect(
                (await twoStep.openSteppedSession({ tokenHash, spend, session: newSession() }))
                    .status,
            ).toBe('ok');
            expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(0);
        }
        expect(await spent()).toMatchObject({ lastStep: 1_001, codes: 9, sessions: 3 });
    });

    test('a suspended account gets no session, and its code is not spent', async () => {
        const maya = await withApp('maya', 1_000);
        const tokenHash = await loginToken(maya.userId);
        await take(tokenHash, 'backup');
        const spend = { method: 'backup', codeHash: maya.codes.hashes[0]! } as const;
        // Suspension ends sessions and leaves step tokens; set directly to keep the enrolling session.
        await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, maya.userId));
        expect(
            await twoStep.openSteppedSession({ tokenHash, spend, session: newSession() }),
        ).toEqual({ status: 'suspended' });
        expect(await twoStep.countBackupCodes(maya.userId)).toBe(10);
        expect(await db.select().from(sessions)).toHaveLength(1);
        await db.update(users).set({ suspendedAt: null }).where(eq(users.id, maya.userId));
        expect(
            (await twoStep.openSteppedSession({ tokenHash, spend, session: newSession() })).status,
        ).toBe('ok');
    });

    const envelope = () => ({
        keyVersion: 1,
        wrappingSalt: bytes(32),
        wrappingNonce: bytes(24),
        encryptedKey: bytes(48),
    });

    test('a password change needs the step; one that is refused for another reason spends nothing', async () => {
        const maya = await withApp('maya', 1_000);
        const change = (input: { twoStep?: twoStep.StepProof; keyVersion?: number }) =>
            auth.changeAccountSecurity({
                userId: maya.userId,
                action: 'password',
                sessionTokenHash: maya.session.token,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: { ...envelope(), keyVersion: input.keyVersion ?? 1 },
                twoStep: input.twoStep,
            });
        const version = async () =>
            (
                await db
                    .select({ version: opaqueCredentials.version })
                    .from(opaqueCredentials)
                    .where(eq(opaqueCredentials.userId, maya.userId))
            )[0]!.version;
        expect(await change({})).toEqual({ status: 'two-step', reason: 'required' });
        expect(await version()).toBe(1);

        const spend = { method: 'totp', factorId: maya.factorId, step: 1_001 } as const;
        const step = await stepUp(maya.userId, maya.session, 'password', spend);
        // A change the repository refuses on its own grounds: the envelope names the wrong key version.
        expect(await change({ twoStep: step, keyVersion: 2 })).toBe(false);
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_000);
        expect(await twoStep.getStepAttempt(step.tokenHash)).toMatchObject({
            answers: 1,
            failures: 0,
        });
        expect(await version()).toBe(1);

        // A step answered with a code already used: refused, counted, and nothing changed.
        await steppedSignIn(maya.userId, { spend });
        expect(await change({ twoStep: step })).toMatchObject({
            status: 'two-step',
            reason: 'spent',
            failure: { status: 'counted', pool: 'device', consecutiveFailures: 1 },
        });
        expect(await version()).toBe(1);
        expect(await deviceFailures(maya.session.deviceId)).toBe(1);

        // The next code, on the same token: the change and the spend commit together.
        await take(step.tokenHash, 'totp', {
            purpose: 'password',
            sessionTokenHash: maya.session.token,
        });
        expect(await change({ twoStep: { ...step, spend: { ...spend, step: 1_002 } } })).toBe(true);
        expect(await version()).toBe(2);
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_002);
        expect(await db.select().from(sessions)).toHaveLength(0);
        // The step itself survives a password change.
        expect(await twoStep.hasTwoStep(maya.userId)).toBe(true);
    });

    test('a change that asked for a replacement session writes one only with the step passed: on the same device, stamped, and for ten minutes however long was asked', async () => {
        const replacement = () => ({
            tokenHash: sha256(randomUUID()),
            expiresAt: new Date(Date.now() + 7 * 24 * HOUR),
        });
        const change = (
            who: { userId: string; session: Session },
            input: { twoStep?: twoStep.StepProof; replacement: ReturnType<typeof replacement> },
        ) =>
            auth.changeAccountSecurity({
                userId: who.userId,
                action: 'password',
                sessionTokenHash: who.session.token,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: envelope(),
                ...input,
            });
        const maya = await withApp('maya');
        const elsewhere = await steppedSignIn(maya.userId);
        // Without the step nothing changes, and nothing is written.
        const refused = replacement();
        expect(await change(maya, { replacement: refused })).toEqual({
            status: 'two-step',
            reason: 'required',
        });
        expect(await sessionRow(refused.tokenHash)).toBeUndefined();

        const asked = replacement();
        const before = Date.now();
        expect(
            await change(maya, {
                twoStep: await stepUp(maya.userId, maya.session, 'password'),
                replacement: asked,
            }),
        ).toBe('replaced');
        // Every other session ended, the other device's included; the one written is this device's.
        const left = await db.select().from(sessions);
        expect(left).toHaveLength(1);
        expect(left[0]).toMatchObject({
            userId: maya.userId,
            deviceId: maya.session.deviceId,
            credentialVersion: 2,
        });
        expect(left[0]!.deviceId).not.toBe(elsewhere.deviceId);
        expect(left[0]!.tokenHash.equals(asked.tokenHash)).toBe(true);
        expect(left[0]!.twoStepAt!.getTime()).toBeGreaterThanOrEqual(before);
        // A week was asked for; ten minutes is what a replacement gets.
        expect(left[0]!.expiresAt.getTime()).toBeLessThanOrEqual(
            Date.now() + twoStep.REPLACEMENT_SESSION_SECONDS * 1000,
        );
        expect(twoStep.REPLACEMENT_SESSION_SECONDS).toBe(600);

        // Using it does not extend it. An ordinary session's deadline slides when it is used,
        // five minutes or more after it was last seen; this one keeps the end it was given.
        const lifetime = { idleSeconds: 7 * 24 * 3600, maxSeconds: 30 * 24 * 3600 };
        const end = left[0]!.expiresAt.getTime();
        const ordinary = await passwordSignIn((await registered()).user.id);
        const ordinaryEnd = (await sessionRow(ordinary.token))!.expiresAt.getTime();
        const start = Date.now();
        vi.useFakeTimers({ now: start + 6 * MINUTE, toFake: ['Date'] });
        try {
            expect((await auth.getSession(asked.tokenHash, lifetime))?.user.id).toBe(maya.userId);
            expect((await sessionRow(asked.tokenHash))!.expiresAt.getTime()).toBe(end);
            // The same use slides the ordinary one, so the check above is not vacuous.
            expect(await auth.getSession(ordinary.token, lifetime)).not.toBeNull();
            expect((await sessionRow(ordinary.token))!.expiresAt.getTime()).toBeGreaterThan(
                ordinaryEnd + 5 * MINUTE,
            );
            // At minute eleven it is over, used or not.
            vi.setSystemTime(start + 11 * MINUTE);
            expect(await auth.getSession(asked.tokenHash, lifetime)).toBeNull();
            expect(await auth.getSession(ordinary.token, lifetime)).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }

        // An account without the step: asked or not, a password change ends every session.
        const { user } = await registered();
        const sam = { userId: user.id, session: await passwordSignIn(user.id) };
        expect(await change(sam, { replacement: replacement() })).toBe(true);
        expect(
            (await db.select().from(sessions)).filter((row) => row.userId === user.id),
        ).toHaveLength(0);
    });

    test('an account without the step changes its password as before, whatever proof is sent', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        expect(
            await auth.changeAccountSecurity({
                userId: user.id,
                action: 'password',
                sessionTokenHash: session.token,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: envelope(),
                twoStep: { tokenHash: sha256(randomUUID()), spend: PHRASE },
            }),
        ).toBe(true);
    });

    test('deleting the account needs the step; a deletion refused for another reason spends nothing', async () => {
        const maya = await withApp('maya', 1_000);
        const remove = (input: { twoStep?: twoStep.StepProof; credentialVersion?: number }) =>
            auth.deleteAccount({
                userId: maya.userId,
                credentialVersion: input.credentialVersion ?? 1,
                sessionTokenHash: maya.session.token,
                twoStep: input.twoStep,
            });
        expect(await remove({})).toEqual({ status: 'two-step', reason: 'required' });
        const spend = { method: 'backup', codeHash: maya.codes.hashes[0]! } as const;
        const step = await stepUp(maya.userId, maya.session, 'delete', spend);
        expect(await remove({ twoStep: step, credentialVersion: 2 })).toBe(false);
        expect(await twoStep.countBackupCodes(maya.userId)).toBe(10);
        expect(await twoStep.getStepAttempt(step.tokenHash)).toMatchObject({ answers: 1 });
        expect(await db.select().from(users)).toHaveLength(1);
        expect(await remove({ twoStep: step })).toBe(true);
        expect(await db.select().from(users)).toHaveLength(0);
    });
});

describe('wrong answers in a row', () => {
    test('count across tokens for sign-ins that prove no device, and the notice starts at the fifth', async () => {
        const maya = await withApp('maya');
        const first = await loginToken(maya.userId);
        const second = await loginToken(maya.userId);
        const counted = [];
        for (const tokenHash of [first, second, first, second, first, second])
            counted.push(await twoStep.recordStepFailure(await take(tokenHash)));
        expect(counted).toMatchObject([
            { pool: 'account', consecutiveFailures: 1, notice: false, left: 4 },
            { pool: 'account', consecutiveFailures: 2, notice: false, left: 4 },
            { pool: 'account', consecutiveFailures: 3, notice: false, left: 3 },
            { pool: 'account', consecutiveFailures: 4, notice: false, left: 3 },
            { pool: 'account', consecutiveFailures: 5, notice: true, left: 2 },
            { pool: 'account', consecutiveFailures: 6, notice: true, left: 2 },
        ]);
        // The count is served on the next token, for the server to act on.
        expect(await twoStep.getStepAttempt(await loginToken(maya.userId))).toMatchObject({
            pool: { kind: 'account' },
            poolFailures: 6,
        });
        // Another account's count is its own.
        const sam = await withApp('sam');
        expect((await fail(sam.userId, 1))[0]).toMatchObject({ consecutiveFailures: 1 });
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(6);
    });

    test('a known device has its own count: sign-ins that proved it and step-ups from its session', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const phone = await keyedDevice(maya.userId, 'phone');
        await fail(maya.userId, 2);
        expect((await fail(maya.userId, 3, laptop)).at(-1)).toMatchObject({
            pool: 'device',
            consecutiveFailures: 3,
            notice: false,
        });
        const binding = { purpose: 'two-step', sessionTokenHash: laptop.token } as const;
        const stepUpToken = await sessionToken(maya.userId, laptop.token);
        expect(
            await twoStep.recordStepFailure(await take(stepUpToken, 'backup', binding)),
        ).toMatchObject({ pool: 'device', consecutiveFailures: 4 });
        expect(
            await twoStep.recordStepFailure(await take(stepUpToken, 'backup', binding)),
        ).toMatchObject({ pool: 'device', consecutiveFailures: 5, notice: true });
        expect(await deviceFailures(laptop.deviceId)).toBe(5);
        expect(await deviceFailures(phone.deviceId)).toBe(0);
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(2);
        // Each token carries its own pool's count.
        expect(
            await twoStep.getStepAttempt(await loginToken(maya.userId, { device: laptop })),
        ).toMatchObject({ pool: { kind: 'device', deviceId: laptop.deviceId }, poolFailures: 5 });
        expect(
            await twoStep.getStepAttempt(await sessionToken(maya.userId, phone.token)),
        ).toMatchObject({ pool: { kind: 'device', deviceId: phone.deviceId }, poolFailures: 0 });
        expect(await twoStep.getStepAttempt(await loginToken(maya.userId))).toMatchObject({
            poolFailures: 2,
        });
    });

    test('a replayed code is counted once, and the count reaches the caller: the fifth carries the notice', async () => {
        const maya = await withApp('maya', 1_000);
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const replay = { method: 'totp', factorId: maya.factorId, step: 1_000 } as const;
        // At sign-in, from sign-ins that prove no device.
        const failures = [];
        for (let attempt = 0; attempt < 5; attempt++) {
            const { result } = await answer(await loginToken(maya.userId), replay);
            if (result.status !== 'spent') throw new Error(`Replay ${result.status}.`);
            failures.push(result.failure);
        }
        expect(failures).toMatchObject([
            { status: 'counted', pool: 'account', consecutiveFailures: 1, notice: false },
            { consecutiveFailures: 2, notice: false },
            { consecutiveFailures: 3, notice: false },
            { consecutiveFailures: 4, notice: false },
            { consecutiveFailures: 5, notice: true, froze: false },
        ]);
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(5);

        // At a step-up, on one token: the same, in the device's count, and the fifth ends the token.
        const tokenHash = await sessionToken(maya.userId, laptop.token);
        const binding = { purpose: 'two-step', sessionTokenHash: laptop.token } as const;
        const refusals = [];
        const taken = [];
        for (let attempt = 0; attempt < 5; attempt++) {
            taken.push(await take(tokenHash, 'totp', binding));
            refusals.push(
                await twoStep.replaceBackupCodes({
                    userId: maya.userId,
                    ...codeSet('new'),
                    step: { sessionTokenHash: laptop.token, tokenHash, spend: replay },
                }),
            );
        }
        expect(refusals).toMatchObject([
            { status: 'two-step', reason: 'spent', failure: { pool: 'device', notice: false } },
            { reason: 'spent', failure: { consecutiveFailures: 2, left: 3 } },
            { reason: 'spent', failure: { consecutiveFailures: 3 } },
            { reason: 'spent', failure: { consecutiveFailures: 4, notice: false } },
            {
                reason: 'spent',
                failure: { consecutiveFailures: 5, notice: true, tokenEnded: true, left: 0 },
            },
        ]);
        expect(await deviceFailures(laptop.deviceId)).toBe(5);
        expect(await twoStep.getStepAttempt(tokenHash)).toBeNull();
        expect(await unusedHashes(maya.userId)).toEqual(hex(maya.codes.hashes));

        // The caller reporting the same answer again is not a second count, while the token stands.
        const standing = await loginToken(maya.userId);
        const slot = await take(standing, 'totp');
        const refused = await twoStep.openSteppedSession({
            tokenHash: standing,
            spend: replay,
            session: newSession(),
        });
        expect(refused).toMatchObject({ status: 'spent', failure: { consecutiveFailures: 6 } });
        expect(await twoStep.recordStepFailure(slot)).toEqual({ status: 'gone' });
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(6);
        expect(await twoStep.getStepAttempt(standing)).toMatchObject({ answers: 1, failures: 1 });
    });

    test('a success resets the count of its own pool and no other', async () => {
        const maya = await withApp('maya', 1_000);
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const phone = await keyedDevice(maya.userId, 'phone');
        const sam = await withApp('sam');
        const samsLaptop = await keyedDevice(sam.userId, 'laptop');
        await fail(maya.userId, 3);
        await fail(maya.userId, 2, laptop);
        await fail(maya.userId, 4, phone);
        await fail(sam.userId, 2);
        await fail(sam.userId, 2, samsLaptop);

        await steppedSignIn(maya.userId, {
            device: laptop,
            spend: { method: 'totp', factorId: maya.factorId, step: 1_001 },
        });
        expect(await deviceFailures(laptop.deviceId)).toBe(0);
        expect(await deviceFailures(phone.deviceId)).toBe(4);
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(3);

        await steppedSignIn(maya.userId, {
            spend: { method: 'totp', factorId: maya.factorId, step: 1_002 },
        });
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(0);
        expect(await deviceFailures(phone.deviceId)).toBe(4);
        expect((await stateRow(sam.userId))!.consecutiveFailures).toBe(2);
        expect(await deviceFailures(samsLaptop.deviceId)).toBe(2);
        // After a reset, the count starts from one.
        expect((await fail(maya.userId, 1))[0]).toMatchObject({ consecutiveFailures: 1 });
    });

    test('the hundredth freezes the app for sign-ins that prove no device, and only for those', async () => {
        const maya = await withApp('maya', 1_000);
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const results = await fail(maya.userId, 99);
        expect(results.some((result) => result.froze)).toBe(false);
        expect((await twoStep.getTwoStep(maya.userId)).totpFrozen).toBe(false);
        expect(await twoStep.getStepAttempt(await loginToken(maya.userId))).toMatchObject({
            totpFrozen: false,
        });

        const [hundredth] = await fail(maya.userId, 1);
        expect(hundredth).toMatchObject({ consecutiveFailures: 100, froze: true });
        expect((await twoStep.getTwoStep(maya.userId)).totpFrozen).toBe(true);
        const frozen = await loginToken(maya.userId);
        expect(await twoStep.getStepAttempt(frozen)).toMatchObject({
            pool: { kind: 'account' },
            totpFrozen: true,
        });
        // The app's code gets no slot there, and passes nothing even with a slot taken for another method.
        expect(
            await twoStep.takeStepAnswer({ tokenHash: frozen, method: 'totp', ...LOGIN }),
        ).toEqual({ status: 'frozen' });
        expect(await twoStep.getStepAttempt(frozen)).toMatchObject({ answers: 0 });
        await take(frozen, 'backup');
        const spend = { method: 'totp', factorId: maya.factorId, step: 1_001 } as const;
        expect(
            await twoStep.openSteppedSession({ tokenHash: frozen, spend, session: newSession() }),
        ).toEqual({ status: 'frozen' });
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_000);
        // Refused unchecked is not a wrong answer.
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(100);

        // A known device still takes the app's codes, at sign-in and at a step-up.
        const known = await loginToken(maya.userId, { device: laptop });
        expect(await twoStep.getStepAttempt(known)).toMatchObject({
            pool: { kind: 'device' },
            totpFrozen: false,
        });
        await take(known, 'totp');
        expect(
            (await twoStep.openSteppedSession({ tokenHash: known, spend, session: newSession() }))
                .status,
        ).toBe('ok');
        // The app's own code from a known device does not lift the freeze.
        expect((await twoStep.getTwoStep(maya.userId)).totpFrozen).toBe(true);
        // Already frozen: the next wrong answer does not freeze it a second time.
        expect((await fail(maya.userId, 1))[0]).toMatchObject({
            consecutiveFailures: 101,
            froze: false,
        });
        // Another account is not frozen by any of it.
        const sam = await withApp('sam');
        expect((await twoStep.getTwoStep(sam.userId)).totpFrozen).toBe(false);
    }, 60_000);

    test('a hundred wrong answers from a known device freeze nothing, and the count is there to act on', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const results = await fail(maya.userId, 101, laptop);
        expect(results.at(-1)).toMatchObject({ pool: 'device', consecutiveFailures: 101 });
        expect(results.some((result) => result.froze)).toBe(false);
        expect((await stateRow(maya.userId))!.totpFrozenAt).toBeNull();
        expect(
            await twoStep.getStepAttempt(await loginToken(maya.userId, { device: laptop })),
        ).toMatchObject({ poolFailures: 101, totpFrozen: false });
        expect(
            await twoStep.getStepAttempt(await sessionToken(maya.userId, laptop.token)),
        ).toMatchObject({ poolFailures: 101, totpFrozen: false });
    }, 60_000);

    test('a freeze is lifted by a success with another method, and never hands out more guesses', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        await fail(maya.userId, 100);

        // A backup code from the known device lifts it, and leaves the shared count where it was.
        await steppedSignIn(maya.userId, {
            device: laptop,
            spend: { method: 'backup', codeHash: maya.codes.hashes[0]! },
        });
        expect(await stateRow(maya.userId)).toMatchObject({
            consecutiveFailures: 100,
            totpFrozenAt: null,
        });
        // So the next wrong answer without a device proof freezes it again at once.
        expect((await fail(maya.userId, 1))[0]).toMatchObject({
            consecutiveFailures: 101,
            froze: true,
        });

        // A success without a device proof, with the phrase: lifted, and the count starts over.
        await steppedSignIn(maya.userId);
        expect(await stateRow(maya.userId)).toMatchObject({
            consecutiveFailures: 0,
            totpFrozenAt: null,
        });
        expect((await fail(maya.userId, 1))[0]).toMatchObject({
            consecutiveFailures: 1,
            froze: false,
        });
    }, 60_000);
});

describe('the recovery key of an account with the step on', () => {
    test('cannot be added from a session by account setup: the phrase passes the step, so it is not stored past it', async () => {
        const recoveryOf = (userId: string) =>
            db.select().from(accountRecoveryKeys).where(eq(accountRecoveryKeys.userId, userId));
        const setUp = (userId: string, session: Session) =>
            auth.initializeAccount({
                userId,
                credentialVersion: 1,
                sessionTokenHash: session.token,
                initialQuotaBytes: 1_073_741_824n,
                recovery: registration().recovery,
            });
        // The step on and, as only an account from before this rule could be, no recovery key.
        const maya = await withApp('maya');
        await db.delete(accountRecoveryKeys).where(eq(accountRecoveryKeys.userId, maya.userId));
        expect(await setUp(maya.userId, maya.session)).toBe(true);
        expect(await recoveryOf(maya.userId)).toHaveLength(0);

        // Without the step, setup stores it as it always has.
        const { user: sam } = await registered();
        const session = await passwordSignIn(sam.id);
        await db.delete(accountRecoveryKeys).where(eq(accountRecoveryKeys.userId, sam.id));
        expect(await setUp(sam.id, session)).toBe(true);
        expect(await recoveryOf(sam.id)).toHaveLength(1);

        // And once the step is off again, maya's can be stored.
        const removed = await twoStep.removeFactor({
            userId: maya.userId,
            factorId: maya.factorId,
            step: await stepUp(maya.userId, maya.session),
        });
        expect(removed.status).toBe('ok');
        expect(await setUp(maya.userId, maya.session)).toBe(true);
        expect(await recoveryOf(maya.userId)).toHaveLength(1);
    });
});

describe('removing a method', () => {
    test('needs the step for a confirmed method, and the answer is spent only if the method goes', async () => {
        const maya = await withApp('maya', 1_000);
        expect(
            await twoStep.removeFactor({ userId: maya.userId, factorId: maya.factorId }),
        ).toEqual({ status: 'two-step', reason: 'required' });
        expect(await twoStep.hasTwoStep(maya.userId)).toBe(true);
        // The step, passed by the app being removed: its last code and its removal, together.
        const spend = { method: 'totp', factorId: maya.factorId, step: 1_001 } as const;
        const step = await stepUp(maya.userId, maya.session, 'two-step', spend);
        // A method that is not there: nothing removed, nothing spent.
        expect(
            await twoStep.removeFactor({ userId: maya.userId, factorId: randomUUID(), step }),
        ).toEqual({ status: 'missing' });
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_000);
        expect(await twoStep.getStepAttempt(step.tokenHash)).not.toBeNull();
        expect(
            await twoStep.removeFactor({ userId: maya.userId, factorId: maya.factorId, step }),
        ).toEqual({ status: 'ok', kind: 'totp', turnedOff: true });
    });

    test('one of two leaves the step on; the last turns it off and deletes the codes, tokens and counts', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const keyId = await securityKey(maya.userId, 'maya');
        await fail(maya.userId, 100);
        await fail(maya.userId, 2, laptop);
        const pendingLogin = await loginToken(maya.userId);
        const sam = await withApp('sam');
        const samsLogin = await loginToken(sam.userId);
        await fail(sam.userId, 1);

        // The app goes, the key stays: the step is on, the codes stand, and the app's freeze is lifted.
        expect(
            await twoStep.removeFactor({
                userId: maya.userId,
                factorId: maya.factorId,
                step: await stepUp(maya.userId, laptop, 'two-step', {
                    method: 'backup',
                    codeHash: maya.codes.hashes[0]!,
                }),
            }),
        ).toEqual({ status: 'ok', kind: 'totp', turnedOff: false });
        expect(await twoStep.getTwoStep(maya.userId)).toMatchObject({
            on: true,
            backupCodesLeft: 9,
            totpFrozen: false,
        });
        expect(await twoStep.getTotpFactor(maya.userId)).toBeNull();
        expect(await twoStep.getStepAttempt(pendingLogin)).not.toBeNull();
        // With only a key, a wrong answer past the hundredth has no app to freeze.
        expect((await fail(maya.userId, 1))[0]).toMatchObject({
            consecutiveFailures: 101,
            froze: false,
        });
        await fail(maya.userId, 1, laptop);

        const last = await stepUp(maya.userId, laptop);
        expect(
            await twoStep.removeFactor({ userId: maya.userId, factorId: keyId, step: last }),
        ).toEqual({ status: 'ok', kind: 'webauthn', turnedOff: true });
        expect(await twoStep.getTwoStep(maya.userId)).toEqual({
            on: false,
            methods: [],
            backupCodesLeft: 0,
            totpFrozen: false,
        });
        expect(await twoStep.getBackupCodes(maya.userId)).toMatchObject({ codes: [] });
        expect(await twoStep.getStepAttempt(pendingLogin)).toBeNull();
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(0);
        expect(await deviceFailures(laptop.deviceId)).toBe(0);
        // Removing it again is nothing.
        expect(await twoStep.removeFactor({ userId: maya.userId, factorId: keyId })).toEqual({
            status: 'missing',
        });

        // Sam's step, codes, token and count are untouched.
        expect(await twoStep.getTwoStep(sam.userId)).toMatchObject({
            on: true,
            backupCodesLeft: 10,
        });
        expect(await twoStep.getStepAttempt(samsLogin)).not.toBeNull();
        expect((await stateRow(sam.userId))!.consecutiveFailures).toBe(1);
    }, 60_000);

    test('a pending app can be dropped without the step, and without touching it', async () => {
        const maya = await withApp('maya');
        const pending = await startApp(
            maya.userId,
            'pending',
            await stepUp(maya.userId, maya.session),
        );
        expect(await twoStep.removeFactor({ userId: maya.userId, factorId: pending })).toEqual({
            status: 'ok',
            kind: 'totp',
            turnedOff: false,
        });
        expect(await twoStep.getTwoStep(maya.userId)).toMatchObject({
            on: true,
            backupCodesLeft: 10,
        });
        expect((await twoStep.getTotpFactor(maya.userId))!.id).toBe(maya.factorId);
    });

    test('turning the step on again starts clean: a new set, no count carried over', async () => {
        const maya = await withApp('first');
        await fail(maya.userId, 3);
        await twoStep.removeFactor({
            userId: maya.userId,
            factorId: maya.factorId,
            step: await stepUp(maya.userId, maya.session),
        });
        const factorId = await startApp(maya.userId, 'second');
        const codes = codeSet('second');
        expect(
            await twoStep.confirmTotpFactor({
                userId: maya.userId,
                factorId,
                step: 3_000,
                sessionTokenHash: maya.session.token,
                credentialVersion: 1,
                backupCodes: codes,
            }),
        ).toEqual({ status: 'ok', turnedOn: true, replaced: false });
        expect(await unusedHashes(maya.userId)).toEqual(hex(codes.hashes));
        expect(
            (
                await answer(await loginToken(maya.userId), {
                    method: 'backup',
                    codeHash: maya.codes.hashes[0]!,
                })
            ).result,
        ).toMatchObject({ status: 'spent' });
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(1);
    });

    test('deleting the account takes its factors, codes, tokens, state and log with it, and nobody else’s', async () => {
        const maya = await withApp('maya');
        await securityKey(maya.userId, 'maya');
        await loginToken(maya.userId);
        await db.insert(accountSecurityEvents).values({ userId: maya.userId, kind: 'sign-in' });
        const sam = await withApp('sam');
        await loginToken(sam.userId);
        expect(
            await auth.deleteAccount({
                userId: maya.userId,
                credentialVersion: 1,
                sessionTokenHash: maya.session.token,
                twoStep: await stepUp(maya.userId, maya.session, 'delete'),
            }),
        ).toBe(true);
        expect((await db.select().from(twoStepFactors)).map((row) => row.userId)).toEqual([
            sam.userId,
        ]);
        expect(await db.select().from(twoStepBackupCodes)).toHaveLength(10);
        expect((await db.select().from(twoStepAttempts)).map((row) => row.userId)).toEqual([
            sam.userId,
        ]);
        expect((await db.select().from(twoStepState)).map((row) => row.userId)).toEqual([
            sam.userId,
        ]);
        expect(await db.select().from(accountSecurityEvents)).toHaveLength(0);
    });
});

describe('what the tables refuse', () => {
    const totp = (userId: string, label: string) => ({
        userId,
        kind: 'totp' as const,
        totpKeyId: fixed(`${label}:key`, 8),
        totpNonce: fixed(`${label}:nonce`, 24),
        totpSecret: fixed(`${label}:secret`, 36),
        totpLastStep: 0,
    });
    const refused = (constraint: string, code = '23514') => ({ cause: { code, constraint } });

    test('a TOTP secret that is not sealed, a confirmed app without a last step, and a second confirmed app', async () => {
        const maya = await withApp('maya');
        const insert = (values: typeof twoStepFactors.$inferInsert) =>
            db.insert(twoStepFactors).values(values);
        // 20 bytes is the bare secret: a sealed one carries the 16-byte tag.
        await expect(
            insert({ ...totp(maya.userId, 'bare'), totpSecret: fixed('bare', 20) }),
        ).rejects.toMatchObject(refused('two_step_factors_totp_valid'));
        await expect(
            insert({ ...totp(maya.userId, 'unsealed'), totpNonce: null }),
        ).rejects.toMatchObject(refused('two_step_factors_totp_valid'));
        // Confirmed with no step behind it, every code in the window would be accepted, the confirming one included.
        const { user: sam } = await registered();
        await expect(
            insert({ ...totp(sam.id, 'floor'), confirmedAt: new Date() }),
        ).rejects.toMatchObject(refused('two_step_factors_totp_valid'));
        await expect(
            insert({ ...totp(maya.userId, 'second'), confirmedAt: new Date(), totpLastStep: 5 }),
        ).rejects.toMatchObject(refused('two_step_factors_one_totp_idx', '23505'));
        // A row is one kind: an app with a key's columns, or a key with a secret, is neither.
        await expect(
            insert({ ...totp(maya.userId, 'mixed'), credentialId: fixed('mixed', 32) }),
        ).rejects.toMatchObject(refused('two_step_factors_webauthn_valid'));
        expect(await db.select().from(twoStepFactors)).toHaveLength(1);
    });

    test('a security key fits beside an app; the same credential twice on one account does not', async () => {
        const maya = await withApp('maya');
        const keyId = await securityKey(maya.userId, 'yubi');
        await expect(securityKey(maya.userId, 'yubi')).rejects.toMatchObject(
            refused('two_step_factors_user_credential_idx', '23505'),
        );
        // Per account, never global: the same credential id on another account says nothing here.
        const sam = await withApp('sam');
        await securityKey(sam.userId, 'yubi');
        await securityKey(maya.userId, 'spare');
        const methods = (await twoStep.getTwoStep(maya.userId)).methods;
        expect(methods.map((method) => method.kind).sort()).toEqual([
            'totp',
            'webauthn',
            'webauthn',
        ]);
        expect(methods.find((method) => method.id === keyId)).toMatchObject({
            name: 'Security key',
            synced: false,
        });
        // A key's public key is not a secret; a TOTP secret on its row would be one stored in the wrong place.
        await expect(
            db
                .update(twoStepFactors)
                .set({ totpSecret: fixed('leak', 36) })
                .where(eq(twoStepFactors.id, keyId)),
        ).rejects.toMatchObject(refused('two_step_factors_totp_valid'));
    });

    test('a backup code row is a 32-byte hash, and a token cannot be bound to the wrong thing', async () => {
        const maya = await withApp('maya');
        // Ten characters of a code, or its bytes, are not what is stored.
        await expect(
            db.insert(twoStepBackupCodes).values({
                userId: maya.userId,
                codeHash: Buffer.from('7KQ2M9XD4P'),
                keyId: fixed('key', 8),
            }),
        ).rejects.toMatchObject(refused('two_step_backup_codes_lengths_valid'));
        const attempt = {
            tokenHash: fixed('token', 32),
            userId: maya.userId,
            credentialVersion: 1,
            expiresAt: new Date(Date.now() + 5 * MINUTE),
        };
        const insert = (values: Partial<typeof twoStepAttempts.$inferInsert>) =>
            db.insert(twoStepAttempts).values({ ...attempt, purpose: 'login', ...values });
        // A sign-in's token bound to a session, and a step-up's bound to none.
        await expect(insert({ sessionTokenHash: maya.session.token })).rejects.toMatchObject(
            refused('two_step_attempts_purpose_binding'),
        );
        await expect(insert({ purpose: 'password' })).rejects.toMatchObject(
            refused('two_step_attempts_purpose_binding'),
        );
        // Only a token that ends by opening a session carries a device for it.
        await expect(
            insert({
                purpose: 'delete',
                sessionTokenHash: maya.session.token,
                deviceId: maya.session.deviceId,
            }),
        ).rejects.toMatchObject(refused('two_step_attempts_session_opening'));
        // A sixth slot, or more failures than slots taken, would be an answer nobody reserved.
        await expect(insert({ answers: 6 })).rejects.toMatchObject(
            refused('two_step_attempts_valid'),
        );
        await expect(insert({ answers: 2, failures: 3 })).rejects.toMatchObject(
            refused('two_step_attempts_valid'),
        );
        await expect(insert({ answers: 5, failures: 5 })).rejects.toMatchObject(
            refused('two_step_attempts_valid'),
        );
        expect(await db.select().from(twoStepAttempts)).toHaveLength(0);
        // An enrolment's token ends in a session too, so it may carry the device and the cookie.
        await insert({
            purpose: 'enrol',
            deviceId: maya.session.deviceId,
            previousTokenHash: maya.session.token,
        });
    });

    test('a security log line outlives its device, without the link', async () => {
        const maya = await withApp('maya');
        const phone = await steppedSignIn(maya.userId);
        await db.insert(accountSecurityEvents).values({
            userId: maya.userId,
            kind: 'sign-in',
            method: 'totp',
            deviceId: phone.deviceId,
            deviceKind: 'ios',
        });
        await db.delete(accountDevices).where(eq(accountDevices.id, phone.deviceId));
        expect(await db.select().from(accountSecurityEvents)).toMatchObject([
            { kind: 'sign-in', method: 'totp', deviceId: null, deviceKind: 'ios' },
        ]);
        // A line names a kind of event and a kind of method: no free text.
        await expect(
            db.insert(accountSecurityEvents).values({ userId: maya.userId, kind: 'Maya’s iPhone' }),
        ).rejects.toMatchObject(refused('account_security_events_kind_valid'));
    });
});

describe('the security log', () => {
    const DAY = 24 * HOUR;

    test('lists the account’s own lines, newest first, with a device only when it is the account’s own', async () => {
        const maya = await withApp('maya');
        const sam = await withApp('sam');
        const phone = await steppedSignIn(maya.userId);
        await auth.registerDevice({
            sessionTokenHash: phone.token,
            kind: 'ios',
            name: 'Maya’s iPhone',
            signingPublicKey: null,
        });
        await twoStep.recordSecurityEvent({
            userId: maya.userId,
            kind: 'two-step-on',
            method: 'totp',
        });
        await twoStep.recordSecurityEvent({
            userId: maya.userId,
            kind: 'sign-in',
            method: 'backup',
            deviceId: phone.deviceId,
        });
        // A line naming another account's device: recorded, without the link.
        await twoStep.recordSecurityEvent({
            userId: maya.userId,
            kind: 'step-failed',
            deviceId: sam.session.deviceId,
        });
        await twoStep.recordSecurityEvent({
            userId: sam.userId,
            kind: 'phrase-used',
            method: 'phrase',
        });
        await db
            .update(accountSecurityEvents)
            .set({ createdAt: new Date(Date.now() - 2 * HOUR) })
            .where(eq(accountSecurityEvents.kind, 'two-step-on'));
        await db
            .update(accountSecurityEvents)
            .set({ createdAt: new Date(Date.now() - HOUR) })
            .where(eq(accountSecurityEvents.kind, 'sign-in'));

        const lines = await twoStep.listSecurityEvents(maya.userId);
        expect(lines.map(({ id: _id, createdAt: _at, ...line }) => line)).toEqual([
            { kind: 'step-failed', method: null, deviceId: null, deviceKind: null },
            { kind: 'sign-in', method: 'backup', deviceId: phone.deviceId, deviceKind: 'ios' },
            { kind: 'two-step-on', method: 'totp', deviceId: null, deviceKind: null },
        ]);
        // Nothing of the device but its kind: the name it gave itself is not in a line.
        expect(JSON.stringify(lines)).not.toContain('iPhone');
        expect((await twoStep.listSecurityEvents(sam.userId)).map((line) => line.kind)).toEqual([
            'phrase-used',
        ]);
    });

    test('keeps ninety days: older lines are not listed, and the sweep deletes them and only them', async () => {
        const maya = await withApp('maya');
        for (const kind of ['sign-in', 'step-failed', 'two-step-off'] as const)
            await twoStep.recordSecurityEvent({ userId: maya.userId, kind });
        await db
            .update(accountSecurityEvents)
            .set({ createdAt: new Date(Date.now() - 90 * DAY - HOUR) })
            .where(eq(accountSecurityEvents.kind, 'sign-in'));
        await db
            .update(accountSecurityEvents)
            .set({ createdAt: new Date(Date.now() - 90 * DAY + HOUR) })
            .where(eq(accountSecurityEvents.kind, 'step-failed'));
        expect((await twoStep.listSecurityEvents(maya.userId)).map((line) => line.kind)).toEqual([
            'two-step-off',
            'step-failed',
        ]);
        expect((await auth.cleanupExpired()).securityEvents).toBe(1);
        expect(
            (await db.select().from(accountSecurityEvents)).map((row) => row.kind).sort(),
        ).toEqual(['step-failed', 'two-step-off']);
    });
});
