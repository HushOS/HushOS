import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, resetDatabase, signingKeyFromSeed } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import {
    accountDevices,
    accountEnrollments,
    opaqueCredentials,
    removedSessionTokens,
    sessions,
    users,
} from './schema';
import { deviceSessionStatement } from './signatures';

/*
 * Devices, step 1 (docs/devices-design.md): every session sits on a device; a
 * device that proves it holds its key comes back to its own row; removing a
 * device ends its sessions at once and cannot be undone by the device; and the
 * sweeps keep what can come back and drop what cannot. Every key below comes
 * from a fixed seed, so a failure reproduces.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIFETIME = { idleSeconds: 7 * 24 * 3600, maxSeconds: 30 * 24 * 3600 };

const hash = (value: string) => createHash('sha256').update(value).digest();
const bytes = (length: number) => randomBytes(length);
const seed = (label: string) => createHash('sha256').update(`hushos-device-test:${label}`).digest();

async function account(options: { ageMs?: number } = {}) {
    const email = `${randomUUID()}@hushos.test`;
    const verification = randomUUID();
    const enrollment = randomUUID();
    await auth.createEnrollment({
        purpose: 'register',
        email,
        normalizedEmail: email,
        verificationTokenHash: hash(verification),
        expiresAt: new Date(Date.now() + HOUR),
    });
    await auth.verifyEnrollment(hash(verification), hash(enrollment), new Date(Date.now() + HOUR));
    const result = await auth.registerAccount({
        enrollmentTokenHash: hash(enrollment),
        initialQuotaBytes: 1_073_741_824n,
        name: 'Test Person',
        registrationRecord: 'record',
        profileVersion: 1,
        serverSetupId: 'primary',
        envelope: {
            envelopeVersion: 1,
            wrappingSalt: bytes(32),
            wrappingNonce: bytes(24),
            encryptedKey: bytes(48),
        },
        recovery: {
            wrappingSalt: bytes(32),
            wrappingNonce: bytes(24),
            encryptedKey: bytes(48),
            backupNonce: bytes(24),
            encryptedRecoveryKey: bytes(48),
            publicKey: bytes(32),
        },
        identity: {
            wrappingSalt: bytes(32),
            encryptionPublicKey: bytes(32),
            encryptionPrivateKeyNonce: bytes(24),
            encryptedEncryptionPrivateKey: bytes(48),
            signingPublicKey: bytes(32),
            signingSeedNonce: bytes(24),
            encryptedSigningSeed: bytes(48),
        },
        workspace: {
            id: randomUUID(),
            grant: {
                keyVersion: 1,
                wrappingSalt: bytes(32),
                wrappingNonce: bytes(24),
                encryptedKey: bytes(48),
            },
        },
    });
    if (result.status !== 'created') throw new Error(`Registration ${result.status}.`);
    // An account older than the enrolment window: its first sign-in is a password one.
    const ageMs = options.ageMs ?? DAY;
    if (ageMs > 0)
        await db
            .update(users)
            .set({ createdAt: new Date(Date.now() - ageMs) })
            .where(eq(users.id, result.user.id));
    return { ...result.user, email };
}

type Signer = ReturnType<typeof signingKeyFromSeed>;

/* A sign-in: an attempt token, and a proof from `proof` when given, signed over `signedAttempt` (default: this attempt). */
async function signIn(
    userId: string,
    options: {
        proof?: { deviceId: string; signer: Signer; signedAttempt?: string; signedUserId?: string };
        previousToken?: Buffer | null;
        credentialVersion?: number;
    } = {},
) {
    const attempt = randomUUID();
    const token = hash(randomUUID());
    const proof = options.proof;
    const result = await auth.createSession({
        userId,
        credentialVersion: options.credentialVersion ?? 1,
        tokenHash: token,
        previousTokenHash: options.previousToken ?? null,
        expiresAt: new Date(Date.now() + HOUR),
        device: proof
            ? {
                  id: proof.deviceId,
                  attemptDigest: hash(attempt),
                  signature: proof.signer.sign(
                      deviceSessionStatement({
                          userId: proof.signedUserId ?? userId,
                          deviceId: proof.deviceId,
                          attemptDigest: hash(proof.signedAttempt ?? attempt),
                      }),
                  ),
              }
            : undefined,
    });
    if (!result || 'suspended' in result) throw new Error('No session.');
    return { token, device: result.device };
}

/* A signed-in device that has registered a key: what a browser or phone has after its first visit. */
async function keyedDevice(userId: string, label: string) {
    const signer = signingKeyFromSeed(seed(`${userId}:${label}`));
    const { token, device } = await signIn(userId);
    const registered = await auth.registerDevice({
        sessionTokenHash: token,
        kind: 'web',
        name: label,
        signingPublicKey: signer.publicKey,
    });
    if (registered.status !== 'ok') throw new Error(`Registration ${registered.status}.`);
    return { token, deviceId: device.id, signer };
}

async function deviceRow(id: string) {
    const [row] = await db.select().from(accountDevices).where(eq(accountDevices.id, id));
    return row;
}

async function resolves(token: Buffer) {
    return (await auth.getSessionUser(token, LIFETIME)) !== null;
}

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('creating a session', () => {
    test('a sign-in without a proof opens a session on a new password device', async () => {
        const user = await account();
        const { token, device } = await signIn(user.id);
        expect(device).toMatchObject({ attached: false, registered: false, created: 'password' });
        const row = await deviceRow(device.id);
        expect(row).toMatchObject({ userId: user.id, approvedBy: 'password', revokedAt: null });
        expect(row?.approvedAt).not.toBeNull();
        expect((await auth.getSession(token, LIFETIME))?.device).toEqual({
            id: device.id,
            registered: false,
        });
    });

    test('the first device of a fresh account is its enrolment device, and only the first', async () => {
        const fresh = await account({ ageMs: 0 });
        expect((await signIn(fresh.id)).device.created).toBe('enrolment');
        expect((await signIn(fresh.id)).device.created).toBe('password');

        // Past the window, a first device is a password one: anyone with the password could make it.
        const old = await account({ ageMs: auth.DEVICE_ENROLMENT_SECONDS * 1000 + 60_000 });
        expect((await signIn(old.id)).device.created).toBe('password');
    });
});

describe('coming back to a device', () => {
    test('a valid proof brings the device back as it was and ends its previous session', async () => {
        const user = await account();
        const first = await keyedDevice(user.id, 'laptop');
        const before = await deviceRow(first.deviceId);
        const again = await signIn(user.id, {
            proof: { deviceId: first.deviceId, signer: first.signer },
        });
        expect(again.device).toMatchObject({
            id: first.deviceId,
            attached: true,
            registered: true,
            created: null,
        });
        const after = await deviceRow(first.deviceId);
        expect(after?.approvedBy).toBe(before?.approvedBy);
        expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
        expect(await resolves(first.token)).toBe(false);
        expect(await resolves(again.token)).toBe(true);
        expect(
            await db.select().from(sessions).where(eq(sessions.deviceId, first.deviceId)),
        ).toHaveLength(1);
        expect(await db.select().from(accountDevices)).toHaveLength(1);
    });

    test.each([
        ['a key that is not the device’s', 'wrong-key'],
        ['another account’s device', 'other-account'],
        ['a revoked device', 'revoked'],
        // A replay of the same attempt never reaches here: finishLogin consumes the attempt first.
        ['a signature over another attempt', 'other-attempt'],
    ] as const)('%s makes a new device and leaves the old one untouched', async (_label, kind) => {
        const user = await account();
        const other = await account();
        const mine = await keyedDevice(user.id, 'laptop');
        const theirs = await keyedDevice(other.id, 'phone');
        let proof: NonNullable<Parameters<typeof signIn>[1]>['proof'];
        switch (kind) {
            case 'wrong-key':
                proof = { deviceId: mine.deviceId, signer: signingKeyFromSeed(seed('stranger')) };
                break;
            case 'other-account':
                // Their own key, over a statement naming this account and their device.
                proof = { deviceId: theirs.deviceId, signer: theirs.signer };
                break;
            case 'revoked': {
                const acting = await keyedDevice(user.id, 'desktop');
                expect(
                    await auth.revokeDevice({
                        userId: user.id,
                        deviceId: mine.deviceId,
                        sessionTokenHash: acting.token,
                    }),
                ).toEqual({ status: 'ok', removed: 1 });
                proof = { deviceId: mine.deviceId, signer: mine.signer };
                break;
            }
            case 'other-attempt':
                proof = {
                    deviceId: mine.deviceId,
                    signer: mine.signer,
                    signedAttempt: randomUUID(),
                };
                break;
        }
        const before = await deviceRow(mine.deviceId);
        const result = await signIn(user.id, { proof });
        expect(result.device.attached).toBe(false);
        expect(result.device.id).not.toBe(mine.deviceId);
        expect(result.device.id).not.toBe(theirs.deviceId);
        expect(result.device.created).toBe('password');
        // The device the proof named is exactly as it was.
        expect(await deviceRow(mine.deviceId)).toEqual(before);
        expect(await deviceRow(theirs.deviceId)).toMatchObject({
            userId: other.id,
            revokedAt: null,
        });
        expect(await resolves(theirs.token)).toBe(true);
    });

    test('the cookie of a keyless device lends it to the next sign-in; a keyed one needs its proof', async () => {
        const user = await account();
        const keyless = await signIn(user.id);
        const reused = await signIn(user.id, { previousToken: keyless.token });
        expect(reused.device).toMatchObject({ id: keyless.device.id, attached: true });
        expect(await resolves(keyless.token)).toBe(false);

        const keyed = await keyedDevice(user.id, 'laptop');
        const without = await signIn(user.id, { previousToken: keyed.token });
        expect(without.device.id).not.toBe(keyed.deviceId);
        expect(without.device.attached).toBe(false);

        // Another account's cookie lends nothing.
        const other = await account();
        const theirs = await signIn(other.id);
        const mine = await signIn(user.id, { previousToken: theirs.token });
        expect(mine.device.id).not.toBe(theirs.device.id);
    });
});

describe('removing a device', () => {
    test('ends its session at once, tells it why, and its key no longer brings it back', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        const phone = await keyedDevice(user.id, 'phone');
        expect(
            await auth.revokeDevice({
                userId: user.id,
                deviceId: phone.deviceId,
                sessionTokenHash: laptop.token,
            }),
        ).toEqual({ status: 'ok', removed: 1 });
        // What Drive and every other route ask: no user, so 401.
        expect(await auth.getSessionUser(phone.token, LIFETIME)).toBeNull();
        expect(await auth.wasRemoved(phone.token)).toBe(true);
        expect(await auth.wasRemoved(laptop.token)).toBe(false);
        expect(await resolves(laptop.token)).toBe(true);

        const back = await signIn(user.id, {
            proof: { deviceId: phone.deviceId, signer: phone.signer },
        });
        expect(back.device.attached).toBe(false);
        expect((await deviceRow(phone.deviceId))?.revokedAt).not.toBeNull();
        expect(
            (await auth.listDevices(user.id, laptop.deviceId)).map((device) => device.id),
        ).not.toContain(phone.deviceId);
    });

    test('another account’s device is missing, and nothing changes for either account', async () => {
        const user = await account();
        const other = await account();
        const mine = await keyedDevice(user.id, 'laptop');
        const theirs = await keyedDevice(other.id, 'phone');
        expect(
            await auth.revokeDevice({
                userId: user.id,
                deviceId: theirs.deviceId,
                sessionTokenHash: mine.token,
            }),
        ).toEqual({ status: 'missing' });
        expect(await resolves(mine.token)).toBe(true);
        expect(await resolves(theirs.token)).toBe(true);
        expect((await deviceRow(theirs.deviceId))?.revokedAt).toBeNull();
        // Renaming it is the same answer.
        expect(
            await auth.renameDevice({
                userId: user.id,
                deviceId: theirs.deviceId,
                name: 'Mine now',
            }),
        ).toBeNull();
        expect((await deviceRow(theirs.deviceId))?.name).toBe('phone');
    });

    test('the device asking cannot remove itself', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        expect(
            await auth.revokeDevice({
                userId: user.id,
                deviceId: laptop.deviceId,
                sessionTokenHash: laptop.token,
            }),
        ).toEqual({ status: 'current' });
        expect(await resolves(laptop.token)).toBe(true);
    });

    test('two devices removing each other at once: exactly one wins, and the loser is signed out', async () => {
        const user = await account();
        const a = await keyedDevice(user.id, 'a');
        const b = await keyedDevice(user.id, 'b');
        const results = await Promise.all([
            auth.revokeDevice({ userId: user.id, deviceId: b.deviceId, sessionTokenHash: a.token }),
            auth.revokeDevice({ userId: user.id, deviceId: a.deviceId, sessionTokenHash: b.token }),
        ]);
        const statuses = results.map((result) => result.status).sort();
        expect(statuses).toEqual(['ok', 'session']);
        const live = await db
            .select({ deviceId: accountDevices.id })
            .from(accountDevices)
            .where(and(eq(accountDevices.userId, user.id), isNull(accountDevices.revokedAt)));
        expect(live).toHaveLength(1);
        const winner = live[0]!.deviceId;
        const loser = winner === a.deviceId ? b : a;
        expect(await resolves(loser.token)).toBe(false);
        expect(await resolves(winner === a.deviceId ? a.token : b.token)).toBe(true);
    });

    test('removing every other device keeps only the one asking', async () => {
        const user = await account();
        const other = await account();
        const keep = await keyedDevice(user.id, 'keep');
        const gone = [await keyedDevice(user.id, 'one'), await signIn(user.id)];
        const theirs = await keyedDevice(other.id, 'theirs');
        expect(
            await auth.revokeOtherDevices({ userId: user.id, sessionTokenHash: keep.token }),
        ).toEqual({ status: 'ok', removed: 2 });
        expect(await resolves(keep.token)).toBe(true);
        for (const device of gone) {
            expect(await resolves(device.token)).toBe(false);
            expect(await auth.wasRemoved(device.token)).toBe(true);
        }
        expect((await auth.listDevices(user.id, keep.deviceId)).map((d) => d.id)).toEqual([
            keep.deviceId,
        ]);
        expect(await resolves(theirs.token)).toBe(true);
    });

    test('removing every other device also ends sessions without a device, from the rolling update', async () => {
        const user = await account();
        const keep = await keyedDevice(user.id, 'keep');
        const old = await signIn(user.id);
        // As a container of the previous release writes one: no device. That release still accepts it.
        await db.update(sessions).set({ deviceId: null }).where(eq(sessions.tokenHash, old.token));
        const other = await account();
        const theirs = await signIn(other.id);
        await db
            .update(sessions)
            .set({ deviceId: null })
            .where(eq(sessions.tokenHash, theirs.token));
        await auth.revokeOtherDevices({ userId: user.id, sessionTokenHash: keep.token });
        expect(
            await db.select().from(sessions).where(eq(sessions.tokenHash, old.token)),
        ).toHaveLength(0);
        expect(await auth.wasRemoved(old.token)).toBe(true);
        expect(await resolves(keep.token)).toBe(true);
        // Another account's are not this account's to end.
        expect(
            await db.select().from(sessions).where(eq(sessions.tokenHash, theirs.token)),
        ).toHaveLength(1);
    });

    test('a session left on a revoked device does not resolve', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        // Only a defect could leave this behind: revoking deletes the sessions in the same step.
        await db
            .update(accountDevices)
            .set({ revokedAt: new Date() })
            .where(eq(accountDevices.id, laptop.deviceId));
        expect(await auth.getSessionUser(laptop.token, LIFETIME)).toBeNull();
        // Nor one without a device, as a container of the previous release writes during a rollout.
        await db
            .update(sessions)
            .set({ deviceId: null })
            .where(eq(sessions.tokenHash, laptop.token));
        expect(await auth.getSessionUser(laptop.token, LIFETIME)).toBeNull();
    });

    test('signing out removes the device, but it is not told it was removed', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        await auth.signOutDevice(laptop.token);
        expect(await resolves(laptop.token)).toBe(false);
        expect((await deviceRow(laptop.deviceId))?.revokedAt).not.toBeNull();
        expect(await auth.wasRemoved(laptop.token)).toBe(false);
        const back = await signIn(user.id, {
            proof: { deviceId: laptop.deviceId, signer: laptop.signer },
        });
        expect(back.device.attached).toBe(false);
    });

    test('a removed device is told so for a week, then no longer', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        const phone = await keyedDevice(user.id, 'phone');
        await auth.revokeDevice({
            userId: user.id,
            deviceId: phone.deviceId,
            sessionTokenHash: laptop.token,
        });
        const [row] = await db
            .select()
            .from(removedSessionTokens)
            .where(eq(removedSessionTokens.tokenHash, phone.token));
        expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(
            (auth.REMOVED_TOKEN_SECONDS - 60) * 1000,
        );
        await db
            .update(removedSessionTokens)
            .set({ expiresAt: new Date(Date.now() - 1) })
            .where(eq(removedSessionTokens.tokenHash, phone.token));
        expect(await auth.wasRemoved(phone.token)).toBe(false);
    });
});

describe('registering a device', () => {
    test('sets the key once, on the session’s own device only', async () => {
        const user = await account();
        const { token, device } = await signIn(user.id);
        const other = await signIn(user.id);
        const key = signingKeyFromSeed(seed('register')).publicKey;
        const first = await auth.registerDevice({
            sessionTokenHash: token,
            kind: 'ios',
            name: 'iPhone',
            signingPublicKey: key,
        });
        expect(first).toMatchObject({ status: 'ok', device: { id: device.id, kind: 'ios' } });
        expect((await deviceRow(device.id))?.signingPublicKey).toEqual(key);
        // A second registration cannot swap the key.
        expect(
            await auth.registerDevice({
                sessionTokenHash: token,
                kind: 'ios',
                name: 'iPhone',
                signingPublicKey: signingKeyFromSeed(seed('swap')).publicKey,
            }),
        ).toEqual({ status: 'registered' });
        expect((await deviceRow(device.id))?.signingPublicKey).toEqual(key);
        // The other device is untouched and cannot take this one's key.
        expect((await deviceRow(other.device.id))?.kind).toBeNull();
        expect(
            await auth.registerDevice({
                sessionTokenHash: other.token,
                kind: 'web',
                name: 'Copy',
                signingPublicKey: key,
            }),
        ).toEqual({ status: 'key-in-use' });
        expect((await deviceRow(other.device.id))?.signingPublicKey).toBeNull();
        // No session, no registration.
        expect(
            await auth.registerDevice({
                sessionTokenHash: hash('nobody'),
                kind: 'web',
                name: 'Ghost',
                signingPublicKey: null,
            }),
        ).toEqual({ status: 'session' });
    });

    test('the table refuses a key that is not 32 bytes', async () => {
        const user = await account();
        const { device } = await signIn(user.id);
        await expect(
            db
                .update(accountDevices)
                .set({ signingPublicKey: bytes(31) })
                .where(eq(accountDevices.id, device.id)),
        ).rejects.toThrow();
    });
});

describe('last seen, and what one account sees', () => {
    test('a device’s last-seen moves only through its own session, after the throttle', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        const phone = await keyedDevice(user.id, 'phone');
        const old = new Date(Date.now() - HOUR);
        await db.update(sessions).set({ lastSeenAt: old }).where(eq(sessions.userId, user.id));
        await db
            .update(accountDevices)
            .set({ lastSeenAt: old })
            .where(eq(accountDevices.userId, user.id));

        await auth.getSession(laptop.token, LIFETIME);
        expect((await deviceRow(laptop.deviceId))!.lastSeenAt.getTime()).toBeGreaterThan(
            old.getTime(),
        );
        expect((await deviceRow(phone.deviceId))!.lastSeenAt.getTime()).toBe(old.getTime());

        // Listing, renaming or removing from the laptop does not touch the phone's.
        await auth.listDevices(user.id, laptop.deviceId);
        await auth.renameDevice({ userId: user.id, deviceId: phone.deviceId, name: 'Old phone' });
        expect((await deviceRow(phone.deviceId))!.lastSeenAt.getTime()).toBe(old.getTime());

        // Within five minutes of the last move, nothing moves again.
        const moved = (await deviceRow(laptop.deviceId))!.lastSeenAt.getTime();
        await db
            .update(accountDevices)
            .set({ lastSeenAt: old })
            .where(eq(accountDevices.id, laptop.deviceId));
        await auth.getSession(laptop.token, LIFETIME);
        expect((await deviceRow(laptop.deviceId))!.lastSeenAt.getTime()).toBe(old.getTime());
        expect(moved).toBeGreaterThan(old.getTime());
    });

    test('the list is the account’s own, the asking device first, with who is signed in', async () => {
        const user = await account();
        const other = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        const phone = await keyedDevice(user.id, 'phone');
        await keyedDevice(other.id, 'theirs');
        await db.delete(sessions).where(eq(sessions.tokenHash, phone.token));
        const listed = await auth.listDevices(user.id, laptop.deviceId);
        expect(listed.map((device) => [device.id, device.current, device.signedIn])).toEqual([
            [laptop.deviceId, true, true],
            [phone.deviceId, false, false],
        ]);
    });
});

describe('what happens to devices around them', () => {
    test('a password change ends every session but keeps every device, and keys bring them back', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        const phone = await keyedDevice(user.id, 'phone');
        expect(
            await auth.changeAccountSecurity({
                userId: user.id,
                action: 'password',
                sessionTokenHash: laptop.token,
                credentialVersion: 1,
                registrationRecord: 'record-2',
                envelope: {
                    keyVersion: 1,
                    wrappingSalt: bytes(32),
                    wrappingNonce: bytes(24),
                    encryptedKey: bytes(48),
                },
            }),
        ).toBe(true);
        expect(await resolves(laptop.token)).toBe(false);
        expect(await resolves(phone.token)).toBe(false);
        expect(await auth.wasRemoved(phone.token)).toBe(false);
        for (const device of [laptop, phone])
            expect((await deviceRow(device.deviceId))?.revokedAt).toBeNull();
        const back = await signIn(user.id, {
            credentialVersion: 2,
            proof: { deviceId: phone.deviceId, signer: phone.signer },
        });
        expect(back.device).toMatchObject({ id: phone.deviceId, attached: true });
        expect(await db.select().from(accountDevices)).toHaveLength(2);
    });

    test('a phrase reset ends every session but keeps every device', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        const verification = randomUUID();
        const enrollment = randomUUID();
        await auth.createEnrollment({
            purpose: 'recover',
            email: user.email,
            normalizedEmail: user.email,
            verificationTokenHash: hash(verification),
            expiresAt: new Date(Date.now() + HOUR),
        });
        const verified = await auth.verifyEnrollment(
            hash(verification),
            hash(enrollment),
            new Date(Date.now() + HOUR),
        );
        const reset = await auth.resetAccountPassword({
            userId: user.id,
            enrollmentId: verified!.id,
            enrollmentTokenHash: hash(enrollment),
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
        expect(await resolves(laptop.token)).toBe(false);
        expect((await deviceRow(laptop.deviceId))?.revokedAt).toBeNull();
        const back = await signIn(user.id, {
            credentialVersion: 2,
            proof: { deviceId: laptop.deviceId, signer: laptop.signer },
        });
        expect(back.device.attached).toBe(true);
        expect(await db.select().from(accountEnrollments)).toHaveLength(0);
    });

    test('suspension leaves devices alone; deleting the account takes them', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        await auth.setUserSuspended(user.id, true);
        expect((await deviceRow(laptop.deviceId))?.revokedAt).toBeNull();
        await auth.setUserSuspended(user.id, false);
        const back = await signIn(user.id, {
            proof: { deviceId: laptop.deviceId, signer: laptop.signer },
        });
        expect(back.device.attached).toBe(true);
        expect(
            await auth.deleteAccount({
                userId: user.id,
                credentialVersion: 1,
                sessionTokenHash: back.token,
            }),
        ).toBe(true);
        expect(await db.select().from(accountDevices)).toHaveLength(0);
    });
});

describe('the sweeps', () => {
    async function age(id: string, values: Partial<typeof accountDevices.$inferInsert>) {
        await db.update(accountDevices).set(values).where(eq(accountDevices.id, id));
    }

    test('a keyless device without a session goes after a day; with a session, or younger, it stays', async () => {
        const user = await account();
        const old = await signIn(user.id);
        const young = await signIn(user.id);
        const live = await signIn(user.id);
        for (const device of [old, young])
            await db.delete(sessions).where(eq(sessions.tokenHash, device.token));
        await age(old.device.id, { createdAt: new Date(Date.now() - DAY - 60_000) });
        await age(young.device.id, { createdAt: new Date(Date.now() - DAY + 60_000) });
        await age(live.device.id, { createdAt: new Date(Date.now() - 5 * DAY) });
        await auth.cleanupExpired();
        expect(await deviceRow(old.device.id)).toBeUndefined();
        expect(await deviceRow(young.device.id)).toBeDefined();
        expect(await deviceRow(live.device.id)).toBeDefined();
    });

    test('a keyed device idle past 90 days is revoked, and a revoked one goes 90 days on', async () => {
        const user = await account();
        const idle = await keyedDevice(user.id, 'idle');
        const recent = await keyedDevice(user.id, 'recent');
        const signedIn = await keyedDevice(user.id, 'signed-in');
        const revokedOld = await keyedDevice(user.id, 'revoked-old');
        const revokedRecent = await keyedDevice(user.id, 'revoked-recent');
        for (const device of [idle, recent, revokedOld, revokedRecent])
            await db.delete(sessions).where(eq(sessions.tokenHash, device.token));
        const days = (n: number) => new Date(Date.now() - n * DAY);
        await age(idle.deviceId, { lastSeenAt: days(91) });
        await age(recent.deviceId, { lastSeenAt: days(89) });
        await age(signedIn.deviceId, { lastSeenAt: days(120) });
        await age(revokedOld.deviceId, { revokedAt: days(91) });
        await age(revokedRecent.deviceId, { revokedAt: days(89) });
        await auth.cleanupExpired();
        expect((await deviceRow(idle.deviceId))?.revokedAt).not.toBeNull();
        expect((await deviceRow(recent.deviceId))?.revokedAt).toBeNull();
        // A device with a live session is in use, however its last-seen reads.
        expect((await deviceRow(signedIn.deviceId))?.revokedAt).toBeNull();
        expect(await deviceRow(revokedOld.deviceId)).toBeUndefined();
        expect(await deviceRow(revokedRecent.deviceId)).toBeDefined();
    });

    test('a removed device’s tokens are forgotten once their week is over', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        const phone = await keyedDevice(user.id, 'phone');
        await auth.revokeDevice({
            userId: user.id,
            deviceId: phone.deviceId,
            sessionTokenHash: laptop.token,
        });
        await auth.cleanupExpired();
        expect(await db.select().from(removedSessionTokens)).toHaveLength(1);
        await db.update(removedSessionTokens).set({ expiresAt: new Date(Date.now() - 1) });
        await auth.cleanupExpired();
        expect(await db.select().from(removedSessionTokens)).toHaveLength(0);
    });
});

describe('password proofs a signed-in session makes', () => {
    test('an attempt is used once: a second consume finds nothing, so a proof cannot be replayed', async () => {
        const user = await account();
        const { token } = await signIn(user.id);
        const attempt = hash(randomUUID());
        await auth.createLoginAttempt({
            tokenHash: attempt,
            userId: user.id,
            credentialVersion: 1,
            profileVersion: 1,
            serverState: 'state',
            purpose: 'devices',
            sessionTokenHash: token,
            expiresAt: new Date(Date.now() + 5 * 60_000),
        });
        expect((await auth.consumeLoginAttempt(attempt))?.purpose).toBe('devices');
        expect(await auth.consumeLoginAttempt(attempt)).toBeNull();
    });

    test('a finished proof gives its start back, so only starts that never finish add up', async () => {
        const bucket = hash(`unfinished:${randomUUID()}`);
        expect(await auth.consumeRateLimit(bucket, 2, HOUR)).toBe(true);
        expect(await auth.consumeRateLimit(bucket, 2, HOUR)).toBe(true);
        await auth.releaseRateLimit(bucket);
        expect(await auth.consumeRateLimit(bucket, 2, HOUR)).toBe(true);
        expect(await auth.consumeRateLimit(bucket, 2, HOUR)).toBe(false);
        // Released down to nothing, the bucket starts again.
        const other = hash(`unfinished:${randomUUID()}`);
        await auth.consumeRateLimit(other, 1, HOUR);
        await auth.releaseRateLimit(other);
        await auth.releaseRateLimit(other);
        expect(await auth.consumeRateLimit(other, 1, HOUR)).toBe(true);
        expect(await auth.consumeRateLimit(other, 1, HOUR)).toBe(false);
    });

    test('a session left on an earlier credential does not count as signed in', async () => {
        const user = await account();
        const laptop = await keyedDevice(user.id, 'laptop');
        const phone = await keyedDevice(user.id, 'phone');
        // Only a defect could leave this: every credential change ends the account's sessions.
        await db
            .update(opaqueCredentials)
            .set({ version: 2 })
            .where(eq(opaqueCredentials.userId, user.id));
        await db
            .update(sessions)
            .set({ credentialVersion: 2 })
            .where(eq(sessions.tokenHash, laptop.token));
        const listed = await auth.listDevices(user.id, laptop.deviceId);
        expect(listed.find((device) => device.id === phone.deviceId)?.signedIn).toBe(false);
        expect(listed.find((device) => device.id === laptop.deviceId)?.signedIn).toBe(true);
    });
});
