import { deriveTwoStepKey, openTotpSecret, twoStepKeyId } from '@hushos/crypto/two-step/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { appCode, fromBase32, loadEdge, type Edge } from '@/test/auth-edge.server';

/*
 * An instance whose operator set neither OPAQUE_SERVER_SETUP nor TWO_STEP_KEY: the OPAQUE
 * setup is made on first use and kept in `server_secrets`, and the two-step key is derived
 * from that stored value (docs/two-step-design.md 8). Through the HTTP edge, real OPAQUE and
 * Postgres. If the server derived the key from anything else (an empty variable, a setup made
 * afresh in memory), every authenticator app would stop working at the next restart.
 */

let edge: Edge;

beforeAll(async () => {
    edge = await loadEdge({ TWO_STEP_ENABLED: 'true' }, { setup: 'database' });
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

describe('the two-step key of an instance that keeps its OPAQUE setup in the database', () => {
    test('is derived from the setup stored in server_secrets: the secret opens under it, and a code signs in', async () => {
        const who = await edge.account();
        const first = await edge.signIn(who);
        expect(first.status).toBe(200);
        const cookie = first.session!;
        const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie });
        const enrol = await edge.call('POST', '/two-step/totp', proof, { cookie });
        expect(enrol.status).toBe(200);
        expect(
            (
                await edge.call(
                    'POST',
                    `/two-step/totp/${enrol.body.id}/confirm`,
                    { code: await appCode(enrol.body.secret, -1) },
                    { cookie },
                )
            ).status,
        ).toBe(200);

        // The setup as the database holds it, read past every helper.
        const { rows } = await edge.db.$client.query(
            `select value from server_secrets where name = 'opaque-setup:primary'`,
        );
        expect(rows).toHaveLength(1);
        const key = await deriveTwoStepKey(
            new Uint8Array(Buffer.from(rows[0].value as string, 'base64url')),
        );
        const [factor] = await edge.db.select().from(edge.schema.twoStepFactors);
        expect(factor!.totpKeyId!.toString('hex')).toBe(
            Buffer.from(await twoStepKeyId(key)).toString('hex'),
        );
        const opened = await openTotpSecret({
            sealed: factor!.totpSecret!,
            nonce: factor!.totpNonce!,
            key,
            userId: who.userId,
            factorId: factor!.id,
        });
        expect(Buffer.from(opened!)).toEqual(Buffer.from(fromBase32(enrol.body.secret)));

        const asked = await edge.signIn(who, { twoStep: true });
        expect(asked.body.twoStep.methods).toContain('totp');
        const passed = await edge.call('POST', '/login/two-step', {
            token: asked.body.twoStep.token,
            proof: { kind: 'totp', code: await appCode(enrol.body.secret) },
        });
        expect(passed.status).toBe(200);
        expect(passed.session).toBeTruthy();
    }, 90_000);
});
