import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { bytes, registered, sha256 } from '../test/accounts';
import { closeDatabase, resetDatabase, signingKeyFromSeed } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import { accountDevices, sessions, twoStepFactors } from './schema';
import { deviceSessionStatement } from './signatures';
import * as twoStep from './two-step';

/*
 * The guard on `sessions` (docs/two-step-design.md 10, decision 9): the database refuses a new
 * session that did not pass the step for an account that has a confirmed factor, whatever the
 * code above it does, so a release that does not know the step cannot sign such an account in.
 * It covers sign-in only. These tests pin what it refuses and, as much, what it must leave
 * alone: accounts without a factor, sessions that were open before the step was turned on, and
 * every path that ends sessions.
 */

const HOUR = 60 * 60 * 1000;
const LIFETIME = { idleSeconds: 7 * 24 * 3600, maxSeconds: 30 * 24 * 3600 };
const REFUSED = { cause: { code: '23514', constraint: 'sessions_two_step_guard' } };

const fixed = (label: string, length: number) =>
    createHash('sha512').update(`hushos-two-step-guard:${label}`).digest().subarray(0, length);

function session(userId: string, options: { twoStepAt?: Date; credentialVersion?: number } = {}) {
    const token = sha256(randomUUID());
    return {
        token,
        opened: auth.createSession({
            userId,
            credentialVersion: options.credentialVersion ?? 1,
            tokenHash: token,
            previousTokenHash: null,
            expiresAt: new Date(Date.now() + HOUR),
            twoStepAt: options.twoStepAt,
        }),
    };
}

async function signIn(
    userId: string,
    options: { twoStepAt?: Date; credentialVersion?: number } = {},
) {
    const { token, opened } = session(userId, options);
    const result = await opened;
    if (!result || 'suspended' in result) throw new Error('No session.');
    return { token, deviceId: result.device.id };
}

/* Turns the step on for the account, from `sessionToken`'s session. */
async function turnOn(userId: string, sessionToken: Buffer) {
    const factorId = randomUUID();
    await twoStep.startTotpFactor({
        id: factorId,
        userId,
        keyId: fixed('key', 8),
        nonce: fixed('nonce', 24),
        sealedSecret: fixed('secret', 36),
    });
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

const resolves = async (token: Buffer) => (await auth.getSessionUser(token, LIFETIME)) !== null;
const sessionsOf = (userId: string) =>
    db.select().from(sessions).where(eq(sessions.userId, userId));

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('an account without a confirmed factor', () => {
    test('signs in as before: no step, no stamp, through the repository and past it', async () => {
        const { user } = await registered();
        const first = await signIn(user.id);
        expect(await resolves(first.token)).toBe(true);
        await oldRelease(user.id, await spareDevice(user.id));
        const rows = await sessionsOf(user.id);
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.twoStepAt === null)).toBe(true);
    });

    test('a pending app asks for nothing: only a confirmed factor turns the guard on', async () => {
        const { user } = await registered();
        await twoStep.startTotpFactor({
            id: randomUUID(),
            userId: user.id,
            keyId: fixed('key', 8),
            nonce: fixed('nonce', 24),
            sealedSecret: fixed('secret', 36),
        });
        const signedIn = await signIn(user.id);
        expect(await resolves(signedIn.token)).toBe(true);
        await oldRelease(user.id, await spareDevice(user.id));
    });

    test('another account’s factor changes nothing for this one', async () => {
        const { user: maya } = await registered();
        await turnOn(maya.id, (await signIn(maya.id)).token);
        const { user: sam } = await registered();
        const signedIn = await signIn(sam.id);
        expect(await resolves(signedIn.token)).toBe(true);
        await oldRelease(sam.id, await spareDevice(sam.id));
        expect(await sessionsOf(sam.id)).toHaveLength(2);
    });
});

describe('an account with a confirmed factor', () => {
    test('gets no session without the step: the row is refused, and the sign-in leaves nothing behind', async () => {
        const { user } = await registered();
        const enrolling = await signIn(user.id);
        await turnOn(user.id, enrolling.token);
        const spare = await spareDevice(user.id);
        const devices = (await db.select().from(accountDevices)).length;

        // A release that does not know the step, writing the row itself.
        await expect(oldRelease(user.id, spare)).rejects.toMatchObject(REFUSED);
        // The repository's own sign-in, called without the step.
        const attempt = session(user.id);
        await expect(attempt.opened).rejects.toMatchObject(REFUSED);
        expect(await resolves(attempt.token)).toBe(false);
        // The refusal rolled the whole sign-in back: no session, and no device made for it.
        expect((await sessionsOf(user.id)).map((row) => row.tokenHash)).toEqual([enrolling.token]);
        expect(await db.select().from(accountDevices)).toHaveLength(devices);
    });

    test('gets a session that passed the step, stamped with when', async () => {
        const { user } = await registered();
        await turnOn(user.id, (await signIn(user.id)).token);
        const passedAt = new Date(Date.now() - 60_000);
        const signedIn = await signIn(user.id, { twoStepAt: passedAt });
        expect(await resolves(signedIn.token)).toBe(true);
        const [row] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.tokenHash, signedIn.token));
        expect(row!.twoStepAt).toEqual(passedAt);
        // Past the repository too, a row with the stamp is taken.
        await oldRelease(user.id, await spareDevice(user.id), { twoStepAt: passedAt });
    });

    test('keeps the sessions it had before the step was turned on, until they end', async () => {
        const { user } = await registered();
        const enrolling = await signIn(user.id);
        const phone = await signIn(user.id);
        await turnOn(user.id, enrolling.token);
        // The phone's session never passed the step, and still resolves and slides its expiry.
        await db
            .update(sessions)
            .set({ lastSeenAt: new Date(Date.now() - HOUR) })
            .where(eq(sessions.tokenHash, phone.token));
        expect(await resolves(phone.token)).toBe(true);
        const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, phone.token));
        expect(row!.twoStepAt).toBeNull();
        expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * HOUR);
        // It can be ended like any other.
        await auth.signOutDevice(phone.token);
        expect(await resolves(phone.token)).toBe(false);
    });

    test('cannot be reached by an UPDATE: a session moved to it, or given a new token, is a new session', async () => {
        const { user: maya } = await registered();
        const enrolling = await signIn(maya.id);
        const phone = await signIn(maya.id);
        await turnOn(maya.id, enrolling.token);
        const { user: sam } = await registered();
        const sams = await signIn(sam.id);

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
                    set: { expiresAt: new Date(Date.now() + 30 * 24 * HOUR) },
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
        await db
            .update(sessions)
            .set({ twoStepAt: new Date() })
            .where(eq(sessions.tokenHash, phone.token));
        const renewed = sha256(randomUUID());
        await db
            .update(sessions)
            .set({ tokenHash: renewed })
            .where(eq(sessions.tokenHash, phone.token));
        expect(await resolves(renewed)).toBe(true);
    });

    test('a security key alone turns the guard on, as an app does', async () => {
        const { user } = await registered();
        await signIn(user.id);
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
        await expect(session(user.id).opened).rejects.toMatchObject(REFUSED);
        expect(await resolves((await signIn(user.id, { twoStepAt: new Date() })).token)).toBe(true);
    });

    test('signs in with the password alone again once its last method is removed', async () => {
        const { user } = await registered();
        const factorId = await turnOn(user.id, (await signIn(user.id)).token);
        await expect(session(user.id).opened).rejects.toMatchObject(REFUSED);
        expect(await twoStep.removeFactor({ userId: user.id, factorId })).toMatchObject({
            turnedOff: true,
        });
        const signedIn = await signIn(user.id);
        expect(await resolves(signedIn.token)).toBe(true);
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
        const enrolling = await signIn(user.id);
        await turnOn(user.id, enrolling.token);
        expect(
            await auth.changeAccountSecurity({
                userId: user.id,
                action: 'password',
                sessionTokenHash: enrolling.token,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: envelope(),
            }),
        ).toBe(true);
        expect(await sessionsOf(user.id)).toHaveLength(0);
        await expect(session(user.id, { credentialVersion: 2 }).opened).rejects.toMatchObject(
            REFUSED,
        );
        const back = await signIn(user.id, { credentialVersion: 2, twoStepAt: new Date() });
        expect(await resolves(back.token)).toBe(true);
        expect(await twoStep.hasTwoStep(user.id)).toBe(true);
    });

    test('a phrase reset ends every session and leaves the step on; signing in again needs it', async () => {
        const email = `${randomUUID()}@hushos.test`;
        const { user } = await registered(email);
        await turnOn(user.id, (await signIn(user.id)).token);
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
        await expect(session(user.id, { credentialVersion: 2 }).opened).rejects.toMatchObject(
            REFUSED,
        );
        const back = await signIn(user.id, { credentialVersion: 2, twoStepAt: new Date() });
        expect(await resolves(back.token)).toBe(true);
    });

    test('removing devices, signing out, suspending and the sweep still end sessions', async () => {
        const { user } = await registered();
        const enrolling = await signIn(user.id);
        await turnOn(user.id, enrolling.token);
        const phone = await signIn(user.id, { twoStepAt: new Date() });
        const tablet = await signIn(user.id, { twoStepAt: new Date() });
        const old = await signIn(user.id, { twoStepAt: new Date() });

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
        expect(await resolves((await signIn(user.id, { twoStepAt: new Date() })).token)).toBe(true);
    });

    test('a known device comes back to its own row with the step, by its cookie or its key, and not without', async () => {
        const { user } = await registered();
        const enrolling = await signIn(user.id);
        await turnOn(user.id, enrolling.token);
        // The browser's unlock: the previous session lends its device to the new one.
        const token = sha256(randomUUID());
        const unlocked = await auth.createSession({
            userId: user.id,
            credentialVersion: 1,
            tokenHash: token,
            previousTokenHash: enrolling.token,
            expiresAt: new Date(Date.now() + HOUR),
            twoStepAt: new Date(),
        });
        expect(unlocked).toMatchObject({ device: { id: enrolling.deviceId, attached: true } });
        expect(await resolves(token)).toBe(true);
        expect(await resolves(enrolling.token)).toBe(false);
        // Without the step, the same unlock is refused and the old session is still there.
        const again = sha256(randomUUID());
        await expect(
            auth.createSession({
                userId: user.id,
                credentialVersion: 1,
                tokenHash: again,
                previousTokenHash: token,
                expiresAt: new Date(Date.now() + HOUR),
            }),
        ).rejects.toMatchObject(REFUSED);
        expect(await resolves(token)).toBe(true);
        expect(await resolves(again)).toBe(false);

        // A device key's proof is not the step either: with a valid proof and no step, no session.
        const signer = signingKeyFromSeed(fixed('device-key', 32));
        expect(
            await auth.registerDevice({
                sessionTokenHash: token,
                kind: 'web',
                name: 'Laptop',
                signingPublicKey: signer.publicKey,
            }),
        ).toMatchObject({ status: 'ok' });
        const proven = (twoStepAt?: Date) => {
            const attemptDigest = sha256(randomUUID());
            const tokenHash = sha256(randomUUID());
            return {
                tokenHash,
                opened: auth.createSession({
                    userId: user.id,
                    credentialVersion: 1,
                    tokenHash,
                    previousTokenHash: null,
                    expiresAt: new Date(Date.now() + HOUR),
                    device: {
                        id: enrolling.deviceId,
                        attemptDigest,
                        signature: signer.sign(
                            deviceSessionStatement({
                                userId: user.id,
                                deviceId: enrolling.deviceId,
                                attemptDigest,
                            }),
                        ),
                    },
                    twoStepAt,
                }),
            };
        };
        await expect(proven().opened).rejects.toMatchObject(REFUSED);
        expect(await resolves(token)).toBe(true);
        const back = proven(new Date());
        expect(await back.opened).toMatchObject({
            device: { id: enrolling.deviceId, attached: true, created: null },
        });
        expect(await resolves(back.tokenHash)).toBe(true);
        expect(await db.select().from(accountDevices)).toHaveLength(1);
    });
});
