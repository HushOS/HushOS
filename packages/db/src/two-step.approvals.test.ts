import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { registered, sha256 } from '../test/accounts';
import { closeDatabase, resetDatabase } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import {
    accountDevices,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepDeviceRequests,
    twoStepFactors,
    twoStepState,
    type TwoStepSessionPurpose,
} from './schema';
import {
    deviceSessionStatement,
    deviceStepCodeParts,
    deviceStepCommitment,
    deviceStepStatement,
} from './signatures';
import * as twoStep from './two-step';

/*
 * Approving on another device as the second step, the rows (docs/two-step-design.md 12). The
 * devices here hold real Ed25519 keys and sign real statements, since the repository checks
 * them. What must hold whatever the server does around it: only another device approves, a
 * step-up only between devices a week old, an approval passes its own token and purpose once,
 * no request outlives its token, a denied one never passes, the three budgets never share room,
 * and what was denied or left unanswered is counted as a failed step.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const fixed = (label: string, length: number) =>
    createHash('sha512').update(`hushos-approvals-test:${label}`).digest().subarray(0, length);
const codeSet = (label: string) => ({
    keyId: fixed(`${label}:key`, 8),
    hashes: Array.from({ length: 10 }, (_, index) => fixed(`${label}:code:${index}`, 32)),
});
const PHRASE = { method: 'phrase' } as const;

type Device = { token: Buffer; deviceId: string; privateKey: KeyObject; publicKey: Buffer };

function deviceKey() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        privateKey,
        publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'),
    };
}

/* Gives the session's device its key and name, as a client does right after signing in. */
async function describe_(session: { token: Buffer; deviceId: string }, name: string) {
    const key = deviceKey();
    const described = await auth.registerDevice({
        sessionTokenHash: session.token,
        kind: 'web',
        name,
        signingPublicKey: key.publicKey,
    });
    if (described.status !== 'ok') throw new Error(`Device ${described.status}.`);
    return { ...session, ...key };
}

/* A device signed in with the password alone, before the account has any second step. */
async function passwordDevice(userId: string, name: string): Promise<Device> {
    const token = sha256(randomUUID());
    const result = await auth.createSession({
        userId,
        credentialVersion: 1,
        tokenHash: token,
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + HOUR),
    });
    if (!result || 'suspended' in result || 'twoStep' in result) throw new Error('No session.');
    return describe_({ token, deviceId: result.device.id }, name);
}

/* A sign-in's step token. `device` proves that device's key, as `login/finish` carries it. */
async function loginToken(userId: string, device?: Device) {
    const tokenHash = sha256(randomUUID());
    const attemptDigest = sha256(randomUUID());
    await twoStep.createStepAttempt({
        purpose: 'login',
        tokenHash,
        userId,
        credentialVersion: 1,
        device: device
            ? {
                  id: device.deviceId,
                  attemptDigest,
                  signature: sign(
                      null,
                      deviceSessionStatement({ userId, deviceId: device.deviceId, attemptDigest }),
                      device.privateKey,
                  ),
              }
            : null,
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    return tokenHash;
}

async function changeToken(
    userId: string,
    device: Device,
    purpose: TwoStepSessionPurpose = 'two-step',
) {
    const tokenHash = sha256(randomUUID());
    await twoStep.createStepAttempt({
        purpose,
        tokenHash,
        userId,
        credentialVersion: 1,
        sessionTokenHash: device.token,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    return tokenHash;
}

/* Answers a sign-in's token: takes a slot and opens the session with `spend`. */
async function answerLogin(tokenHash: Buffer, spend: twoStep.StepSpend) {
    const taken = await twoStep.takeStepAnswer({
        tokenHash,
        method: spend.method,
        purpose: 'login',
        sessionTokenHash: null,
    });
    if (taken.status !== 'ok') return { status: `no slot: ${taken.status}` as const };
    const session = { tokenHash: sha256(randomUUID()), expiresAt: new Date(Date.now() + HOUR) };
    return { ...(await twoStep.openSteppedSession({ tokenHash, spend, session })), session };
}

/* A new device signs in with the recovery phrase: a session that passed the step. */
async function phraseDevice(userId: string, name: string): Promise<Device> {
    const answered = await answerLogin(await loginToken(userId), PHRASE);
    if (answered.status !== 'ok') throw new Error(`Step ${answered.status}.`);
    return describe_({ token: answered.session.tokenHash, deviceId: answered.device.id }, name);
}

type Asking = { purpose: string; deviceKey: Buffer; nonce: Buffer };
const asking = (purpose: string, key: Buffer = deviceKey().publicKey): Asking => ({
    purpose,
    deviceKey: key,
    nonce: randomBytes(32),
});
const commitmentOf = (tokenHash: Buffer, from: Asking) =>
    deviceStepCommitment({
        purpose: from.purpose,
        tokenDigest: tokenHash,
        deviceSigningKey: from.deviceKey,
        nonce: from.nonce,
    });

/* `chosen`: the device the person picked to answer, as the screen that turns the method on sends it. */
async function request(tokenHash: Buffer, from: Asking, chosen?: string) {
    return twoStep.createDeviceRequest({
        tokenHash,
        commitment: commitmentOf(tokenHash, from),
        kind: 'web',
        name: 'Chrome on Windows',
        approverDeviceId: chosen,
    });
}

const signedBy = (approver: Device, userId: string, id: string, tokenHash: Buffer, from: Asking) =>
    sign(
        null,
        deviceStepStatement({
            userId,
            requestId: id,
            purpose: from.purpose,
            tokenDigest: tokenHash,
            deviceSigningKey: from.deviceKey,
        }),
        approver.privateKey,
    );

/*
 * The code a request comes to, as its two numbers, worked out from what each device made
 * itself: the asking one its key and nonce, the approving one its 32 bytes. Where the method is
 * turned on the approving device shows it, and the person types it on the asking one.
 */
type Code = { number: number; word: number };
const codeOf = (
    userId: string,
    requestId: string,
    tokenHash: Buffer,
    from: Asking,
    approverKey: Buffer,
): Code =>
    deviceStepCodeParts({
        userId,
        requestId,
        purpose: from.purpose,
        tokenDigest: tokenHash,
        deviceSigningKey: from.deviceKey,
        approverKey,
        nonce: from.nonce,
    });
/* Another code than `code`: off by one in its number, or in its word. */
const not = (code: Code, part: keyof Code = 'number'): Code =>
    part === 'number'
        ? { ...code, number: (code.number + 1) % 100 }
        : { ...code, word: (code.word + 1) % 2048 };
/* What the approving device showed for each request `approved` ran. */
const shown = new Map<string, Code>();

/* The whole exchange: the request, the approving device's key, the reveal, the signature. */
async function approved(userId: string, tokenHash: Buffer, from: Asking, approver: Device) {
    // Turning the method on names the device that is to approve; nothing else does here.
    const made = await request(
        tokenHash,
        from,
        from.purpose === 'device-approval' ? approver.deviceId : undefined,
    );
    if (made.status !== 'ok') throw new Error(`Request ${made.status}.`);
    const approverKey = randomBytes(32);
    shown.set(made.id, codeOf(userId, made.id, tokenHash, from, approverKey));
    const opened = await twoStep.openDeviceRequest({
        sessionTokenHash: approver.token,
        requestId: made.id,
        approverKey,
    });
    if (opened.status !== 'ok') throw new Error(`Open ${opened.status}.`);
    const revealed = await twoStep.revealDeviceRequest({
        tokenHash,
        requestId: made.id,
        deviceKey: from.deviceKey,
        nonce: from.nonce,
    });
    if (revealed.status !== 'ok') throw new Error(`Reveal ${revealed.status}.`);
    const done = await twoStep.approveDeviceRequest({
        sessionTokenHash: approver.token,
        requestId: made.id,
        signature: signedBy(approver, userId, made.id, tokenHash, from),
    });
    if (done.status !== 'ok') throw new Error(`Approve ${done.status}.`);
    return made.id;
}

/*
 * An account with Approve on another device on, turned on the way a person does it: the laptop
 * asks, the phone (signed in with the password, like the laptop) approves.
 */
async function withDeviceStep() {
    const { user } = await registered();
    const laptop = await passwordDevice(user.id, 'Laptop');
    const phone = await passwordDevice(user.id, 'Phone');
    const tokenHash = sha256(randomUUID());
    const started = await twoStep.startDeviceFactor({
        userId: user.id,
        sessionTokenHash: laptop.token,
        credentialVersion: 1,
        tokenHash,
        expiresAt: new Date(Date.now() + 5 * MINUTE),
    });
    if (started.status !== 'ok') throw new Error(`Start ${started.status}.`);
    const from = asking('device-approval', laptop.publicKey);
    const requestId = await approved(user.id, tokenHash, from, phone);
    const confirmed = await twoStep.confirmDeviceFactor({
        userId: user.id,
        factorId: started.id,
        sessionTokenHash: laptop.token,
        credentialVersion: 1,
        tokenHash,
        requestId,
        code: shown.get(requestId)!,
        backupCodes: codeSet('first'),
    });
    if (confirmed.status !== 'ok') throw new Error(`Confirm ${confirmed.status}.`);
    return { userId: user.id, laptop, phone };
}

/* Moves when a device was approved on the account, as time would. */
const age = (device: Device, days: number) =>
    db
        .update(accountDevices)
        .set({ approvedAt: new Date(Date.now() - days * 24 * HOUR) })
        .where(eq(accountDevices.id, device.deviceId));

const requestRow = async (id: string) =>
    (await db.select().from(twoStepDeviceRequests).where(eq(twoStepDeviceRequests.id, id)))[0]!;
const accountFailures = async (userId: string) =>
    (
        await db
            .select({ failures: twoStepState.consecutiveFailures })
            .from(twoStepState)
            .where(eq(twoStepState.userId, userId))
    )[0]?.failures ?? 0;
const deviceFailures = async (device: Device) =>
    (
        await db
            .select({ failures: accountDevices.twoStepFailures })
            .from(accountDevices)
            .where(eq(accountDevices.id, device.deviceId))
    )[0]!.failures;
/* Ends a token as its five minutes would. */
const expire = (tokenHash: Buffer) =>
    db
        .update(twoStepAttempts)
        .set({
            createdAt: new Date(Date.now() - 6 * MINUTE),
            expiresAt: new Date(Date.now() - MINUTE),
        })
        .where(eq(twoStepAttempts.tokenHash, tokenHash));

/* Ends a token and its requests as five minutes passing would, for the worker's sweep to find. */
async function lapse(tokenHash: Buffer) {
    await expire(tokenHash);
    await db
        .update(twoStepDeviceRequests)
        .set({
            createdAt: new Date(Date.now() - 6 * MINUTE),
            expiresAt: new Date(Date.now() - MINUTE),
        })
        .where(eq(twoStepDeviceRequests.tokenHash, tokenHash));
}

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('turning the method on', () => {
    test('it is pending until another device approves, and the first approval turns the step on for both devices', async () => {
        const { user } = await registered();
        const laptop = await passwordDevice(user.id, 'Laptop');
        const phone = await passwordDevice(user.id, 'Phone');
        const tokenHash = sha256(randomUUID());
        const started = await twoStep.startDeviceFactor({
            userId: user.id,
            sessionTokenHash: laptop.token,
            credentialVersion: 1,
            tokenHash,
            expiresAt: new Date(Date.now() + 5 * MINUTE),
        });
        if (started.status !== 'ok') throw new Error(started.status);
        // Pending, it is no second step: the account's step is off and nothing lists it.
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        expect((await twoStep.getTwoStep(user.id)).methods).toEqual([]);

        const from = asking('device-approval', laptop.publicKey);
        const made = await request(tokenHash, from, phone.deviceId);
        if (made.status !== 'ok') throw new Error(made.status);
        const approverKey = randomBytes(32);
        const code = codeOf(user.id, made.id, tokenHash, from, approverKey);
        const confirm = (requestId: string) =>
            twoStep.confirmDeviceFactor({
                userId: user.id,
                factorId: started.id,
                sessionTokenHash: laptop.token,
                credentialVersion: 1,
                tokenHash,
                requestId,
                code,
                backupCodes: codeSet('first'),
            });
        // Nobody approved yet: asking again changes nothing.
        expect(await confirm(made.id)).toEqual({ status: 'pending' });
        expect(await twoStep.hasTwoStep(user.id)).toBe(false);
        // The device that asked cannot be the one that approves.
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: laptop.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'gone' });

        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            approverKey,
        });
        await twoStep.revealDeviceRequest({
            tokenHash,
            requestId: made.id,
            deviceKey: from.deviceKey,
            nonce: from.nonce,
        });
        // Opened and revealed is not approved: the right code confirms nothing yet.
        expect(await confirm(made.id)).toEqual({ status: 'pending' });
        await twoStep.approveDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            signature: signedBy(phone, user.id, made.id, tokenHash, from),
        });
        expect(await confirm(made.id)).toEqual({
            status: 'ok',
            turnedOn: true,
            approverDeviceId: phone.deviceId,
        });

        const status = await twoStep.getTwoStep(user.id);
        expect(status.on).toBe(true);
        expect(status.methods.map((method) => method.kind)).toEqual(['device']);
        expect(status.defaultKind).toBe('device');
        expect(status.backupCodesLeft).toBe(10);
        // Both sessions passed the step together, so each is "another device" from now on.
        const stamped = await db
            .select({ deviceId: sessions.deviceId, twoStepAt: sessions.twoStepAt })
            .from(sessions)
            .where(eq(sessions.userId, user.id));
        expect(stamped.every((session) => session.twoStepAt !== null)).toBe(true);
        expect(stamped).toHaveLength(2);
        // The token and the approval are used up: neither confirms anything again.
        expect(await confirm(made.id)).toEqual({ status: 'missing' });
        expect((await requestRow(made.id)).endedReason).toBe('used');
    });

    test('it is refused on a device without a key and on an account with no other device, and stores nothing', async () => {
        const { user } = await registered();
        const alone = await passwordDevice(user.id, 'Laptop');
        const start = (session: Buffer) =>
            twoStep.startDeviceFactor({
                userId: user.id,
                sessionTokenHash: session,
                credentialVersion: 1,
                tokenHash: sha256(randomUUID()),
                expiresAt: new Date(Date.now() + 5 * MINUTE),
            });
        expect(await start(alone.token)).toEqual({ status: 'unavailable' });
        expect(
            await twoStep.canAddDeviceStep({ userId: user.id, sessionTokenHash: alone.token }),
        ).toBe(false);
        // A second device that never got a key cannot approve, so there is still no other device.
        const keyless = sha256(randomUUID());
        await auth.createSession({
            userId: user.id,
            credentialVersion: 1,
            tokenHash: keyless,
            previousTokenHash: null,
            expiresAt: new Date(Date.now() + HOUR),
        });
        expect(await start(alone.token)).toEqual({ status: 'unavailable' });
        // And it cannot ask either.
        expect(await start(keyless)).toEqual({ status: 'unavailable' });
        expect(await db.select().from(twoStepFactors)).toEqual([]);
        expect(await db.select().from(twoStepAttempts)).toEqual([]);
    });

    test('a device-only account is one the session guard refuses a password-only session for', async () => {
        const { userId, laptop } = await withDeviceStep();
        await expect(
            db.insert(sessions).values({
                userId,
                credentialVersion: 1,
                tokenHash: sha256(randomUUID()),
                deviceId: laptop.deviceId,
                expiresAt: new Date(Date.now() + HOUR),
            }),
        ).rejects.toMatchObject({ cause: { constraint: 'sessions_two_step_guard' } });
    });

    test('removing it ends its open requests, clears the default and turns the step off when it was the last', async () => {
        const { userId, laptop } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const made = await request(tokenHash, asking('login'));
        if (made.status !== 'ok') throw new Error(made.status);
        const [factor] = await db.select().from(twoStepFactors);
        const stepToken = await changeToken(userId, laptop);
        await twoStep.takeStepAnswer({
            tokenHash: stepToken,
            method: 'phrase',
            purpose: 'two-step',
            sessionTokenHash: laptop.token,
        });
        expect(
            await twoStep.removeFactor({
                userId,
                factorId: factor!.id,
                step: { sessionTokenHash: laptop.token, tokenHash: stepToken, spend: PHRASE },
            }),
        ).toMatchObject({ status: 'ok', kind: 'device', turnedOff: true });
        expect(await requestRow(made.id)).toMatchObject({ state: 'ended', endedReason: 'off' });
        expect(await twoStep.hasTwoStep(userId)).toBe(false);
        expect(await db.select().from(twoStepBackupCodes)).toEqual([]);
        const [state] = await db.select().from(twoStepState);
        expect(state!.defaultKind).toBeNull();
    });
});

describe('a sign-in approved on another device', () => {
    test('opens the session, names the approving device on the new one, and uses the approval up', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const from = asking('login');
        const requestId = await approved(userId, tokenHash, from, phone);
        const answered = await answerLogin(tokenHash, { method: 'device', requestId });
        if (answered.status !== 'ok') throw new Error(answered.status);
        expect(answered.method).toBe('device');
        const [session] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.tokenHash, answered.session.tokenHash));
        expect(session!.twoStepAt).not.toBeNull();
        const [device] = await db
            .select()
            .from(accountDevices)
            .where(eq(accountDevices.id, answered.device.id));
        expect(device).toMatchObject({ approvedBy: 'device', approvedByDeviceId: phone.deviceId });
        expect((await requestRow(requestId)).endedReason).toBe('used');
        // The token went with it, so the same approval opens nothing a second time.
        expect((await answerLogin(tokenHash, { method: 'device', requestId })).status).toBe(
            'no slot: gone',
        );
    });

    test('before any device approved, the request passes nothing and the token keeps its answers', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const made = await request(tokenHash, asking('login'));
        if (made.status !== 'ok') throw new Error(made.status);
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            approverKey: randomBytes(32),
        });
        expect(
            (await answerLogin(tokenHash, { method: 'device', requestId: made.id })).status,
        ).toBe('gone');
        expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(2);
        // Refused, not counted: the token is still there to be answered.
        expect(await twoStep.getStepAttempt(tokenHash)).not.toBeNull();
        expect(await accountFailures(userId)).toBe(0);
    });

    test('the asking device reveals once, only after a device opened, and only what it committed to', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const from = asking('login');
        const made = await request(tokenHash, from);
        if (made.status !== 'ok') throw new Error(made.status);
        const reveal = (shown: Asking) =>
            twoStep.revealDeviceRequest({
                tokenHash,
                requestId: made.id,
                deviceKey: shown.deviceKey,
                nonce: shown.nonce,
            });
        // Nothing is revealed before an approving device has fixed its own key.
        expect(await reveal(from)).toEqual({ status: 'state' });
        expect((await requestRow(made.id)).deviceKey).toBeNull();
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            approverKey: randomBytes(32),
        });
        expect(await reveal(from)).toEqual({ status: 'ok' });
        expect(await reveal(from)).toEqual({ status: 'state' });

        // Other keys than the committed ones end the request: no code could match them.
        expect((await answerLogin(tokenHash, PHRASE)).status).toBe('ok');
        const second = await loginToken(userId);
        const other = await request(second, asking('login'));
        if (other.status !== 'ok') throw new Error(other.status);
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: other.id,
            approverKey: randomBytes(32),
        });
        expect(
            await twoStep.revealDeviceRequest({
                tokenHash: second,
                requestId: other.id,
                deviceKey: deviceKey().publicKey,
                nonce: randomBytes(32),
            }),
        ).toEqual({ status: 'mismatch' });
        expect(await requestRow(other.id)).toMatchObject({
            state: 'ended',
            endedReason: 'mismatch',
        });
    });

    test('a commitment made for another purpose or token is not what was committed to', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const from = asking('login');
        // The device committed for a password change, and the token is a sign-in's.
        const made = await twoStep.createDeviceRequest({
            tokenHash,
            commitment: commitmentOf(tokenHash, { ...from, purpose: 'password' }),
        });
        if (made.status !== 'ok') throw new Error(made.status);
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            approverKey: randomBytes(32),
        });
        expect(
            await twoStep.revealDeviceRequest({
                tokenHash,
                requestId: made.id,
                deviceKey: from.deviceKey,
                nonce: from.nonce,
            }),
        ).toEqual({ status: 'mismatch' });
    });

    test('only a signature by the approving device over this request approves it', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        const sign_ = async (
            signature: (id: string, tokenHash: Buffer, from: Asking) => Buffer,
        ) => {
            const tokenHash = await loginToken(userId);
            const from = asking('login');
            const made = await request(tokenHash, from);
            if (made.status !== 'ok') throw new Error(made.status);
            await twoStep.openDeviceRequest({
                sessionTokenHash: phone.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            });
            await twoStep.revealDeviceRequest({
                tokenHash,
                requestId: made.id,
                deviceKey: from.deviceKey,
                nonce: from.nonce,
            });
            const result = await twoStep.approveDeviceRequest({
                sessionTokenHash: phone.token,
                requestId: made.id,
                signature: signature(made.id, tokenHash, from),
            });
            return { result, tokenHash, id: made.id };
        };
        // Another device's key, though it is the account's own.
        const byLaptop = await sign_((id, tokenHash, from) =>
            signedBy(laptop, userId, id, tokenHash, from),
        );
        expect(byLaptop.result).toEqual({ status: 'signature' });
        expect(
            (await answerLogin(byLaptop.tokenHash, { method: 'device', requestId: byLaptop.id }))
                .status,
        ).toBe('gone');
        // The right key over another request's statement.
        const other = await sign_((_id, tokenHash, from) =>
            signedBy(phone, userId, randomUUID(), tokenHash, from),
        );
        expect(other.result).toEqual({ status: 'signature' });
        // The right key over a statement that names another purpose.
        const purpose = await sign_((id, tokenHash, from) =>
            signedBy(phone, userId, id, tokenHash, { ...from, purpose: 'password' }),
        );
        expect(purpose.result).toEqual({ status: 'signature' });
    });

    test('an approval passes only the token it was made for', async () => {
        const { userId, phone } = await withDeviceStep();
        const first = await loginToken(userId);
        const requestId = await approved(userId, first, asking('login'), phone);
        const second = await loginToken(userId);
        expect((await answerLogin(second, { method: 'device', requestId })).status).toBe('gone');
        expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(2);
        // Its own token still passes with it.
        expect((await answerLogin(first, { method: 'device', requestId })).status).toBe('ok');
    });

    test('a device that proved its key cannot approve its own sign-in, and must reveal its own key', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId, laptop);
        const from = asking('login', laptop.publicKey);
        const made = await request(tokenHash, from);
        if (made.status !== 'ok') throw new Error(made.status);
        expect(made.class).toBe('known');
        // The laptop's still-live session is the token's own device: it sees and opens nothing.
        expect(await twoStep.listApprovalPrompts(laptop.token)).toEqual([]);
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: laptop.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'gone' });
        expect(
            await twoStep.denyDeviceRequest({
                sessionTokenHash: laptop.token,
                requestId: made.id,
                reason: 'denied',
            }),
        ).toEqual({ status: 'gone' });
        const prompts = await twoStep.listApprovalPrompts(phone.token);
        expect(prompts.map((prompt) => prompt.id)).toEqual([made.id]);
        // What the phone is shown is the server's own record of the laptop, not what was sent.
        expect(prompts[0]!.device).toEqual({ kind: 'web', name: 'Laptop' });

        // A known device that commits to a key that is not its own is refused at the reveal.
        const second = await loginToken(userId, laptop);
        const forged = asking('login');
        const other = await request(second, forged);
        if (other.status !== 'ok') throw new Error(other.status);
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: other.id,
            approverKey: randomBytes(32),
        });
        expect(
            await twoStep.revealDeviceRequest({
                tokenHash: second,
                requestId: other.id,
                deviceKey: forged.deviceKey,
                nonce: forged.nonce,
            }),
        ).toEqual({ status: 'mismatch' });
    });

    test('only a device with a key and a session that passed the step approves; a removed one does not', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        // A session from before the step was on never passed it.
        await db
            .update(sessions)
            .set({ twoStepAt: null })
            .where(eq(sessions.tokenHash, laptop.token));
        const tokenHash = await loginToken(userId);
        const from = asking('login');
        const made = await request(tokenHash, from);
        if (made.status !== 'ok') throw new Error(made.status);
        expect(await twoStep.listApprovalPrompts(laptop.token)).toEqual([]);
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: laptop.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'gone' });

        // The phone approves, and is removed before the new device answers: its approval is void.
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            approverKey: randomBytes(32),
        });
        await twoStep.revealDeviceRequest({
            tokenHash,
            requestId: made.id,
            deviceKey: from.deviceKey,
            nonce: from.nonce,
        });
        await twoStep.approveDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            signature: signedBy(phone, userId, made.id, tokenHash, from),
        });
        await db
            .update(accountDevices)
            .set({ revokedAt: new Date() })
            .where(eq(accountDevices.id, phone.deviceId));
        expect(
            (await answerLogin(tokenHash, { method: 'device', requestId: made.id })).status,
        ).toBe('gone');
        // With no device left that may approve, the method answers no new sign-in.
        expect((await request(await loginToken(userId), asking('login'))).status).toBe(
            'unavailable',
        );
    });
});

describe('a request never outlives its token', () => {
    test('once the token has expired, nothing can open, approve or read the request', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const from = asking('login');
        const made = await request(tokenHash, from);
        if (made.status !== 'ok') throw new Error(made.status);
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            approverKey: randomBytes(32),
        });
        await twoStep.revealDeviceRequest({
            tokenHash,
            requestId: made.id,
            deviceKey: from.deviceKey,
            nonce: from.nonce,
        });
        await expire(tokenHash);
        expect(await twoStep.listApprovalPrompts(phone.token)).toEqual([]);
        expect(
            await twoStep.approveDeviceRequest({
                sessionTokenHash: phone.token,
                requestId: made.id,
                signature: signedBy(phone, userId, made.id, tokenHash, from),
            }),
        ).toEqual({ status: 'gone' });
        expect(await twoStep.getDeviceRequest({ tokenHash, requestId: made.id })).toBeNull();
        expect((await requestRow(made.id)).state).toBe('revealed');
    });

    test('an approval given in time is worth nothing once the token has expired', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const requestId = await approved(userId, tokenHash, asking('login'), phone);
        await expire(tokenHash);
        expect((await answerLogin(tokenHash, { method: 'device', requestId })).status).toBe(
            'no slot: gone',
        );
        expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(2);
    });

    test('a token passed another way ends its request, which is not a failed step', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const from = asking('login');
        const made = await request(tokenHash, from);
        if (made.status !== 'ok') throw new Error(made.status);
        expect((await answerLogin(tokenHash, PHRASE)).status).toBe('ok');
        expect(await requestRow(made.id)).toMatchObject({
            state: 'ended',
            endedReason: 'passed',
            counted: false,
        });
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: phone.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'gone' });
        expect(await twoStep.settleDeviceRequests(userId)).toEqual([]);
        expect(await accountFailures(userId)).toBe(0);
    });
});

describe('denied, wrong and unanswered requests', () => {
    test('a denied request never passes, is counted as a failed step, and leaves the token for another way', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const made = await request(tokenHash, asking('login'));
        if (made.status !== 'ok') throw new Error(made.status);
        const denied = await twoStep.denyDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            reason: 'denied',
        });
        expect(denied).toMatchObject({
            status: 'ok',
            counted: { class: 'unknown', reason: 'denied', deviceId: null, consecutiveFailures: 1 },
        });
        expect(await accountFailures(userId)).toBe(1);
        expect(
            (await answerLogin(tokenHash, { method: 'device', requestId: made.id })).status,
        ).toBe('gone');
        // Denied once: a second Deny, or the sweep, counts nothing more.
        expect(
            await twoStep.denyDeviceRequest({
                sessionTokenHash: phone.token,
                requestId: made.id,
                reason: 'not-me',
            }),
        ).toEqual({ status: 'gone' });
        await expire(tokenHash);
        expect(await twoStep.settleDeviceRequests(userId)).toEqual([]);
        expect(await accountFailures(userId)).toBe(1);
    });

    test('ending a request does not end its token: the person can still answer another way', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const made = await request(tokenHash, asking('login'));
        if (made.status !== 'ok') throw new Error(made.status);
        await twoStep.denyDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            reason: 'wrong-code',
        });
        expect((await answerLogin(tokenHash, PHRASE)).status).toBe('ok');
        // And that success starts the count over, as after any wrong answer.
        expect(await accountFailures(userId)).toBe(0);
    });

    test('a wrong code from a known device is counted on that device, never on the account', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId, laptop);
        const made = await request(tokenHash, asking('login', laptop.publicKey));
        if (made.status !== 'ok') throw new Error(made.status);
        const denied = await twoStep.denyDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            reason: 'wrong-code',
        });
        expect(denied).toMatchObject({ counted: { class: 'known', deviceId: laptop.deviceId } });
        expect(await deviceFailures(laptop)).toBe(1);
        expect(await accountFailures(userId)).toBe(0);
    });

    test('an approved request cannot be denied afterwards', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const requestId = await approved(userId, tokenHash, asking('login'), phone);
        expect(
            await twoStep.denyDeviceRequest({
                sessionTokenHash: phone.token,
                requestId,
                reason: 'denied',
            }),
        ).toEqual({ status: 'gone' });
        expect((await answerLogin(tokenHash, { method: 'device', requestId })).status).toBe('ok');
    });

    test('a request left unanswered by a sign-in that proved no device is one failed step; a known device’s is none', async () => {
        const { userId, laptop } = await withDeviceStep();
        const unknown = await loginToken(userId);
        const first = await request(unknown, asking('login'));
        // The same sign-in asks again: one sign-in left unanswered is one failed step, not two.
        const again = await request(unknown, asking('login'));
        const known = await loginToken(userId, laptop);
        const own = await request(known, asking('login', laptop.publicKey));
        if (first.status !== 'ok' || again.status !== 'ok' || own.status !== 'ok')
            throw new Error('request');
        expect(await twoStep.settleDeviceRequests(userId)).toEqual([]);
        await lapse(unknown);
        await lapse(known);
        const counted = await twoStep.settleDeviceRequests();
        expect(counted).toHaveLength(1);
        expect(counted[0]).toMatchObject({
            userId,
            class: 'unknown',
            reason: 'expired',
            consecutiveFailures: 1,
        });
        expect(await accountFailures(userId)).toBe(1);
        expect(await deviceFailures(laptop)).toBe(0);
        expect(await requestRow(own.id)).toMatchObject({
            state: 'ended',
            endedReason: 'expired',
            counted: false,
        });
        // Counted once: the next sweep finds nothing.
        expect(await twoStep.settleDeviceRequests()).toEqual([]);
        expect(await accountFailures(userId)).toBe(1);
    });

    test('the fifth request in a row that goes unanswered asks for the notice', async () => {
        const { userId } = await withDeviceStep();
        let last: twoStep.CountedRequest[] = [];
        for (let round = 0; round < 5; round++) {
            const tokenHash = await loginToken(userId);
            expect((await request(tokenHash, asking('login'))).status).toBe('ok');
            await expire(tokenHash);
            last = await twoStep.settleDeviceRequests(userId);
            expect(last).toHaveLength(1);
            expect(last[0]!.notice).toBe(round === 4);
        }
        expect(last[0]!.consecutiveFailures).toBe(5);
    });
});

describe('who may approve a change', () => {
    test('a step-up needs both devices to have been on the account for seven days', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        // Both devices are new: another device cannot answer a change at all.
        const fresh = await changeToken(userId, laptop);
        expect((await twoStep.getStepAttempt(fresh)) !== null).toBe(true);
        expect(await twoStep.deviceStepUsable((await twoStep.getStepAttempt(fresh))!)).toBe(false);
        expect((await request(fresh, asking('two-step', laptop.publicKey))).status).toBe(
            'unavailable',
        );

        // The device asking is old enough, the one that would approve is six days old.
        await age(laptop, 8);
        await age(phone, 6);
        expect((await request(fresh, asking('two-step', laptop.publicKey))).status).toBe(
            'unavailable',
        );
        // The other way round: the phone is old enough, the laptop asking is not.
        await age(laptop, 6);
        await age(phone, 8);
        expect((await request(fresh, asking('two-step', laptop.publicKey))).status).toBe(
            'unavailable',
        );
        // A sign-in is not a step-up: the same two devices still approve one.
        const signIn = await loginToken(userId);
        expect((await request(signIn, asking('login'))).status).toBe('ok');
    });

    test('a device that turns seven days old after the request was made still cannot approve it early', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        await age(laptop, 8);
        await age(phone, 8);
        const tokenHash = await changeToken(userId, laptop);
        const from = asking('two-step', laptop.publicKey);
        const made = await request(tokenHash, from);
        if (made.status !== 'ok') throw new Error(made.status);
        // The phone was replaced by a new device after the request was made.
        await age(phone, 1);
        expect(await twoStep.listApprovalPrompts(phone.token)).toEqual([]);
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: phone.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'gone' });
    });

    test('between two devices a week old, an approval passes the change it was asked for and no other', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        await age(laptop, 8);
        await age(phone, 8);
        const tokenHash = await changeToken(userId, laptop, 'two-step');
        const from = asking('two-step', laptop.publicKey);
        const requestId = await approved(userId, tokenHash, from, phone);
        // The laptop cannot approve its own change, though it is old enough.
        expect(await twoStep.listApprovalPrompts(laptop.token)).toEqual([]);

        // The same approval, offered for a password change's token from the same session.
        const password = await changeToken(userId, laptop, 'password');
        await twoStep.takeStepAnswer({
            tokenHash: password,
            method: 'device',
            purpose: 'password',
            sessionTokenHash: laptop.token,
        });
        expect(
            await twoStep.replaceBackupCodes({
                userId,
                ...codeSet('stolen'),
                step: {
                    sessionTokenHash: laptop.token,
                    tokenHash: password,
                    spend: { method: 'device', requestId },
                },
            }),
        ).toMatchObject({ status: 'two-step', reason: 'gone' });

        await twoStep.takeStepAnswer({
            tokenHash,
            method: 'device',
            purpose: 'two-step',
            sessionTokenHash: laptop.token,
        });
        expect(
            await twoStep.replaceBackupCodes({
                userId,
                ...codeSet('second'),
                step: {
                    sessionTokenHash: laptop.token,
                    tokenHash,
                    spend: { method: 'device', requestId },
                },
            }),
        ).toEqual({ status: 'ok' });
        const codes = await db.select().from(twoStepBackupCodes);
        expect(codes.every((code) => code.keyId.equals(fixed('second:key', 8)))).toBe(true);
    });
});

describe('budgets', () => {
    test('a sign-in that proved no device has five requests a day for the account, and they are not the known devices’', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        await age(laptop, 8);
        await age(phone, 8);
        for (let round = 0; round < 5; round++)
            expect((await request(await loginToken(userId), asking('login'))).status).toBe('ok');
        expect((await request(await loginToken(userId), asking('login'))).status).toBe('limit');
        // The owner's own devices are untouched by that: each has its own room.
        const known = await request(
            await loginToken(userId, laptop),
            asking('login', laptop.publicKey),
        );
        expect(known).toMatchObject({ status: 'ok', class: 'known' });
        const change = await request(
            await changeToken(userId, laptop),
            asking('two-step', laptop.publicKey),
        );
        expect(change).toMatchObject({ status: 'ok', class: 'change' });
        // A day later the account's budget is back.
        await db
            .update(twoStepDeviceRequests)
            .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
            .where(eq(twoStepDeviceRequests.class, 'unknown'));
        expect((await request(await loginToken(userId), asking('login'))).status).toBe('ok');
    });

    test('a known device’s five requests are its own: they take nothing from another device or from new sign-ins', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        for (let round = 0; round < 5; round++)
            expect(
                (await request(await loginToken(userId, laptop), asking('login', laptop.publicKey)))
                    .status,
            ).toBe('ok');
        expect(
            (await request(await loginToken(userId, laptop), asking('login', laptop.publicKey)))
                .status,
        ).toBe('limit');
        expect(
            (await request(await loginToken(userId, phone), asking('login', phone.publicKey)))
                .status,
        ).toBe('ok');
        expect((await request(await loginToken(userId), asking('login'))).status).toBe('ok');
    });

    test('step-ups have five a day for a device and ten for the account, apart from sign-ins', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        const tablet = await phraseDevice(userId, 'Tablet');
        for (const device of [laptop, phone, tablet]) await age(device, 8);
        // The request that turned the method on was the laptop's, more than a day ago.
        await db
            .update(twoStepDeviceRequests)
            .set({ createdAt: new Date(Date.now() - 25 * HOUR) })
            .where(eq(twoStepDeviceRequests.purpose, 'device-approval'));
        const change = async (device: Device) =>
            (await request(await changeToken(userId, device), asking('two-step', device.publicKey)))
                .status;
        for (let round = 0; round < 5; round++) expect(await change(laptop)).toBe('ok');
        expect(await change(laptop)).toBe('limit');
        for (let round = 0; round < 5; round++) expect(await change(phone)).toBe('ok');
        // The tablet has made none, and the account's ten are spent.
        expect(await change(tablet)).toBe('limit');
        // Sign-ins are another class: both kinds still have all their room.
        expect((await request(await loginToken(userId), asking('login'))).status).toBe('ok');
        expect(
            (await request(await loginToken(userId, tablet), asking('login', tablet.publicKey)))
                .status,
        ).toBe('ok');
    });

    test('one request is open at a time for new sign-ins: a newer one replaces it until a device has it in hand', async () => {
        const { userId, phone } = await withDeviceStep();
        const first = await request(await loginToken(userId), asking('login'));
        const second = await request(await loginToken(userId), asking('login'));
        if (first.status !== 'ok' || second.status !== 'ok') throw new Error('request');
        expect(await requestRow(first.id)).toMatchObject({
            state: 'ended',
            endedReason: 'replaced',
        });
        expect((await twoStep.listApprovalPrompts(phone.token)).map((prompt) => prompt.id)).toEqual(
            [second.id],
        );
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: second.id,
            approverKey: randomBytes(32),
        });
        // Someone else's sign-in cannot push aside the one the owner is answering.
        expect((await request(await loginToken(userId), asking('login'))).status).toBe('busy');
        expect((await requestRow(second.id)).state).toBe('opened');
        // And a refused request spent nothing of the day's budget.
        const made = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(twoStepDeviceRequests)
            .where(
                and(
                    eq(twoStepDeviceRequests.userId, userId),
                    eq(twoStepDeviceRequests.class, 'unknown'),
                ),
            );
        expect(made[0]!.count).toBe(2);
    });

    test('a request another device opened is not shown to, or taken by, a third', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        const made = await request(await loginToken(userId), asking('login'));
        if (made.status !== 'ok') throw new Error(made.status);
        const key = randomBytes(32);
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: phone.token,
                requestId: made.id,
                approverKey: key,
            }),
        ).toEqual({ status: 'ok', approverKey: key });
        expect(await twoStep.listApprovalPrompts(laptop.token)).toEqual([]);
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: laptop.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'taken' });
        // The device that opened it gets its first key back, never a second one.
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: phone.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'ok', approverKey: key });
    });
});

describe('where the asking device is', () => {
    const PLACE = 'near Lyon, France';
    const located = (tokenHash: Buffer, from: Asking) =>
        twoStep.createDeviceRequest({
            tokenHash,
            commitment: commitmentOf(tokenHash, from),
            kind: 'web',
            name: 'Chrome on Windows',
            location: PLACE,
        });
    const placeOf = async (id: string) => (await requestRow(id)).location;

    test('is shown to the approving device while the request is open, and to it alone', async () => {
        const { userId, phone } = await withDeviceStep();
        const made = await located(await loginToken(userId), asking('login'));
        if (made.status !== 'ok') throw new Error(made.status);
        const [prompt] = await twoStep.listApprovalPrompts(phone.token);
        expect(prompt).toMatchObject({ id: made.id, location: PLACE });
        // A request made where the server was told nothing has no place, not an empty one.
        const bare = await request(await loginToken(userId), asking('login'));
        if (bare.status !== 'ok') throw new Error(bare.status);
        expect(await placeOf(bare.id)).toBeNull();
    });

    test('is deleted however the request ends', async () => {
        const { userId, phone } = await withDeviceStep();
        const open = async () => {
            const tokenHash = await loginToken(userId);
            const from = asking('login');
            const made = await located(tokenHash, from);
            if (made.status !== 'ok') throw new Error(made.status);
            expect(await placeOf(made.id)).toBe(PLACE);
            return { tokenHash, from, id: made.id };
        };

        // Denied.
        const denied = await open();
        await twoStep.denyDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: denied.id,
            reason: 'denied',
        });
        expect(await requestRow(denied.id)).toMatchObject({ state: 'ended', location: null });

        // Replaced by a newer request.
        const replaced = await open();
        const newer = await open();
        expect(await requestRow(replaced.id)).toMatchObject({
            endedReason: 'replaced',
            location: null,
        });

        // The step passed another way.
        expect((await answerLogin(newer.tokenHash, PHRASE)).status).toBe('ok');
        expect(await requestRow(newer.id)).toMatchObject({ endedReason: 'passed', location: null });

        // Approved and used: the place went with the request, not with the sign-in.
        const used = await open();
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: used.id,
            approverKey: randomBytes(32),
        });
        await twoStep.revealDeviceRequest({
            tokenHash: used.tokenHash,
            requestId: used.id,
            deviceKey: used.from.deviceKey,
            nonce: used.from.nonce,
        });
        await twoStep.approveDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: used.id,
            signature: signedBy(phone, userId, used.id, used.tokenHash, used.from),
        });
        // Still open while approved and unused: the approving device may be looking at it.
        expect(await placeOf(used.id)).toBe(PLACE);
        expect(
            (await answerLogin(used.tokenHash, { method: 'device', requestId: used.id })).status,
        ).toBe('ok');
        expect(await requestRow(used.id)).toMatchObject({ endedReason: 'used', location: null });

        // Left unanswered until its token ran out.
        const left = await open();
        await expire(left.tokenHash);
        await twoStep.settleDeviceRequests(userId);
        expect(await requestRow(left.id)).toMatchObject({ endedReason: 'expired', location: null });

        // Whatever the code above it does, the table keeps no place on a request that ended.
        expect(await db.select().from(twoStepDeviceRequests)).toSatisfy(
            (rows: { location: string | null }[]) => rows.every((row) => row.location === null),
        );
        await expect(
            db
                .update(twoStepDeviceRequests)
                .set({ location: PLACE })
                .where(eq(twoStepDeviceRequests.id, denied.id)),
        ).rejects.toMatchObject({
            cause: { constraint: 'two_step_device_requests_location_valid' },
        });
    });

    test('goes when the method is turned off with a request still open', async () => {
        const { userId, laptop } = await withDeviceStep();
        const made = await located(await loginToken(userId), asking('login'));
        if (made.status !== 'ok') throw new Error(made.status);
        const [factor] = await db.select().from(twoStepFactors);
        const stepToken = await changeToken(userId, laptop);
        await twoStep.takeStepAnswer({
            tokenHash: stepToken,
            method: 'phrase',
            purpose: 'two-step',
            sessionTokenHash: laptop.token,
        });
        await twoStep.removeFactor({
            userId,
            factorId: factor!.id,
            step: { sessionTokenHash: laptop.token, tokenHash: stepToken, spend: PHRASE },
        });
        expect(await requestRow(made.id)).toMatchObject({ endedReason: 'off', location: null });
    });
});

describe('the approval that turns the method on is the chosen device’s alone', () => {
    async function starting() {
        const { user } = await registered();
        const laptop = await passwordDevice(user.id, 'Laptop');
        const phone = await passwordDevice(user.id, 'Phone');
        // Someone else, with the password: signed in, with a device key, like the other two.
        const intruder = await passwordDevice(user.id, 'Chrome on Windows');
        const tokenHash = sha256(randomUUID());
        const started = await twoStep.startDeviceFactor({
            userId: user.id,
            sessionTokenHash: laptop.token,
            credentialVersion: 1,
            tokenHash,
            expiresAt: new Date(Date.now() + 5 * MINUTE),
        });
        if (started.status !== 'ok') throw new Error(started.status);
        return { userId: user.id, laptop, phone, intruder, tokenHash, factorId: started.id };
    }

    /*
     * The list the person chose from is made of the devices' own words, so the one chosen may
     * be somebody else's that calls itself theirs. Its approval is real, and worth nothing
     * without the code it shows: the person cannot read a screen they are not holding.
     */
    test('a chosen device the person is not holding approves, and the method is still not turned on', async () => {
        const { userId, laptop, phone, intruder, tokenHash, factorId } = await starting();
        const from = asking('device-approval', laptop.publicKey);
        // The intruder's browser, picked from the list by the name it gave itself, approves.
        const requestId = await approved(userId, tokenHash, from, intruder);
        const code = shown.get(requestId)!;
        const confirm = (session: Device, typed: Code) =>
            twoStep.confirmDeviceFactor({
                userId,
                factorId,
                sessionTokenHash: session.token,
                credentialVersion: 1,
                tokenHash,
                requestId,
                code: typed,
                backupCodes: codeSet('first'),
            });
        // The intruder knows the code, and it is no use to it: the setup is the laptop's.
        expect(await confirm(intruder, code)).toEqual({ status: 'missing' });
        expect(await confirm(phone, code)).toEqual({ status: 'missing' });
        expect((await requestRow(requestId)).state).toBe('approved');
        // The person at the laptop sees no code. A guess is one in 204,800, and the only one:
        // the request ends, and it is a failed step of the laptop's.
        expect(await confirm(laptop, not(code))).toMatchObject({
            status: 'code',
            counted: { userId, requestId, reason: 'wrong-code', deviceId: laptop.deviceId },
        });
        expect(await requestRow(requestId)).toMatchObject({
            state: 'ended',
            endedReason: 'wrong-code',
            counted: true,
        });
        expect(await deviceFailures(laptop)).toBe(1);
        // Even the right code, after that.
        expect(await confirm(laptop, code)).toEqual({ status: 'missing' });
        expect(await twoStep.hasTwoStep(userId)).toBe(false);
        const stamps = await db
            .select({ twoStepAt: sessions.twoStepAt })
            .from(sessions)
            .where(eq(sessions.userId, userId));
        expect(stamps.every((session) => session.twoStepAt === null)).toBe(true);
    });

    test('the code is the whole code: the right number with another word, or the word with another number, is wrong', async () => {
        const { userId, laptop, phone, tokenHash, factorId } = await starting();
        const from = asking('device-approval', laptop.publicKey);
        for (const part of ['number', 'word'] as const) {
            const requestId = await approved(userId, tokenHash, from, phone);
            expect(
                await twoStep.confirmDeviceFactor({
                    userId,
                    factorId,
                    sessionTokenHash: laptop.token,
                    credentialVersion: 1,
                    tokenHash,
                    requestId,
                    code: not(shown.get(requestId)!, part),
                    backupCodes: codeSet('first'),
                }),
            ).toMatchObject({ status: 'code' });
            expect(await twoStep.hasTwoStep(userId)).toBe(false);
        }
        // A request of its own again, and the code that phone shows for it: on.
        const requestId = await approved(userId, tokenHash, from, phone);
        expect(
            await twoStep.confirmDeviceFactor({
                userId,
                factorId,
                sessionTokenHash: laptop.token,
                credentialVersion: 1,
                tokenHash,
                requestId,
                code: shown.get(requestId)!,
                backupCodes: codeSet('first'),
            }),
        ).toMatchObject({ status: 'ok', turnedOn: true });
    });

    test('a third signed-in device cannot see, open, approve or end it, and gains nothing from it', async () => {
        const { userId, laptop, phone, intruder, tokenHash, factorId } = await starting();
        const from = asking('device-approval', laptop.publicKey);
        const made = await request(tokenHash, from, phone.deviceId);
        if (made.status !== 'ok') throw new Error(made.status);

        expect(await twoStep.listApprovalPrompts(intruder.token)).toEqual([]);
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: intruder.token,
                requestId: made.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'gone' });
        expect(
            await twoStep.denyDeviceRequest({
                sessionTokenHash: intruder.token,
                requestId: made.id,
                reason: 'denied',
            }),
        ).toEqual({ status: 'gone' });
        // The phone was chosen: it is told so, opens it, and the reveal follows.
        const [prompt] = await twoStep.listApprovalPrompts(phone.token);
        expect(prompt).toMatchObject({ id: made.id, chosen: true, selfNamed: false });
        const approverKey = randomBytes(32);
        await twoStep.openDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            approverKey,
        });
        await twoStep.revealDeviceRequest({
            tokenHash,
            requestId: made.id,
            deviceKey: from.deviceKey,
            nonce: from.nonce,
        });
        // Even with a signature of its own over the right statement, the third device approves nothing.
        expect(
            await twoStep.approveDeviceRequest({
                sessionTokenHash: intruder.token,
                requestId: made.id,
                signature: signedBy(intruder, userId, made.id, tokenHash, from),
            }),
        ).toEqual({ status: 'gone' });
        expect((await requestRow(made.id)).state).toBe('revealed');

        await twoStep.approveDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: made.id,
            signature: signedBy(phone, userId, made.id, tokenHash, from),
        });
        expect(
            await twoStep.confirmDeviceFactor({
                userId,
                factorId,
                sessionTokenHash: laptop.token,
                credentialVersion: 1,
                tokenHash,
                requestId: made.id,
                code: codeOf(userId, made.id, tokenHash, from, approverKey),
                backupCodes: codeSet('first'),
            }),
        ).toMatchObject({ status: 'ok', turnedOn: true, approverDeviceId: phone.deviceId });
        // The step is on, and only the two devices that took part passed it: the third one's
        // session has no stamp, so it approves no sign-in, its own included.
        const stamps = await db
            .select({ deviceId: sessions.deviceId, twoStepAt: sessions.twoStepAt })
            .from(sessions)
            .where(eq(sessions.userId, userId));
        expect(stamps.find((row) => row.deviceId === intruder.deviceId)!.twoStepAt).toBeNull();
        expect(stamps.filter((row) => row.twoStepAt !== null)).toHaveLength(2);
        const signIn = await request(await loginToken(userId), asking('login'));
        if (signIn.status !== 'ok') throw new Error(signIn.status);
        expect(await twoStep.listApprovalPrompts(intruder.token)).toEqual([]);
        expect(
            await twoStep.openDeviceRequest({
                sessionTokenHash: intruder.token,
                requestId: signIn.id,
                approverKey: randomBytes(32),
            }),
        ).toEqual({ status: 'gone' });
    });

    test('it is refused without a choice, and with a choice that is not another device of the account', async () => {
        const { laptop, phone, tokenHash } = await starting();
        const from = asking('device-approval', laptop.publicKey);
        expect((await request(tokenHash, from)).status).toBe('choice');
        // The asking device itself, a device that does not exist, and another account's device.
        expect((await request(tokenHash, from, laptop.deviceId)).status).toBe('unavailable');
        expect((await request(tokenHash, from, randomUUID())).status).toBe('unavailable');
        const other = await registered();
        const theirs = await passwordDevice(other.user.id, 'Elsewhere');
        expect((await request(tokenHash, from, theirs.deviceId)).status).toBe('unavailable');
        expect(await db.select().from(twoStepDeviceRequests)).toEqual([]);
        expect((await request(tokenHash, from, phone.deviceId)).status).toBe('ok');
    });

    test('a sign-in cannot name who answers it: any device that may approve still can', async () => {
        const { userId, laptop, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        // Whoever holds only the password asks for the laptop alone to answer.
        const made = await request(tokenHash, asking('login'), laptop.deviceId);
        if (made.status !== 'ok') throw new Error(made.status);
        expect((await requestRow(made.id)).chosenDeviceId).toBeNull();
        expect((await twoStep.listApprovalPrompts(phone.token)).map((prompt) => prompt.id)).toEqual(
            [made.id],
        );
        // And what it calls itself is marked as its own words, for the prompt to say so.
        expect((await twoStep.listApprovalPrompts(phone.token))[0]).toMatchObject({
            selfNamed: true,
            chosen: false,
        });
    });
});

describe('one sign-in is one failed step at most', () => {
    test('a replaced request whose successor was denied is not counted again when the token runs out', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        const first = await request(tokenHash, asking('login'));
        const second = await request(tokenHash, asking('login'));
        if (first.status !== 'ok' || second.status !== 'ok') throw new Error('request');
        await twoStep.denyDeviceRequest({
            sessionTokenHash: phone.token,
            requestId: second.id,
            reason: 'denied',
        });
        expect(await accountFailures(userId)).toBe(1);
        await expire(tokenHash);
        expect(await twoStep.settleDeviceRequests(userId)).toEqual([]);
        expect(await accountFailures(userId)).toBe(1);
        expect(await requestRow(first.id)).toMatchObject({ state: 'ended', counted: false });
    });

    test('a request a device approved was answered: left unused, it is not a failed step', async () => {
        const { userId, phone } = await withDeviceStep();
        const tokenHash = await loginToken(userId);
        // The person asked twice; the second was approved, and then they closed the page.
        const replaced = await request(tokenHash, asking('login'));
        const requestId = await approved(userId, tokenHash, asking('login'), phone);
        if (replaced.status !== 'ok') throw new Error(replaced.status);
        await expire(tokenHash);
        expect(await twoStep.settleDeviceRequests(userId)).toEqual([]);
        expect(await accountFailures(userId)).toBe(0);
        expect(await requestRow(requestId)).toMatchObject({
            state: 'ended',
            endedReason: 'expired',
            counted: false,
        });
    });
});

describe('the sweep', () => {
    test('one account that cannot be settled does not keep the accounts after it waiting', async () => {
        const stuck = await withDeviceStep();
        const fine = await withDeviceStep();
        for (const account of [stuck, fine]) {
            const tokenHash = await loginToken(account.userId);
            expect((await request(tokenHash, asking('login'))).status).toBe('ok');
            await lapse(tokenHash);
        }
        // A fault in one account's rows: every write to its requests fails.
        await db.execute(
            sql`create function approvals_test_fault() returns trigger language plpgsql as $$ begin raise exception 'fault'; end $$`,
        );
        await db.execute(
            sql.raw(
                `create trigger approvals_test_fault before update on two_step_device_requests for each row when (old.user_id = '${stuck.userId}') execute function approvals_test_fault()`,
            ),
        );
        try {
            const failed: string[] = [];
            const counted = await twoStep.settleDeviceRequests(undefined, (accounts) =>
                failed.push(...accounts.map((account) => account.userId)),
            );
            expect(failed).toEqual([stuck.userId]);
            expect(counted.map((request) => request.userId)).toEqual([fine.userId]);
            expect(await accountFailures(fine.userId)).toBe(1);
            expect(await accountFailures(stuck.userId)).toBe(0);
        } finally {
            await db.execute(sql`drop trigger approvals_test_fault on two_step_device_requests`);
            await db.execute(sql`drop function approvals_test_fault()`);
        }
        // The fault gone, the next sweep settles what the last one could not.
        const later = await twoStep.settleDeviceRequests();
        expect(later.map((request) => request.userId)).toEqual([stuck.userId]);
    });
});
