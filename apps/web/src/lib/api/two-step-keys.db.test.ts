import { randomBytes } from 'node:crypto';
import { deriveTwoStepKey, openTotpSecret, twoStepKeyId } from '@hushos/crypto/two-step/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { appCode, fromBase32, loadEdge, type Account, type Edge } from '@/test/auth-edge.server';

/*
 * The two-step key during a rotation (docs/two-step-design.md 8), through the HTTP edge, real
 * OPAQUE and Postgres: TWO_STEP_KEY is set, TWO_STEP_PREVIOUS_KEY is the key before it, and
 * the instance began with neither, on the key derived from its OPAQUE setup. New secrets and
 * codes must be made under TWO_STEP_KEY, or setting it protects nothing; and every row from
 * before must still open, or a rotation locks people out of their second step.
 */

const CURRENT = new Uint8Array(randomBytes(32));
const PREVIOUS = new Uint8Array(randomBytes(32));
const encoded = (key: Uint8Array) => Buffer.from(key).toString('base64url');
const idOf = async (key: Uint8Array) => Buffer.from(await twoStepKeyId(key)).toString('hex');

let edge: Edge;
let derived: Uint8Array;

beforeAll(async () => {
    edge = await loadEdge({
        TWO_STEP_ENABLED: 'true',
        TWO_STEP_KEY: encoded(CURRENT),
        TWO_STEP_PREVIOUS_KEY: encoded(PREVIOUS),
    });
    derived = await deriveTwoStepKey(
        new Uint8Array(Buffer.from(await edge.serverSetup(), 'base64url')),
    );
});
beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await edge.resetDatabase();
    edge.outbox.length = 0;
});
afterEach(() => {
    vi.useRealTimers();
});
afterAll(() => edge.closeDatabase());

async function signedIn() {
    const who = await edge.account();
    const first = await edge.signIn(who);
    expect(first.status).toBe(200);
    return { who, cookie: first.session! };
}

/* A sign-in through the step with `proof`: the reply to the answer. */
async function signInWith(who: Account, proof: Record<string, string>) {
    const asked = await edge.signIn(who, { twoStep: true });
    expect(asked.body.twoStep).toBeDefined();
    return edge.call('POST', '/login/two-step', { token: asked.body.twoStep.token, proof });
}

describe('the two-step key', () => {
    test('TWO_STEP_KEY, when set, is the key new secrets and codes are made under, not the derived one', async () => {
        const { who, cookie } = await signedIn();
        const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie });
        const enrol = await edge.call('POST', '/two-step/totp', proof, { cookie });
        expect(enrol.status).toBe(200);
        const confirmed = await edge.call(
            'POST',
            `/two-step/totp/${enrol.body.id}/confirm`,
            { code: await appCode(enrol.body.secret, -1) },
            { cookie },
        );
        expect(confirmed.status).toBe(200);

        const [factor] = await edge.db.select().from(edge.schema.twoStepFactors);
        expect(factor!.totpKeyId!.toString('hex')).toBe(await idOf(CURRENT));
        const open = (key: Uint8Array) =>
            openTotpSecret({
                sealed: factor!.totpSecret!,
                nonce: factor!.totpNonce!,
                key,
                userId: who.userId,
                factorId: factor!.id,
            });
        // The stored secret opens under TWO_STEP_KEY and under nothing else the server has.
        expect(Buffer.from((await open(CURRENT))!)).toEqual(
            Buffer.from(fromBase32(enrol.body.secret)),
        );
        expect(await open(derived)).toBeNull();
        expect(await open(PREVIOUS)).toBeNull();
        const codes = await edge.db.select().from(edge.schema.twoStepBackupCodes);
        expect(codes).toHaveLength(10);
        expect(new Set(codes.map((code) => code.keyId.toString('hex')))).toEqual(
            new Set([await idOf(CURRENT)]),
        );

        // And what was made under it is read under it.
        expect(
            (await signInWith(who, { kind: 'totp', code: await appCode(enrol.body.secret) }))
                .status,
        ).toBe(200);
        expect(
            (await signInWith(who, { kind: 'backup', code: confirmed.body.backupCodes[0] })).status,
        ).toBe(200);
    }, 90_000);

    test('rows from before a rotation still pass: under TWO_STEP_PREVIOUS_KEY, and under the key derived from the OPAQUE setup', async () => {
        for (const [name, key] of [
            ['previous', PREVIOUS],
            ['derived', derived],
        ] as const) {
            const { who, cookie } = await signedIn();
            const { factorId, secret, codes } = await edge.stepUnder(key, who, cookie);
            const stored = (await edge.db.select().from(edge.schema.twoStepFactors)).find(
                (row) => row.id === factorId,
            )!;
            expect(stored.totpKeyId!.toString('hex'), name).toBe(await idOf(key));
            const withApp = await signInWith(who, { kind: 'totp', code: await appCode(secret) });
            expect(withApp.status, name).toBe(200);
            expect(withApp.session, name).toBeTruthy();
            const withCode = await signInWith(who, { kind: 'backup', code: codes[0]! });
            expect(withCode.status, name).toBe(200);
            // A code that is not one of the ten is still wrong, not "unavailable".
            expect(
                await signInWith(who, { kind: 'backup', code: 'AAAAA-AAAAA' }),
                name,
            ).toMatchObject({ status: 401, body: { code: 'step-wrong' } });
        }
    }, 120_000);

    test('a row under a key that is in none of the three places is unavailable, not wrong', async () => {
        const { who, cookie } = await signedIn();
        const { secret } = await edge.stepUnder(new Uint8Array(randomBytes(32)), who, cookie);
        expect(await signInWith(who, { kind: 'totp', code: await appCode(secret) })).toMatchObject({
            status: 503,
        });
        expect(await edge.db.select().from(edge.schema.sessions)).toHaveLength(1);
    }, 60_000);
});
