import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    deviceStepCode,
    deviceStepCommitment,
    deviceStepStatement,
} from '@hushos/crypto/device-approval';
import { stepTokenDigest } from '@hushos/crypto/two-step';
import { signingKeyFromSeed } from '../../../../../packages/db/test/helpers';
import { loadEdge, type Account, type Edge } from '@/test/auth-edge.server';

/*
 * Approve on another device as the second step, through the HTTP edge with real OPAQUE,
 * Postgres and device keys (docs/two-step-design.md 12). The two devices here do what the
 * clients do: commit, open, reveal, compare the code, sign. What must hold whatever a client
 * sends: an answer before the approval is `step-pending` and costs nothing; an approval passes
 * its own token and purpose and nothing else; the token's own device never approves; a change
 * is approved only between devices a week old; a denied request never passes and is a failed
 * step; no request outlives its token; a client that did not name the method is never shown it;
 * and no notice carries a device's name.
 */

let edge: Edge;

beforeAll(async () => {
    edge = await loadEdge({ TWO_STEP_ENABLED: 'true', NOTIFICATIONS_ENABLED: 'true' });
});
beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await reset();
    edge.outbox.length = 0;
    edge.emitted.length = 0;
    edge.state.address = '203.0.113.1';
});
afterEach(async () => {
    vi.useRealTimers();
    // Notices and pings go out after the reply and are not awaited: let the last ones land.
    await edge.quiet();
});
afterAll(() => edge.closeDatabase());

/*
 * Every request here ends by pinging the account's devices or sending a notice, after its
 * reply. One still writing when the next test truncates the tables can deadlock with it;
 * Postgres then ends one of the two, and the truncate is simply run again.
 */
async function reset() {
    for (let attempt = 1; ; attempt++) {
        try {
            return await edge.resetDatabase();
        } catch (error) {
            const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
            if (code !== '40P01' || attempt >= 4) throw error;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
}

const ALL = ['webauthn', 'device'];
type Signed = { cookie: string; deviceId: string; seed: Buffer; key: string };
type Step = {
    token: string;
    methods: string[];
    withheld?: true;
    defaultUnavailable?: true;
    phrase: { userId: string; recoveryVersion: number; wrappingSalt: string };
};

/* A device signed in with the password, with a device key and the name it gave itself. */
async function device(who: Account, name: string): Promise<Signed> {
    const reply = await edge.signIn(who);
    expect(reply.status).toBe(200);
    const cookie = reply.session!;
    const seed = randomBytes(32);
    const key = signingKeyFromSeed(seed).publicKey.toString('base64url');
    const registered = await edge.call(
        'POST',
        '/devices',
        { kind: 'web', name, signingPublicKey: key },
        { cookie },
    );
    expect(registered.status).toBe(200);
    return { cookie, deviceId: reply.body.device.id as string, seed, key };
}

const password = async (cookie: string) =>
    (await edge.passwordProof('/two-step/reauth', {}, { cookie })).proof;
const prompts = async (cookie: string) =>
    (await edge.call('GET', '/approvals', undefined, { cookie })).body.approvals as {
        id: string;
        purpose: string;
        class: string;
        device: { kind: string | null; name: string | null };
        tokenDigest: string;
        commitment: string;
        approverKey?: string;
        reveal?: { deviceSigningKey: string; nonce: string };
    }[];
const status = (id: string, token: string, cookie?: string) =>
    edge.call('GET', `/approvals/${id}`, undefined, {
        cookie,
        headers: { 'x-step-token': token },
    });
const events = async (cookie: string) =>
    (
        (await edge.call('GET', '/security-events', undefined, { cookie })).body.events as {
            kind: string;
            method: string | null;
        }[]
    ).map(({ kind, method }) => `${kind}:${method}`);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/* What the asking device does first: its commitment, for this token and purpose. */
async function ask(
    token: string,
    purpose: string,
    key: string,
    options: { cookie?: string; name?: string } = {},
) {
    const nonce = b64(randomBytes(32));
    const tokenDigest = await stepTokenDigest(token);
    const commitment = await deviceStepCommitment({
        purpose,
        tokenDigest,
        deviceSigningKey: key,
        nonce,
    });
    const reply = await edge.call(
        'POST',
        '/approvals',
        { stepToken: token, commitment, kind: 'web', name: options.name ?? 'Chrome on Windows' },
        { cookie: options.cookie },
    );
    return { reply, nonce, tokenDigest, key, purpose, token, cookie: options.cookie };
}
type Asked = Awaited<ReturnType<typeof ask>>;

/*
 * The approving device's part, as its client does it: open with a fresh value, wait for the
 * reveal, check it against the commitment it saw first, and sign only if the codes agree.
 * Answers both codes, so a test can see they are the same one.
 */
async function approveFrom(approver: Signed, userId: string, asked: Asked) {
    const id = asked.reply.body.requestId as string;
    const before = (await prompts(approver.cookie)).find((prompt) => prompt.id === id)!;
    const opened = await edge.call(
        'POST',
        `/approvals/${id}/open`,
        { ephemeralKey: b64(randomBytes(32)) },
        { cookie: approver.cookie },
    );
    expect(opened.status).toBe(200);
    const approverKey = opened.body.approverKey as string;
    // The asking device learns the approving device's value, and only then reveals.
    const seen = await status(id, asked.token, asked.cookie);
    expect(seen.body).toEqual({ state: 'opened', approverKey });
    const revealed = await edge.call(
        'POST',
        `/approvals/${id}/reveal`,
        { stepToken: asked.token, deviceSigningKey: asked.key, nonce: asked.nonce },
        { cookie: asked.cookie },
    );
    expect(revealed.status).toBe(200);
    const after = (await prompts(approver.cookie)).find((prompt) => prompt.id === id)!;
    expect(
        await deviceStepCommitment({
            purpose: before.purpose,
            tokenDigest: before.tokenDigest,
            deviceSigningKey: after.reveal!.deviceSigningKey,
            nonce: after.reveal!.nonce,
        }),
    ).toBe(before.commitment);
    const step = {
        userId,
        requestId: id,
        purpose: before.purpose,
        tokenDigest: before.tokenDigest,
        deviceSigningKey: after.reveal!.deviceSigningKey,
    };
    const theirs = await deviceStepCode({ ...step, approverKey, nonce: after.reveal!.nonce });
    const ours = await deviceStepCode({
        userId: asked.reply.body.userId,
        requestId: id,
        purpose: asked.purpose,
        tokenDigest: asked.tokenDigest,
        deviceSigningKey: asked.key,
        approverKey,
        nonce: asked.nonce,
    });
    const approved = await edge.call(
        'POST',
        `/approvals/${id}/approve`,
        {
            signature: signingKeyFromSeed(approver.seed)
                .sign(Buffer.from(deviceStepStatement(step)))
                .toString('base64url'),
        },
        { cookie: approver.cookie },
    );
    return { approved, id, codes: { asking: ours, approving: theirs } };
}

/* An account with the method on: the laptop asked, the phone approved. */
async function withDeviceStep() {
    const who = await edge.account();
    const laptop = await device(who, 'Maya’s Laptop');
    const phone = await device(who, 'Maya’s Phone');
    const started = await edge.call('POST', '/two-step/device', await password(laptop.cookie), {
        cookie: laptop.cookie,
    });
    expect(started.status).toBe(200);
    const asked = await ask(started.body.token, 'device-approval', laptop.key, {
        cookie: laptop.cookie,
    });
    expect(asked.reply.status).toBe(200);
    const { approved, id } = await approveFrom(phone, who.userId, asked);
    expect(approved.status).toBe(200);
    const confirmed = await edge.call(
        'POST',
        `/two-step/device/${started.body.id}/confirm`,
        { token: started.body.token, requestId: id },
        { cookie: laptop.cookie },
    );
    expect(confirmed.status).toBe(200);
    return { who, laptop, phone, codes: confirmed.body.backupCodes as string[] };
}

/* A sign-in as far as the step, from a client that names `methods` (null: one from before passkeys). */
async function toStep(who: Account, methods: string[] | null = ALL, proof?: Signed) {
    const reply = await edge.signIn(who, {
        twoStep: true,
        ...(methods ? { methods } : {}),
        ...(proof ? { device: { deviceId: proof.deviceId, seed: proof.seed } } : {}),
    });
    expect(reply.status).toBe(200);
    expect(reply.session).toBeUndefined();
    return reply.body.twoStep as Step;
}
const answer = (token: string, proof: unknown) =>
    edge.call('POST', '/login/two-step', { token, proof });
/* Moves when a device was approved on the account, as time would. The id is the server's own. */
const age = (signed: Signed, days: number) => {
    if (!/^[0-9a-f-]{36}$/.test(signed.deviceId) || !Number.isInteger(days)) throw new Error('age');
    return edge.db.execute(
        `update account_devices set approved_at = now() - interval '${days} days' where id = '${signed.deviceId}'`,
    );
};
const newKey = () => signingKeyFromSeed(randomBytes(32)).publicKey.toString('base64url');

describe('turning it on', () => {
    test('one real approval from another device confirms it, turns the step on and tells the account, naming no device', async () => {
        const who = await edge.account();
        const laptop = await device(who, 'Maya’s Laptop');
        const phone = await device(who, 'Maya’s Phone');
        const settings = async (cookie: string, query = '?methods=webauthn,device') =>
            (await edge.call('GET', `/two-step${query}`, undefined, { cookie })).body;
        expect(await settings(laptop.cookie)).toMatchObject({ on: false, otherDevice: true });

        const started = await edge.call('POST', '/two-step/device', await password(laptop.cookie), {
            cookie: laptop.cookie,
        });
        expect(started.status).toBe(200);
        const confirm = (requestId: string) =>
            edge.call(
                'POST',
                `/two-step/device/${started.body.id}/confirm`,
                { token: started.body.token, requestId },
                { cookie: laptop.cookie },
            );
        const asked = await ask(started.body.token, 'device-approval', laptop.key, {
            cookie: laptop.cookie,
        });
        expect(asked.reply.status).toBe(200);
        // Pending, it is no step: the account still signs in with its password alone.
        expect((await confirm(asked.reply.body.requestId)).body.code).toBe('step-pending');
        expect((await settings(laptop.cookie)).on).toBe(false);
        expect((await edge.signIn(who)).status).toBe(200);

        // The phone is shown what is asked and by which device, as the server knows it; the
        // laptop is shown nothing, since the request is its own.
        const [shown] = await prompts(phone.cookie);
        expect(shown).toMatchObject({
            purpose: 'device-approval',
            class: 'change',
            device: { kind: 'web', name: 'Maya’s Laptop' },
        });
        expect(await prompts(laptop.cookie)).toEqual([]);

        const { approved, id, codes } = await approveFrom(phone, who.userId, asked);
        expect(approved.status).toBe(200);
        // Both screens show the same two digits and a word.
        expect(codes.asking).toBe(codes.approving);
        expect(codes.asking).toMatch(/^\d{2} [a-z]+$/);

        const confirmed = await confirm(id);
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.backupCodes).toHaveLength(10);
        expect(await settings(laptop.cookie)).toMatchObject({
            on: true,
            defaultKind: 'device',
            backupCodesLeft: 10,
            methods: [{ kind: 'device', name: null }],
        });
        // The password alone no longer signs in.
        expect((await edge.signIn(who)).body.code).toBe('update-required');
        // The same approval turns nothing on twice.
        expect((await confirm(id)).status).toBe(404);

        const [told] = await edge.notices('two-step-on');
        expect(told).toMatchObject({ to: who.email, method: 'Another of your devices' });
        expect(await events(laptop.cookie)).toContain('two-step-on:device');
        for (const notice of edge.outbox) expect(notice.text).not.toMatch(/Maya’s|Laptop|Phone/);
    });

    test('a client that does not name the method never sees it, in settings or at a step', async () => {
        const { who, laptop } = await withDeviceStep();
        const list = async (query: string) =>
            (await edge.call('GET', `/two-step${query}`, undefined, { cookie: laptop.cookie }))
                .body;
        // 1.6 names nothing; 1.7 names passkeys. Both see the step as on, with no method of theirs.
        for (const query of ['', '?methods=webauthn']) {
            const seen = await list(query);
            expect(seen.on).toBe(true);
            expect(seen.methods).toEqual([]);
            expect(seen).not.toHaveProperty('otherDevice');
        }
        expect((await list('?methods=webauthn,device')).methods).toHaveLength(1);

        // At sign-in, 1.6 gets the two ways back and no hint it could not read.
        const old = await toStep(who, null);
        expect(old.methods).toEqual(['backup', 'phrase']);
        expect(old).not.toHaveProperty('withheld');
        expect(old).not.toHaveProperty('defaultUnavailable');
        // 1.7 is told a way was left out and that the usual one is not on offer.
        const passkeys = await toStep(who, ['webauthn']);
        expect(passkeys.methods).toEqual(['backup', 'phrase']);
        expect(passkeys).toMatchObject({ withheld: true, defaultUnavailable: true });
        // A client that names it is offered it first: it is the account's default.
        const current = await toStep(who);
        expect(current.methods).toEqual(['device', 'backup', 'phrase']);
        expect(current).not.toHaveProperty('withheld');

        // A request made with a token whose client never named the method still runs: what a
        // token can pass with does not depend on what was asked for it.
        const made = await ask(old.token, 'login', newKey());
        expect(made.reply.status).toBe(200);
    });

    test('it is not offered where no other device could approve', async () => {
        const who = await edge.account();
        const alone = await device(who, 'Laptop');
        expect(
            (
                await edge.call('GET', '/two-step?methods=device', undefined, {
                    cookie: alone.cookie,
                })
            ).body.otherDevice,
        ).toBe(false);
        const started = await edge.call('POST', '/two-step/device', await password(alone.cookie), {
            cookie: alone.cookie,
        });
        expect(started.status).toBe(409);
        expect(started.body.code).toBe('device-unavailable');
        expect(await edge.db.select().from(edge.schema.twoStepFactors)).toEqual([]);
    });
});

describe('a sign-in on a new device', () => {
    test('is `step-pending` and free until the other device approves, then opens the session', async () => {
        const { who, phone } = await withDeviceStep();
        edge.outbox.length = 0;
        const step = await toStep(who);
        const key = newKey();
        const asked = await ask(step.token, 'login', key, { name: 'Chrome on Windows' });
        expect(asked.reply.status).toBe(200);
        const id = asked.reply.body.requestId as string;
        // The account's id comes with the request: a sign-in has not been told it, and the code covers it.
        expect(asked.reply.body.userId).toBe(who.userId);

        // Asked five times before anyone approved: never counted, never a slot of the token.
        for (let asking = 0; asking < 6; asking++) {
            const early = await answer(step.token, { kind: 'device', requestId: id });
            expect(early.status).toBe(409);
            expect(early.body.code).toBe('step-pending');
            expect(early.session).toBeUndefined();
        }
        const tokens = await edge.db.select().from(edge.schema.twoStepAttempts);
        expect(tokens.filter((token) => token.purpose === 'login')).toMatchObject([
            { answers: 0, failures: 0 },
        ]);

        // The phone is told what is asked, in the new device's own words; every device was pinged.
        const [shown] = await prompts(phone.cookie);
        expect(shown).toMatchObject({
            id,
            purpose: 'login',
            class: 'unknown',
            device: { kind: 'web', name: 'Chrome on Windows' },
        });
        const pinged = (await edge.db.select().from(edge.schema.notificationEvents)).filter(
            (event) => event.kind === 'approval-request',
        );
        // One for the request that turned the method on, one for this sign-in: an id and nothing else.
        expect(pinged).toHaveLength(2);
        for (const event of pinged) expect(event).toMatchObject({ userId: who.userId, data: {} });

        const { approved, codes } = await approveFrom(phone, who.userId, asked);
        expect(approved.status).toBe(200);
        expect(codes.asking).toBe(codes.approving);
        expect((await status(id, step.token)).body.state).toBe('approved');

        const passed = await answer(step.token, { kind: 'device', requestId: id });
        expect(passed.status).toBe(200);
        expect(passed.session).toBeTruthy();
        expect(passed.body.envelope.encryptedKey).toBeTruthy();
        expect(await events(passed.session!)).toContain('sign-in:device');
        const [told] = await edge.notices('new-device');
        expect(told!.method).toBe('Your password and another of your devices');
        expect(told!.text).not.toMatch(/Chrome|Windows|Maya/);
        // Used once: the token and the approval are both gone.
        expect((await answer(step.token, { kind: 'device', requestId: id })).body.code).toBe(
            'step-expired',
        );
    });

    test('an approval for one sign-in passes no other, and one for a sign-in passes no change', async () => {
        const { who, laptop, phone } = await withDeviceStep();
        const first = await toStep(who);
        const asked = await ask(first.token, 'login', newKey());
        const { approved, id } = await approveFrom(phone, who.userId, asked);
        expect(approved.status).toBe(200);

        // Another sign-in, with the same password, offers the first one's approval.
        const second = await toStep(who);
        const stolen = await answer(second.token, { kind: 'device', requestId: id });
        expect(stolen.status).toBe(401);
        expect(stolen.body.code).toBe('step-wrong');
        expect(stolen.session).toBeUndefined();

        // A signed-in session offers it for making new backup codes.
        const change = await edge.call(
            'POST',
            '/two-step/challenge',
            { purpose: 'two-step', twoStepMethods: ALL },
            { cookie: laptop.cookie },
        );
        const codes = await edge.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await password(laptop.cookie)),
                twoStep: { token: change.body.token, proof: { kind: 'device', requestId: id } },
            },
            { cookie: laptop.cookie },
        );
        expect(codes.status).toBe(403);
        expect(codes.body.code).toBe('step-wrong');
        // It still passes the sign-in it was given for.
        expect((await answer(first.token, { kind: 'device', requestId: id })).status).toBe(200);
    });

    test('a denied request never passes, is a failed step, and This wasn’t me tells the account at once', async () => {
        const { who, phone } = await withDeviceStep();
        edge.outbox.length = 0;
        const step = await toStep(who);
        const asked = await ask(step.token, 'login', newKey(), { name: 'HushOS Support' });
        const id = asked.reply.body.requestId as string;
        const denied = await edge.call(
            'POST',
            `/approvals/${id}/deny`,
            { reason: 'not-me' },
            { cookie: phone.cookie },
        );
        expect(denied.status).toBe(200);
        // The device that asked learns only that it was not approved, never by whom or how.
        expect((await status(id, step.token)).body).toEqual({ state: 'ended', ended: 'refused' });
        const refused = await answer(step.token, { kind: 'device', requestId: id });
        expect(refused.status).toBe(401);
        expect(refused.body.code).toBe('step-wrong');
        expect(refused.session).toBeUndefined();
        // Nothing can approve it afterwards.
        expect(
            (
                await edge.call(
                    'POST',
                    `/approvals/${id}/open`,
                    { ephemeralKey: b64(randomBytes(32)) },
                    { cookie: phone.cookie },
                )
            ).status,
        ).toBe(404);

        // One failed step, in the log and in the account's count, and the notice without waiting
        // for the fifth. The words the new device chose for itself are in none of it.
        const [told] = await edge.notices('step-failed');
        expect(told).toMatchObject({ to: who.email });
        expect(told!.text).not.toContain('HushOS Support');
        expect(await events(phone.cookie)).toContain('step-failed:device');
        const [state] = await edge.db.select().from(edge.schema.twoStepState);
        expect(state!.consecutiveFailures).toBe(1);

        // Ending the request did not end the token: the phrase still signs this device in.
        const signed = await answer(step.token, await edge.phraseProof(who.phrase, step));
        expect(signed.status).toBe(200);
    });

    test('a plain Deny is counted and logged, and the notice waits for the fifth in a row', async () => {
        const { who, phone } = await withDeviceStep();
        edge.outbox.length = 0;
        for (let round = 1; round <= 5; round++) {
            const step = await toStep(who);
            const asked = await ask(step.token, 'login', newKey());
            expect(asked.reply.status).toBe(200);
            const denied = await edge.call(
                'POST',
                `/approvals/${asked.reply.body.requestId}/deny`,
                { reason: round % 2 ? 'denied' : 'wrong-code' },
                { cookie: phone.cookie },
            );
            expect(denied.status).toBe(200);
            if (round < 5) {
                await edge.quiet();
                expect(edge.outbox.filter((notice) => notice.kind === 'step-failed')).toEqual([]);
            }
        }
        expect(await edge.notices('step-failed')).toHaveLength(1);
        // The sixth request of the day is refused before any device is asked.
        const sixth = await ask((await toStep(who)).token, 'login', newKey());
        expect(sixth.reply.status).toBe(429);
        expect(sixth.reply.body.code).toBe('device-limited');
    });

    test('answering the step another way ends the request', async () => {
        const { who, phone, codes } = await withDeviceStep();
        const step = await toStep(who);
        const asked = await ask(step.token, 'login', newKey());
        const id = asked.reply.body.requestId as string;
        expect(await prompts(phone.cookie)).toHaveLength(1);
        // A wrong backup code: the answer is counted as what it is, and the request is over.
        const wrong = await answer(step.token, { kind: 'backup', code: 'AAAAA-AAAAA' });
        expect(wrong.body.code).toBe('step-wrong');
        expect(await prompts(phone.cookie)).toEqual([]);
        expect((await status(id, step.token)).body.state).toBe('ended');
        expect((await answer(step.token, { kind: 'device', requestId: id })).body.code).toBe(
            'step-wrong',
        );
        // The token is still good for a right answer.
        expect((await answer(step.token, { kind: 'backup', code: codes[0] })).status).toBe(200);
    });

    test('no request outlives its token', async () => {
        const { who, phone } = await withDeviceStep();
        const step = await toStep(who);
        const asked = await ask(step.token, 'login', newKey());
        const id = asked.reply.body.requestId as string;
        const opened = await edge.call(
            'POST',
            `/approvals/${id}/open`,
            { ephemeralKey: b64(randomBytes(32)) },
            { cookie: phone.cookie },
        );
        expect(opened.status).toBe(200);
        await edge.call('POST', `/approvals/${id}/reveal`, {
            stepToken: step.token,
            deviceSigningKey: asked.key,
            nonce: asked.nonce,
        });
        // Five minutes on, the token is over, and so is everything that hung from it.
        vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);
        expect(await prompts(phone.cookie)).toEqual([]);
        const late = await edge.call(
            'POST',
            `/approvals/${id}/approve`,
            {
                signature: signingKeyFromSeed(phone.seed)
                    .sign(
                        Buffer.from(
                            deviceStepStatement({
                                userId: who.userId,
                                requestId: id,
                                purpose: 'login',
                                tokenDigest: asked.tokenDigest,
                                deviceSigningKey: asked.key,
                            }),
                        ),
                    )
                    .toString('base64url'),
            },
            { cookie: phone.cookie },
        );
        expect(late.status).toBe(404);
        expect((await status(id, step.token)).body.code).toBe('step-expired');
        expect((await answer(step.token, { kind: 'device', requestId: id })).body.code).toBe(
            'step-expired',
        );
        // Left unanswered by a sign-in that proved no device: a failed step, in the log.
        expect(await events(phone.cookie)).toContain('step-failed:device');
    });
});

describe('who may approve', () => {
    test('a device that proved its key is never the one that approves its own sign-in', async () => {
        const { who, laptop, phone } = await withDeviceStep();
        // The laptop signs in again with its key's proof, its old session still live.
        const step = await toStep(who, ALL, laptop);
        const asked = await ask(step.token, 'login', laptop.key);
        expect(asked.reply.status).toBe(200);
        const id = asked.reply.body.requestId as string;
        expect(await prompts(laptop.cookie)).toEqual([]);
        for (const [path, body] of [
            ['open', { ephemeralKey: b64(randomBytes(32)) }],
            ['deny', { reason: 'denied' }],
        ] as const)
            expect(
                (
                    await edge.call('POST', `/approvals/${id}/${path}`, body, {
                        cookie: laptop.cookie,
                    })
                ).status,
            ).toBe(404);
        // The phone sees the laptop as the server knows it, not as the request described it.
        const [shown] = await prompts(phone.cookie);
        expect(shown).toMatchObject({ class: 'known', device: { name: 'Maya’s Laptop' } });
        const { approved } = await approveFrom(phone, who.userId, asked);
        expect(approved.status).toBe(200);
        expect((await answer(step.token, { kind: 'device', requestId: id })).status).toBe(200);
    });

    test('a change is approved only between two devices that have been on the account for a week', async () => {
        const { who, laptop, phone } = await withDeviceStep();
        const challenge = async () =>
            (
                await edge.call(
                    'POST',
                    '/two-step/challenge',
                    { purpose: 'two-step', twoStepMethods: ALL },
                    { cookie: laptop.cookie },
                )
            ).body as Step;
        // Both devices signed in today: the usual way is not on offer for a change, and a
        // request for one is refused whatever the client asks.
        const early = await challenge();
        expect(early.methods).toEqual(['backup', 'phrase']);
        expect(early.defaultUnavailable).toBe(true);
        const refused = await ask(early.token, 'two-step', laptop.key, { cookie: laptop.cookie });
        expect(refused.reply.status).toBe(409);
        expect(refused.reply.body.code).toBe('device-unavailable');

        // One of the two is a week old: still not enough, whichever it is.
        await age(laptop, 8);
        expect((await challenge()).methods).toEqual(['backup', 'phrase']);
        await age(laptop, 1);
        await age(phone, 8);
        expect((await challenge()).methods).toEqual(['backup', 'phrase']);

        await age(laptop, 8);
        const step = await challenge();
        expect(step.methods).toEqual(['device', 'backup', 'phrase']);
        const asked = await ask(step.token, 'two-step', laptop.key, { cookie: laptop.cookie });
        expect(asked.reply.status).toBe(200);
        // The laptop cannot approve its own change.
        expect(await prompts(laptop.cookie)).toEqual([]);
        const [shown] = await prompts(phone.cookie);
        expect(shown).toMatchObject({ purpose: 'two-step', class: 'change' });
        const { approved, id } = await approveFrom(phone, who.userId, asked);
        expect(approved.status).toBe(200);

        const made = await edge.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await password(laptop.cookie)),
                twoStep: { token: step.token, proof: { kind: 'device', requestId: id } },
            },
            { cookie: laptop.cookie },
        );
        expect(made.status).toBe(200);
        expect(made.body.codes).toHaveLength(10);
    });

    test('a change denied by the other device is a failed step of the device that asked', async () => {
        const { who, laptop, phone } = await withDeviceStep();
        await age(laptop, 8);
        await age(phone, 8);
        edge.outbox.length = 0;
        const step = (
            await edge.call(
                'POST',
                '/two-step/challenge',
                { purpose: 'password', twoStepMethods: ALL },
                { cookie: laptop.cookie },
            )
        ).body as Step;
        const asked = await ask(step.token, 'password', laptop.key, { cookie: laptop.cookie });
        const denied = await edge.call(
            'POST',
            `/approvals/${asked.reply.body.requestId}/deny`,
            { reason: 'not-me' },
            { cookie: phone.cookie },
        );
        expect(denied.status).toBe(200);
        // From a session that is signed in: this one never says nobody got in.
        const [told] = await edge.notices('change-step-failed');
        expect(told).toMatchObject({ to: who.email });
        const devices = await edge.db.select().from(edge.schema.accountDevices);
        expect(devices.find((row) => row.id === laptop.deviceId)!.twoStepFailures).toBe(1);
    });

    test('a session that never passed the step, and one signed out since, approve nothing', async () => {
        const { who, laptop, phone } = await withDeviceStep();
        // A third device signs in with a backup code and gets a key: it passed the step.
        const step = await toStep(who);
        const asked = await ask(step.token, 'login', newKey());
        const id = asked.reply.body.requestId as string;
        // The phone signs out: its session is gone, and its device with it.
        expect((await edge.call('POST', '/logout', {}, { cookie: phone.cookie })).status).toBe(200);
        expect(
            (
                await edge.call(
                    'POST',
                    `/approvals/${id}/open`,
                    { ephemeralKey: b64(randomBytes(32)) },
                    { cookie: phone.cookie },
                )
            ).status,
        ).toBe(401);
        // The laptop still may.
        const { approved } = await approveFrom(laptop, who.userId, asked);
        expect(approved.status).toBe(200);
    });
});
