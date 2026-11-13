import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { registered, sha256 } from '../test/accounts';
import { closeDatabase, resetDatabase } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import {
    sessions,
    twoStepBackupCodes,
    twoStepFactors,
    twoStepKeyRegistrations,
    twoStepState,
} from './schema';
import * as twoStep from './two-step';

/*
 * Passkeys and security keys as a second step, and the default method, the rows
 * (docs/two-step-design.md 3, 12). The repository verifies no signature: the server hands it a
 * key it has verified and the counter an assertion carried. What must hold here whatever the
 * server does: a registration adds one key, for the session and account it was made for, and
 * never after the step was turned on without it; an account has at most ten keys and never the
 * same one twice; a counter only goes up; the first method turned on is the default, a later
 * one never moves it, and it goes with the last method of its kind.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const fixed = (label: string, length: number) =>
    createHash('sha512').update(`hushos-keys-test:${label}`).digest().subarray(0, length);
const codeSet = (label: string) => ({
    keyId: fixed(`${label}:key`, 8),
    hashes: Array.from({ length: 10 }, (_, index) => fixed(`${label}:code:${index}`, 32)),
});
const credential = (label: string, signCount = 0, synced = false) => ({
    credentialId: fixed(`${label}:credential`, 32),
    publicKey: fixed(`${label}:public`, 77),
    signCount,
    transports: ['usb'],
    backupEligible: synced,
    backupState: synced,
});
const PHRASE = { method: 'phrase' } as const;

type Session = { token: Buffer; deviceId: string };

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

/* A sign-in's step token with a slot taken, answered with `spend`. */
async function signIn(userId: string, spend: twoStep.StepSpend = PHRASE) {
    const tokenHash = sha256(randomUUID());
    await twoStep.createStepAttempt({
        purpose: 'login',
        tokenHash,
        userId,
        credentialVersion: 1,
        device: null,
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    const taken = await twoStep.takeStepAnswer({
        tokenHash,
        method: spend.method,
        purpose: 'login',
        sessionTokenHash: null,
    });
    if (taken.status !== 'ok') throw new Error(`No slot: ${taken.status}.`);
    const session = { tokenHash: sha256(randomUUID()), expiresAt: new Date(Date.now() + HOUR) };
    return { session, result: await twoStep.openSteppedSession({ tokenHash, spend, session }) };
}

async function steppedSession(userId: string): Promise<Session> {
    const { session, result } = await signIn(userId);
    if (result.status !== 'ok') throw new Error(`Step ${result.status}.`);
    return { token: session.tokenHash, deviceId: result.device.id };
}

/* A step-up from `session` for a change to the step: its token with a slot taken. */
async function stepUp(userId: string, session: Session): Promise<twoStep.SessionStep> {
    const tokenHash = sha256(randomUUID());
    await twoStep.createStepAttempt({
        purpose: 'two-step',
        tokenHash,
        userId,
        credentialVersion: 1,
        sessionTokenHash: session.token,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    const taken = await twoStep.takeStepAnswer({
        tokenHash,
        method: 'phrase',
        purpose: 'two-step',
        sessionTokenHash: session.token,
    });
    if (taken.status !== 'ok') throw new Error(`No slot: ${taken.status}.`);
    return { sessionTokenHash: session.token, tokenHash, spend: PHRASE };
}

/* Starts adding a key from `session`: what `two-step/keys/options` stores. */
async function register(
    userId: string,
    session: Session,
    options: { step?: twoStep.SessionStep; expiresAt?: Date } = {},
) {
    const tokenHash = sha256(randomUUID());
    const started = await twoStep.startKeyRegistration({
        tokenHash,
        userId,
        sessionTokenHash: session.token,
        credentialVersion: 1,
        challenge: fixed(`${tokenHash.toString('hex')}:challenge`, 32),
        expiresAt: options.expiresAt ?? new Date(Date.now() + 5 * MINUTE),
        step: options.step,
    });
    return { tokenHash, started };
}

const add = (
    userId: string,
    session: Session,
    registrationTokenHash: Buffer,
    label: string,
    extra: Partial<Parameters<typeof twoStep.addWebauthnFactor>[0]> = {},
) =>
    twoStep.addWebauthnFactor({
        userId,
        sessionTokenHash: session.token,
        credentialVersion: 1,
        registrationTokenHash,
        name: 'Security key',
        ...credential(label),
        ...extra,
    });

/* An account whose step was turned on with a key: the key's id, and the session that added it. */
async function withKey(label: string, signCount = 0) {
    const { user } = await registered();
    const session = await passwordSignIn(user.id);
    const { tokenHash } = await register(user.id, session);
    const added = await add(user.id, session, tokenHash, label, {
        signCount,
        backupCodes: codeSet(label),
    });
    if (added.status !== 'ok') throw new Error(`Key ${added.status}.`);
    return { userId: user.id, session, factorId: added.method.id };
}

/* An account whose step was turned on with an authenticator app. */
async function withApp(label: string) {
    const { user } = await registered();
    const session = await passwordSignIn(user.id);
    const id = randomUUID();
    await twoStep.startTotpFactor({
        id,
        userId: user.id,
        keyId: fixed(`${label}:key`, 8),
        nonce: fixed(`${label}:nonce`, 24),
        sealedSecret: fixed(`${label}:secret`, 36),
    });
    const confirmed = await twoStep.confirmTotpFactor({
        userId: user.id,
        factorId: id,
        step: 1_000,
        sessionTokenHash: session.token,
        credentialVersion: 1,
        backupCodes: codeSet(label),
    });
    if (confirmed.status !== 'ok') throw new Error(`App ${confirmed.status}.`);
    return { userId: user.id, session, factorId: id };
}

const stateOf = async (userId: string) =>
    (await db.select().from(twoStepState).where(eq(twoStepState.userId, userId)))[0];
const factorOf = async (id: string) =>
    (await db.select().from(twoStepFactors).where(eq(twoStepFactors.id, id)))[0];
const keysOf = async (userId: string) =>
    (await twoStep.getTwoStep(userId)).methods.filter((method) => method.kind === 'webauthn');
const registrationsOf = async (userId: string) =>
    (
        await db
            .select()
            .from(twoStepKeyRegistrations)
            .where(eq(twoStepKeyRegistrations.userId, userId))
    ).length;

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('the order methods are offered in', () => {
    test('the default comes first, then passkey, app, device, and only kinds the account has', () => {
        expect(twoStep.kindOrder(['totp', 'webauthn'], null)).toEqual(['webauthn', 'totp']);
        expect(twoStep.kindOrder(['totp', 'webauthn'], 'totp')).toEqual(['totp', 'webauthn']);
        expect(twoStep.kindOrder(['webauthn', 'totp', 'device'], 'device')).toEqual([
            'device',
            'webauthn',
            'totp',
        ]);
        // A default whose kind has no confirmed method is not offered at all.
        expect(twoStep.kindOrder(['totp'], 'webauthn')).toEqual(['totp']);
        expect(twoStep.kindOrder([], 'totp')).toEqual([]);
    });
});

describe('adding a key', () => {
    test('the first key turns the step on: codes stored, session stamped, key listed, and it is the default', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        const { tokenHash, started } = await register(user.id, session);
        expect(started).toEqual({ status: 'ok' });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);

        // Without the codes the step is not turned on, and the registration is still good.
        expect(await add(user.id, session, tokenHash, 'yubi')).toEqual({
            status: 'codes-required',
        });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);

        const added = await add(user.id, session, tokenHash, 'yubi', {
            name: 'Desk key',
            backupCodes: codeSet('yubi'),
        });
        expect(added).toMatchObject({
            status: 'ok',
            turnedOn: true,
            method: { kind: 'webauthn', name: 'Desk key', synced: false, lastUsedAt: null },
        });
        const status = await twoStep.getTwoStep(user.id);
        expect(status).toMatchObject({ on: true, backupCodesLeft: 10, defaultKind: 'webauthn' });
        expect((await stateOf(user.id))?.defaultKind).toBe('webauthn');
        const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, session.token));
        expect(row?.twoStepAt).toBeInstanceOf(Date);
        // The server reads back exactly what it verified.
        expect(await twoStep.listWebauthnCredentials(user.id)).toEqual([
            {
                id: added.status === 'ok' ? added.method.id : '',
                credentialId: credential('yubi').credentialId,
                publicKey: credential('yubi').publicKey,
                signCount: 0,
                transports: ['usb'],
            },
        ]);
    });

    test('a registration adds one key: used again, or by two requests at once, it adds no second', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        const { tokenHash } = await register(user.id, session);
        const results = await Promise.all([
            add(user.id, session, tokenHash, 'one', { backupCodes: codeSet('a') }),
            add(user.id, session, tokenHash, 'two', { backupCodes: codeSet('b') }),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual(['missing', 'ok']);
        expect(await keysOf(user.id)).toHaveLength(1);
        expect(await add(user.id, session, tokenHash, 'three')).toEqual({ status: 'missing' });
        expect(await keysOf(user.id)).toHaveLength(1);
    });

    test('a registration is good only for the session and the account it was made for, and for five minutes', async () => {
        const maya = await registered();
        const sam = await registered();
        const mayas = await passwordSignIn(maya.user.id);
        const other = await passwordSignIn(maya.user.id);
        const sams = await passwordSignIn(sam.user.id);
        const { tokenHash } = await register(maya.user.id, mayas);

        // Another of the account's own sessions, and another account, get nothing from it.
        expect(
            await add(maya.user.id, other, tokenHash, 'k', { backupCodes: codeSet('k') }),
        ).toEqual({ status: 'missing' });
        expect(await add(sam.user.id, sams, tokenHash, 'k', { backupCodes: codeSet('k') })).toEqual(
            { status: 'missing' },
        );
        expect(
            await twoStep.getKeyRegistration({
                tokenHash,
                userId: sam.user.id,
                sessionTokenHash: sams.token,
            }),
        ).toBeNull();
        expect(await twoStep.hasTwoStep(sam.user.id)).toBe(false);

        // Past its five minutes it is gone, though the row is still there.
        await db
            .update(twoStepKeyRegistrations)
            .set({
                createdAt: new Date(Date.now() - 10 * MINUTE),
                expiresAt: new Date(Date.now() - MINUTE),
            })
            .where(eq(twoStepKeyRegistrations.tokenHash, tokenHash));
        expect(
            await add(maya.user.id, mayas, tokenHash, 'k', { backupCodes: codeSet('k') }),
        ).toEqual({ status: 'missing' });
        expect(await twoStep.hasTwoStep(maya.user.id)).toBe(false);
        expect((await auth.cleanupExpired()).keyRegistrations).toBe(1);
    });

    test('with the step on, starting needs the step, and a step for another purpose does not pass', async () => {
        const { userId } = await withApp('app');
        const session = await steppedSession(userId);

        expect((await register(userId, session)).started).toEqual({
            status: 'two-step',
            reason: 'required',
        });
        expect(await registrationsOf(userId)).toBe(0);

        // A token for a password change does not add a key.
        const passwordToken = sha256(randomUUID());
        await twoStep.createStepAttempt({
            purpose: 'password',
            tokenHash: passwordToken,
            userId,
            credentialVersion: 1,
            sessionTokenHash: session.token,
            expiresAt: new Date(Date.now() + 5 * MINUTE),
        });
        await twoStep.takeStepAnswer({
            tokenHash: passwordToken,
            method: 'phrase',
            purpose: 'password',
            sessionTokenHash: session.token,
        });
        expect(
            (
                await register(userId, session, {
                    step: {
                        sessionTokenHash: session.token,
                        tokenHash: passwordToken,
                        spend: PHRASE,
                    },
                })
            ).started,
        ).toEqual({ status: 'two-step', reason: 'gone' });
        expect(await registrationsOf(userId)).toBe(0);

        const { tokenHash, started } = await register(userId, session, {
            step: await stepUp(userId, session),
        });
        expect(started).toEqual({ status: 'ok' });
        const added = await add(userId, session, tokenHash, 'key');
        expect(added).toMatchObject({ status: 'ok', turnedOn: false });
    });

    test('a registration started while the step was off adds nothing once the step is on', async () => {
        const { user } = await registered();
        const session = await passwordSignIn(user.id);
        const { tokenHash } = await register(user.id, session);

        // Meanwhile the step is turned on with an app, in another tab.
        const id = randomUUID();
        await twoStep.startTotpFactor({
            id,
            userId: user.id,
            keyId: fixed('k', 8),
            nonce: fixed('n', 24),
            sealedSecret: fixed('s', 36),
        });
        const confirmed = await twoStep.confirmTotpFactor({
            userId: user.id,
            factorId: id,
            step: 1_000,
            sessionTokenHash: session.token,
            credentialVersion: 1,
            backupCodes: codeSet('app'),
        });
        expect(confirmed).toMatchObject({ status: 'ok', turnedOn: true });

        // The key would now be a second method nobody passed the step for.
        expect(await add(user.id, session, tokenHash, 'late')).toEqual({ status: 'missing' });
        expect(await keysOf(user.id)).toEqual([]);
    });

    test('the same credential is not added twice, and the eleventh key is refused', async () => {
        const { userId, session } = await withKey('first');
        const again = await register(userId, session, { step: await stepUp(userId, session) });
        expect(await add(userId, session, again.tokenHash, 'first')).toEqual({ status: 'exists' });
        expect(await keysOf(userId)).toHaveLength(1);

        for (let index = 2; index <= twoStep.WEBAUTHN_KEY_LIMIT; index++) {
            const { tokenHash } = await register(userId, session, {
                step: await stepUp(userId, session),
            });
            expect((await add(userId, session, tokenHash, `key-${index}`)).status).toBe('ok');
        }
        expect(await keysOf(userId)).toHaveLength(10);
        // The eleventh is refused before a step is spent on it.
        const step = await stepUp(userId, session);
        expect((await register(userId, session, { step })).started).toEqual({ status: 'limit' });
        expect(await twoStep.getStepAttempt(step.tokenHash)).not.toBeNull();
        expect(await keysOf(userId)).toHaveLength(10);
    });

    test('another account may hold the same credential id: the index is per account', async () => {
        const maya = await withKey('shared');
        const sam = await withKey('shared');
        expect(await keysOf(maya.userId)).toHaveLength(1);
        expect(await keysOf(sam.userId)).toHaveLength(1);
    });
});

describe('a key answering the step', () => {
    const spend = (factorId: string, signCount: number, backedUp = false) =>
        ({ method: 'webauthn', factorId, signCount, backedUp }) as const;

    test('a counter that goes up passes, and is stored with the hour the key was used', async () => {
        const { userId, factorId } = await withKey('k', 5);
        const { result } = await signIn(userId, spend(factorId, 6));
        expect(result).toMatchObject({ status: 'ok', method: 'webauthn' });
        const row = await factorOf(factorId);
        expect(row?.signCount).toBe(6);
        expect(row?.lastUsedAt?.getTime()).toBe(Math.floor(Date.now() / HOUR) * HOUR);
    });

    test('5 then 5, and 5 then 0, are refused, counted as a wrong answer, and open no session', async () => {
        const { userId, factorId } = await withKey('k', 5);
        for (const next of [5, 0]) {
            const { session, result } = await signIn(userId, spend(factorId, next));
            expect(result).toMatchObject({
                status: 'spent',
                failure: { status: 'counted', pool: 'account' },
            });
            expect(
                await db.select().from(sessions).where(eq(sessions.tokenHash, session.tokenHash)),
            ).toEqual([]);
        }
        expect((await factorOf(factorId))?.signCount).toBe(5);
        expect((await stateOf(userId))?.consecutiveFailures).toBe(2);
    });

    test('a stored 0 and a new 0 pass, as a synced passkey answers every time', async () => {
        const { userId, factorId } = await withKey('k', 0);
        expect((await signIn(userId, spend(factorId, 0))).result.status).toBe('ok');
        expect((await signIn(userId, spend(factorId, 0, true))).result.status).toBe('ok');
        // The key says it is backed up now: the list shows it as saved in a password manager.
        expect((await keysOf(userId))[0]?.synced).toBe(true);
    });

    test('two assertions with the same counter racing on two tokens give one session', async () => {
        const { userId, factorId } = await withKey('k', 5);
        const results = await Promise.all([
            signIn(userId, spend(factorId, 9)),
            signIn(userId, spend(factorId, 9)),
        ]);
        expect(results.map(({ result }) => result.status).sort()).toEqual(['ok', 'spent']);
        expect((await factorOf(factorId))?.signCount).toBe(9);
    });

    test('another account’s key, and a removed key, do not pass', async () => {
        const maya = await withKey('maya', 1);
        const sam = await withKey('sam', 1);
        // Sam's key named on Maya's sign-in: it is not a key of Maya's account.
        expect((await signIn(maya.userId, spend(sam.factorId, 2))).result.status).toBe('spent');
        expect((await factorOf(sam.factorId))?.signCount).toBe(1);

        // A second key, then the first removed: its assertion no longer passes.
        const second = await register(maya.userId, maya.session, {
            step: await stepUp(maya.userId, maya.session),
        });
        expect((await add(maya.userId, maya.session, second.tokenHash, 'spare')).status).toBe('ok');
        const removed = await twoStep.removeFactor({
            userId: maya.userId,
            factorId: maya.factorId,
            step: await stepUp(maya.userId, maya.session),
        });
        expect(removed).toMatchObject({ status: 'ok', turnedOff: false });
        expect((await signIn(maya.userId, spend(maya.factorId, 2))).result.status).toBe('spent');
    });

    test('a key lifts the app’s freeze, as any method but the app does', async () => {
        const { userId, session } = await withApp('app');
        const stepped = await steppedSession(userId);
        const { tokenHash } = await register(userId, stepped, {
            step: await stepUp(userId, stepped),
        });
        const added = await add(userId, stepped, tokenHash, 'key');
        if (added.status !== 'ok') throw new Error('No key.');
        await db
            .update(twoStepState)
            .set({ totpFrozenAt: new Date(), consecutiveFailures: 100 })
            .where(eq(twoStepState.userId, userId));
        expect((await signIn(userId, spend(added.method.id, 1))).result.status).toBe('ok');
        expect(await stateOf(userId)).toMatchObject({ totpFrozenAt: null, consecutiveFailures: 0 });
        expect(session.token).toBeInstanceOf(Buffer);
    });
});

describe('the default', () => {
    test('a second kind never moves the usual way, even for an account that never chose one', async () => {
        const { userId } = await withApp('app');
        expect((await twoStep.getTwoStep(userId)).defaultKind).toBe('totp');
        // An account from before there was a default: nothing is stored.
        await db
            .update(twoStepState)
            .set({ defaultKind: null })
            .where(eq(twoStepState.userId, userId));
        const session = await steppedSession(userId);
        const { tokenHash } = await register(userId, session, {
            step: await stepUp(userId, session),
        });
        expect((await add(userId, session, tokenHash, 'key')).status).toBe('ok');
        // Without this the order alone (passkey before app) would have moved it.
        expect((await stateOf(userId))?.defaultKind).toBe('totp');
        expect((await twoStep.getTwoStep(userId)).defaultKind).toBe('totp');
    });

    test('only a session that passed the step may change it, and only to a kind the account has', async () => {
        const { userId, session } = await withApp('app');
        const stepped = await steppedSession(userId);
        const { tokenHash } = await register(userId, stepped, {
            step: await stepUp(userId, stepped),
        });
        await add(userId, stepped, tokenHash, 'key');
        const other = await registered();
        const others = await passwordSignIn(other.user.id);

        // A session from before the step was on never passed it.
        const old = sha256(randomUUID());
        await db
            .update(sessions)
            .set({ twoStepAt: null })
            .where(eq(sessions.tokenHash, session.token));
        const set = (token: Buffer, kind: 'webauthn' | 'totp' | 'device', user = userId) =>
            twoStep.setDefaultKind({
                userId: user,
                kind,
                sessionTokenHash: token,
                credentialVersion: 1,
            });
        expect(await set(session.token, 'webauthn')).toEqual({ status: 'step' });
        expect(await set(old, 'webauthn')).toEqual({ status: 'session' });
        // Another account's session changes nothing here, and its own account has no key.
        expect(await set(others.token, 'webauthn')).toEqual({ status: 'session' });
        expect(await set(others.token, 'webauthn', other.user.id)).toEqual({ status: 'step' });
        expect((await twoStep.getTwoStep(userId)).defaultKind).toBe('totp');

        expect(await set(stepped.token, 'device')).toEqual({ status: 'missing' });
        expect(await set(stepped.token, 'webauthn')).toEqual({ status: 'ok', changed: true });
        expect(await set(stepped.token, 'webauthn')).toEqual({ status: 'ok', changed: false });
        expect((await twoStep.getTwoStep(userId)).defaultKind).toBe('webauthn');
    });

    test('it goes with the last method of its kind, and does not come back when that kind is added again', async () => {
        const { userId, factorId } = await withKey('first');
        const session = await steppedSession(userId);
        const second = await register(userId, session, { step: await stepUp(userId, session) });
        const spare = await add(userId, session, second.tokenHash, 'spare');
        if (spare.status !== 'ok') throw new Error('No spare.');
        // An app too, so the step stays on when the keys go.
        const appId = randomUUID();
        await twoStep.startTotpFactor({
            id: appId,
            userId,
            keyId: fixed('k', 8),
            nonce: fixed('n', 24),
            sealedSecret: fixed('s', 36),
            step: await stepUp(userId, session),
        });
        await twoStep.confirmTotpFactor({
            userId,
            factorId: appId,
            step: 1_000,
            sessionTokenHash: session.token,
            credentialVersion: 1,
        });
        expect((await twoStep.getTwoStep(userId)).defaultKind).toBe('webauthn');

        // One key of two removed: the default's kind still has a method, so it stays.
        const one = await twoStep.removeFactor({
            userId,
            factorId,
            step: await stepUp(userId, session),
        });
        expect(one).toEqual({ status: 'ok', kind: 'webauthn', turnedOff: false });
        expect((await stateOf(userId))?.defaultKind).toBe('webauthn');

        // The last key removed: the default is cleared, and the app is what comes first.
        const last = await twoStep.removeFactor({
            userId,
            factorId: spare.method.id,
            step: await stepUp(userId, session),
        });
        expect(last).toEqual({
            status: 'ok',
            kind: 'webauthn',
            turnedOff: false,
            defaultKind: 'totp',
        });
        expect((await stateOf(userId))?.defaultKind).toBeNull();
        expect((await twoStep.getTwoStep(userId)).defaultKind).toBe('totp');

        // A key added again later is a second kind beside the app: the app stays the default.
        const third = await register(userId, session, { step: await stepUp(userId, session) });
        expect((await add(userId, session, third.tokenHash, 'third')).status).toBe('ok');
        expect((await twoStep.getTwoStep(userId)).defaultKind).toBe('totp');
    });

    test('removing the last method turns the step off and takes the default, the codes and any registration with it', async () => {
        const { userId, session, factorId } = await withKey('only');
        const pending = await register(userId, session, { step: await stepUp(userId, session) });
        expect(pending.started).toEqual({ status: 'ok' });
        const removed = await twoStep.removeFactor({
            userId,
            factorId,
            step: await stepUp(userId, session),
        });
        expect(removed).toEqual({ status: 'ok', kind: 'webauthn', turnedOff: true });
        expect(await twoStep.getTwoStep(userId)).toMatchObject({
            on: false,
            defaultKind: null,
            backupCodesLeft: 0,
        });
        expect((await stateOf(userId))?.defaultKind).toBeNull();
        expect(
            await db.select().from(twoStepBackupCodes).where(eq(twoStepBackupCodes.userId, userId)),
        ).toEqual([]);
        expect(await registrationsOf(userId)).toBe(0);
    });
});

describe('names', () => {
    test('a key is renamed by its own account only, and an app has no name to change', async () => {
        const maya = await withKey('maya');
        const sam = await withApp('sam');
        expect(
            await twoStep.renameFactor({
                userId: sam.userId,
                factorId: maya.factorId,
                name: 'Mine now',
            }),
        ).toBeNull();
        expect(
            await twoStep.renameFactor({
                userId: sam.userId,
                factorId: sam.factorId,
                name: 'App',
            }),
        ).toBeNull();
        expect((await factorOf(sam.factorId))?.name).toBeNull();
        expect(
            await twoStep.renameFactor({
                userId: maya.userId,
                factorId: maya.factorId,
                name: 'Blue key',
            }),
        ).toMatchObject({ id: maya.factorId, name: 'Blue key', kind: 'webauthn' });
        expect((await keysOf(maya.userId))[0]?.name).toBe('Blue key');
    });
});
