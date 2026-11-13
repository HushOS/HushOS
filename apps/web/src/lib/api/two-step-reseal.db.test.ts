import { randomBytes, randomUUID } from 'node:crypto';
import type * as Keys from '@hushos/auth/two-step-keys';
import { deriveTwoStepKey, openTotpSecret, twoStepKeyId } from '@hushos/crypto/two-step/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { appCode, fromBase32, loadEdge, type Account, type Edge } from '@/test/auth-edge.server';

/*
 * Re-sealing after a rotation of the two-step key (docs/two-step-design.md 8): the worker's
 * job itself, on the keys this instance was started with, against Postgres, with every
 * sign-in through the HTTP edge and real OPAQUE. TWO_STEP_KEY is set,
 * TWO_STEP_PREVIOUS_KEY is the key before it, and the instance began on the key derived from
 * its OPAQUE setup. After the job, every secret it could open is under TWO_STEP_KEY and its
 * codes still sign in, so the old key can go at the next rotation; and whatever it could not
 * open is exactly as it was, because the only copy of someone's second step is in that row.
 */

const CURRENT = new Uint8Array(randomBytes(32));
const PREVIOUS = new Uint8Array(randomBytes(32));
const LOST = new Uint8Array(randomBytes(32));
const encoded = (key: Uint8Array) => Buffer.from(key).toString('base64url');
const idOf = async (key: Uint8Array) => Buffer.from(await twoStepKeyId(key)).toString('hex');

type Run = Awaited<ReturnType<(typeof Keys)['resealTwoStepSecrets']>>;

let edge: Edge;
let keys: typeof Keys;
let derived: Uint8Array;
/* The worker's job, as pg-boss calls it. */
let job: () => Promise<Run>;

beforeAll(async () => {
    edge = await loadEdge({
        TWO_STEP_ENABLED: 'true',
        TWO_STEP_KEY: encoded(CURRENT),
        TWO_STEP_PREVIOUS_KEY: encoded(PREVIOUS),
    });
    // Loaded after the environment is set, as the worker loads them after its own.
    keys = await import('@hushos/auth/two-step-keys');
    // The jobs package exports only its client to the web app, so the handler is named by its file.
    const { twoStepReseal } = (await import(
        new URL('../../../../../packages/jobs/src/jobs/two-step.ts', import.meta.url).pathname
    )) as { twoStepReseal: (job: unknown) => Promise<Run> };
    job = () =>
        twoStepReseal({
            id: randomUUID(),
            name: 'auth.two-step-reseal',
            data: {},
            signal: new AbortController().signal,
        });
    derived = await deriveTwoStepKey(
        new Uint8Array(Buffer.from(await edge.serverSetup(), 'base64url')),
    );
});
beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await edge.resetDatabase();
    edge.outbox.length = 0;
    edge.emitted.length = 0;
});
afterEach(() => {
    vi.useRealTimers();
});
afterAll(() => edge.closeDatabase());

/* An account with an app and ten codes made under `key`, as an instance on that key made them. */
async function accountUnder(key: Uint8Array) {
    const who = await edge.account();
    const first = await edge.signIn(who);
    expect(first.status).toBe(200);
    return { who, ...(await edge.stepUnder(key, who, first.session!)) };
}

/* A sign-in through the step with `proof`: the reply to the answer. */
async function signInWith(who: Account, proof: Record<string, string>) {
    const asked = await edge.signIn(who, { twoStep: true });
    expect(asked.body.twoStep).toBeDefined();
    return edge.call('POST', '/login/two-step', { token: asked.body.twoStep.token, proof });
}

async function row(factorId: string) {
    const found = (await edge.db.select().from(edge.schema.twoStepFactors)).find(
        (factor) => factor.id === factorId,
    )!;
    return {
        sealedWith: found.totpKeyId!.toString('hex'),
        nonce: found.totpNonce!.toString('hex'),
        sealed: found.totpSecret!.toString('hex'),
        lastStep: found.totpLastStep,
        userId: found.userId,
    };
}

/* What `key` opens of the stored row, as base32, or null. */
async function opened(factorId: string, key: Uint8Array) {
    const found = (await edge.db.select().from(edge.schema.twoStepFactors)).find(
        (factor) => factor.id === factorId,
    )!;
    const secret = await openTotpSecret({
        sealed: found.totpSecret!,
        nonce: found.totpNonce!,
        key,
        userId: found.userId,
        factorId,
    });
    return secret && Buffer.from(secret).toString('hex');
}
const hexOf = (secret: string) => Buffer.from(fromBase32(secret)).toString('hex');

/* The web service says which key it seals under, as it does once it is ready. */
async function webIsUp() {
    const auth = await import('@hushos/auth/server');
    await auth.announceTwoStepKey();
}

describe('the re-seal job after a key rotation', () => {
    test('moves secrets from the previous key and from the derived key to TWO_STEP_KEY, and their codes still sign in', async () => {
        const fromPrevious = await accountUnder(PREVIOUS);
        const fromDerived = await accountUnder(derived);
        // A code accepted before the job: the step it spent must stay spent afterwards.
        const used = await appCode(fromPrevious.secret);
        expect((await signInWith(fromPrevious.who, { kind: 'totp', code: used })).status).toBe(200);
        const spent = (await row(fromPrevious.factorId)).lastStep;
        await webIsUp();

        const run = await job();
        expect(run).toMatchObject({
            status: 'done',
            sealedWith: await idOf(CURRENT),
            moved: 2,
            changed: 0,
            unopened: 0,
            unknown: {},
            left: {},
        });

        for (const { factorId, secret } of [fromPrevious, fromDerived]) {
            expect((await row(factorId)).sealedWith).toBe(await idOf(CURRENT));
            // The same secret, under the current key alone: neither old key is needed for it again.
            expect(await opened(factorId, CURRENT)).toBe(hexOf(secret));
            expect(await opened(factorId, PREVIOUS)).toBeNull();
            expect(await opened(factorId, derived)).toBeNull();
        }

        // The person's app is untouched, and its codes pass at the real server.
        expect(
            (
                await signInWith(fromDerived.who, {
                    kind: 'totp',
                    code: await appCode(fromDerived.secret),
                })
            ).status,
        ).toBe(200);
        // The code used before the job is still a used code: the last step came through the re-seal.
        expect((await row(fromPrevious.factorId)).lastStep).toBe(spent);
        expect(await signInWith(fromPrevious.who, { kind: 'totp', code: used })).toMatchObject({
            status: 401,
            body: { code: 'step-wrong' },
        });
        expect(
            (
                await signInWith(fromPrevious.who, {
                    kind: 'totp',
                    code: await appCode(fromPrevious.secret, 1),
                })
            ).status,
        ).toBe(200);
    }, 120_000);

    test('backup codes are not re-keyed: they stay under their key, are counted for the operator, and still sign in', async () => {
        const account = await accountUnder(PREVIOUS);
        await webIsUp();
        const run = await job();
        expect(run).toMatchObject({
            status: 'done',
            moved: 1,
            left: {},
            backupCodes: { [await idOf(PREVIOUS)]: 1 },
        });
        const codes = await edge.db.select().from(edge.schema.twoStepBackupCodes);
        expect(new Set(codes.map((code) => code.keyId.toString('hex')))).toEqual(
            new Set([await idOf(PREVIOUS)]),
        );
        expect(
            (await signInWith(account.who, { kind: 'backup', code: account.codes[0]! })).status,
        ).toBe(200);
    }, 90_000);

    test('a secret under a key the worker does not have is left exactly as it is, and named by its key id', async () => {
        const lost = await accountUnder(LOST);
        const movable = await accountUnder(PREVIOUS);
        const before = await row(lost.factorId);
        await webIsUp();

        const run = await job();
        expect(run).toMatchObject({
            status: 'done',
            moved: 1,
            unopened: 0,
            unknown: { [await idOf(LOST)]: 1 },
            left: { [await idOf(LOST)]: 1 },
        });
        // Not a byte of it changed: the key can still be put back, and only it opens the row.
        expect(await row(lost.factorId)).toEqual(before);
        expect(await opened(lost.factorId, LOST)).toBe(hexOf(lost.secret));
        expect((await row(movable.factorId)).sealedWith).toBe(await idOf(CURRENT));

        // A worker that cannot read the OPAQUE setup has no derived key: such rows wait too.
        const waiting = await accountUnder(derived);
        const derivedBefore = await row(waiting.factorId);
        const withoutSetup = await keys.twoStepKeyring({
            serverSetup: null,
            key: encoded(CURRENT),
            previousKey: encoded(PREVIOUS),
        });
        expect(await keys.resealTwoStepSecrets({ keyring: withoutSetup })).toMatchObject({
            status: 'done',
            moved: 0,
            unknown: { [await idOf(LOST)]: 1, [await idOf(derived)]: 1 },
        });
        expect(await row(waiting.factorId)).toEqual(derivedBefore);
    }, 120_000);

    test('a row that does not open under the key it names is never given a fresh seal', async () => {
        const victim = await accountUnder(PREVIOUS);
        const other = await accountUnder(PREVIOUS);
        // Someone who can write to the database puts their own app's sealed secret on the
        // victim's row. The seal names the account and the method, so it does not open there.
        const theirs = (await edge.db.select().from(edge.schema.twoStepFactors)).find(
            (factor) => factor.id === other.factorId,
        )!;
        await edge.db
            .update(edge.schema.twoStepFactors)
            .set({ totpNonce: theirs.totpNonce, totpSecret: theirs.totpSecret });
        const before = await row(victim.factorId);
        await webIsUp();

        const run = await job();
        expect(run).toMatchObject({
            status: 'done',
            moved: 1,
            unopened: 1,
            left: { [await idOf(PREVIOUS)]: 1 },
        });
        expect(await row(victim.factorId)).toEqual(before);
        // Re-sealed with the victim's names, the attacker's codes would have passed the victim's step.
        expect(await opened(victim.factorId, CURRENT)).toBeNull();
        expect((await row(other.factorId)).sealedWith).toBe(await idOf(CURRENT));
    }, 90_000);

    test('nothing moves until the web service seals under the worker’s current key', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = await row(account.factorId);

        // The web service has said nothing yet: it may still be running on the old settings.
        expect(await job()).toEqual({
            status: 'waiting',
            sealedWith: await idOf(CURRENT),
            webSealsWith: null,
        });
        expect(await row(account.factorId)).toEqual(before);

        // The web service seals under TWO_STEP_KEY; a worker given some other key is not followed.
        await webIsUp();
        const stray = new Uint8Array(randomBytes(32));
        const strayRing = await keys.twoStepKeyring({
            serverSetup: await edge.serverSetup(),
            key: encoded(stray),
            previousKey: encoded(PREVIOUS),
        });
        expect(await keys.resealTwoStepSecrets({ keyring: strayRing })).toEqual({
            status: 'waiting',
            sealedWith: await idOf(stray),
            webSealsWith: await idOf(CURRENT),
        });
        expect(await row(account.factorId)).toEqual(before);
        // Moved to the stray key, no web process could have opened it again.
        expect(await opened(account.factorId, stray)).toBeNull();

        // A worker with no key at all (no TWO_STEP_KEY, no setup it can read) does nothing either.
        expect(await keys.resealTwoStepSecrets({ keyring: null })).toEqual({ status: 'no-key' });
        expect(await row(account.factorId)).toEqual(before);

        expect((await job()).status).toBe('done');
        expect((await row(account.factorId)).sealedWith).toBe(await idOf(CURRENT));
    }, 90_000);

    test('a second run finds nothing to do and rewrites nothing', async () => {
        const account = await accountUnder(PREVIOUS);
        await webIsUp();
        expect(await job()).toMatchObject({ status: 'done', moved: 1 });
        const after = await row(account.factorId);
        expect(await job()).toMatchObject({ status: 'done', moved: 0, changed: 0, left: {} });
        // The same nonce: a run that re-sealed what is already current would churn every row at every run.
        expect(await row(account.factorId)).toEqual(after);
    }, 90_000);

    test('the job’s log line has counts and key ids an operator can read, and no key or secret', async () => {
        const account = await accountUnder(PREVIOUS);
        const lost = await accountUnder(LOST);
        await webIsUp();
        edge.emitted.length = 0;
        await job();

        const line = edge.emitted.find(
            (event) => (event.twoStep as { reseal?: string } | undefined)?.reseal === 'done',
        );
        // Read after redaction: a field the log blanked would tell the operator nothing.
        expect(line?.twoStep).toMatchObject({
            reseal: 'done',
            sealedWith: await idOf(CURRENT),
            moved: 1,
            unknown: { [await idOf(LOST)]: 1 },
            left: 1,
            leftUnder: { [await idOf(LOST)]: 1 },
            backupCodesUnder: { [await idOf(PREVIOUS)]: 1, [await idOf(LOST)]: 1 },
        });
        const logged = JSON.stringify(edge.emitted);
        const forms = (bytes: Uint8Array) => [
            Buffer.from(bytes).toString('hex'),
            Buffer.from(bytes).toString('base64url'),
            Buffer.from(bytes).toString('base64'),
        ];
        const stored = await edge.db.select().from(edge.schema.twoStepFactors);
        for (const secret of [
            ...forms(CURRENT),
            ...forms(PREVIOUS),
            ...forms(derived),
            ...forms(fromBase32(account.secret)),
            account.secret,
            lost.secret,
            ...stored.flatMap((factor) => forms(factor.totpSecret!)),
        ])
            expect(logged).not.toContain(secret);
    }, 90_000);
});
