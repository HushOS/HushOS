import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { bytes, registered, sha256 } from '../test/accounts';
import { closeDatabase, lockObserver, resetDatabase, signingKeyFromSeed } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import { accountDevices, sessions, twoStepFactors } from './schema';
import { deviceSessionStatement } from './signatures';
import * as twoStep from './two-step';

/*
 * Who gets a session (docs/two-step-design.md 4, 10, decision 9). An account with a confirmed
 * factor gets one only by passing the step, or by the 30-day exemption for a device that
 * keeps its session. `createSession` decides that under the account's lock and answers a
 * typed refusal; the trigger on `sessions` stands behind it and refuses the row whatever the
 * code above it does, so a release that does not know the step cannot sign such an account
 * in. These tests pin what is refused and, as much, what must be left alone: accounts
 * without a factor, sessions that were open before the step was turned on, and every path
 * that ends sessions.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;
const LIFETIME = { idleSeconds: 7 * 24 * 3600, maxSeconds: 30 * 24 * 3600 };
const REFUSED = { cause: { code: '23514', constraint: 'sessions_two_step_guard' } };
const ASKED = { twoStep: true };
const PHRASE = { method: 'phrase' } as const;

const fixed = (label: string, length: number) =>
    createHash('sha512').update(`hushos-two-step-guard:${label}`).digest().subarray(0, length);

type Signer = ReturnType<typeof signingKeyFromSeed>;
type Proof = { deviceId: string; signer: Signer };

function proofOf(userId: string, proof: Proof) {
    const attemptDigest = sha256(randomUUID());
    return {
        id: proof.deviceId,
        attemptDigest,
        signature: proof.signer.sign(
            deviceSessionStatement({ userId, deviceId: proof.deviceId, attemptDigest }),
        ),
    };
}

/* A sign-in with the password alone, as `login/finish` makes it: whatever the repository answers. */
function password(
    userId: string,
    options: { previous?: Buffer | null; proof?: Proof; credentialVersion?: number } = {},
) {
    const token = sha256(randomUUID());
    return {
        token,
        answered: auth.createSession({
            userId,
            credentialVersion: options.credentialVersion ?? 1,
            tokenHash: token,
            previousTokenHash: options.previous ?? null,
            expiresAt: new Date(Date.now() + HOUR),
            device: options.proof ? proofOf(userId, options.proof) : undefined,
        }),
    };
}

async function passwordSignIn(userId: string, options: Parameters<typeof password>[1] = {}) {
    const { token, answered } = password(userId, options);
    const result = await answered;
    if (!result || 'suspended' in result || 'twoStep' in result) throw new Error('No session.');
    return { token, deviceId: result.device.id, attached: result.device.attached };
}

/* A sign-in that passes the step, the way the server will: a token, a slot, the gated function. */
async function steppedSignIn(
    userId: string,
    options: { previous?: Buffer | null; proof?: Proof; credentialVersion?: number } = {},
) {
    const tokenHash = sha256(randomUUID());
    await twoStep.createStepAttempt({
        purpose: 'login',
        tokenHash,
        userId,
        credentialVersion: options.credentialVersion ?? 1,
        device: options.proof ? proofOf(userId, options.proof) : null,
        previousTokenHash: options.previous ?? null,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    await twoStep.takeStepAnswer({
        tokenHash,
        purpose: 'login',
        sessionTokenHash: null,
        method: 'phrase',
    });
    const token = sha256(randomUUID());
    const result = await twoStep.openSteppedSession({
        tokenHash,
        spend: PHRASE,
        session: { tokenHash: token, expiresAt: new Date(Date.now() + HOUR) },
    });
    if (result.status !== 'ok') throw new Error(`Step ${result.status}.`);
    return { token, deviceId: result.device.id, attached: result.device.attached };
}

/* A step-up from the session, with a slot taken, for a gated change. */
async function stepUp(
    userId: string,
    sessionTokenHash: Buffer,
    purpose: 'password' | 'two-step' = 'two-step',
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
    await twoStep.takeStepAnswer({ tokenHash, purpose, sessionTokenHash, method: 'phrase' });
    return { sessionTokenHash, tokenHash, spend: PHRASE };
}

async function startApp(userId: string) {
    const factorId = randomUUID();
    await twoStep.startTotpFactor({
        id: factorId,
        userId,
        keyId: fixed('key', 8),
        nonce: fixed('nonce', 24),
        sealedSecret: fixed('secret', 36),
    });
    return factorId;
}

/* Turns the step on for the account, from `sessionToken`'s session. */
async function turnOn(userId: string, sessionToken: Buffer) {
    const factorId = await startApp(userId);
    const result = await twoStep.confirmTotpFactor({
        userId,
        factorId,
        step: 1_000,
        sessionTokenHash: sessionToken,
        credentialVersion: 1,
        backupCodes: {
            keyId: fixed('key', 8),
            hashes: Array.from({ length: 10 }, (_, index) => fixed(`code:${index}`, 32)),
        },
    });
    if (result.status !== 'ok') throw new Error(`Confirmation ${result.status}.`);
    return factorId;
}

/* A session row written past the repository, as a release that does not know the step writes it. */
function oldRelease(userId: string, deviceId: string, values: { twoStepAt?: Date } = {}) {
    return db.insert(sessions).values({
        userId,
        deviceId,
        tokenHash: sha256(randomUUID()),
        credentialVersion: 1,
        expiresAt: new Date(Date.now() + HOUR),
        ...values,
    });
}

async function spareDevice(userId: string) {
    const [device] = await db
        .insert(accountDevices)
        .values({ userId, approvedBy: 'password', approvedAt: new Date() })
        .returning({ id: accountDevices.id });
    return device!.id;
}

/* Gives the session's device a key of its own. */
async function giveKey(
    session: { token: Buffer; deviceId: string },
    label: string,
): Promise<Proof> {
    const signer = signingKeyFromSeed(fixed(`${label}:device-key`, 32));
    const result = await auth.registerDevice({
        sessionTokenHash: session.token,
        kind: 'web',
        name: label,
        signingPublicKey: signer.publicKey,
    });
    if (result.status !== 'ok') throw new Error(`Device ${result.status}.`);
    return { deviceId: session.deviceId, signer };
}

const resolves = async (token: Buffer) => (await auth.getSessionUser(token, LIFETIME)) !== null;
const sessionsOf = (userId: string) =>
    db.select().from(sessions).where(eq(sessions.userId, userId));
const sessionRow = async (token: Buffer) =>
    (await db.select().from(sessions).where(eq(sessions.tokenHash, token)))[0];
const stamp = (token: Buffer, twoStepAt: Date | null) =>
    db.update(sessions).set({ twoStepAt }).where(eq(sessions.tokenHash, token));

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('an account without a confirmed factor', () => {
    test('signs in as before: no step, no stamp, through the repository and past it', async () => {
        const { user } = await registered();
        const first = await passwordSignIn(user.id);
        expect(await resolves(first.token)).toBe(true);
        await oldRelease(user.id, await spareDevice(user.id));
        const rows = await sessionsOf(user.id);
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.twoStepAt === null)).toBe(true);
        // An unlock stays an unlock: the same device, and still no stamp.
        const unlocked = await passwordSignIn(user.id, { previous: first.token });
        expect(unlocked).toMatchObject({ deviceId: first.deviceId, attached: true });
        expect((await sessionRow(unlocked.token))!.twoStepAt).toBeNull();
    });

    test('a pending app asks for nothing: only a confirmed factor turns the gate on', async () => {
        const { user } = await registered();
        await startApp(user.id);
        const signedIn = await passwordSignIn(user.id);
        expect(await resolves(signedIn.token)).toBe(true);
        await oldRelease(user.id, await spareDevice(user.id));
    });

    test('another account’s factor changes nothing for this one', async () => {
        const { user: maya } = await registered();
        await turnOn(maya.id, (await passwordSignIn(maya.id)).token);
        const { user: sam } = await registered();
        const signedIn = await passwordSignIn(sam.id);
        expect(await resolves(signedIn.token)).toBe(true);
        await oldRelease(sam.id, await spareDevice(sam.id));
        expect(await sessionsOf(sam.id)).toHaveLength(2);
    });
});

describe('an account with a confirmed factor', () => {
    test('gets no session for the password alone: the repository says so, writes nothing, and the database refuses the row', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        await turnOn(user.id, enrolling.token);
        const spare = await spareDevice(user.id);
        const devices = (await db.select().from(accountDevices)).length;

        // The repository's own sign-in: a typed answer, not an error, and nothing left behind.
        const attempt = password(user.id);
        expect(await attempt.answered).toEqual(ASKED);
        expect(await resolves(attempt.token)).toBe(false);
        expect((await sessionsOf(user.id)).map((row) => row.tokenHash)).toEqual([enrolling.token]);
        expect(await db.select().from(accountDevices)).toHaveLength(devices);
        // A release that does not know the step, writing the row itself.
        await expect(oldRelease(user.id, spare)).rejects.toMatchObject(REFUSED);
        expect(await sessionsOf(user.id)).toHaveLength(1);
    });

    test('a device key’s proof is not the step: a known device with the password alone is asked too', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        const laptop = await giveKey(enrolling, 'laptop');
        await turnOn(user.id, enrolling.token);
        // Its session ended (7 days idle, say); the key is still on the device.
        await db.delete(sessions).where(eq(sessions.tokenHash, enrolling.token));
        expect(await password(user.id, { proof: laptop }).answered).toEqual(ASKED);
        expect(await sessionsOf(user.id)).toHaveLength(0);
        // With the step, it comes back to its own row.
        const back = await steppedSignIn(user.id, { proof: laptop });
        expect(back).toMatchObject({ deviceId: laptop.deviceId, attached: true });
        expect(await db.select().from(accountDevices)).toHaveLength(1);
    });

    test('gets a session by passing the step, stamped with when', async () => {
        const { user } = await registered();
        await turnOn(user.id, (await passwordSignIn(user.id)).token);
        const before = Date.now();
        const signedIn = await steppedSignIn(user.id);
        expect(await resolves(signedIn.token)).toBe(true);
        const passedAt = (await sessionRow(signedIn.token))!.twoStepAt!.getTime();
        expect(passedAt).toBeGreaterThanOrEqual(before);
        expect(passedAt).toBeLessThanOrEqual(Date.now());
        // Past the repository too, a row with the stamp is taken.
        await oldRelease(user.id, await spareDevice(user.id), { twoStepAt: new Date() });
    });

    test('keeps the sessions it had before the step was turned on, until they end', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        const phone = await passwordSignIn(user.id);
        await turnOn(user.id, enrolling.token);
        // The phone's session never passed the step, and still resolves and slides its expiry.
        await db
            .update(sessions)
            .set({ lastSeenAt: new Date(Date.now() - HOUR) })
            .where(eq(sessions.tokenHash, phone.token));
        expect(await resolves(phone.token)).toBe(true);
        const row = (await sessionRow(phone.token))!;
        expect(row.twoStepAt).toBeNull();
        expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
        // It can be ended like any other.
        await auth.signOutDevice(phone.token);
        expect(await resolves(phone.token)).toBe(false);
    });

    test('a sign-in that waited on the account’s lock while a method was confirmed is asked for the step', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        const factorId = await startApp(user.id);
        // The confirmation, mid-flight: it holds the account's lock and has written the factor.
        const confirming = lockObserver();
        let attempt: ReturnType<typeof password>;
        try {
            await confirming.query('begin');
            await confirming.query('select 1 from users where id = $1 for update', [user.id]);
            await confirming.query(
                'update two_step_factors set confirmed_at = now(), totp_last_step = 1000 where id = $1',
                [factorId],
            );
            // The sign-in read nothing yet: whatever it reads, it reads after the lock.
            attempt = password(user.id);
            await expect.poll(() => confirming.waitingOn('users'), { timeout: 10_000 }).toBe(true);
            await confirming.query('commit');
        } finally {
            await confirming.end();
        }
        // Decided before the lock, it would have found no factor and met the trigger instead.
        expect(await attempt.answered).toEqual(ASKED);
        expect((await sessionsOf(user.id)).map((row) => row.tokenHash)).toEqual([enrolling.token]);
    });

    test('cannot be reached by an UPDATE: a session moved to it, or given a new token, is a new session', async () => {
        const { user: maya } = await registered();
        const enrolling = await passwordSignIn(maya.id);
        const phone = await passwordSignIn(maya.id);
        await turnOn(maya.id, enrolling.token);
        const { user: sam } = await registered();
        const sams = await passwordSignIn(sam.id);

        // Sam's session, which no step was ever asked for, rewritten as Maya's.
        await expect(
            db.update(sessions).set({ userId: maya.id }).where(eq(sessions.tokenHash, sams.token)),
        ).rejects.toMatchObject(REFUSED);
        await expect(
            db
                .update(sessions)
                .set({ userId: maya.id, tokenHash: sha256(randomUUID()) })
                .where(eq(sessions.tokenHash, sams.token)),
        ).rejects.toMatchObject(REFUSED);
        // Maya's old phone session, from before the step, handed a fresh token.
        await expect(
            db
                .update(sessions)
                .set({ tokenHash: sha256(randomUUID()) })
                .where(eq(sessions.tokenHash, phone.token)),
        ).rejects.toMatchObject(REFUSED);
        // An upsert onto an existing row is an insert first.
        await expect(
            db
                .insert(sessions)
                .values({
                    userId: maya.id,
                    deviceId: phone.deviceId,
                    tokenHash: phone.token,
                    credentialVersion: 1,
                    expiresAt: new Date(Date.now() + HOUR),
                })
                .onConflictDoUpdate({
                    target: sessions.tokenHash,
                    set: { expiresAt: new Date(Date.now() + 30 * DAY) },
                }),
        ).rejects.toMatchObject(REFUSED);
        // A stamp taken off, then the session moved: still refused at the move.
        await db.update(sessions).set({ twoStepAt: null }).where(eq(sessions.userId, maya.id));
        await expect(
            db
                .update(sessions)
                .set({ tokenHash: sha256(randomUUID()) })
                .where(eq(sessions.tokenHash, enrolling.token)),
        ).rejects.toMatchObject(REFUSED);

        expect((await sessionsOf(sam.id)).map((row) => row.tokenHash)).toEqual([sams.token]);
        expect(await resolves(sams.token)).toBe(true);
        // A stepped session may be given a new token: it passed.
        await stamp(phone.token, new Date());
        const renewed = sha256(randomUUID());
        await db
            .update(sessions)
            .set({ tokenHash: renewed })
            .where(eq(sessions.tokenHash, phone.token));
        expect(await resolves(renewed)).toBe(true);
    });

    test('a security key alone turns the gate on, as an app does', async () => {
        const { user } = await registered();
        await passwordSignIn(user.id);
        await db.insert(twoStepFactors).values({
            userId: user.id,
            kind: 'webauthn',
            name: 'Security key',
            confirmedAt: new Date(),
            credentialId: fixed('credential', 32),
            publicKey: fixed('public', 64),
            signCount: 0,
            transports: ['usb'],
            backupEligible: false,
            backupState: false,
        });
        expect(await password(user.id).answered).toEqual(ASKED);
        await expect(oldRelease(user.id, await spareDevice(user.id))).rejects.toMatchObject(
            REFUSED,
        );
        expect(await resolves((await steppedSignIn(user.id)).token)).toBe(true);
    });

    test('signs in with the password alone again once its last method is removed', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        const factorId = await turnOn(user.id, enrolling.token);
        expect(await password(user.id).answered).toEqual(ASKED);
        expect(
            await twoStep.removeFactor({
                userId: user.id,
                factorId,
                step: await stepUp(user.id, enrolling.token),
            }),
        ).toMatchObject({ turnedOff: true });
        const signedIn = await passwordSignIn(user.id);
        expect(await resolves(signedIn.token)).toBe(true);
        await oldRelease(user.id, await spareDevice(user.id));
    });

    test('the guard reads the factors itself: a role that may write sessions and read nothing else is held to it, and not locked out', async () => {
        const { user: maya } = await registered();
        await turnOn(maya.id, (await passwordSignIn(maya.id)).token);
        const { user: sam } = await registered();
        const [mayas, mayasOther, sams] = [
            await spareDevice(maya.id),
            await spareDevice(maya.id),
            await spareDevice(sam.id),
        ];
        // An application role as a split-role install has it when the new table was never granted.
        const role = `hushos_guard_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        const insert = (userId: string, deviceId: string, stamped: boolean) =>
            client.query(
                `insert into sessions (user_id, device_id, token_hash, credential_version, expires_at, two_step_at)
                 values ($1, $2, $3, 1, now() + interval '1 hour', ${stamped ? 'now()' : 'null'})`,
                [userId, deviceId, sha256(randomUUID())],
            );
        try {
            await client.query(`create role ${role}`);
            await client.query(`grant insert on sessions to ${role}`);
            await client.query('begin');
            await client.query(`set local role ${role}`);
            await client.query('savepoint reading');
            await expect(client.query('select 1 from two_step_factors')).rejects.toMatchObject({
                code: '42501',
            });
            await client.query('rollback to savepoint reading');
            // Without a factor, and with the step passed: both go in.
            await insert(sam.id, sams, false);
            await insert(maya.id, mayas, true);
            // With a factor and no step: refused by the guard, not by a missing grant.
            await expect(insert(maya.id, mayasOther, false)).rejects.toMatchObject({
                code: '23514',
                constraint: 'sessions_two_step_guard',
            });
        } finally {
            await client.query('rollback').catch(() => undefined);
            await client.query(`drop owned by ${role}`).catch(() => undefined);
            await client.query(`drop role if exists ${role}`);
            await client.end();
        }
    });
});

describe('a device that keeps its session', () => {
    test('is not asked again at an unlock: the new session inherits when the step was passed, and does not extend it', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        await turnOn(user.id, enrolling.token);
        const passedAt = new Date(Date.now() - 10 * DAY);
        await stamp(enrolling.token, passedAt);

        // The web's unlock after a lock: the cookie of a live, stepped session on this device.
        const first = await passwordSignIn(user.id, { previous: enrolling.token });
        expect(first).toMatchObject({ deviceId: enrolling.deviceId, attached: true });
        expect((await sessionRow(first.token))!.twoStepAt).toEqual(passedAt);
        expect(await resolves(enrolling.token)).toBe(false);
        // Unlock after unlock, the moment stays the one the step was passed at.
        const second = await passwordSignIn(user.id, { previous: first.token });
        expect((await sessionRow(second.token))!.twoStepAt).toEqual(passedAt);
        expect(await sessionsOf(user.id)).toHaveLength(1);

        // A keyed device proving its key, with its own session's cookie, is the same device too.
        const laptop = await giveKey(second, 'laptop');
        const third = await passwordSignIn(user.id, { previous: second.token, proof: laptop });
        expect(third).toMatchObject({ deviceId: laptop.deviceId, attached: true });
        expect((await sessionRow(third.token))!.twoStepAt).toEqual(passedAt);
    });

    test('is asked once thirty days have passed since it passed the step, however often it unlocked', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        await turnOn(user.id, enrolling.token);
        await stamp(enrolling.token, new Date(Date.now() - 30 * DAY + MINUTE));
        const unlocked = await passwordSignIn(user.id, { previous: enrolling.token });
        // The same session, a little later: thirty days and a minute since the step.
        await stamp(unlocked.token, new Date(Date.now() - 30 * DAY - MINUTE));
        const attempt = password(user.id, { previous: unlocked.token });
        expect(await attempt.answered).toEqual(ASKED);
        // Asked, with nothing written: the old session is still the device's session.
        expect(await resolves(unlocked.token)).toBe(true);
        expect(await resolves(attempt.token)).toBe(false);
    });

    test('is asked when the cookie is not a live, stepped session of this account on this device', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        const old = await passwordSignIn(user.id);
        await turnOn(user.id, enrolling.token);
        const asked = async (options: Parameters<typeof password>[1]) =>
            expect(await password(user.id, options).answered).toEqual(ASKED);

        // No cookie at all.
        await asked({});
        // A session from before the step was on: it never passed.
        await asked({ previous: old.token });
        // Another account's stepped session.
        const { user: sam } = await registered();
        const sams = await passwordSignIn(sam.id);
        await turnOn(sam.id, sams.token);
        await asked({ previous: sams.token });
        // A stepped session on another device: a keyed device's cookie without its proof lends
        // nothing, so the sign-in would be a new device.
        const laptop = await steppedSignIn(user.id);
        const laptopKey = await giveKey(laptop, 'laptop');
        await asked({ previous: laptop.token });
        // The laptop's proof with the browser's cookie: the proven device is not the cookie's.
        await asked({ previous: enrolling.token, proof: laptopKey });
        // A stepped session that has expired.
        const expired = await steppedSignIn(user.id);
        await db
            .update(sessions)
            .set({
                createdAt: new Date(Date.now() - 2 * HOUR),
                expiresAt: new Date(Date.now() - HOUR),
            })
            .where(eq(sessions.tokenHash, expired.token));
        await asked({ previous: expired.token });

        // None of it wrote anything: the same sessions, the same devices.
        expect(
            (await sessionsOf(user.id)).map((row) => row.tokenHash.toString('hex')).sort(),
        ).toEqual(
            [enrolling.token, old.token, laptop.token, expired.token]
                .map((token) => token.toString('hex'))
                .sort(),
        );
        expect(await db.select().from(accountDevices)).toHaveLength(5);
        // And the browser that did pass still unlocks.
        const unlocked = await passwordSignIn(user.id, { previous: enrolling.token });
        expect(unlocked.deviceId).toBe(enrolling.deviceId);
    });
});

describe('the paths that end and reopen sessions, with the step on', () => {
    const envelope = () => ({
        keyVersion: 1,
        wrappingSalt: bytes(32),
        wrappingNonce: bytes(24),
        encryptedKey: bytes(48),
    });

    test('a password change ends every session; signing in again needs the step', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        await turnOn(user.id, enrolling.token);
        expect(
            await auth.changeAccountSecurity({
                userId: user.id,
                action: 'password',
                sessionTokenHash: enrolling.token,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: envelope(),
                twoStep: await stepUp(user.id, enrolling.token, 'password'),
            }),
        ).toBe(true);
        expect(await sessionsOf(user.id)).toHaveLength(0);
        // The old cookie is no exemption: its session is gone.
        expect(
            await password(user.id, { credentialVersion: 2, previous: enrolling.token }).answered,
        ).toEqual(ASKED);
        const back = await steppedSignIn(user.id, { credentialVersion: 2 });
        expect(await resolves(back.token)).toBe(true);
        expect(await twoStep.hasTwoStep(user.id)).toBe(true);
    });

    test('a phrase reset ends every session and leaves the step on; signing in again needs it', async () => {
        const email = `${randomUUID()}@hushos.test`;
        const { user } = await registered(email);
        await turnOn(user.id, (await passwordSignIn(user.id)).token);
        const verification = randomUUID();
        const enrollment = randomUUID();
        await auth.createEnrollment({
            purpose: 'recover',
            email,
            normalizedEmail: email,
            verificationTokenHash: sha256(verification),
            expiresAt: new Date(Date.now() + HOUR),
        });
        const verified = await auth.verifyEnrollment(
            sha256(verification),
            sha256(enrollment),
            new Date(Date.now() + HOUR),
        );
        const reset = await auth.resetAccountPassword({
            userId: user.id,
            enrollmentId: verified!.id,
            enrollmentTokenHash: sha256(enrollment),
            credentialVersion: 1,
            registrationRecord: 'record-2',
            profileVersion: 1,
            serverSetupId: 'primary',
            envelope: envelope(),
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
        expect(await sessionsOf(user.id)).toHaveLength(0);
        // The reset is not a way around the step: the methods and codes are as they were.
        expect(await twoStep.getTwoStep(user.id)).toMatchObject({ on: true, backupCodesLeft: 10 });
        expect(await password(user.id, { credentialVersion: 2 }).answered).toEqual(ASKED);
        const back = await steppedSignIn(user.id, { credentialVersion: 2 });
        expect(await resolves(back.token)).toBe(true);
    });

    test('removing devices, signing out, suspending and the sweep still end sessions', async () => {
        const { user } = await registered();
        const enrolling = await passwordSignIn(user.id);
        await turnOn(user.id, enrolling.token);
        const phone = await steppedSignIn(user.id);
        const tablet = await steppedSignIn(user.id);
        const old = await steppedSignIn(user.id);

        expect(
            await auth.revokeDevice({
                userId: user.id,
                deviceId: phone.deviceId,
                sessionTokenHash: enrolling.token,
            }),
        ).toEqual({ status: 'ok', removed: 1 });
        expect(await resolves(phone.token)).toBe(false);
        expect(await auth.wasRemoved(phone.token)).toBe(true);

        await auth.signOutDevice(tablet.token);
        expect(await resolves(tablet.token)).toBe(false);

        await db
            .update(sessions)
            .set({
                createdAt: new Date(Date.now() - 2 * HOUR),
                expiresAt: new Date(Date.now() - HOUR),
            })
            .where(eq(sessions.tokenHash, old.token));
        expect((await auth.cleanupExpired()).sessions).toBe(1);

        await auth.setUserSuspended(user.id, true);
        expect(await sessionsOf(user.id)).toHaveLength(0);
        await auth.setUserSuspended(user.id, false);
        expect(await resolves((await steppedSignIn(user.id)).token)).toBe(true);
    });
});
