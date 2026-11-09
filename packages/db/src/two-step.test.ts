import { randomUUID } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { bytes, registered, sha256 } from '../test/accounts';
import { closeDatabase, deleteTestAccount, resetDatabase } from '../test/helpers';
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
    type TwoStepPurpose,
} from './schema';
import * as twoStep from './two-step';

/*
 * Two-step sign-in, the rows (docs/two-step-design.md 10, "Tests that must
 * exist", for the database layer). What is checked here is what must hold
 * whatever the routes above do: the guard on sessions, a time step, a backup
 * code and a token each used once (under concurrent requests too), a factor
 * reached only through its own account, and the counters that lock. Hashes and
 * time steps are fixed values, so a failure reproduces.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/* A time step: the repository compares steps with each other, never with the clock. */
const STEP = 59_000_000;
const KEY_ID = sha256('two-step-key').subarray(0, 8);

let serial = 0;
const token = (label: string) => sha256(`${label}:${++serial}`);
const codes = (label: string) =>
    Array.from({ length: 10 }, (_, index) => ({
        codeHash: sha256(`backup:${label}:${index}`),
        keyId: KEY_ID,
    }));

/* The SQLSTATE and constraint a statement was refused with, or null when it went through. */
async function refusal(run: PromiseLike<unknown>) {
    try {
        await run;
    } catch (error) {
        for (
            let current: unknown = error, depth = 0;
            current && typeof current === 'object' && depth < 3;
            depth++
        ) {
            const { code, constraint, cause } = current as {
                code?: unknown;
                constraint?: unknown;
                cause?: unknown;
            };
            if (typeof code === 'string') return { code, constraint };
            current = cause;
        }
        throw error;
    }
    return null;
}

async function account() {
    return (await registered()).user;
}

/*
 * A session on a device of its own; `twoStepAt` as a sign-in that passed the step sets it.
 * `keyed` gives the device a signing key: only such a device can prove itself at a sign-in.
 */
async function session(userId: string, options: { twoStepAt?: Date; keyed?: boolean } = {}) {
    const tokenHash = token('session');
    const result = await auth.createSession({
        userId,
        credentialVersion: 1,
        tokenHash,
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + HOUR),
        twoStepAt: options.twoStepAt,
    });
    if (!result || 'suspended' in result) throw new Error('No session.');
    if (options.keyed) {
        const device = await auth.registerDevice({
            sessionTokenHash: tokenHash,
            kind: 'web',
            name: 'Laptop',
            signingPublicKey: sha256(`device-key:${result.device.id}`),
        });
        if (device.status !== 'ok') throw new Error(`Device ${device.status}.`);
    }
    return { tokenHash, deviceId: result.device.id };
}

type Executor = Parameters<typeof auth.createSession>[1];

/* A password change asked from `sessionTokenHash`; a `keyVersion` other than the account's is refused. */
function changePassword(
    userId: string,
    sessionTokenHash: Buffer,
    options: { keyVersion?: number; executor?: Executor } = {},
) {
    return auth.changeAccountSecurity(
        {
            userId,
            action: 'password',
            sessionTokenHash,
            credentialVersion: 1,
            registrationRecord: 'record-2',
            envelope: {
                keyVersion: options.keyVersion ?? 1,
                wrappingSalt: bytes(32),
                wrappingNonce: bytes(24),
                encryptedKey: bytes(48),
            },
        },
        options.executor,
    );
}

async function pendingTotp(userId: string) {
    const id = randomUUID();
    const pending = await twoStep.createPendingTotp({
        id,
        userId,
        name: 'Authenticator app',
        keyId: KEY_ID,
        nonce: bytes(24),
        secret: bytes(36),
    });
    if (!pending) throw new Error('No pending factor.');
    return id;
}

/* An authenticator app enrolled and confirmed at `step`, with the account's ten codes if it is the first factor. */
async function enrolTotp(
    userId: string,
    options: { step?: number; sessionTokenHash?: Buffer; label?: string } = {},
) {
    const factorId = await pendingTotp(userId);
    const set = codes(options.label ?? userId);
    const result = await twoStep.confirmTotp({
        userId,
        factorId,
        step: options.step ?? STEP,
        backupCodes: set,
        sessionTokenHash: options.sessionTokenHash,
    });
    if (result.status !== 'ok') throw new Error(`Confirmation ${result.status}.`);
    return { factorId, codes: set, result };
}

function addKey(userId: string, label: string, options: { signCount?: number } = {}) {
    return twoStep.addSecurityKey({
        userId,
        name: label,
        credentialId: sha256(`credential:${label}`),
        publicKey: sha256(`public-key:${label}`),
        signCount: options.signCount ?? 0,
        transports: ['usb'],
        backupEligible: false,
        backupState: false,
        backupCodes: codes(`${userId}:${label}`),
    });
}

async function enrolKey(userId: string, label: string, options: { signCount?: number } = {}) {
    const added = await addKey(userId, label, options);
    if (added.status !== 'ok') throw new Error(`Key ${added.status}.`);
    return added.id;
}

/* A step token: for a sign-in unless a purpose and its session are given. */
async function stepToken(
    userId: string,
    options: {
        purpose?: TwoStepPurpose;
        sessionTokenHash?: Buffer;
        deviceId?: string;
        credentialVersion?: number;
    } = {},
) {
    const binding = {
        tokenHash: token('step'),
        purpose: options.purpose ?? ('login' as const),
        sessionTokenHash: options.sessionTokenHash ?? null,
    };
    await twoStep.createStepAttempt({
        ...binding,
        userId,
        credentialVersion: options.credentialVersion ?? 1,
        deviceId: options.deviceId,
    });
    return binding;
}

/* `times` wrong authenticator codes, each token taking its five. */
async function wrongCodes(userId: string, times: number, options: { deviceId?: string } = {}) {
    let binding: Awaited<ReturnType<typeof stepToken>> | undefined;
    let last: twoStep.StepFailure | undefined;
    for (let index = 0; index < times; index++) {
        if (index % twoStep.STEP_TOKEN_FAILURES === 0) binding = await stepToken(userId, options);
        last = await twoStep.failStep({ ...binding!, method: 'totp' });
        if (last.status !== 'counted') throw new Error('The failure was not counted.');
    }
    return last as Extract<twoStep.StepFailure, { status: 'counted' }>;
}

async function stateOf(userId: string) {
    const [row] = await db.select().from(twoStepState).where(eq(twoStepState.userId, userId));
    return row;
}

async function factorRow(id: string) {
    const [row] = await db.select().from(twoStepFactors).where(eq(twoStepFactors.id, id));
    return row;
}

async function deviceFailures(id: string) {
    const [row] = await db
        .select({ failures: accountDevices.twoStepFailures })
        .from(accountDevices)
        .where(eq(accountDevices.id, id));
    return row?.failures;
}

async function sessionRow(tokenHash: Buffer) {
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash));
    return row;
}

/* An account with an app and a key whose app the hundredth wrong code has just frozen, and a known laptop. */
async function frozenAccount() {
    const user = await account();
    const laptop = await session(user.id, { keyed: true });
    const app = await enrolTotp(user.id);
    const key = await enrolKey(user.id, 'key');
    await db
        .update(twoStepState)
        .set({ consecutiveFailures: 99 })
        .where(eq(twoStepState.userId, user.id));
    const last = await wrongCodes(user.id, 1);
    if (!last.froze) throw new Error('The app did not freeze.');
    return { user, laptop, app, key };
}

function rawSession(userId: string, twoStepAt: Date | null) {
    return db.insert(sessions).values({
        userId,
        tokenHash: token('raw-session'),
        credentialVersion: 1,
        expiresAt: new Date(Date.now() + HOUR),
        twoStepAt,
    });
}

beforeEach(async () => {
    serial = 0;
    await resetDatabase();
});
afterAll(closeDatabase);

describe('the guard on sessions', () => {
    test('a session without two_step_at is refused for an account with a confirmed factor, and only then', async () => {
        const user = await account();
        const other = await account();
        await enrolTotp(user.id);

        expect(await refusal(rawSession(user.id, null))).toEqual({
            code: '23514',
            constraint: 'sessions_two_step_guard',
        });
        expect(await refusal(rawSession(user.id, new Date()))).toBeNull();
        // Another account's factor says nothing about this one.
        expect(await refusal(rawSession(other.id, null))).toBeNull();
        expect(await db.select().from(sessions).where(isNull(sessions.twoStepAt))).toHaveLength(1);
    });

    test('an enrolment nobody finished does not turn the guard on', async () => {
        const user = await account();
        await pendingTotp(user.id);
        expect(await refusal(rawSession(user.id, null))).toBeNull();
    });

    test('a sign-in that does not know the step makes no session and no device', async () => {
        const user = await account();
        await enrolTotp(user.id);
        // What a container of the release before two-step runs: createSession without twoStepAt.
        await expect(session(user.id)).rejects.toThrow();
        expect(await db.select().from(sessions)).toHaveLength(0);
        expect(await db.select().from(accountDevices)).toHaveLength(0);

        const at = new Date(Date.now() - MINUTE);
        const stepped = await session(user.id, { twoStepAt: at });
        expect((await sessionRow(stepped.tokenHash))?.twoStepAt).toEqual(at);
    });

    test('the guard lifts when the last factor is removed', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        expect(await refusal(rawSession(user.id, null))).not.toBeNull();
        await twoStep.removeFactor({ userId: user.id, factorId });
        expect(await refusal(rawSession(user.id, null))).toBeNull();
    });
});

describe('enrolling an authenticator app', () => {
    test('a pending factor never answers the step', async () => {
        const user = await account();
        const factorId = await pendingTotp(user.id);
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        expect((await twoStep.getTwoStep(user.id)).factors).toEqual([]);
        expect(await twoStep.takeTotpStep({ userId: user.id, factorId, step: STEP })).toBe(false);

        const binding = await stepToken(user.id);
        const passed = await twoStep.passStep({
            ...binding,
            proof: { method: 'totp', factorId, step: STEP },
        });
        expect(passed).toEqual({ status: 'refused', reason: 'unknown' });
    });

    test('the step it was confirmed with cannot be used again; only a later one can, once', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id, { step: STEP });
        const take = (step: number) => twoStep.takeTotpStep({ userId: user.id, factorId, step });
        expect(await take(STEP)).toBe(false);
        expect(await take(STEP - 1)).toBe(false);
        expect(await take(STEP + 1)).toBe(true);
        expect(await take(STEP + 1)).toBe(false);
        expect(await take(STEP)).toBe(false);
        expect((await factorRow(factorId))?.totpLastStep).toBe(STEP + 1);
    });

    test('turning the step on needs a set of ten backup codes, and changes nothing without one', async () => {
        const user = await account();
        const factorId = await pendingTotp(user.id);
        const confirm = (backupCodes?: twoStep.BackupCodeInput[]) =>
            twoStep.confirmTotp({ userId: user.id, factorId, step: STEP, backupCodes });
        expect(await confirm()).toEqual({ status: 'codes' });
        expect(await confirm(codes('short').slice(0, 9))).toEqual({ status: 'codes' });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        expect((await factorRow(factorId))?.confirmedAt).toBeNull();

        expect(await confirm(codes('full'))).toEqual({
            status: 'ok',
            turnedOn: true,
            replaced: false,
        });
        const state = await twoStep.getTwoStep(user.id);
        expect(state.on).toBe(true);
        expect(state.backupCodes).toHaveLength(10);
    });

    test('confirming marks the session that enrolled as stepped, and no other', async () => {
        const user = await account();
        const stranger = await account();
        const enrolling = await session(user.id);
        const elsewhere = await session(user.id);
        const theirs = await session(stranger.id);

        await enrolTotp(user.id, { sessionTokenHash: enrolling.tokenHash });
        expect((await sessionRow(enrolling.tokenHash))?.twoStepAt).toBeInstanceOf(Date);
        expect((await sessionRow(elsewhere.tokenHash))?.twoStepAt).toBeNull();

        // A session of another account, named by mistake or on purpose, is never marked.
        const second = await account();
        await enrolTotp(second.id, { sessionTokenHash: theirs.tokenHash });
        expect((await sessionRow(theirs.tokenHash))?.twoStepAt).toBeNull();
    });

    test('a pending factor lasts ten minutes and no longer', async () => {
        const user = await account();
        const inTime = await pendingTotp(user.id);
        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - 10 * MINUTE + 5_000) })
            .where(eq(twoStepFactors.id, inTime));
        expect(await twoStep.getPendingTotp({ userId: user.id, factorId: inTime })).not.toBeNull();

        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - 10 * MINUTE - 1_000) })
            .where(eq(twoStepFactors.id, inTime));
        expect(await twoStep.getPendingTotp({ userId: user.id, factorId: inTime })).toBeNull();
        expect(
            await twoStep.confirmTotp({
                userId: user.id,
                factorId: inTime,
                step: STEP,
                backupCodes: codes('late'),
            }),
        ).toEqual({ status: 'missing' });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
    });

    test('another account can neither read nor confirm a pending factor', async () => {
        const user = await account();
        const stranger = await account();
        const factorId = await pendingTotp(user.id);
        expect(await twoStep.getPendingTotp({ userId: stranger.id, factorId })).toBeNull();
        expect(
            await twoStep.confirmTotp({
                userId: stranger.id,
                factorId,
                step: STEP,
                backupCodes: codes('stranger'),
            }),
        ).toEqual({ status: 'missing' });
        expect(await twoStep.hasTwoStep(stranger.id)).toBe(false);
        expect((await factorRow(factorId))?.confirmedAt).toBeNull();
    });

    test('a new app replaces the old one when it is confirmed, and keeps the backup codes', async () => {
        const user = await account();
        const first = await enrolTotp(user.id, { label: 'first' });
        const second = await enrolTotp(user.id, { label: 'second', step: STEP + 10 });
        expect(second.result).toEqual({ status: 'ok', turnedOn: false, replaced: true });

        const state = await twoStep.getTwoStep(user.id);
        expect(state.factors.map((factor) => factor.id)).toEqual([second.factorId]);
        // The old secret answers nothing any more.
        expect(
            await twoStep.takeTotpStep({
                userId: user.id,
                factorId: first.factorId,
                step: STEP + 20,
            }),
        ).toBe(false);
        // The set shown when the step was turned on still stands; the second set was never stored.
        expect(state.backupCodes.map((code) => code.codeHash).sort((a, b) => a.compare(b))).toEqual(
            first.codes.map((code) => code.codeHash).sort((a, b) => a.compare(b)),
        );
    });

    test('starting again drops the earlier pending secret', async () => {
        const user = await account();
        const abandoned = await pendingTotp(user.id);
        const current = await pendingTotp(user.id);
        expect(await twoStep.getPendingTotp({ userId: user.id, factorId: abandoned })).toBeNull();
        expect(await twoStep.getPendingTotp({ userId: user.id, factorId: current })).not.toBeNull();
    });

    test('the database holds one confirmed app per account, whatever the code does', async () => {
        const user = await account();
        await enrolTotp(user.id);
        const second = db.insert(twoStepFactors).values({
            userId: user.id,
            kind: 'totp',
            name: 'Second app',
            confirmedAt: new Date(),
            totpKeyId: KEY_ID,
            totpNonce: bytes(24),
            totpSecret: bytes(36),
            totpLastStep: 0,
        });
        expect(await refusal(second)).toEqual({
            code: '23505',
            constraint: 'two_step_factors_totp_idx',
        });
    });
});

describe('a time step', () => {
    test('of eight requests carrying the same code, exactly one takes the step', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                twoStep.takeTotpStep({ userId: user.id, factorId, step: STEP + 1 }),
            ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    test('is not taken through another account', async () => {
        const user = await account();
        const stranger = await account();
        const { factorId } = await enrolTotp(user.id);
        await enrolTotp(stranger.id);
        expect(await twoStep.takeTotpStep({ userId: stranger.id, factorId, step: STEP + 1 })).toBe(
            false,
        );
        expect((await factorRow(factorId))?.totpLastStep).toBe(STEP);
    });

    test('leaves a last-used time to the hour, and the database takes nothing finer', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        const before = Date.now();
        await twoStep.takeTotpStep({ userId: user.id, factorId, step: STEP + 1 });
        const used = (await factorRow(factorId))?.lastUsedAt;
        expect(used!.getTime() % HOUR).toBe(0);
        expect(before - used!.getTime()).toBeLessThan(HOUR);

        const finer = db
            .update(twoStepFactors)
            .set({ lastUsedAt: new Date(used!.getTime() + 1_000) })
            .where(eq(twoStepFactors.id, factorId));
        expect(await refusal(finer)).toEqual({
            code: '23514',
            constraint: 'two_step_factors_last_used_hour',
        });
    });
});

describe('security keys', () => {
    test('the first key turns the step on; the same credential is not added twice, per account', async () => {
        const user = await account();
        const stranger = await account();
        expect(await addKey(user.id, 'yubikey')).toMatchObject({ status: 'ok', turnedOn: true });
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
        expect(await addKey(user.id, 'yubikey')).toEqual({ status: 'duplicate' });
        // Per account, never global: a global rule would say whether a key is in use elsewhere.
        expect(await addKey(stranger.id, 'yubikey')).toMatchObject({ status: 'ok' });
        expect((await twoStep.getTwoStep(user.id)).factors).toHaveLength(1);
    });

    test('an account holds ten keys, and the eleventh is refused', async () => {
        const user = await account();
        for (let index = 0; index < 10; index++)
            expect(await addKey(user.id, `key-${index}`)).toMatchObject({ status: 'ok' });
        expect(await addKey(user.id, 'key-10')).toEqual({ status: 'limit' });
        expect((await twoStep.getTwoStep(user.id)).factors).toHaveLength(10);
    });

    test('a key without the step’s codes cannot be the first factor', async () => {
        const user = await account();
        const added = await twoStep.addSecurityKey({
            userId: user.id,
            name: 'Security key',
            credentialId: sha256('credential'),
            publicKey: sha256('public-key'),
            signCount: 0,
            transports: [],
            backupEligible: false,
            backupState: false,
        });
        expect(added).toEqual({ status: 'codes' });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
    });

    test('a counter that does not go up is refused when either is non-zero', async () => {
        const user = await account();
        const factorId = await enrolKey(user.id, 'counting', { signCount: 5 });
        const use = (signCount: number) =>
            twoStep.takeKeyCounter({ userId: user.id, factorId, signCount, backupState: false });
        expect(await use(5)).toBe(false);
        expect(await use(0)).toBe(false);
        expect(await use(4)).toBe(false);
        expect((await factorRow(factorId))?.signCount).toBe(5);
        expect(await use(6)).toBe(true);
        expect(await use(6)).toBe(false);
        expect((await factorRow(factorId))?.signCount).toBe(6);
    });

    test('a key that always reports zero passes, until it reports more', async () => {
        const user = await account();
        const factorId = await enrolKey(user.id, 'synced');
        const use = (signCount: number) =>
            twoStep.takeKeyCounter({ userId: user.id, factorId, signCount, backupState: true });
        expect(await use(0)).toBe(true);
        expect(await use(0)).toBe(true);
        expect((await factorRow(factorId))?.backupState).toBe(true);
        expect(await use(3)).toBe(true);
        expect(await use(0)).toBe(false);
    });

    test('of eight assertions carrying the same counter, exactly one is taken', async () => {
        const user = await account();
        const factorId = await enrolKey(user.id, 'cloned', { signCount: 1 });
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                twoStep.takeKeyCounter({
                    userId: user.id,
                    factorId,
                    signCount: 2,
                    backupState: false,
                }),
            ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    test('another account’s key is not used, and its counter does not move', async () => {
        const user = await account();
        const stranger = await account();
        const factorId = await enrolKey(user.id, 'mine');
        await enrolKey(stranger.id, 'theirs');
        expect(
            await twoStep.takeKeyCounter({
                userId: stranger.id,
                factorId,
                signCount: 9,
                backupState: false,
            }),
        ).toBe(false);
        expect((await factorRow(factorId))?.signCount).toBe(0);
    });

    test('each kind of factor holds its own columns and none of the other’s', async () => {
        const user = await account();
        const totpWithCredential = db.insert(twoStepFactors).values({
            userId: user.id,
            kind: 'totp',
            name: 'App',
            totpKeyId: KEY_ID,
            totpNonce: bytes(24),
            totpSecret: bytes(36),
            totpLastStep: 0,
            credentialId: bytes(16),
        });
        const keyWithoutPublicKey = db.insert(twoStepFactors).values({
            userId: user.id,
            kind: 'webauthn',
            name: 'Key',
            confirmedAt: new Date(),
            credentialId: bytes(16),
            signCount: 0,
            transports: [],
            backupEligible: false,
            backupState: false,
        });
        const shortSecret = db.insert(twoStepFactors).values({
            userId: user.id,
            kind: 'totp',
            name: 'App',
            totpKeyId: KEY_ID,
            totpNonce: bytes(24),
            // The 20-byte secret unsealed: a sealed one is 36.
            totpSecret: bytes(20),
            totpLastStep: 0,
        });
        for (const insert of [totpWithCredential, keyWithoutPublicKey, shortSecret])
            expect(await refusal(insert)).toEqual({
                code: '23514',
                constraint: 'two_step_factors_kind_columns',
            });
    });
});

describe('renaming and removing a method', () => {
    test('only the account’s own method is renamed', async () => {
        const user = await account();
        const stranger = await account();
        const factorId = await enrolKey(user.id, 'Desk key');
        await enrolKey(stranger.id, 'Their key');
        expect(
            await twoStep.renameFactor({ userId: stranger.id, factorId, name: 'Taken over' }),
        ).toBe(false);
        expect((await factorRow(factorId))?.name).toBe('Desk key');
        expect(await twoStep.renameFactor({ userId: user.id, factorId, name: 'Drawer key' })).toBe(
            true,
        );
        expect((await factorRow(factorId))?.name).toBe('Drawer key');
    });

    test('another account cannot remove a method', async () => {
        const user = await account();
        const stranger = await account();
        const { factorId } = await enrolTotp(user.id);
        await enrolTotp(stranger.id);
        expect(await twoStep.removeFactor({ userId: stranger.id, factorId })).toEqual({
            status: 'missing',
        });
        expect(await twoStep.hasTwoStep(user.id)).toBe(true);
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
    });

    test('removing one of two methods leaves the step on, with its codes', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        await enrolKey(user.id, 'key');
        expect(await twoStep.removeFactor({ userId: user.id, factorId })).toEqual({
            status: 'ok',
            kind: 'totp',
            turnedOff: false,
        });
        const state = await twoStep.getTwoStep(user.id);
        expect(state.on).toBe(true);
        expect(state.backupCodes).toHaveLength(10);
    });

    test('removing the last method turns the step off: codes, counts and tokens go, the handle and salt stay', async () => {
        const user = await account();
        const laptop = await session(user.id, { keyed: true });
        const { factorId } = await enrolTotp(user.id);
        const before = await stateOf(user.id);
        await wrongCodes(user.id, 3);
        await wrongCodes(user.id, 2, { deviceId: laptop.deviceId });
        const outstanding = await stepToken(user.id);

        expect(await twoStep.removeFactor({ userId: user.id, factorId })).toEqual({
            status: 'ok',
            kind: 'totp',
            turnedOff: true,
        });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        expect(
            await db
                .select()
                .from(twoStepBackupCodes)
                .where(eq(twoStepBackupCodes.userId, user.id)),
        ).toEqual([]);
        expect(await twoStep.getStepAttempt(outstanding)).toBeNull();
        expect(await deviceFailures(laptop.deviceId)).toBe(0);
        const after = await stateOf(user.id);
        expect(after?.consecutiveFailures).toBe(0);
        // Made once per account: a key registered later carries the same handle.
        expect(after?.webauthnUserHandle).toEqual(before?.webauthnUserHandle);
        expect(after?.backupCodeSalt).toEqual(before?.backupCodeSalt);
    });

    test('the handle and salt are made once, and differ between accounts', async () => {
        const user = await account();
        const stranger = await account();
        const first = await twoStep.ensureState(user.id);
        const again = await twoStep.ensureState(user.id);
        const theirs = await twoStep.ensureState(stranger.id);
        expect(again).toEqual(first);
        expect(theirs?.webauthnUserHandle).not.toEqual(first?.webauthnUserHandle);
        expect(theirs?.backupCodeSalt).not.toEqual(first?.backupCodeSalt);
        expect(await twoStep.ensureState(randomUUID())).toBeNull();
    });
});

describe('backup codes', () => {
    test('a code is spent once, and the count of those left goes down', async () => {
        const user = await account();
        const { codes: set } = await enrolTotp(user.id);
        const spend = (index: number) =>
            twoStep.spendBackupCode({ userId: user.id, codeHash: set[index]!.codeHash });
        expect(await spend(0)).toBe(9);
        expect(await spend(0)).toBeNull();
        expect(await spend(1)).toBe(8);
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(8);
    });

    test('of eight requests carrying one code, exactly one spends it', async () => {
        const user = await account();
        const { codes: set } = await enrolTotp(user.id);
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                twoStep.spendBackupCode({ userId: user.id, codeHash: set[0]!.codeHash }),
            ),
        );
        expect(results.filter((left) => left !== null)).toEqual([9]);
    });

    test('a code from another account is refused, and stays unspent there', async () => {
        const user = await account();
        const stranger = await account();
        await enrolTotp(user.id, { label: 'mine' });
        const theirs = await enrolTotp(stranger.id, { label: 'theirs' });
        expect(
            await twoStep.spendBackupCode({
                userId: user.id,
                codeHash: theirs.codes[0]!.codeHash,
            }),
        ).toBeNull();
        expect((await twoStep.getTwoStep(stranger.id)).backupCodes).toHaveLength(10);
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
    });

    test('a new set invalidates every old code, used or not', async () => {
        const user = await account();
        const { codes: old } = await enrolTotp(user.id, { label: 'old' });
        await twoStep.spendBackupCode({ userId: user.id, codeHash: old[0]!.codeHash });
        const fresh = codes('fresh');
        expect(await twoStep.replaceBackupCodes({ userId: user.id, codes: fresh })).toBe(true);

        for (const code of old)
            expect(
                await twoStep.spendBackupCode({ userId: user.id, codeHash: code.codeHash }),
            ).toBeNull();
        expect(
            await twoStep.spendBackupCode({ userId: user.id, codeHash: fresh[0]!.codeHash }),
        ).toBe(9);
        expect(
            await db
                .select()
                .from(twoStepBackupCodes)
                .where(eq(twoStepBackupCodes.userId, user.id)),
        ).toHaveLength(10);
    });

    test('an account without the step gets no codes, and a set is ten', async () => {
        const user = await account();
        expect(await twoStep.replaceBackupCodes({ userId: user.id, codes: codes('off') })).toBe(
            false,
        );
        expect(await db.select().from(twoStepBackupCodes)).toEqual([]);
        await enrolTotp(user.id);
        await expect(
            twoStep.replaceBackupCodes({ userId: user.id, codes: codes('nine').slice(0, 9) }),
        ).rejects.toThrow();
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
    });
});

describe('step tokens', () => {
    test('a token lasts five minutes and no longer', async () => {
        const user = await account();
        await enrolTotp(user.id);
        const binding = {
            tokenHash: token('step'),
            purpose: 'login' as const,
            sessionTokenHash: null,
        };
        const before = Date.now();
        const { expiresAt } = await twoStep.createStepAttempt({
            ...binding,
            userId: user.id,
            credentialVersion: 1,
        });
        expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(5 * MINUTE);
        expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * MINUTE);
        expect((await twoStep.getStepAttempt(binding))?.expiresAt).toEqual(expiresAt);

        const expire = (at: Date) =>
            db
                .update(twoStepAttempts)
                .set({ createdAt: new Date(Date.now() - 6 * MINUTE), expiresAt: at })
                .where(eq(twoStepAttempts.tokenHash, binding.tokenHash));
        await expire(new Date(Date.now() + 5_000));
        expect(await twoStep.getStepAttempt(binding)).not.toBeNull();
        await expire(new Date(Date.now() - 1));
        expect(await twoStep.getStepAttempt(binding)).toBeNull();
        expect(await twoStep.failStep({ ...binding, method: 'totp' })).toEqual({
            status: 'missing',
        });
        expect(await twoStep.passStep({ ...binding, proof: { method: 'phrase' } })).toEqual({
            status: 'missing',
        });
        // An expired token counted nothing against the account.
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(0);
    });

    test('a token passes once', async () => {
        const user = await account();
        await enrolTotp(user.id);
        const binding = await stepToken(user.id);
        const first = await twoStep.passStep({ ...binding, proof: { method: 'phrase' } });
        expect(first).toMatchObject({ status: 'ok', attempt: { userId: user.id } });
        expect(await twoStep.passStep({ ...binding, proof: { method: 'phrase' } })).toEqual({
            status: 'missing',
        });
    });

    test('of six requests carrying one token, exactly one passes', async () => {
        const user = await account();
        await enrolTotp(user.id);
        const binding = await stepToken(user.id);
        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                twoStep.passStep({ ...binding, proof: { method: 'phrase' } }),
            ),
        );
        expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'missing')).toHaveLength(5);
    });

    test('a token takes four wrong answers and is gone at the fifth', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        const spent = await stepToken(user.id);
        const kept = await stepToken(user.id);
        for (const left of [4, 3, 2, 1])
            expect(await twoStep.failStep({ ...spent, method: 'webauthn' })).toMatchObject({
                status: 'counted',
                left,
            });
        expect(await twoStep.getStepAttempt(spent)).not.toBeNull();
        expect(await twoStep.failStep({ ...spent, method: 'webauthn' })).toMatchObject({
            status: 'counted',
            left: 0,
        });
        expect(await twoStep.getStepAttempt(spent)).toBeNull();
        expect(await twoStep.failStep({ ...spent, method: 'webauthn' })).toEqual({
            status: 'missing',
        });
        expect(
            await twoStep.passStep({
                ...spent,
                proof: { method: 'totp', factorId, step: STEP + 1 },
            }),
        ).toEqual({ status: 'missing' });

        // Four wrong answers leave a token that still passes with a right one.
        for (let index = 0; index < 4; index++)
            await twoStep.failStep({ ...kept, method: 'webauthn' });
        expect(
            await twoStep.passStep({
                ...kept,
                proof: { method: 'totp', factorId, step: STEP + 1 },
            }),
        ).toMatchObject({ status: 'ok' });
    });

    test('a token bound to one purpose or session is refused for another, and a sign-in’s token authorises no change', async () => {
        const user = await account();
        const here = await session(user.id);
        const there = await session(user.id);
        await enrolTotp(user.id);
        const change = await stepToken(user.id, {
            purpose: 'password',
            sessionTokenHash: here.tokenHash,
        });
        const signIn = await stepToken(user.id);
        const pass = (binding: twoStep.StepBinding) =>
            twoStep.passStep({ ...binding, proof: { method: 'phrase' } });

        expect(await pass({ ...change, purpose: 'delete' })).toEqual({ status: 'missing' });
        expect(await pass({ ...change, sessionTokenHash: there.tokenHash })).toEqual({
            status: 'missing',
        });
        expect(await pass({ ...change, purpose: 'login', sessionTokenHash: null })).toEqual({
            status: 'missing',
        });
        expect(
            await pass({ ...signIn, purpose: 'password', sessionTokenHash: here.tokenHash }),
        ).toEqual({ status: 'missing' });
        expect(await twoStep.failStep({ ...change, purpose: 'delete', method: 'totp' })).toEqual({
            status: 'missing',
        });

        // Neither was spent nor counted by the refusals: each still passes where it belongs.
        expect((await twoStep.getStepAttempt(change))?.failures).toBe(0);
        expect(await pass(change)).toMatchObject({ status: 'ok' });
        expect(await pass(signIn)).toMatchObject({ status: 'ok' });
    });

    test('a password change drops every step token issued before it', async () => {
        const user = await account();
        const current = await session(user.id);
        const { codes: set } = await enrolTotp(user.id, { sessionTokenHash: current.tokenHash });
        const signIn = await stepToken(user.id);
        await stepToken(user.id, { purpose: 'delete', sessionTokenHash: current.tokenHash });
        expect(await changePassword(user.id, current.tokenHash)).toBe(true);

        expect(
            await db.select().from(twoStepAttempts).where(eq(twoStepAttempts.userId, user.id)),
        ).toEqual([]);
        expect(
            await twoStep.passStep({
                ...signIn,
                proof: { method: 'backup', codeHash: set[0]!.codeHash },
            }),
        ).toEqual({ status: 'missing' });
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
    });

    test('a phrase reset drops every step token too', async () => {
        const email = 'reset@hushos.test';
        const { user } = await registered(email);
        await enrolTotp(user.id);
        await stepToken(user.id);
        const verification = token('verification');
        const enrollment = token('enrollment');
        await auth.createEnrollment({
            purpose: 'recover',
            email,
            normalizedEmail: email,
            verificationTokenHash: verification,
            expiresAt: new Date(Date.now() + HOUR),
        });
        const verified = await auth.verifyEnrollment(
            verification,
            enrollment,
            new Date(Date.now() + HOUR),
        );
        const reset = await auth.resetAccountPassword({
            userId: user.id,
            enrollmentId: verified!.id,
            enrollmentTokenHash: enrollment,
            credentialVersion: 1,
            registrationRecord: 'record-2',
            profileVersion: 1,
            serverSetupId: 'primary',
            envelope: {
                keyVersion: 1,
                wrappingSalt: bytes(32),
                wrappingNonce: bytes(24),
                encryptedKey: bytes(48),
            },
            recovery: {
                recoveryVersion: 2,
                wrappingSalt: bytes(32),
                wrappingNonce: bytes(24),
                encryptedKey: bytes(48),
                backupNonce: bytes(24),
                encryptedRecoveryKey: bytes(48),
                publicKey: bytes(32),
            },
        });
        expect(reset?.id).toBe(user.id);
        expect(await db.select().from(twoStepAttempts)).toEqual([]);
        // The step itself is untouched: the next sign-in is asked as usual.
        expect(await twoStep.hasTwoStep(user.id)).toBe(true);
    });

    test('a token naming the old password passes nothing and counts nothing, however late it lands', async () => {
        const user = await account();
        const current = await session(user.id);
        const laptop = await session(user.id, { keyed: true });
        const { codes: set } = await enrolTotp(user.id, { sessionTokenHash: current.tokenHash });
        // One wrong code from a new device short of the freeze, and three on the laptop.
        await db
            .update(twoStepState)
            .set({ consecutiveFailures: 99 })
            .where(eq(twoStepState.userId, user.id));
        await db
            .update(accountDevices)
            .set({ twoStepFailures: 3 })
            .where(eq(accountDevices.id, laptop.deviceId));
        expect(await changePassword(user.id, current.tokenHash)).toBe(true);

        // Tokens a sign-in wrote just after the change, having read the credential just before it.
        const toPass = await stepToken(user.id);
        const fromNew = await stepToken(user.id);
        const fromLaptop = await stepToken(user.id, { deviceId: laptop.deviceId });
        expect(
            await twoStep.passStep({
                ...toPass,
                proof: { method: 'backup', codeHash: set[0]!.codeHash },
            }),
        ).toEqual({ status: 'stale' });
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
        for (const binding of [fromNew, fromLaptop])
            expect(await twoStep.failStep({ ...binding, method: 'totp' })).toEqual({
                status: 'missing',
            });
        // Each is gone at its first use, and neither pool moved: the app is not frozen.
        expect(await db.select().from(twoStepAttempts)).toEqual([]);
        expect(await stateOf(user.id)).toMatchObject({
            consecutiveFailures: 99,
            totpFrozenAt: null,
        });
        expect(await deviceFailures(laptop.deviceId)).toBe(3);

        // Under the new password the counts are live: the next wrong code is the hundredth.
        const fresh = await stepToken(user.id, { credentialVersion: 2 });
        expect(await twoStep.failStep({ ...fresh, method: 'totp' })).toMatchObject({
            consecutive: 100,
            froze: true,
        });
    });

    test('a change’s token dies with the session it was asked from', async () => {
        const user = await account();
        const asking = await session(user.id);
        const { codes: set } = await enrolTotp(user.id);
        const binding = await stepToken(user.id, {
            purpose: 'delete',
            sessionTokenHash: asking.tokenHash,
        });
        await db.delete(sessions).where(eq(sessions.tokenHash, asking.tokenHash));
        expect(
            await twoStep.passStep({
                ...binding,
                proof: { method: 'backup', codeHash: set[0]!.codeHash },
            }),
        ).toEqual({ status: 'missing' });
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
    });

    test('an enrol token is never passed by a proof, the phrase included', async () => {
        const user = await account();
        await enrolTotp(user.id);
        const binding = await stepToken(user.id, { purpose: 'enrol' });
        expect(await twoStep.passStep({ ...binding, proof: { method: 'phrase' } })).toEqual({
            status: 'missing',
        });
        expect(await twoStep.getStepAttempt(binding)).not.toBeNull();
    });

    test('turning the step on ends the account’s enrol tokens, and nobody else’s', async () => {
        const viaApp = await account();
        const viaKey = await account();
        const waiting = await account();
        const first = await stepToken(viaApp.id, { purpose: 'enrol' });
        const second = await stepToken(viaApp.id, { purpose: 'enrol' });
        const forKey = await stepToken(viaKey.id, { purpose: 'enrol' });
        const theirs = await stepToken(waiting.id, { purpose: 'enrol' });

        // Starting an enrolment ends nothing: the step is not on yet.
        const factorId = await pendingTotp(viaApp.id);
        expect(await twoStep.getStepAttempt(second)).not.toBeNull();
        await twoStep.confirmTotp({
            userId: viaApp.id,
            factorId,
            step: STEP,
            backupCodes: codes('enrolled'),
        });
        // The token the sign-in did not use could otherwise enrol another app, with no step.
        expect(await twoStep.getStepAttempt(first)).toBeNull();
        expect(await twoStep.getStepAttempt(second)).toBeNull();

        await enrolKey(viaKey.id, 'first key');
        expect(await twoStep.getStepAttempt(forKey)).toBeNull();
        expect(await twoStep.getStepAttempt(theirs)).not.toBeNull();
    });

    test('the database refuses a token whose binding does not fit its purpose', async () => {
        const user = await account();
        const here = await session(user.id);
        const insert = (values: Partial<typeof twoStepAttempts.$inferInsert>) =>
            db.insert(twoStepAttempts).values({
                tokenHash: token('raw-step'),
                userId: user.id,
                purpose: 'login',
                credentialVersion: 1,
                expiresAt: new Date(Date.now() + 5 * MINUTE),
                ...values,
            });
        expect(await refusal(insert({ sessionTokenHash: here.tokenHash }))).toMatchObject({
            constraint: 'two_step_attempts_session_binding',
        });
        expect(await refusal(insert({ purpose: 'password' }))).toMatchObject({
            constraint: 'two_step_attempts_session_binding',
        });
        expect(
            await refusal(
                insert({
                    purpose: 'delete',
                    sessionTokenHash: here.tokenHash,
                    deviceId: here.deviceId,
                }),
            ),
        ).toMatchObject({ constraint: 'two_step_attempts_login_only' });
        expect(await refusal(insert({ purpose: 'email' as TwoStepPurpose }))).toMatchObject({
            constraint: 'two_step_attempts_purpose_valid',
        });
        expect(await refusal(insert({ failures: 6 }))).toMatchObject({
            constraint: 'two_step_attempts_valid',
        });
        expect(await refusal(insert({}))).toBeNull();
    });
});

describe('passing the step', () => {
    test('an authenticator code passes once: the second token carrying it is refused and kept', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        const first = await stepToken(user.id);
        const second = await stepToken(user.id);
        const proof = { method: 'totp' as const, factorId, step: STEP + 1 };
        expect(await twoStep.passStep({ ...first, proof })).toMatchObject({
            status: 'ok',
            backupCodesLeft: null,
        });
        expect(await twoStep.passStep({ ...second, proof })).toEqual({
            status: 'refused',
            reason: 'replayed',
        });
        // Refused, not spent: the token is still there for the caller to count the wrong answer on.
        expect(await twoStep.failStep({ ...second, method: 'totp' })).toMatchObject({
            status: 'counted',
            left: 4,
            consecutive: 1,
        });
    });

    test('of four sign-ins carrying the same code at once, exactly one passes', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        const tokens = await Promise.all(Array.from({ length: 4 }, () => stepToken(user.id)));
        const results = await Promise.all(
            tokens.map((binding) =>
                twoStep.passStep({
                    ...binding,
                    proof: { method: 'totp', factorId, step: STEP + 1 },
                }),
            ),
        );
        expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'refused')).toHaveLength(3);
    });

    test('a code used at sign-in is refused for a security change in the same step', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        const signIn = await stepToken(user.id);
        const proof = { method: 'totp' as const, factorId, step: STEP + 1 };
        const passed = await twoStep.passStep({ ...signIn, proof });
        if (passed.status !== 'ok') throw new Error('The sign-in did not pass.');
        const opened = await session(user.id, { twoStepAt: passed.at });
        const change = await stepToken(user.id, {
            purpose: 'password',
            sessionTokenHash: opened.tokenHash,
        });
        expect(await twoStep.passStep({ ...change, proof })).toEqual({
            status: 'refused',
            reason: 'replayed',
        });
        expect(
            await twoStep.passStep({ ...change, proof: { ...proof, step: STEP + 2 } }),
        ).toMatchObject({ status: 'ok' });
    });

    test('a backup code passes one token and says how many are left', async () => {
        const user = await account();
        const { codes: set } = await enrolTotp(user.id);
        const proof = { method: 'backup' as const, codeHash: set[3]!.codeHash };
        const first = await stepToken(user.id);
        const second = await stepToken(user.id);
        expect(await twoStep.passStep({ ...first, proof })).toMatchObject({
            status: 'ok',
            backupCodesLeft: 9,
        });
        // Spent already: a replay, not a stranger's code.
        expect(await twoStep.passStep({ ...second, proof })).toEqual({
            status: 'refused',
            reason: 'replayed',
        });
        expect(await twoStep.getStepAttempt(second)).not.toBeNull();
    });

    test('of four sign-ins carrying one backup code at once, exactly one passes', async () => {
        const user = await account();
        const { codes: set } = await enrolTotp(user.id);
        const tokens = await Promise.all(Array.from({ length: 4 }, () => stepToken(user.id)));
        const results = await Promise.all(
            tokens.map((binding) =>
                twoStep.passStep({
                    ...binding,
                    proof: { method: 'backup', codeHash: set[0]!.codeHash },
                }),
            ),
        );
        expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(9);
    });

    test('another account’s app, key or backup code does not pass this account’s token', async () => {
        const user = await account();
        const stranger = await account();
        await enrolTotp(user.id, { label: 'mine' });
        const theirs = await enrolTotp(stranger.id, { label: 'theirs' });
        const theirKey = await enrolKey(stranger.id, 'their key');
        const binding = await stepToken(user.id);
        const proofs: twoStep.StepProof[] = [
            { method: 'totp', factorId: theirs.factorId, step: STEP + 1 },
            { method: 'webauthn', factorId: theirKey, signCount: 1, backupState: false },
            { method: 'backup', codeHash: theirs.codes[0]!.codeHash },
        ];
        for (const proof of proofs)
            expect(await twoStep.passStep({ ...binding, proof })).toEqual({
                status: 'refused',
                reason: 'unknown',
            });
        // Nothing of the other account moved.
        expect((await factorRow(theirs.factorId))?.totpLastStep).toBe(STEP);
        expect((await factorRow(theirKey))?.signCount).toBe(0);
        expect((await twoStep.getTwoStep(stranger.id)).backupCodes).toHaveLength(10);
    });

    test('a key passes by the counter rule: 5 then 5 is refused, 0 then 0 passes', async () => {
        const user = await account();
        const counting = await enrolKey(user.id, 'counting', { signCount: 5 });
        const synced = await enrolKey(user.id, 'synced');
        const pass = async (factorId: string, signCount: number) =>
            twoStep.passStep({
                ...(await stepToken(user.id)),
                proof: { method: 'webauthn', factorId, signCount, backupState: false },
            });
        expect(await pass(counting, 5)).toEqual({ status: 'refused', reason: 'counter' });
        expect(await pass(counting, 0)).toEqual({ status: 'refused', reason: 'counter' });
        expect((await pass(counting, 6)).status).toBe('ok');
        expect((await pass(synced, 0)).status).toBe('ok');
        expect((await pass(synced, 0)).status).toBe('ok');
    });

    test('a removed key no longer passes', async () => {
        const user = await account();
        await enrolTotp(user.id);
        const key = await enrolKey(user.id, 'lost');
        await twoStep.removeFactor({ userId: user.id, factorId: key });
        const binding = await stepToken(user.id);
        expect(
            await twoStep.passStep({
                ...binding,
                proof: { method: 'webauthn', factorId: key, signCount: 1, backupState: false },
            }),
        ).toEqual({ status: 'refused', reason: 'unknown' });
    });

    test('inside a transaction that fails, the token, the code and the step are all put back', async () => {
        const user = await account();
        const { factorId, codes: set } = await enrolTotp(user.id);
        const withCode = await stepToken(user.id);
        const withApp = await stepToken(user.id);
        class Abort extends Error {}
        await expect(
            db.transaction(async (tx) => {
                const code = await twoStep.passStep(
                    { ...withCode, proof: { method: 'backup', codeHash: set[0]!.codeHash } },
                    tx,
                );
                const app = await twoStep.passStep(
                    { ...withApp, proof: { method: 'totp', factorId, step: STEP + 1 } },
                    tx,
                );
                expect([code.status, app.status]).toEqual(['ok', 'ok']);
                // The session could not be made: everything the step spent comes back.
                throw new Abort();
            }),
        ).rejects.toBeInstanceOf(Abort);

        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
        expect((await factorRow(factorId))?.totpLastStep).toBe(STEP);
        expect(
            await twoStep.passStep({
                ...withCode,
                proof: { method: 'backup', codeHash: set[0]!.codeHash },
            }),
        ).toMatchObject({ status: 'ok', backupCodesLeft: 9 });
        expect(
            await twoStep.passStep({
                ...withApp,
                proof: { method: 'totp', factorId, step: STEP + 1 },
            }),
        ).toMatchObject({ status: 'ok' });
    });

    test('a refused proof inside a transaction leaves it usable, with the token still there', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        const binding = await stepToken(user.id);
        const counted = await db.transaction(async (tx) => {
            const refused = await twoStep.passStep(
                { ...binding, proof: { method: 'totp', factorId, step: STEP } },
                tx,
            );
            expect(refused).toEqual({ status: 'refused', reason: 'replayed' });
            return twoStep.failStep({ ...binding, method: 'totp' }, tx);
        });
        expect(counted).toMatchObject({ status: 'counted', left: 4 });
        expect((await twoStep.getStepAttempt(binding))?.failures).toBe(1);
    });
});

describe('failure counts and the freeze', () => {
    test('wrong codes from new devices count in a row across tokens, and a success there starts again', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        expect((await wrongCodes(user.id, 4)).consecutive).toBe(4);
        // The fifth in a row is what the caller sends the notice on; it comes on a second token here.
        expect(await wrongCodes(user.id, 1)).toMatchObject({
            pool: 'account',
            consecutive: 5,
            froze: false,
        });
        expect((await wrongCodes(user.id, 6)).consecutive).toBe(11);

        const binding = await stepToken(user.id);
        await twoStep.passStep({ ...binding, proof: { method: 'totp', factorId, step: STEP + 1 } });
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(0);
        expect((await wrongCodes(user.id, 1)).consecutive).toBe(1);
    });

    test('a known device has its own count, which the account’s shared one does not touch, nor the other way', async () => {
        const user = await account();
        const laptop = await session(user.id, { keyed: true });
        const { factorId } = await enrolTotp(user.id);
        expect(await wrongCodes(user.id, 3, { deviceId: laptop.deviceId })).toMatchObject({
            pool: 'device',
            deviceId: laptop.deviceId,
            consecutive: 3,
        });
        await wrongCodes(user.id, 2);
        expect(await deviceFailures(laptop.deviceId)).toBe(3);
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(2);

        // A success from a new device leaves the laptop's count where it was.
        const fromNew = await stepToken(user.id);
        await twoStep.passStep({ ...fromNew, proof: { method: 'totp', factorId, step: STEP + 1 } });
        expect(await deviceFailures(laptop.deviceId)).toBe(3);
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(0);

        // A success from the laptop starts its own count again, and not the shared one.
        await wrongCodes(user.id, 2);
        const fromLaptop = await stepToken(user.id, { deviceId: laptop.deviceId });
        await twoStep.passStep({
            ...fromLaptop,
            proof: { method: 'totp', factorId, step: STEP + 2 },
        });
        expect(await deviceFailures(laptop.deviceId)).toBe(0);
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(2);
    });

    test('only codes count: a wrong key assertion or phrase signature spends the token alone', async () => {
        const user = await account();
        await enrolTotp(user.id);
        const binding = await stepToken(user.id);
        for (const method of ['webauthn', 'phrase'] as const)
            expect(await twoStep.failStep({ ...binding, method })).toMatchObject({
                status: 'counted',
                pool: null,
                consecutive: null,
            });
        expect((await twoStep.getStepAttempt(binding))?.failures).toBe(2);
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(0);
        // A wrong backup code is a code.
        expect(await twoStep.failStep({ ...binding, method: 'backup' })).toMatchObject({
            pool: 'account',
            consecutive: 1,
        });
    });

    /* Devices a sign-in's token may name that are not a known device of `userId`, each for its own reason. */
    async function unknownDevices(userId: string, twoStepAt?: Date) {
        const stranger = await account();
        const theirs = await session(stranger.id, { keyed: true });
        const removed = await session(userId, { keyed: true, twoStepAt });
        await db
            .update(accountDevices)
            .set({ revokedAt: new Date() })
            .where(eq(accountDevices.id, removed.deviceId));
        // Holds a session, but never registered a key: it cannot have proved anything at sign-in.
        const keyless = await session(userId, { twoStepAt });
        // Waiting to be approved, as device approval will leave a row.
        const [pending] = await db
            .insert(accountDevices)
            .values({ userId, kind: 'web', signingPublicKey: sha256(`pending-key:${userId}`) })
            .returning({ id: accountDevices.id });
        return {
            'another account’s': theirs.deviceId,
            removed: removed.deviceId,
            keyless: keyless.deviceId,
            unapproved: pending!.id,
        };
    }

    test('a sign-in naming another account’s device, a removed, keyless or unapproved one counts as a new device', async () => {
        const user = await account();
        const devices = await unknownDevices(user.id);
        await enrolTotp(user.id);
        for (const [which, deviceId] of Object.entries(devices))
            expect(await wrongCodes(user.id, 1, { deviceId }), which).toMatchObject({
                pool: 'account',
                deviceId: null,
            });
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(4);
        for (const deviceId of Object.values(devices))
            expect(await deviceFailures(deviceId)).toBe(0);
    });

    test('a wrong code for a change counts on the device of the session asking', async () => {
        const user = await account();
        const asking = await session(user.id);
        await enrolTotp(user.id);
        const binding = await stepToken(user.id, {
            purpose: 'password',
            sessionTokenHash: asking.tokenHash,
        });
        expect(await twoStep.failStep({ ...binding, method: 'totp' })).toMatchObject({
            pool: 'device',
            deviceId: asking.deviceId,
            consecutive: 1,
        });
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(0);
    });

    test('the hundredth wrong code in a row freezes the app, not the ninety-ninth', async () => {
        const user = await account();
        await enrolTotp(user.id);
        // Ninety-eight already counted, set directly; the two that matter are counted for real.
        await db
            .update(twoStepState)
            .set({ consecutiveFailures: 98 })
            .where(eq(twoStepState.userId, user.id));
        expect(await wrongCodes(user.id, 1)).toMatchObject({ consecutive: 99, froze: false });
        expect((await stateOf(user.id))?.totpFrozenAt).toBeNull();
        expect(await wrongCodes(user.id, 1)).toMatchObject({ consecutive: 100, froze: true });
        const frozenAt = (await stateOf(user.id))?.totpFrozenAt;
        expect(frozenAt).toBeInstanceOf(Date);
        // Frozen once: later failures neither report it again nor move the time.
        expect(await wrongCodes(user.id, 1)).toMatchObject({ consecutive: 101, froze: false });
        expect((await stateOf(user.id))?.totpFrozenAt).toEqual(frozenAt);
    });

    test('a frozen app is refused from a new device and still passes from a known one', async () => {
        const { user, laptop, app } = await frozenAccount();
        const proof = { method: 'totp' as const, factorId: app.factorId, step: STEP + 1 };
        const fromNew = await stepToken(user.id);
        expect(await twoStep.passStep({ ...fromNew, proof })).toEqual({ status: 'frozen' });
        // Refused before the code was looked at: the step is not taken and the token is still there.
        expect((await factorRow(app.factorId))?.totpLastStep).toBe(STEP);
        expect(await twoStep.getStepAttempt(fromNew)).not.toBeNull();

        const fromLaptop = await stepToken(user.id, { deviceId: laptop.deviceId });
        expect(await twoStep.passStep({ ...fromLaptop, proof })).toMatchObject({
            status: 'ok',
            unfroze: false,
        });
        // The app's own success, from a known device, does not thaw it for new ones.
        expect((await stateOf(user.id))?.totpFrozenAt).toBeInstanceOf(Date);
        const again = await stepToken(user.id);
        expect(await twoStep.passStep({ ...again, proof: { ...proof, step: STEP + 2 } })).toEqual({
            status: 'frozen',
        });
    });

    test('a frozen app stays refused for a sign-in naming any device that is not a known one', async () => {
        const { user, app } = await frozenAccount();
        const devices = await unknownDevices(user.id, new Date());
        for (const [which, deviceId] of Object.entries(devices)) {
            const binding = await stepToken(user.id, { deviceId });
            expect(
                await twoStep.passStep({
                    ...binding,
                    proof: { method: 'totp', factorId: app.factorId, step: STEP + 1 },
                }),
                which,
            ).toEqual({ status: 'frozen' });
        }
    });

    test('a frozen app still answers a change asked from a session on a device, and not one from a session without', async () => {
        const { user, app } = await frozenAccount();
        const proof = { method: 'totp' as const, factorId: app.factorId, step: STEP + 1 };
        // A session made by a container of the release before devices: it has none.
        const deviceless = token('raw-session');
        await db.insert(sessions).values({
            userId: user.id,
            tokenHash: deviceless,
            credentialVersion: 1,
            expiresAt: new Date(Date.now() + HOUR),
            twoStepAt: new Date(),
        });
        const fromNowhere = await stepToken(user.id, {
            purpose: 'password',
            sessionTokenHash: deviceless,
        });
        expect(await twoStep.passStep({ ...fromNowhere, proof })).toEqual({ status: 'frozen' });

        // Holding a session is what makes its device known, key or no key.
        const known = await session(user.id, { twoStepAt: new Date() });
        const fromKnown = await stepToken(user.id, {
            purpose: 'password',
            sessionTokenHash: known.tokenHash,
        });
        expect(await twoStep.passStep({ ...fromKnown, proof })).toMatchObject({
            status: 'ok',
            unfroze: false,
        });
        expect((await stateOf(user.id))?.totpFrozenAt).toBeInstanceOf(Date);
    });

    test('while the app is frozen a backup code still passes from a new device, and thaws it', async () => {
        const { user, app } = await frozenAccount();
        const withCode = await stepToken(user.id);
        expect(
            await twoStep.passStep({
                ...withCode,
                proof: { method: 'backup', codeHash: app.codes[0]!.codeHash },
            }),
        ).toMatchObject({ status: 'ok', unfroze: true });
        expect(await stateOf(user.id)).toMatchObject({
            totpFrozenAt: null,
            consecutiveFailures: 0,
        });

        const withApp = await stepToken(user.id);
        expect(
            await twoStep.passStep({
                ...withApp,
                proof: { method: 'totp', factorId: app.factorId, step: STEP + 1 },
            }),
        ).toMatchObject({ status: 'ok' });
        // The count started again with the thaw: one wrong code is one, not a hundred and one.
        expect(await wrongCodes(user.id, 1)).toMatchObject({ consecutive: 1, froze: false });
    });

    test('a key or the phrase passes while the app is frozen, from a new device or a known one', async () => {
        const viaKey = await frozenAccount();
        const keyToken = await stepToken(viaKey.user.id, { deviceId: viaKey.laptop.deviceId });
        expect(
            await twoStep.passStep({
                ...keyToken,
                proof: {
                    method: 'webauthn',
                    factorId: viaKey.key,
                    signCount: 1,
                    backupState: false,
                },
            }),
        ).toMatchObject({ status: 'ok', unfroze: true });
        // From a known device too the thaw starts the shared count again: left at a hundred, the
        // next wrong code from a new device would freeze the app straight back.
        expect(await stateOf(viaKey.user.id)).toMatchObject({
            totpFrozenAt: null,
            consecutiveFailures: 0,
        });
        expect(await wrongCodes(viaKey.user.id, 1)).toMatchObject({ consecutive: 1, froze: false });

        const viaPhrase = await frozenAccount();
        const phraseToken = await stepToken(viaPhrase.user.id);
        expect(
            await twoStep.passStep({ ...phraseToken, proof: { method: 'phrase' } }),
        ).toMatchObject({ status: 'ok', unfroze: true });
        expect((await stateOf(viaPhrase.user.id))?.totpFrozenAt).toBeNull();
    });

    test('a known device’s count never freezes the app', async () => {
        const user = await account();
        const laptop = await session(user.id, { keyed: true });
        const { factorId } = await enrolTotp(user.id);
        await db
            .update(accountDevices)
            .set({ twoStepFailures: 99 })
            .where(eq(accountDevices.id, laptop.deviceId));
        expect(await wrongCodes(user.id, 2, { deviceId: laptop.deviceId })).toMatchObject({
            consecutive: 101,
            froze: false,
        });
        expect((await stateOf(user.id))?.totpFrozenAt).toBeNull();
        const fromNew = await stepToken(user.id);
        expect(
            await twoStep.passStep({
                ...fromNew,
                proof: { method: 'totp', factorId, step: STEP + 1 },
            }),
        ).toMatchObject({ status: 'ok' });
    });

    test('with keys and backup codes only there is no app to freeze, however many codes are wrong', async () => {
        const user = await account();
        await enrolKey(user.id, 'only key');
        await db
            .update(twoStepState)
            .set({ consecutiveFailures: 99 })
            .where(eq(twoStepState.userId, user.id));
        for (const consecutive of [100, 101]) {
            const binding = await stepToken(user.id);
            expect(await twoStep.failStep({ ...binding, method: 'backup' })).toMatchObject({
                pool: 'account',
                consecutive,
                froze: false,
            });
        }
        expect((await stateOf(user.id))?.totpFrozenAt).toBeNull();
        // An app enrolled afterwards starts with a count of its own, not a hundred and one.
        await enrolTotp(user.id);
        expect(await wrongCodes(user.id, 1)).toMatchObject({ consecutive: 1, froze: false });
    });

    test('the freeze goes with the app: removing it, or turning the step off, leaves nothing frozen', async () => {
        const keepsKey = await frozenAccount();
        await twoStep.removeFactor({ userId: keepsKey.user.id, factorId: keepsKey.app.factorId });
        expect((await stateOf(keepsKey.user.id))?.totpFrozenAt).toBeNull();
        expect(await twoStep.hasTwoStep(keepsKey.user.id)).toBe(true);

        // The key goes first here, so it is turning the step off that has to clear the freeze.
        const turnsOff = await frozenAccount();
        await twoStep.removeFactor({ userId: turnsOff.user.id, factorId: turnsOff.key });
        expect((await stateOf(turnsOff.user.id))?.totpFrozenAt).toBeInstanceOf(Date);
        expect(
            await twoStep.removeFactor({
                userId: turnsOff.user.id,
                factorId: turnsOff.app.factorId,
            }),
        ).toMatchObject({ turnedOff: true });
        expect(await stateOf(turnsOff.user.id)).toMatchObject({
            totpFrozenAt: null,
            consecutiveFailures: 0,
        });
    });

    test('a change asked from a session that has expired, or from another account’s session, passes nothing and counts in no pool', async () => {
        const user = await account();
        const stranger = await account();
        const asking = await session(user.id);
        const theirs = await session(stranger.id);
        const { codes: set } = await enrolTotp(user.id);
        const expired = await stepToken(user.id, {
            purpose: 'password',
            sessionTokenHash: asking.tokenHash,
        });
        // Past its time, and not swept yet.
        await db
            .update(sessions)
            .set({
                createdAt: new Date(Date.now() - 2 * HOUR),
                expiresAt: new Date(Date.now() - 1),
            })
            .where(eq(sessions.tokenHash, asking.tokenHash));
        // A token of this account that names a session of someone else's.
        const borrowed = await stepToken(user.id, {
            purpose: 'password',
            sessionTokenHash: theirs.tokenHash,
        });
        for (const binding of [expired, borrowed]) {
            expect(await twoStep.failStep({ ...binding, method: 'totp' })).toEqual({
                status: 'counted',
                userId: user.id,
                left: 4,
                pool: null,
                deviceId: null,
                consecutive: null,
                froze: false,
            });
            expect(
                await twoStep.passStep({
                    ...binding,
                    proof: { method: 'backup', codeHash: set[0]!.codeHash },
                }),
            ).toEqual({ status: 'missing' });
        }
        expect((await stateOf(user.id))?.consecutiveFailures).toBe(0);
        expect(await deviceFailures(asking.deviceId)).toBe(0);
        expect(await deviceFailures(theirs.deviceId)).toBe(0);
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
    });

    test('the fifth wrong answer and a right one racing on one token: exactly one of them lands', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        let lastStep = STEP;
        let inARow = 0;
        for (let round = 0; round < 6; round++) {
            const binding = await stepToken(user.id);
            for (let wrong = 0; wrong < 4; wrong++)
                await twoStep.failStep({ ...binding, method: 'totp' });
            inARow += 4;
            const step = STEP + round + 1;
            const fail = () => twoStep.failStep({ ...binding, method: 'totp' });
            const pass = () =>
                twoStep.passStep({ ...binding, proof: { method: 'totp', factorId, step } });
            // Started in either order, so each gets to go first.
            const [failed, passed] =
                round % 2 === 0
                    ? await Promise.all([fail(), pass()])
                    : ((await Promise.all([pass(), fail()])).reverse() as [
                          twoStep.StepFailure,
                          twoStep.StepPass,
                      ]);
            if (passed.status === 'ok') {
                expect(failed).toEqual({ status: 'missing' });
                lastStep = step;
                inARow = 0;
            } else {
                expect(passed).toEqual({ status: 'missing' });
                inARow += 1;
                expect(failed).toMatchObject({ status: 'counted', left: 0, consecutive: inARow });
            }
            // Whoever won, the token is spent, and the step and the count say the same thing.
            expect(await twoStep.getStepAttempt(binding)).toBeNull();
            expect((await factorRow(factorId))?.totpLastStep).toBe(lastStep);
            expect((await stateOf(user.id))?.consecutiveFailures).toBe(inARow);
        }
    });

    test('a newly confirmed app starts unfrozen', async () => {
        const { user } = await frozenAccount();
        const replacement = await enrolTotp(user.id, { step: STEP + 50 });
        expect(await stateOf(user.id)).toMatchObject({
            totpFrozenAt: null,
            consecutiveFailures: 0,
        });
        const binding = await stepToken(user.id);
        expect(
            await twoStep.passStep({
                ...binding,
                proof: { method: 'totp', factorId: replacement.factorId, step: STEP + 51 },
            }),
        ).toMatchObject({ status: 'ok' });
    });
});

describe('what the rows outlive', () => {
    test('the sweep drops expired tokens, enrolments past ten minutes and log lines past 90 days, and nothing younger', async () => {
        const user = await account();
        const laptop = await session(user.id);
        const confirmed = await enrolTotp(user.id);
        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - DAY) })
            .where(eq(twoStepFactors.id, confirmed.factorId));

        const other = await account();
        const stale = await pendingTotp(other.id);
        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - 10 * MINUTE - 5_000) })
            .where(eq(twoStepFactors.id, stale));
        const third = await account();
        const young = await pendingTotp(third.id);
        await db
            .update(twoStepFactors)
            .set({ createdAt: new Date(Date.now() - 9 * MINUTE) })
            .where(eq(twoStepFactors.id, young));

        const liveToken = await stepToken(user.id);
        const deadToken = await stepToken(user.id);
        await db
            .update(twoStepAttempts)
            .set({
                createdAt: new Date(Date.now() - HOUR),
                expiresAt: new Date(Date.now() - 1_000),
            })
            .where(eq(twoStepAttempts.tokenHash, deadToken.tokenHash));

        const event = (daysAgo: number) => ({
            userId: user.id,
            kind: 'sign-in',
            method: 'totp' as const,
            deviceId: laptop.deviceId,
            deviceKind: 'web' as const,
            createdAt: new Date(Date.now() - daysAgo * DAY),
        });
        await db.insert(accountSecurityEvents).values([event(91), event(89)]);

        const removed = await auth.cleanupExpired();
        expect(removed).toMatchObject({ twoStepAttempts: 1, pendingFactors: 1, securityEvents: 1 });
        expect(await factorRow(confirmed.factorId)).toBeDefined();
        expect(await factorRow(stale)).toBeUndefined();
        expect(await factorRow(young)).toBeDefined();
        expect(await twoStep.getStepAttempt(liveToken)).not.toBeNull();
        expect(
            await db
                .select()
                .from(twoStepAttempts)
                .where(eq(twoStepAttempts.tokenHash, deadToken.tokenHash)),
        ).toEqual([]);
        const kept = await db.select().from(accountSecurityEvents);
        expect(kept).toHaveLength(1);
        expect(Date.now() - kept[0]!.createdAt.getTime()).toBeLessThan(90 * DAY);
    });

    test('a device that is deleted takes its sign-in tokens with it, and leaves its log lines without it', async () => {
        const user = await account();
        const laptop = await session(user.id);
        await enrolTotp(user.id);
        const binding = await stepToken(user.id, { deviceId: laptop.deviceId });
        await db.insert(accountSecurityEvents).values({
            userId: user.id,
            kind: 'sign-in',
            deviceId: laptop.deviceId,
            deviceKind: 'web',
        });
        await db.delete(accountDevices).where(eq(accountDevices.id, laptop.deviceId));
        expect(await twoStep.getStepAttempt(binding)).toBeNull();
        expect(await db.select().from(accountSecurityEvents)).toMatchObject([
            { deviceId: null, deviceKind: 'web' },
        ]);
    });

    test('an account with the step on can still be deleted, and leaves none of it behind', async () => {
        const user = await account();
        const keeper = await account();
        const laptop = await session(user.id);
        await enrolTotp(user.id, { sessionTokenHash: laptop.tokenHash });
        await enrolKey(user.id, 'key');
        await enrolTotp(keeper.id, { label: 'keeper' });
        await stepToken(user.id, { deviceId: laptop.deviceId });
        await db.insert(accountSecurityEvents).values({ userId: user.id, kind: 'two-step-on' });

        await deleteTestAccount(user.id);
        for (const table of [twoStepFactors, twoStepBackupCodes, twoStepState, twoStepAttempts])
            expect(await db.select().from(table).where(eq(table.userId, user.id))).toEqual([]);
        expect(await db.select().from(accountSecurityEvents)).toEqual([]);
        // The other account's step is untouched.
        expect((await twoStep.getTwoStep(keeper.id)).backupCodes).toHaveLength(10);
    });

    test('a bound password proof can be tagged two-step, and only with a session', async () => {
        const user = await account();
        const here = await session(user.id);
        const attempt = (sessionTokenHash: Buffer | null) =>
            auth.createLoginAttempt({
                purpose: 'two-step',
                sessionTokenHash,
                tokenHash: token('opaque'),
                userId: user.id,
                credentialVersion: 1,
                profileVersion: 1,
                serverState: 'state',
                expiresAt: new Date(Date.now() + MINUTE),
            });
        expect(await refusal(attempt(here.tokenHash))).toBeNull();
        expect(await refusal(attempt(null))).toMatchObject({
            constraint: 'opaque_login_attempts_purpose_binding',
        });
    });
});

/*
 * passStep and what it authorises in one transaction of the caller's: the real
 * createSession, changeAccountSecurity and deleteAccount, each run inside it.
 * When they refuse and the caller rolls back, nothing of the step is spent.
 */
describe('in one transaction with what the step authorises', () => {
    class Abort extends Error {}

    test('a sign-in commits its step and its session together', async () => {
        const user = await account();
        const { factorId } = await enrolTotp(user.id);
        const binding = await stepToken(user.id);
        const sessionToken = token('session');
        const at = await db.transaction(async (tx) => {
            const passed = await twoStep.passStep(
                { ...binding, proof: { method: 'totp', factorId, step: STEP + 1 } },
                tx,
            );
            if (passed.status !== 'ok') throw new Error(`The step ${passed.status}.`);
            const opened = await auth.createSession(
                {
                    userId: passed.attempt.userId,
                    credentialVersion: passed.attempt.credentialVersion,
                    tokenHash: sessionToken,
                    previousTokenHash: passed.attempt.previousTokenHash,
                    expiresAt: new Date(Date.now() + HOUR),
                    twoStepAt: passed.at,
                },
                tx,
            );
            expect(opened).toMatchObject({ user: { id: user.id } });
            return passed.at;
        });
        expect((await sessionRow(sessionToken))?.twoStepAt).toEqual(at);
        expect(await twoStep.getStepAttempt(binding)).toBeNull();
        expect((await factorRow(factorId))?.totpLastStep).toBe(STEP + 1);
    });

    test('a session that cannot be made gives back the token, the backup code, the count and the freeze', async () => {
        const { user, app } = await frozenAccount();
        const binding = await stepToken(user.id);
        // Suspended between the password and the step.
        await auth.setUserSuspended(user.id, true);
        await expect(
            db.transaction(async (tx) => {
                const passed = await twoStep.passStep(
                    { ...binding, proof: { method: 'backup', codeHash: app.codes[0]!.codeHash } },
                    tx,
                );
                // Inside the transaction the step is spent and the app thawed.
                expect(passed).toMatchObject({ status: 'ok', backupCodesLeft: 9, unfroze: true });
                if (passed.status !== 'ok') return;
                const opened = await auth.createSession(
                    {
                        userId: user.id,
                        credentialVersion: 1,
                        tokenHash: token('session'),
                        previousTokenHash: null,
                        expiresAt: new Date(Date.now() + HOUR),
                        twoStepAt: passed.at,
                    },
                    tx,
                );
                expect(opened).toEqual({ suspended: true });
                throw new Abort();
            }),
        ).rejects.toBeInstanceOf(Abort);

        expect(await db.select().from(sessions)).toEqual([]);
        expect((await twoStep.getStepAttempt(binding))?.failures).toBe(0);
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
        const state = await stateOf(user.id);
        expect(state?.totpFrozenAt).toBeInstanceOf(Date);
        expect(state?.consecutiveFailures).toBe(100);
    });

    test('a change that is refused gives back the token, the time step and the device’s count; one that goes through spends them', async () => {
        const user = await account();
        const asking = await session(user.id);
        const { factorId } = await enrolTotp(user.id, { sessionTokenHash: asking.tokenHash });
        await db
            .update(accountDevices)
            .set({ twoStepFailures: 3 })
            .where(eq(accountDevices.id, asking.deviceId));
        const binding = await stepToken(user.id, {
            purpose: 'password',
            sessionTokenHash: asking.tokenHash,
        });
        const change = (keyVersion: number) =>
            db.transaction(async (tx) => {
                const passed = await twoStep.passStep(
                    { ...binding, proof: { method: 'totp', factorId, step: STEP + 1 } },
                    tx,
                );
                expect(passed.status).toBe('ok');
                const changed = await changePassword(user.id, asking.tokenHash, {
                    keyVersion,
                    executor: tx,
                });
                if (!changed) throw new Abort();
            });

        // The envelope names a key version the account is not at: the change is refused.
        await expect(change(2)).rejects.toBeInstanceOf(Abort);
        expect((await twoStep.getStepAttempt(binding))?.failures).toBe(0);
        expect((await factorRow(factorId))?.totpLastStep).toBe(STEP);
        expect(await deviceFailures(asking.deviceId)).toBe(3);
        const [before] = await db
            .select({ version: opaqueCredentials.version })
            .from(opaqueCredentials)
            .where(eq(opaqueCredentials.userId, user.id));
        expect(before?.version).toBe(1);

        await change(1);
        const [after] = await db
            .select({ version: opaqueCredentials.version })
            .from(opaqueCredentials)
            .where(eq(opaqueCredentials.userId, user.id));
        expect(after?.version).toBe(2);
        expect((await factorRow(factorId))?.totpLastStep).toBe(STEP + 1);
        expect(await deviceFailures(asking.deviceId)).toBe(0);
        expect(await db.select().from(twoStepAttempts)).toEqual([]);
    });

    test('a deletion that is refused gives the step back; one that goes through takes the account', async () => {
        const user = await account();
        const asking = await session(user.id);
        const { codes: set } = await enrolTotp(user.id, { sessionTokenHash: asking.tokenHash });
        const binding = await stepToken(user.id, {
            purpose: 'delete',
            sessionTokenHash: asking.tokenHash,
        });
        const remove = (credentialVersion: number) =>
            db.transaction(async (tx) => {
                const passed = await twoStep.passStep(
                    { ...binding, proof: { method: 'backup', codeHash: set[0]!.codeHash } },
                    tx,
                );
                expect(passed.status).toBe('ok');
                const deleted = await auth.deleteAccount(
                    { userId: user.id, credentialVersion, sessionTokenHash: asking.tokenHash },
                    tx,
                );
                if (deleted !== true) throw new Abort();
            });

        await expect(remove(2)).rejects.toBeInstanceOf(Abort);
        expect(await twoStep.getStepAttempt(binding)).not.toBeNull();
        expect((await twoStep.getTwoStep(user.id)).backupCodes).toHaveLength(10);
        expect(await auth.getUserById(user.id)).not.toBeNull();

        await remove(1);
        expect(await auth.getUserById(user.id)).toBeNull();
        expect(await db.select().from(twoStepFactors)).toEqual([]);
    });
});
