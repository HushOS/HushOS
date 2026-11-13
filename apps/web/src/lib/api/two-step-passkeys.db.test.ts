import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    softKey,
    type AnswerOverrides,
    type SoftKey,
} from '../../../../../packages/auth/test/soft-key';
import { appCode, loadEdge, type Account, type Edge, type Reply } from '@/test/auth-edge.server';

/*
 * Passkeys and security keys as a second step, the default method, and what older clients are
 * shown, through the HTTP edge with real OPAQUE and Postgres (docs/two-step-design.md 3, 12).
 * The key is software (packages/auth/test/soft-key.ts): it answers as a browser hands a real
 * key's answer over, and can be made wrong in exactly one way at a time. What must hold
 * whatever a client sends: a key is added only by the session that proved the password (and
 * the step, once it is on), against its own challenge, once; an assertion passes only for the
 * token whose challenge it signed, from this site, by one of the account's own keys, with a
 * counter that went up; a client is never shown a method it did not say it can answer; and
 * the account's usual way comes first, or the client is told it is not available.
 */

const ANDROID = 'android:apk-key-hash:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const OTHER_APP = 'android:apk-key-hash:_-7d3Nva2djX1tXU09LR0M_OzczLysrJyMfGxcTDwsE';
/* A certificate the server vouches for in assetlinks.json (SHA-256 of nothing), and its origin. */
const VOUCHED =
    'E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55';
const VOUCHED_APP = 'android:apk-key-hash:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';

let edge: Edge;

beforeAll(async () => {
    edge = await loadEdge({
        TWO_STEP_ENABLED: 'true',
        WEBAUTHN_ANDROID_ORIGINS: ANDROID,
        ANDROID_APP_CERT_SHA256: VOUCHED,
    });
});
beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await edge.resetDatabase();
    edge.outbox.length = 0;
    edge.emitted.length = 0;
    edge.state.address = '203.0.113.1';
});
afterEach(() => {
    vi.useRealTimers();
});
afterAll(() => edge.closeDatabase());

type Step = {
    token: string;
    methods: string[];
    phrase: { userId: string; recoveryVersion: number; wrappingSalt: string };
    webauthn?: {
        challenge: string;
        rpId: string;
        timeout: number;
        userVerification: string;
        allowCredentials: { id: string; type: string; transports?: string[] }[];
    };
    withheld?: true;
    defaultUnavailable?: true;
};

async function signedIn() {
    const who = await edge.account();
    const first = await edge.signIn(who);
    expect(first.status).toBe(200);
    return { who, cookie: first.session! };
}

/* The password proved again for a change to the step. */
const password = async (cookie: string) =>
    (await edge.passwordProof('/two-step/reauth', {}, { cookie })).proof;

/* A step for a change to the step, answered with a backup code or whatever `proof` is. */
async function stepUp(
    cookie: string,
    purpose = 'two-step',
    methods: string[] | null = ['webauthn'],
) {
    const reply = await edge.call(
        'POST',
        '/two-step/challenge',
        { purpose, ...(methods ? { twoStepMethods: methods } : {}) },
        { cookie },
    );
    expect(reply.status).toBe(200);
    return reply.body as Step;
}

/* The options a key is asked when it is added: the password and, with the step on, the step. */
async function keyOptions(cookie: string, twoStep?: unknown): Promise<Reply> {
    return edge.call(
        'POST',
        '/two-step/keys/options',
        { ...(await password(cookie)), ...(twoStep ? { twoStep } : {}) },
        { cookie },
    );
}

/* Adds `key` as the settings page does. With the step on, `code` (a backup code) answers it. */
async function addKey(
    cookie: string,
    key: SoftKey,
    options: { code?: string; name?: string; use?: AnswerOverrides } = {},
) {
    const twoStep = options.code
        ? { token: (await stepUp(cookie)).token, proof: { kind: 'backup', code: options.code } }
        : undefined;
    const started = await keyOptions(cookie, twoStep);
    expect(started.status).toBe(200);
    const added = await edge.call(
        'POST',
        '/two-step/keys',
        {
            registrationToken: started.body.registrationToken,
            ...(options.name ? { name: options.name } : {}),
            response: key.register(started.body.options, options.use),
        },
        { cookie },
    );
    return { started, added };
}

/* An account whose step was turned on with a key. */
async function withKey(options: Parameters<typeof softKey>[0] = {}) {
    const account = await signedIn();
    const key = softKey(options);
    const { added } = await addKey(account.cookie, key);
    expect(added.status).toBe(200);
    return {
        ...account,
        key,
        factorId: added.body.method.id as string,
        codes: added.body.backupCodes as string[],
    };
}

/* Turns the step on with an authenticator app, as the settings page does. */
async function addApp(cookie: string, code?: string) {
    const twoStep = code
        ? { token: (await stepUp(cookie)).token, proof: { kind: 'backup', code } }
        : undefined;
    const enrol = await edge.call(
        'POST',
        '/two-step/totp',
        { ...(await password(cookie)), ...(twoStep ? { twoStep } : {}) },
        { cookie },
    );
    expect(enrol.status).toBe(200);
    const confirmed = await edge.call(
        'POST',
        `/two-step/totp/${enrol.body.id}/confirm`,
        { code: await appCode(enrol.body.secret, -1) },
        { cookie },
    );
    expect(confirmed.status).toBe(200);
    return {
        factorId: enrol.body.id as string,
        secret: enrol.body.secret as string,
        codes: confirmed.body.backupCodes as string[] | undefined,
    };
}

/* A sign-in as far as the step. `methods: null` is a client from before passkeys. */
async function toStep(who: Account, methods: string[] | null = ['webauthn']) {
    const reply = await edge.signIn(who, { twoStep: true, ...(methods ? { methods } : {}) });
    expect(reply.status).toBe(200);
    expect(reply.session).toBeUndefined();
    return reply.body.twoStep as Step;
}

const answer = (token: string, proof: unknown) =>
    edge.call('POST', '/login/two-step', { token, proof });
const withKeyAnswer = (step: Step, key: SoftKey, use?: AnswerOverrides) =>
    answer(step.token, { kind: 'webauthn', response: key.assert(step.webauthn!, use) });
const settings = async (cookie: string, query = '?methods=webauthn') =>
    (await edge.call('GET', `/two-step${query}`, undefined, { cookie })).body;
const events = async (cookie: string) =>
    (
        (await edge.call('GET', '/security-events', undefined, { cookie })).body.events as {
            kind: string;
            method: string | null;
        }[]
    ).map(({ kind, method }) => `${kind}:${method}`);
const factors = () => edge.db.select().from(edge.schema.twoStepFactors);

describe('adding a passkey or security key', () => {
    test('the first key turns the step on: asked for nothing that names it, stored confirmed, codes shown once, the account told', async () => {
        const { who, cookie } = await signedIn();
        const key = softKey();
        const { started, added } = await addKey(cookie, key);

        // What the key is asked: this site, no attestation, no resident key, no user verification.
        const { options } = started.body;
        expect(options.rp).toEqual({ id: 'localhost', name: 'HushOS' });
        expect(options.attestation).toBe('none');
        expect(options.authenticatorSelection).toEqual({
            residentKey: 'discouraged',
            userVerification: 'discouraged',
            requireResidentKey: false,
        });
        expect(options.pubKeyCredParams.map((entry: { alg: number }) => entry.alg)).toEqual([
            -8, -7, -257,
        ]);
        expect(options.user.name).toBe(who.email);
        // The handle is random, 32 bytes, and never the account's id.
        expect(Buffer.from(options.user.id, 'base64url')).toHaveLength(32);
        expect(Buffer.from(options.user.id, 'base64url').toString()).not.toContain(who.userId);
        expect(options.excludeCredentials).toEqual([]);

        expect(added.status).toBe(200);
        expect(added.body.method).toMatchObject({
            kind: 'webauthn',
            name: 'Security key',
            synced: false,
            lastUsedAt: null,
        });
        expect(added.body.backupCodes).toHaveLength(10);
        expect(await settings(cookie)).toMatchObject({
            on: true,
            backupCodesLeft: 10,
            defaultKind: 'webauthn',
            methods: [{ id: added.body.method.id, kind: 'webauthn' }],
        });
        // The password alone no longer signs in.
        const again = await edge.signIn(who);
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('update-required');

        const [told] = await edge.notices('two-step-on');
        expect(told).toMatchObject({ to: who.email, method: 'A passkey or security key' });
        expect(await events(cookie)).toContain('two-step-on:webauthn');
        // No attestation statement and no AAGUID are kept: only what an assertion is checked against.
        const [stored] = await factors();
        expect(stored!.credentialId!.toString('base64url')).toBe(key.id);
        expect(stored!.confirmedAt).toBeInstanceOf(Date);
    });

    test('a registration that is wrong in any one way adds nothing, and uses its token up', async () => {
        const wrong: [string, AnswerOverrides][] = [
            ['another site’s origin', { origin: 'https://hushos.example' }],
            ['an Android app the operator did not list', { origin: OTHER_APP }],
            ['another RP ID', { rpId: 'hushos.example' }],
            ['a challenge the server did not issue', { challenge: 'A'.repeat(43) }],
            ['an assertion in place of a registration', { type: 'webauthn.get' }],
            ['nobody at the key', { absent: true }],
            ['a page framed by another site', { crossOrigin: true }],
        ];
        for (const [what, use] of wrong) {
            const { cookie } = await signedIn();
            const key = softKey();
            const { started, added } = await addKey(cookie, key, { use });
            expect(added.status, what).toBe(400);
            expect(added.body.code, what).toBe('key-refused');
            expect((await settings(cookie)).on, what).toBe(false);
            // One answer a token: a right one after the wrong one is too late.
            const late = await edge.call(
                'POST',
                '/two-step/keys',
                {
                    registrationToken: started.body.registrationToken,
                    response: key.register(started.body.options),
                },
                { cookie },
            );
            expect(late.status, what).toBe(404);
        }
        expect(await factors()).toEqual([]);
    });

    test('a registration token adds one key, for the session that asked: replayed, or carried to another session, it adds nothing', async () => {
        const { who, cookie, key } = await withKey();
        const other = await signedInAgain(who, key);
        const code = (await freshCodes(cookie, key))[0]!;
        const twoStep = {
            token: (await stepUp(cookie)).token,
            proof: { kind: 'backup', code },
        };
        const started = await keyOptions(cookie, twoStep);
        expect(started.status).toBe(200);
        // The account's keys are excluded, so a browser will not add the same one twice.
        expect(started.body.options.excludeCredentials).toEqual([
            { id: key.id, type: 'public-key', transports: ['usb'] },
        ]);
        const spare = softKey();
        const body = {
            registrationToken: started.body.registrationToken,
            response: spare.register(started.body.options),
        };
        // Another session of the same account holding the token gets nothing from it.
        expect((await edge.call('POST', '/two-step/keys', body, { cookie: other })).status).toBe(
            404,
        );
        expect((await edge.call('POST', '/two-step/keys', body, { cookie })).status).toBe(200);
        // And the same answer again, or a third key on the same challenge, adds nothing.
        expect((await edge.call('POST', '/two-step/keys', body, { cookie })).status).toBe(404);
        const third = softKey();
        expect(
            (
                await edge.call(
                    'POST',
                    '/two-step/keys',
                    { ...body, response: third.register(started.body.options) },
                    { cookie },
                )
            ).status,
        ).toBe(404);
        expect((await settings(cookie)).methods).toHaveLength(2);
        const [told] = await edge.notices('two-step-key-added');
        expect(told?.to).toBe(who.email);
    });

    test('with the step on, a key is added only with the step; and never the same key twice', async () => {
        const { cookie, key, codes } = await withKey();
        // The password alone starts nothing.
        const bare = await keyOptions(cookie);
        expect(bare.status).toBe(403);
        expect(bare.body.code).toBe('two-step');
        // Nor does a wrong answer.
        const wrong = await keyOptions(cookie, {
            token: (await stepUp(cookie)).token,
            proof: { kind: 'backup', code: 'AAAAA-AAAAA' },
        });
        expect(wrong.status).toBe(403);
        expect(wrong.body.code).toBe('step-wrong');
        expect(await edge.db.select().from(edge.schema.twoStepKeyRegistrations)).toEqual([]);

        // The key itself answers the step for adding another.
        const step = await stepUp(cookie);
        const started = await keyOptions(cookie, {
            token: step.token,
            proof: { kind: 'webauthn', response: key.assert(step.webauthn!) },
        });
        expect(started.status).toBe(200);
        // The same credential again: refused by the server, whatever the browser let through.
        const same = await edge.call(
            'POST',
            '/two-step/keys',
            {
                registrationToken: started.body.registrationToken,
                response: key.register(started.body.options),
            },
            { cookie },
        );
        expect(same.status).toBe(409);
        expect(same.body.code).toBe('exists');
        expect((await settings(cookie)).methods).toHaveLength(1);
        expect(codes).toHaveLength(10);
    });

    test('a synced passkey is named Passkey and listed as synced; a name that will not do is refused before the key’s one answer is used', async () => {
        const { cookie } = await signedIn();
        const passkey = softKey({ synced: true });
        const started = await keyOptions(cookie);
        const send = (name?: string) =>
            edge.call(
                'POST',
                '/two-step/keys',
                {
                    registrationToken: started.body.registrationToken,
                    ...(name ? { name } : {}),
                    response: passkey.register(started.body.options),
                },
                { cookie },
            );
        // A bidi override in a name could make it read as another: refused, token still good.
        expect((await send('Key‮drowssap')).status).toBe(400);
        const added = await send();
        expect(added.status).toBe(200);
        expect(added.body.method).toMatchObject({ name: 'Passkey', synced: true });
    });

    test('renaming is the account’s own, keys only, by the device-name rules; no notice ever carries the name', async () => {
        const maya = await withKey();
        const sam = await signedIn();
        const app = await addApp(sam.cookie);
        const rename = (cookie: string, id: string, name: string) =>
            edge.call('PUT', `/two-step/methods/${id}`, { name }, { cookie });

        expect((await rename(sam.cookie, maya.factorId, 'Mine')).status).toBe(404);
        expect((await rename(sam.cookie, app.factorId, 'App')).status).toBe(404);
        expect((await rename(maya.cookie, maya.factorId, 'Key‮drowssap')).status).toBe(400);
        const renamed = await rename(maya.cookie, maya.factorId, '  Zebra   key ');
        expect(renamed.status).toBe(200);
        expect(renamed.body.method).toMatchObject({ id: maya.factorId, name: 'Zebra key' });
        expect((await settings(maya.cookie)).methods[0].name).toBe('Zebra key');

        // Removed, used and added: whatever is sent about this key names its kind only.
        const step = await toStep(maya.who);
        expect((await withKeyAnswer(step, maya.key)).status).toBe(200);
        await removeMethod(maya.cookie, maya.factorId, maya.codes[0]!);
        await edge.notices('two-step-off');
        await edge.quiet();
        expect(edge.outbox.length).toBeGreaterThan(1);
        for (const notice of edge.outbox)
            expect(`${notice.subject} ${notice.text}`).not.toContain('Zebra');
    });
});

/* Another session of the account, signed in through its key. */
async function signedInAgain(who: Account, key: SoftKey) {
    const step = await toStep(who);
    const reply = await withKeyAnswer(step, key);
    expect(reply.status).toBe(200);
    return reply.session!;
}

/* A new set of backup codes, with the key as the step. */
async function freshCodes(cookie: string, key: SoftKey) {
    const step = await stepUp(cookie);
    const made = await edge.call(
        'POST',
        '/two-step/backup-codes',
        {
            ...(await password(cookie)),
            twoStep: {
                token: step.token,
                proof: { kind: 'webauthn', response: key.assert(step.webauthn!) },
            },
        },
        { cookie },
    );
    expect(made.status).toBe(200);
    return made.body.codes as string[];
}

async function removeMethod(cookie: string, factorId: string, code: string) {
    const removed = await edge.call(
        'DELETE',
        `/two-step/methods/${factorId}`,
        {
            ...(await password(cookie)),
            twoStep: { token: (await stepUp(cookie)).token, proof: { kind: 'backup', code } },
        },
        { cookie },
    );
    expect(removed.status).toBe(200);
    return removed.body as { removed: boolean; on: boolean };
}

describe('a key at sign-in', () => {
    test('the step carries this token’s challenge and the account’s keys; the key’s answer opens the session', async () => {
        const { who, key, factorId, cookie } = await withKey();
        const step = await toStep(who);
        expect(step.methods).toEqual(['webauthn', 'backup', 'phrase']);
        expect(step.webauthn).toEqual({
            challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            rpId: 'localhost',
            timeout: 300_000,
            userVerification: 'discouraged',
            allowCredentials: [{ id: key.id, type: 'public-key', transports: ['usb'] }],
        });
        // A fresh challenge for every token.
        expect((await toStep(who)).webauthn!.challenge).not.toBe(step.webauthn!.challenge);

        const reply = await withKeyAnswer(step, key);
        expect(reply.status).toBe(200);
        expect(reply.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(reply.body.envelope.encryptedKey).toBeTruthy();
        expect(await events(cookie)).toContain('sign-in:webauthn');
        const [stored] = (await factors()).filter((row) => row.id === factorId);
        // Added at 1, used once since.
        expect(stored!.signCount).toBe(2);
        expect(stored!.lastUsedAt).toBeInstanceOf(Date);
        // Used, the token and its challenge are gone: the same answer opens nothing again.
        const replayed = await answer(step.token, {
            kind: 'webauthn',
            response: key.assert(step.webauthn!),
        });
        expect(replayed.status).toBe(401);
        expect(replayed.body.code).toBe('step-expired');
        expect(replayed.session).toBeUndefined();
    });

    test('an assertion that is wrong in any one way opens nothing, and is counted', async () => {
        const { who, key } = await withKey();
        const wrong: [string, AnswerOverrides][] = [
            ['another site’s origin', { origin: 'https://hushos.example' }],
            ['an Android app the operator did not list', { origin: OTHER_APP }],
            ['another RP ID', { rpId: 'hushos.example' }],
            ['nobody at the key', { absent: true }],
            ['a registration in place of an assertion', { type: 'webauthn.create' }],
            ['a page framed by another site', { crossOrigin: true }],
        ];
        for (const [what, use] of wrong) {
            const step = await toStep(who);
            const reply = await withKeyAnswer(step, key, use);
            expect(reply.status, what).toBe(401);
            expect(reply.body.code, what).toBe('step-wrong');
            expect(reply.session, what).toBeUndefined();
            expect(reply.body.envelope, what).toBeUndefined();
        }
        expect(await edge.db.select().from(edge.schema.sessions)).toHaveLength(1);
        const [state] = await edge.db.select().from(edge.schema.twoStepState);
        expect(state!.consecutiveFailures).toBe(wrong.length);
    });

    test('an assertion over one token’s challenge does not pass another token', async () => {
        const { who, key } = await withKey();
        const first = await toStep(who);
        const second = await toStep(who);
        const reply = await answer(second.token, {
            kind: 'webauthn',
            response: key.assert(first.webauthn!),
        });
        expect(reply.status).toBe(401);
        expect(reply.body.code).toBe('step-wrong');
        // The token it was made for still takes it.
        expect((await withKeyAnswer(first, key)).status).toBe(200);
    });

    test('another account’s key, and a key removed since, do not pass', async () => {
        const maya = await withKey();
        const sam = await withKey();
        const step = await toStep(maya.who);
        // Sam's key signs Maya's challenge for this site: right in every way but whose it is.
        const stranger = await withKeyAnswer(step, sam.key);
        expect(stranger.status).toBe(401);
        expect(stranger.body.code).toBe('step-wrong');

        // A second key, then the first removed.
        const spare = softKey();
        expect((await addKey(maya.cookie, spare, { code: maya.codes[0] })).added.status).toBe(200);
        expect(await removeMethod(maya.cookie, maya.factorId, maya.codes[1]!)).toEqual({
            removed: true,
            on: true,
        });
        const after = await toStep(maya.who);
        expect(after.webauthn!.allowCredentials.map((entry) => entry.id)).toEqual([spare.id]);
        expect((await withKeyAnswer(after, maya.key)).status).toBe(401);
        expect((await withKeyAnswer(after, spare)).status).toBe(200);
    });

    test('a counter that does not go up is refused and the account is told its key may have been copied', async () => {
        const { who, key, cookie } = await withKey({ counter: 5 });
        // 5 then 5, and 5 then 0: a clone answers with a count the real key has passed.
        for (const counter of [5, 0]) {
            const reply = await withKeyAnswer(await toStep(who), key, { counter });
            expect(reply.status).toBe(401);
            expect(reply.body.code).toBe('step-wrong');
            expect(reply.session).toBeUndefined();
        }
        const told = await edge.notices('key-counter');
        // Once an hour, however often it happens.
        expect(told).toHaveLength(1);
        expect(told[0]!.to).toBe(who.email);
        expect(await events(cookie)).toContain('key-counter:webauthn');

        // The real key, one use on, still signs in.
        expect((await withKeyAnswer(await toStep(who), key, { counter: 6 })).status).toBe(200);
    });

    test('two answers of one key racing: the one that finds its counter passed is refused, and the account is told', async () => {
        const { who, key } = await withKey({ counter: 5 });
        // Both answers are checked against the stored count before either is spent: held at
        // the door of the transaction until both have arrived, as two requests in flight are.
        const open = edge.twoStepRepository.openSteppedSession;
        const held: (() => void)[] = [];
        const gate = vi
            .spyOn(edge.twoStepRepository, 'openSteppedSession')
            .mockImplementation(async (input) => {
                await new Promise<void>((arrived) => {
                    held.push(arrived);
                    if (held.length === 2) for (const go of held) go();
                });
                return open(input);
            });
        const [first, second] = [await toStep(who), await toStep(who)];
        const replies = await Promise.all([
            withKeyAnswer(first, key, { counter: 6 }),
            withKeyAnswer(second, key, { counter: 6 }),
        ]);
        gate.mockRestore();
        // The same count twice: a real key never gives it, a copy of one does. One gets in.
        expect(replies.map((reply) => reply.status).sort((a, b) => a - b)).toEqual([200, 401]);
        const refused = replies.find((reply) => reply.status === 401)!;
        expect(refused.body.code).toBe('step-wrong');
        expect(refused.session).toBeUndefined();
        // Found only inside the transaction, after the check let it through: told all the same.
        const told = await edge.notices('key-counter');
        expect(told.map((notice) => notice.to)).toEqual([who.email]);
        const cookie = replies.find((reply) => reply.status === 200)!.session!;
        expect(await events(cookie)).toContain('key-counter:webauthn');
    });

    test('the account’s credential id signed by another key opens nothing, moves no counter, and is not called a copied key', async () => {
        // A fresh account, so no notice of any kind has been sent or spent, and a counter far
        // ahead of the stored one: the only thing wrong with this answer is whose key signed it.
        const { who, key, factorId } = await withKey({ counter: 5 });
        const before = (await factors()).find((row) => row.id === factorId)!.signCount;
        const forger = softKey();
        const step = await toStep(who);
        const reply = await answer(step.token, {
            kind: 'webauthn',
            response: {
                ...forger.assert(step.webauthn!, { counter: 99 }),
                id: key.id,
                rawId: key.id,
            },
        });
        expect(reply.status).toBe(401);
        expect(reply.body.code).toBe('step-wrong');
        expect(reply.session).toBeUndefined();
        expect(reply.body.envelope).toBeUndefined();
        // Only the session that added the key exists, and the key's counter is where it was.
        expect(await edge.db.select().from(edge.schema.sessions)).toHaveLength(1);
        expect((await factors()).find((row) => row.id === factorId)!.signCount).toBe(before);
        // A wrong signature says nothing about the real key: nobody is told it was copied.
        await edge.quiet();
        expect(edge.outbox.filter((notice) => notice.kind === 'key-counter')).toEqual([]);
        const logged = await edge.db.select().from(edge.schema.accountSecurityEvents);
        expect(logged.filter((line) => line.kind === 'key-counter')).toEqual([]);
        expect(logged.filter((line) => line.kind === 'sign-in')).toEqual([]);
    });

    test('a synced passkey reports 0 every time, and passes every time', async () => {
        const { who, key } = await withKey({ synced: true });
        expect((await withKeyAnswer(await toStep(who), key)).status).toBe(200);
        expect((await withKeyAnswer(await toStep(who), key)).status).toBe(200);
    });

    test('five wrong answers end a token, but a key is never refused for a spent code budget', async () => {
        const { who, key } = await withKey();
        const step = await toStep(who);
        for (let attempt = 1; attempt <= 5; attempt++) {
            const reply = await withKeyAnswer(step, key, { origin: 'https://hushos.example' });
            expect(reply.status).toBe(401);
            expect(reply.body.code).toBe(attempt < 5 ? 'step-wrong' : 'step-expired');
        }
        // The token is over: even the right answer comes too late.
        expect((await withKeyAnswer(step, key)).body.code).toBe('step-expired');
        // Ten wrong codes spend the account's 15-minute budget for codes: the eleventh is not
        // even looked at...
        for (let token = 0; token < 2; token++) {
            const next = await toStep(who);
            for (let attempt = 0; attempt < 5; attempt++)
                await answer(next.token, { kind: 'backup', code: 'AAAAA-AAAAA' });
        }
        const limited = await answer((await toStep(who)).token, {
            kind: 'backup',
            code: 'AAAAA-AAAAA',
        });
        expect(limited.status).toBe(429);
        expect(limited.body.code).toBe('step-limited');
        // ...and the key still signs in.
        expect((await withKeyAnswer(await toStep(who), key)).status).toBe(200);
    });

    test('an Android app answers from its own origin only when the operator listed it', async () => {
        const { who, key } = await withKey();
        expect((await withKeyAnswer(await toStep(who), key, { origin: ANDROID })).status).toBe(200);
        const other = await withKeyAnswer(await toStep(who), key, { origin: OTHER_APP });
        expect(other.status).toBe(401);
        // The list, once set, is the whole answer: the certificate's own origin is not added to it.
        const vouched = await withKeyAnswer(await toStep(who), key, { origin: VOUCHED_APP });
        expect(vouched.status).toBe(401);
    });

    test('a key’s answer is the step for a change, and only for the change its token was asked for', async () => {
        const { cookie, key } = await withKey();
        // A token asked for a password change, answered at the route that makes backup codes.
        const forPassword = await stepUp(cookie, 'password');
        const misused = await edge.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await password(cookie)),
                twoStep: {
                    token: forPassword.token,
                    proof: { kind: 'webauthn', response: key.assert(forPassword.webauthn!) },
                },
            },
            { cookie },
        );
        expect(misused.status).toBe(403);
        expect(misused.body.code).toBe('step-expired');
        expect((await settings(cookie)).backupCodesLeft).toBe(10);
        // A sign-in's token does not authorise a change either.
        const { who } = { who: (await edge.db.select().from(edge.schema.users))[0]! };
        const login = await edge.signIn(
            { userId: who.id, email: who.email, phrase: '' },
            { twoStep: true, methods: ['webauthn'] },
        );
        const loginStep = login.body.twoStep as Step;
        const crossed = await edge.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...(await password(cookie)),
                twoStep: {
                    token: loginStep.token,
                    proof: { kind: 'webauthn', response: key.assert(loginStep.webauthn!) },
                },
            },
            { cookie },
        );
        expect(crossed.status).toBe(403);
        // Asked for the right purpose, the key makes the codes.
        expect(await freshCodes(cookie, key)).toHaveLength(10);
    });
});

describe('older apps and servers', () => {
    test('login/start says it reads twoStepMethods to everyone, an unknown address included', async () => {
        const who = await edge.account();
        const known = await edge.passwordProof('/login/start', { email: who.email });
        const unknown = await edge.passwordProof('/login/start', { email: 'nobody@hush.example' });
        expect(known.challenge.twoStepMethods).toBe(true);
        expect(unknown.challenge.twoStepMethods).toBe(true);
        expect(Object.keys(unknown.challenge).sort()).toEqual(Object.keys(known.challenge).sort());
    });

    test('a client from before passkeys is never shown a key: not at sign-in, not at a change, not in settings', async () => {
        const { who, cookie, codes } = await withKey();
        // Key only: it gets the two ways back, and nothing that hints at more.
        const keyOnly = await toStep(who, null);
        expect(keyOnly.methods).toEqual(['backup', 'phrase']);
        expect(Object.keys(keyOnly).sort()).toEqual(['expiresAt', 'methods', 'phrase', 'token']);
        expect(await settings(cookie, '')).toEqual({
            on: true,
            methods: [],
            backupCodesLeft: 10,
            totpFrozen: false,
        });

        const app = await addApp(cookie, codes[0]);
        const both = await toStep(who, null);
        expect(both.methods).toEqual(['totp', 'backup', 'phrase']);
        expect(both.webauthn).toBeUndefined();
        expect('withheld' in both || 'defaultUnavailable' in both).toBe(false);
        const change = await stepUp(cookie, 'password', null);
        expect(change.methods).toEqual(['totp', 'backup', 'phrase']);
        expect(change.webauthn).toBeUndefined();
        const listed = await settings(cookie, '');
        expect(listed.methods.map((method: { kind: string }) => method.kind)).toEqual(['totp']);
        expect('defaultKind' in listed).toBe(false);

        // Its Turn off removes the first method it lists, which can only be the app: the step
        // stays on, by the key it never knew about.
        const off = await removeMethod(cookie, listed.methods[0].id, codes[1]!);
        expect(off).toEqual({ removed: true, on: true });
        expect(app.factorId).toBe(listed.methods[0].id);
        expect((await settings(cookie)).methods.map((m: { kind: string }) => m.kind)).toEqual([
            'webauthn',
        ]);
    });

    test('a client that names what it can answer is shown that, and told when something was left out', async () => {
        const { who, cookie, codes } = await withKey();
        await addApp(cookie, codes[0]);
        // This build knows passkeys but cannot use one here (a phone on a self-hosted server).
        const without = await toStep(who, []);
        expect(without.methods).toEqual(['totp', 'backup', 'phrase']);
        expect(without.webauthn).toBeUndefined();
        expect(without.withheld).toBe(true);
        expect(without.defaultUnavailable).toBe(true);
        // It can: nothing is left out, and nothing is said.
        const named = await toStep(who, ['webauthn']);
        expect(named.methods).toEqual(['webauthn', 'totp', 'backup', 'phrase']);
        expect(named.withheld).toBeUndefined();
        expect(named.defaultUnavailable).toBeUndefined();
        // A kind this server has never heard of is ignored, not refused.
        const newer = await toStep(who, ['webauthn', 'hologram']);
        expect(newer.methods).toEqual(['webauthn', 'totp', 'backup', 'phrase']);
        // A change is filtered the same way.
        expect((await stepUp(cookie, 'delete', [])).withheld).toBe(true);
        expect((await stepUp(cookie, 'delete', ['webauthn'])).methods[0]).toBe('webauthn');
    });
});

describe('the default', () => {
    test('the first method turned on comes first, a second kind does not move it, and Make default does', async () => {
        const { who, cookie } = await signedIn();
        const app = await addApp(cookie);
        const key = softKey();
        expect((await addKey(cookie, key, { code: app.codes![0] })).added.status).toBe(200);
        expect((await settings(cookie)).defaultKind).toBe('totp');
        expect((await toStep(who)).methods).toEqual(['totp', 'webauthn', 'backup', 'phrase']);

        const set = (kind: string, as = cookie) =>
            edge.call('PUT', '/two-step/default', { kind }, { cookie: as });
        const changed = await set('webauthn');
        expect(changed.status).toBe(200);
        expect(changed.body).toEqual({ defaultKind: 'webauthn' });
        expect((await settings(cookie)).defaultKind).toBe('webauthn');
        expect((await toStep(who)).methods).toEqual(['webauthn', 'totp', 'backup', 'phrase']);
        expect(await events(cookie)).toContain('default-changed:webauthn');
        // The same choice again changes nothing, and logs nothing.
        await set('webauthn');
        expect((await events(cookie)).filter((line) => line.startsWith('default-changed'))).toEqual(
            ['default-changed:webauthn'],
        );
        // A kind the server does not offer as a default is refused by the route itself.
        expect((await set('backup')).status).toBe(400);
        expect((await set('device')).status).toBe(400);
    });

    test('only a session that passed the step changes it, and only to a kind the account has', async () => {
        const { who, cookie } = await signedIn();
        // A second session, from before the step was on: it never passed it.
        const old = (await edge.signIn(who)).session!;
        const app = await addApp(cookie);
        const set = (kind: string, as: string) =>
            edge.call('PUT', '/two-step/default', { kind }, { cookie: as });
        expect((await set('webauthn', cookie)).status).toBe(404);
        await addKey(cookie, softKey(), { code: app.codes![0] });
        expect((await set('webauthn', old)).status).toBe(403);
        expect((await set('webauthn', 'A'.repeat(43))).status).toBe(401);
        expect((await settings(cookie)).defaultKind).toBe('totp');
        expect((await toStep(who)).methods[0]).toBe('totp');
    });

    test('when the usual way cannot be used for a sign-in it is not first, and the client is told only that', async () => {
        const { who, cookie } = await signedIn();
        const app = await addApp(cookie);
        await addKey(cookie, softKey(), { code: app.codes![0] });
        // The app is the default, and frozen for devices HushOS does not recognise.
        await edge.db.update(edge.schema.twoStepState).set({ totpFrozenAt: new Date() });
        const step = await toStep(who);
        expect(step.methods).toEqual(['webauthn', 'backup', 'phrase']);
        expect(step.defaultUnavailable).toBe(true);
        // Not a method the client failed to name: nothing says which reason it was.
        expect(step.withheld).toBeUndefined();
    });

    test('it goes with the last method of its kind, and does not come back when that kind is added again', async () => {
        const { who, cookie, factorId, codes } = await withKey();
        const app = await addApp(cookie, codes[0]);
        expect(app.codes).toBeUndefined();
        expect((await settings(cookie)).defaultKind).toBe('webauthn');

        expect(await removeMethod(cookie, factorId, codes[1]!)).toEqual({
            removed: true,
            on: true,
        });
        const [told] = await edge.notices('two-step-key-removed');
        expect(told?.to).toBe(who.email);
        expect((await settings(cookie)).defaultKind).toBe('totp');
        expect(await events(cookie)).toEqual(
            expect.arrayContaining(['method-removed:webauthn', 'default-changed:totp']),
        );
        expect((await toStep(who)).methods).toEqual(['totp', 'backup', 'phrase']);

        // A key again: a second kind beside the app, which stays the usual way.
        expect((await addKey(cookie, softKey(), { code: codes[2] })).added.status).toBe(200);
        expect((await settings(cookie)).defaultKind).toBe('totp');
        expect((await toStep(who)).methods[0]).toBe('totp');
    });

    test('removing the last method, a key, turns the step off: the password alone signs in again, and the account is told', async () => {
        const { who, cookie, factorId, codes } = await withKey();
        // Not without the step.
        const bare = await edge.call(
            'DELETE',
            `/two-step/methods/${factorId}`,
            await password(cookie),
            { cookie },
        );
        expect(bare.status).toBe(403);
        expect((await settings(cookie)).on).toBe(true);
        expect(await removeMethod(cookie, factorId, codes[0]!)).toEqual({
            removed: true,
            on: false,
        });
        expect((await edge.notices('two-step-off'))[0]?.to).toBe(who.email);
        expect(await settings(cookie)).toMatchObject({ on: false, methods: [], defaultKind: null });
        expect((await edge.signIn(who)).status).toBe(200);
    });
});
