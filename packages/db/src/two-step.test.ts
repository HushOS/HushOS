import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { registered, sha256 } from '../test/accounts';
import { closeDatabase, lockObserver, resetDatabase } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import {
    accountDevices,
    accountSecurityEvents,
    opaqueCredentials,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepFactors,
    twoStepState,
} from './schema';
import * as twoStep from './two-step';

/*
 * Two-step sign-in, the rows (docs/two-step-design.md 2, 4, 10): a pending app never counts and
 * expires; a time step and a backup code are accepted once, however many requests race; a step
 * token is single use, bound to its purpose, session and credential version, and dies at the
 * fifth wrong answer; wrong answers count per pool and freeze the app for new devices at the
 * hundredth; and nothing reaches another account's rows. The repository checks no code and
 * opens no secret, so secrets and hashes here are fixed bytes of the right length.
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

async function signIn(userId: string, options: { twoStepAt?: Date } = {}) {
    const token = sha256(randomUUID());
    const result = await auth.createSession({
        userId,
        credentialVersion: 1,
        tokenHash: token,
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + HOUR),
        twoStepAt: options.twoStepAt,
    });
    if (!result || 'suspended' in result) throw new Error('No session.');
    return { token, deviceId: result.device.id };
}

async function startApp(userId: string, label: string) {
    const id = randomUUID();
    await twoStep.startTotpFactor({ id, userId, ...sealed(label) });
    return id;
}

/* An account with the step on: one confirmed app whose last step is `step`, and its ten codes. */
async function withApp(label: string, step = 1_000) {
    const { user } = await registered();
    const session = await signIn(user.id);
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

/* One of the account's devices with a key of its own, signed in after passing the step. */
async function keyedDevice(userId: string, label: string) {
    const session = await signIn(userId, { twoStepAt: new Date() });
    const result = await auth.registerDevice({
        sessionTokenHash: session.token,
        kind: 'web',
        name: label,
        signingPublicKey: fixed(`${userId}:${label}:device`, 32),
    });
    if (result.status !== 'ok') throw new Error(`Device ${result.status}.`);
    return session;
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

async function loginToken(userId: string, deviceId: string | null = null) {
    const tokenHash = sha256(randomUUID());
    await twoStep.createStepAttempt({
        purpose: 'login',
        tokenHash,
        userId,
        credentialVersion: 1,
        deviceId,
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    return tokenHash;
}

async function sessionToken(
    userId: string,
    sessionTokenHash: Buffer,
    purpose: 'password' | 'delete' | 'two-step' = 'password',
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

/* `times` wrong answers from sign-ins on `deviceId` (none: the account's pool), on as many tokens as that takes. */
async function fail(userId: string, times: number, deviceId: string | null = null) {
    const results: Extract<twoStep.StepFailure, { status: 'counted' }>[] = [];
    let token: Buffer | null = null;
    for (let index = 0; index < times; index++) {
        token ??= await loginToken(userId, deviceId);
        const result = await twoStep.recordStepFailure(token);
        if (result.status !== 'counted') throw new Error('The token was gone.');
        results.push(result);
        if (result.tokenEnded) token = null;
    }
    return results;
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
const stampOf = async (token: Buffer) =>
    (
        await db
            .select({ twoStepAt: sessions.twoStepAt })
            .from(sessions)
            .where(eq(sessions.tokenHash, token))
    )[0]?.twoStepAt;

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('enrolling an authenticator app', () => {
    test('a pending app is not the step: the account stays off, no secret is served for sign-in, and codes cannot be made', async () => {
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
        // Its step cannot be moved either: nothing accepts a code for a pending app.
        expect(await twoStep.advanceTotpStep({ userId: user.id, factorId, step: 1_000 })).toBe(
            false,
        );
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
        const enrolling = await signIn(user.id);
        const other = await signIn(user.id);
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
        const moved = (step: number) =>
            twoStep.advanceTotpStep({ userId: user.id, factorId, step });
        expect(await moved(57_000_000)).toBe(false);
        expect(await moved(57_000_001)).toBe(true);
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
        const session = await signIn(user.id);
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

    test('a pending app cannot be confirmed after ten minutes, and the sweep deletes it and only it', async () => {
        const { user } = await registered();
        const session = await signIn(user.id);
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
        const session = await signIn(user.id);
        const { user: sam } = await registered();
        const sams = await signIn(sam.id);
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

    test('a second app replaces the first in one step, and leaves the codes and the session’s stamp alone', async () => {
        const maya = await withApp('first', 1_000);
        const stamped = await stampOf(maya.session.token);
        await twoStep.useBackupCode({ userId: maya.userId, codeHash: maya.codes.hashes[0]! });
        const next = await startApp(maya.userId, 'second');
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
        // The old secret's row is gone, so a code from the old app has nothing to move.
        expect(await factorRow(maya.factorId)).toBeUndefined();
        expect(
            await twoStep.advanceTotpStep({
                userId: maya.userId,
                factorId: maya.factorId,
                step: 9_000,
            }),
        ).toBe(false);
        // The set passed with a replacement is ignored: the old codes stand, the used one stays used.
        const codes = await twoStep.getBackupCodes(maya.userId);
        expect(codes!.codes.map(({ codeHash }) => codeHash.toString('hex')).sort()).toEqual(
            maya.codes.hashes
                .slice(1)
                .map((hash) => hash.toString('hex'))
                .sort(),
        );
        expect(await stampOf(maya.session.token)).toEqual(stamped);
    });

    test('starting again drops the earlier pending app, never the confirmed one', async () => {
        const maya = await withApp('confirmed');
        const first = await startApp(maya.userId, 'first');
        const second = await startApp(maya.userId, 'second');
        expect(await factorRow(first)).toBeUndefined();
        expect(await factorRow(second)).toBeDefined();
        expect((await twoStep.getTotpFactor(maya.userId))!.id).toBe(maya.factorId);
        // Another account's pending app is not this account's to drop.
        const { user: sam } = await registered();
        const sams = await startApp(sam.id, 'sam');
        await startApp(maya.userId, 'third');
        expect(await factorRow(sams)).toBeDefined();
    });

    test('two confirmations of one pending app at once: one wins', async () => {
        const { user } = await registered();
        const session = await signIn(user.id);
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

    test('another account cannot read, confirm, advance or remove a factor', async () => {
        const maya = await withApp('maya', 1_000);
        const pending = await startApp(maya.userId, 'pending');
        const { user: sam } = await registered();
        const sams = await signIn(sam.id);
        expect(
            await twoStep.getPendingTotpFactor({ userId: sam.id, factorId: pending }),
        ).toBeNull();
        expect(
            await twoStep.confirmTotpFactor({
                userId: sam.id,
                factorId: pending,
                step: 2_000,
                sessionTokenHash: sams.token,
                credentialVersion: 1,
                backupCodes: codeSet('sam'),
            }),
        ).toEqual({ status: 'missing' });
        expect(
            await twoStep.advanceTotpStep({ userId: sam.id, factorId: maya.factorId, step: 5_000 }),
        ).toBe(false);
        for (const factorId of [maya.factorId, pending])
            expect(await twoStep.removeFactor({ userId: sam.id, factorId })).toEqual({
                status: 'missing',
            });
        expect(await twoStep.hasTwoStep(sam.id)).toBe(false);
        expect(await twoStep.getTotpFactor(sam.id)).toBeNull();
        expect(await stampOf(sams.token)).toBeNull();
        // Maya's rows are as they were.
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_000);
        expect((await factorRow(pending))!.confirmedAt).toBeNull();
        expect(await twoStep.countBackupCodes(maya.userId)).toBe(10);
    });
});

describe('a code’s time step', () => {
    test('is accepted once: the same step and earlier ones are refused, a later one is accepted', async () => {
        const maya = await withApp('maya', 1_000);
        const move = (step: number) =>
            twoStep.advanceTotpStep({ userId: maya.userId, factorId: maya.factorId, step });
        expect(await move(1_001)).toBe(true);
        expect(await move(1_001)).toBe(false);
        // The step before is still inside the 90-second window, and already behind the last one used.
        expect(await move(1_000)).toBe(false);
        expect(await move(999)).toBe(false);
        expect(await move(1_002)).toBe(true);
        expect((await factorRow(maya.factorId))!.totpLastStep).toBe(1_002);
        // Not a time step at all.
        for (const step of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
            expect(await move(step)).toBe(false);
    });

    test('eight requests with the same code race to one success', async () => {
        const maya = await withApp('maya', 1_000);
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                twoStep.advanceTotpStep({
                    userId: maya.userId,
                    factorId: maya.factorId,
                    step: 1_001,
                }),
            ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    test('when the app was last used is kept to the hour, and the table refuses anything finer', async () => {
        const maya = await withApp('maya', 1_000);
        await twoStep.advanceTotpStep({
            userId: maya.userId,
            factorId: maya.factorId,
            step: 1_001,
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
    test('a code works once, including under eight requests at once', async () => {
        const maya = await withApp('maya');
        const codeHash = maya.codes.hashes[3]!;
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                twoStep.useBackupCode({ userId: maya.userId, codeHash }),
            ),
        );
        expect(results.filter((result) => result !== null)).toEqual([{ left: 9 }]);
        expect(await twoStep.useBackupCode({ userId: maya.userId, codeHash })).toBeNull();
        expect(await twoStep.countBackupCodes(maya.userId)).toBe(9);
        // The used code is no longer among those a typed code is compared with.
        const left = (await twoStep.getBackupCodes(maya.userId))!.codes;
        expect(left).toHaveLength(9);
        expect(left.some((code) => code.codeHash.equals(codeHash))).toBe(false);
        // A hash nobody stored is no code.
        expect(
            await twoStep.useBackupCode({ userId: maya.userId, codeHash: fixed('unknown', 32) }),
        ).toBeNull();
    });

    test('a code is spent for its own account only, even when another account stores the same bytes', async () => {
        const maya = await withApp('shared');
        const sam = await withApp('shared');
        const codeHash = maya.codes.hashes[0]!;
        expect(await twoStep.useBackupCode({ userId: maya.userId, codeHash })).toEqual({ left: 9 });
        expect(await twoStep.countBackupCodes(sam.userId)).toBe(10);
        expect(await twoStep.useBackupCode({ userId: sam.userId, codeHash })).toEqual({ left: 9 });
        // An account without the step has no codes to answer with, whatever is typed.
        const { user: noor } = await registered();
        expect(await twoStep.useBackupCode({ userId: noor.id, codeHash })).toBeNull();
        expect(await twoStep.getBackupCodes(noor.id)).toBeNull();
    });

    test('a new set replaces the old one whole: old codes stop working, and the salt stays', async () => {
        const maya = await withApp('old');
        const salt = (await twoStep.getBackupCodes(maya.userId))!.salt;
        await twoStep.useBackupCode({ userId: maya.userId, codeHash: maya.codes.hashes[0]! });
        const next = codeSet('new');
        expect(await twoStep.replaceBackupCodes({ userId: maya.userId, ...next })).toEqual({
            status: 'ok',
        });
        expect(await twoStep.countBackupCodes(maya.userId)).toBe(10);
        for (const codeHash of maya.codes.hashes)
            expect(await twoStep.useBackupCode({ userId: maya.userId, codeHash })).toBeNull();
        expect(
            await twoStep.useBackupCode({ userId: maya.userId, codeHash: next.hashes[9]! }),
        ).toEqual({ left: 9 });
        const stored = (await twoStep.getBackupCodes(maya.userId))!;
        expect(stored.salt.equals(salt)).toBe(true);
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

    test('a set that is not ten different hashes is refused and the old set stands', async () => {
        const maya = await withApp('maya');
        const set = codeSet('short');
        await expect(
            twoStep.replaceBackupCodes({
                userId: maya.userId,
                ...set,
                hashes: set.hashes.slice(2),
            }),
        ).rejects.toThrow(/10 different/);
        expect(
            await twoStep.useBackupCode({ userId: maya.userId, codeHash: maya.codes.hashes[0]! }),
        ).toEqual({ left: 9 });
    });
});

describe('step tokens', () => {
    test('a token is used once, including under eight requests at once', async () => {
        const maya = await withApp('maya');
        const tokenHash = await loginToken(maya.userId);
        const consume = () =>
            twoStep.consumeStepAttempt({ tokenHash, purpose: 'login', sessionTokenHash: null });
        const results = await Promise.all(Array.from({ length: 8 }, consume));
        const won = results.filter((result) => result !== null);
        expect(won).toHaveLength(1);
        expect(won[0]).toMatchObject({
            userId: maya.userId,
            purpose: 'login',
            credentialVersion: 1,
            failures: 0,
            pool: { kind: 'account' },
            totpFrozen: false,
        });
        expect(await consume()).toBeNull();
        expect(await twoStep.getStepAttempt(tokenHash)).toBeNull();
        expect(await twoStep.recordStepFailure(tokenHash)).toEqual({ status: 'gone' });
    });

    test('a token is refused once its five minutes are over, and the sweep deletes it', async () => {
        const maya = await withApp('maya');
        const expired = await loginToken(maya.userId);
        const live = await loginToken(maya.userId);
        await db
            .update(twoStepAttempts)
            .set({
                createdAt: new Date(Date.now() - 5 * MINUTE - 1_000),
                expiresAt: new Date(Date.now() - 1_000),
            })
            .where(eq(twoStepAttempts.tokenHash, expired));
        expect(await twoStep.getStepAttempt(expired)).toBeNull();
        expect(
            await twoStep.consumeStepAttempt({
                tokenHash: expired,
                purpose: 'login',
                sessionTokenHash: null,
            }),
        ).toBeNull();
        // A wrong answer on a dead token counts nowhere.
        expect(await twoStep.recordStepFailure(expired)).toEqual({ status: 'gone' });
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(0);
        expect((await auth.cleanupExpired()).stepAttempts).toBe(1);
        expect(await db.select().from(twoStepAttempts)).toHaveLength(1);
        expect(await twoStep.getStepAttempt(live)).not.toBeNull();
    });

    test('a token made for one purpose or session is refused for another, and survives the refusal', async () => {
        const maya = await withApp('maya');
        const other = await signIn(maya.userId, { twoStepAt: new Date() });
        const tokenHash = await sessionToken(maya.userId, maya.session.token, 'password');
        const consume = (
            purpose: 'login' | 'password' | 'delete' | 'two-step',
            sessionTokenHash: Buffer | null,
        ) => twoStep.consumeStepAttempt({ tokenHash, purpose, sessionTokenHash });
        expect(await consume('delete', maya.session.token)).toBeNull();
        expect(await consume('two-step', maya.session.token)).toBeNull();
        expect(await consume('password', other.token)).toBeNull();
        expect(await consume('password', null)).toBeNull();
        expect(await consume('login', null)).toBeNull();
        expect(await consume('password', maya.session.token)).toMatchObject({
            purpose: 'password',
            pool: { kind: 'device', deviceId: maya.session.deviceId },
        });
    });

    test('a sign-in’s token cannot authorise a security change', async () => {
        const maya = await withApp('maya');
        const tokenHash = await loginToken(maya.userId);
        for (const purpose of ['password', 'delete', 'two-step'] as const)
            expect(
                await twoStep.consumeStepAttempt({
                    tokenHash,
                    purpose,
                    sessionTokenHash: maya.session.token,
                }),
            ).toBeNull();
        // Nor does naming a session make a sign-in token pass as a sign-in.
        expect(
            await twoStep.consumeStepAttempt({
                tokenHash,
                purpose: 'login',
                sessionTokenHash: maya.session.token,
            }),
        ).toBeNull();
        expect(await twoStep.getStepAttempt(tokenHash)).not.toBeNull();
    });

    test('a token from before a password change is refused after it', async () => {
        const maya = await withApp('maya');
        const login = await loginToken(maya.userId);
        const stepUp = await sessionToken(maya.userId, maya.session.token);
        // What a password change does to the credential (changeAccountSecurity, resetAccountPassword).
        await db
            .update(opaqueCredentials)
            .set({ version: 2 })
            .where(eq(opaqueCredentials.userId, maya.userId));
        expect(await twoStep.getStepAttempt(login)).toBeNull();
        expect(
            await twoStep.consumeStepAttempt({
                tokenHash: login,
                purpose: 'login',
                sessionTokenHash: null,
            }),
        ).toBeNull();
        expect(
            await twoStep.consumeStepAttempt({
                tokenHash: stepUp,
                purpose: 'password',
                sessionTokenHash: maya.session.token,
            }),
        ).toBeNull();
        expect(await twoStep.recordStepFailure(login)).toEqual({ status: 'gone' });
    });

    test('a step-up’s token dies with its session', async () => {
        const maya = await withApp('maya');
        const other = await signIn(maya.userId, { twoStepAt: new Date() });
        const tokenHash = await sessionToken(maya.userId, other.token, 'delete');
        expect(await twoStep.getStepAttempt(tokenHash)).not.toBeNull();
        await auth.signOutDevice(other.token);
        expect(await twoStep.getStepAttempt(tokenHash)).toBeNull();
        expect(
            await twoStep.consumeStepAttempt({
                tokenHash,
                purpose: 'delete',
                sessionTokenHash: other.token,
            }),
        ).toBeNull();
    });

    test('the fifth wrong answer ends the token; four leave it usable', async () => {
        const maya = await withApp('maya');
        const tokenHash = await loginToken(maya.userId);
        for (const left of [4, 3, 2, 1])
            expect(await twoStep.recordStepFailure(tokenHash)).toMatchObject({
                status: 'counted',
                left,
                tokenEnded: false,
            });
        expect(await twoStep.getStepAttempt(tokenHash)).toMatchObject({ failures: 4 });
        expect(await twoStep.recordStepFailure(tokenHash)).toMatchObject({
            status: 'counted',
            left: 0,
            tokenEnded: true,
        });
        expect(await twoStep.getStepAttempt(tokenHash)).toBeNull();
        expect(
            await twoStep.consumeStepAttempt({
                tokenHash,
                purpose: 'login',
                sessionTokenHash: null,
            }),
        ).toBeNull();
        expect(await twoStep.recordStepFailure(tokenHash)).toEqual({ status: 'gone' });
        // A second token of the same account starts at five again.
        const next = await loginToken(maya.userId);
        expect(await twoStep.recordStepFailure(next)).toMatchObject({ left: 4 });
    });

    test('only the account’s own keyed device selects a device’s count; anything else is the shared one', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const sam = await withApp('sam');
        const samsLaptop = await keyedDevice(sam.userId, 'laptop');

        const own = await loginToken(maya.userId, laptop.deviceId);
        expect(await twoStep.getStepAttempt(own)).toMatchObject({
            deviceId: laptop.deviceId,
            pool: { kind: 'device', deviceId: laptop.deviceId },
        });
        // Another account's device, a device without a key, and an id that is no device.
        for (const deviceId of [samsLaptop.deviceId, maya.session.deviceId, randomUUID()]) {
            const tokenHash = await loginToken(maya.userId, deviceId);
            expect(await twoStep.getStepAttempt(tokenHash)).toMatchObject({
                deviceId: null,
                pool: { kind: 'account' },
            });
            await twoStep.recordStepFailure(tokenHash);
        }
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(3);
        expect(await deviceFailures(samsLaptop.deviceId)).toBe(0);
        expect(await deviceFailures(laptop.deviceId)).toBe(0);

        // A device removed after the token was made: the token is dead, not moved to the shared count.
        await auth.revokeDevice({
            userId: maya.userId,
            deviceId: laptop.deviceId,
            sessionTokenHash: maya.session.token,
        });
        expect(await twoStep.getStepAttempt(own)).toBeNull();
        expect(await twoStep.recordStepFailure(own)).toEqual({ status: 'gone' });
    });
});

describe('wrong answers in a row', () => {
    test('count across tokens for sign-ins that prove no device, and the notice starts at the fifth', async () => {
        const maya = await withApp('maya');
        const first = await loginToken(maya.userId);
        const second = await loginToken(maya.userId);
        const counted = [];
        for (const tokenHash of [first, second, first, second, first, second])
            counted.push(await twoStep.recordStepFailure(tokenHash));
        expect(counted).toMatchObject([
            { pool: 'account', consecutiveFailures: 1, notice: false },
            { pool: 'account', consecutiveFailures: 2, notice: false },
            { pool: 'account', consecutiveFailures: 3, notice: false },
            { pool: 'account', consecutiveFailures: 4, notice: false },
            { pool: 'account', consecutiveFailures: 5, notice: true },
            { pool: 'account', consecutiveFailures: 6, notice: true },
        ]);
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
        expect((await fail(maya.userId, 3, laptop.deviceId)).at(-1)).toMatchObject({
            pool: 'device',
            consecutiveFailures: 3,
            notice: false,
        });
        const stepUp = await sessionToken(maya.userId, laptop.token);
        expect(await twoStep.recordStepFailure(stepUp)).toMatchObject({
            pool: 'device',
            consecutiveFailures: 4,
        });
        expect(await twoStep.recordStepFailure(stepUp)).toMatchObject({
            pool: 'device',
            consecutiveFailures: 5,
            notice: true,
        });
        expect(await deviceFailures(laptop.deviceId)).toBe(5);
        expect(await deviceFailures(phone.deviceId)).toBe(0);
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(2);
    });

    test('a success resets the count of its own pool and no other', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const phone = await keyedDevice(maya.userId, 'phone');
        const sam = await withApp('sam');
        const samsLaptop = await keyedDevice(sam.userId, 'laptop');
        await fail(maya.userId, 3);
        await fail(maya.userId, 2, laptop.deviceId);
        await fail(maya.userId, 4, phone.deviceId);
        await fail(sam.userId, 2);
        await fail(sam.userId, 2, samsLaptop.deviceId);

        await twoStep.recordStepSuccess({
            userId: maya.userId,
            pool: { kind: 'device', deviceId: laptop.deviceId },
            method: 'totp',
        });
        expect(await deviceFailures(laptop.deviceId)).toBe(0);
        expect(await deviceFailures(phone.deviceId)).toBe(4);
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(3);

        // Maya's success naming Sam's device resets nothing of Sam's.
        await twoStep.recordStepSuccess({
            userId: maya.userId,
            pool: { kind: 'device', deviceId: samsLaptop.deviceId },
            method: 'totp',
        });
        expect(await deviceFailures(samsLaptop.deviceId)).toBe(2);

        await twoStep.recordStepSuccess({
            userId: maya.userId,
            pool: { kind: 'account' },
            method: 'totp',
        });
        expect((await stateRow(maya.userId))!.consecutiveFailures).toBe(0);
        expect(await deviceFailures(phone.deviceId)).toBe(4);
        expect((await stateRow(sam.userId))!.consecutiveFailures).toBe(2);
        // After a reset, the count starts from one.
        expect((await fail(maya.userId, 1))[0]).toMatchObject({ consecutiveFailures: 1 });
    });

    test('the hundredth freezes the app for sign-ins that prove no device, and only for those', async () => {
        const maya = await withApp('maya');
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
        expect(await twoStep.getStepAttempt(await loginToken(maya.userId))).toMatchObject({
            pool: { kind: 'account' },
            totpFrozen: true,
        });
        // A known device still takes the app's codes, at sign-in and at a step-up.
        expect(
            await twoStep.getStepAttempt(await loginToken(maya.userId, laptop.deviceId)),
        ).toMatchObject({ pool: { kind: 'device' }, totpFrozen: false });
        expect(
            await twoStep.getStepAttempt(await sessionToken(maya.userId, laptop.token)),
        ).toMatchObject({ totpFrozen: false });
        // Already frozen: the next wrong answer does not freeze it a second time.
        expect((await fail(maya.userId, 1))[0]).toMatchObject({
            consecutiveFailures: 101,
            froze: false,
        });
        // Another account is not frozen by any of it.
        const sam = await withApp('sam');
        expect((await twoStep.getTwoStep(sam.userId)).totpFrozen).toBe(false);
    }, 60_000);

    test('a hundred wrong answers from a known device freeze nothing', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const results = await fail(maya.userId, 100, laptop.deviceId);
        expect(results.at(-1)).toMatchObject({ pool: 'device', consecutiveFailures: 100 });
        expect(results.some((result) => result.froze)).toBe(false);
        expect((await stateRow(maya.userId))!.totpFrozenAt).toBeNull();
    }, 60_000);

    test('a freeze is lifted by a success with another method, not by the app from a known device, and never hands out more guesses', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        await fail(maya.userId, 100);
        const device = { kind: 'device', deviceId: laptop.deviceId } as const;

        // The frozen method itself, from a known device: still frozen.
        expect(
            await twoStep.recordStepSuccess({ userId: maya.userId, pool: device, method: 'totp' }),
        ).toEqual({ unfroze: false });
        expect((await twoStep.getTwoStep(maya.userId)).totpFrozen).toBe(true);

        // A backup code from the known device lifts it, and leaves the shared count where it was.
        expect(
            await twoStep.recordStepSuccess({
                userId: maya.userId,
                pool: device,
                method: 'backup',
            }),
        ).toEqual({ unfroze: true });
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
        expect(
            await twoStep.recordStepSuccess({
                userId: maya.userId,
                pool: { kind: 'account' },
                method: 'phrase',
            }),
        ).toEqual({ unfroze: true });
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

describe('removing a method', () => {
    test('one of two leaves the step on; the last turns it off and deletes the codes, tokens and counts', async () => {
        const maya = await withApp('maya');
        const laptop = await keyedDevice(maya.userId, 'laptop');
        const keyId = await securityKey(maya.userId, 'maya');
        await fail(maya.userId, 100);
        await fail(maya.userId, 2, laptop.deviceId);
        const pendingLogin = await loginToken(maya.userId);
        const sam = await withApp('sam');
        const samsLogin = await loginToken(sam.userId);
        await fail(sam.userId, 1);

        // The app goes, the key stays: the step is on, the codes stand, and the app's freeze is lifted.
        expect(
            await twoStep.removeFactor({ userId: maya.userId, factorId: maya.factorId }),
        ).toEqual({ status: 'ok', kind: 'totp', turnedOff: false });
        expect(await twoStep.getTwoStep(maya.userId)).toMatchObject({
            on: true,
            backupCodesLeft: 10,
            totpFrozen: false,
        });
        expect(await twoStep.getTotpFactor(maya.userId)).toBeNull();
        expect(await twoStep.getStepAttempt(pendingLogin)).not.toBeNull();
        // With only a key, a wrong answer past the hundredth has no app to freeze.
        expect((await fail(maya.userId, 1))[0]).toMatchObject({
            consecutiveFailures: 101,
            froze: false,
        });

        expect(await twoStep.removeFactor({ userId: maya.userId, factorId: keyId })).toEqual({
            status: 'ok',
            kind: 'webauthn',
            turnedOff: true,
        });
        expect(await twoStep.getTwoStep(maya.userId)).toEqual({
            on: false,
            methods: [],
            backupCodesLeft: 0,
            totpFrozen: false,
        });
        for (const codeHash of maya.codes.hashes)
            expect(await twoStep.useBackupCode({ userId: maya.userId, codeHash })).toBeNull();
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

    test('a pending app can be dropped without touching the step', async () => {
        const maya = await withApp('maya');
        const pending = await startApp(maya.userId, 'pending');
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
        await twoStep.removeFactor({ userId: maya.userId, factorId: maya.factorId });
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
        expect(
            await twoStep.useBackupCode({ userId: maya.userId, codeHash: maya.codes.hashes[0]! }),
        ).toBeNull();
        expect(
            await twoStep.useBackupCode({ userId: maya.userId, codeHash: codes.hashes[0]! }),
        ).toEqual({ left: 9 });
        expect((await fail(maya.userId, 1))[0]).toMatchObject({ consecutiveFailures: 1 });
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
        // Only a sign-in carries a device for the session it will open.
        await expect(
            insert({
                purpose: 'delete',
                sessionTokenHash: maya.session.token,
                deviceId: maya.session.deviceId,
            }),
        ).rejects.toMatchObject(refused('two_step_attempts_login_only'));
        // A stored count of five would be a token that outlived its fifth wrong answer.
        await expect(insert({ failures: 5 })).rejects.toMatchObject(
            refused('two_step_attempts_valid'),
        );
        expect(await db.select().from(twoStepAttempts)).toHaveLength(0);
    });

    test('a security log line outlives its device, without the link', async () => {
        const maya = await withApp('maya');
        const phone = await signIn(maya.userId, { twoStepAt: new Date() });
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
