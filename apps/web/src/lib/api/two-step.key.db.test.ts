import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { captureMail, startApi, steadyClock, type Harness } from '@/test/two-step-api.server';

/*
 * An operator sets TWO_STEP_KEY on a server whose accounts already have a
 * second step (docs/two-step-design.md 8): everything made under the derived
 * key, which is what the harness seals and hashes under, must keep working,
 * and everything made from then on is under the new key. Backup codes cannot
 * be re-keyed, so a set keeps verifying under the key it names.
 */

const KEY = randomBytes(32);
let api: Harness;

beforeAll(async () => {
    api = await startApi({ TWO_STEP_ENABLED: 'true', TWO_STEP_KEY: KEY.toString('base64url') });
});
beforeEach(async () => {
    steadyClock();
    await api.resetDatabase();
    captureMail();
});
afterAll(async () => {
    vi.useRealTimers();
    await api.closeDatabase();
});

const keyId = (key: Buffer) => createHash('sha256').update(key).digest().subarray(0, 8);

test('an app and backup codes from before the key was set still pass the step', async () => {
    const who = await api.account();
    const app = await api.enrol(who.id);
    const [factor] = await api.rows.factorRows();
    // Sealed under the derived key, not the operator's.
    expect(factor!.totpKeyId).toEqual((await api.twoStepKey()).id);
    expect(factor!.totpKeyId).not.toEqual(keyId(KEY));

    for (const proof of [
        { kind: 'totp', code: await app.code() },
        { kind: 'backup', code: app.backupCodes[0] },
    ]) {
        const asked = await api.signIn(who);
        const done = await api.call('POST', '/login/two-step', {
            token: asked.body.twoStep.token,
            proof,
        });
        expect(done.status, proof.kind).toBe(200);
    }
});

test('what is made after it is under the new key, and works beside the old', async () => {
    const who = await api.account();
    const old = await api.enrol(who.id);
    const first = await api.signIn(who);
    const { cookie } = await api.call('POST', '/login/two-step', {
        token: first.body.twoStep.token,
        proof: { kind: 'totp', code: await old.code() },
    });
    const token = await api.call(
        'POST',
        '/two-step/challenge',
        { purpose: 'two-step' },
        { cookie },
    );
    const password = await api.prove(who, '/two-step/reauth', { cookie });
    const made = await api.call(
        'POST',
        '/two-step/backup-codes',
        {
            attemptToken: password.attemptToken,
            finishLoginRequest: password.finishLoginRequest,
            twoStep: {
                token: token.body.token,
                proof: { kind: 'backup', code: old.backupCodes[1] },
            },
        },
        { cookie },
    );
    expect(made.status).toBe(200);
    const stored = await api.rows.backupCodeRows();
    expect(stored).toHaveLength(10);
    for (const row of stored) expect(row.keyId).toEqual(keyId(KEY));

    // A new code passes; the old app, still sealed under the derived key, does too.
    for (const proof of [
        { kind: 'backup', code: made.body.codes[0] },
        { kind: 'totp', code: await old.code(1) },
    ]) {
        const asked = await api.signIn(who);
        const done = await api.call('POST', '/login/two-step', {
            token: asked.body.twoStep.token,
            proof,
        });
        expect(done.status, proof.kind).toBe(200);
    }
});
