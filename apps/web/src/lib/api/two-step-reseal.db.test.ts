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

const MINUTE = 60_000;

/*
 * The web service has been up on these settings for a while: this process says which keys it
 * has, as it does at every readiness check, and its first word is dated 31 minutes back, as
 * if it had been saying so since then.
 */
async function webIsUp() {
    const auth = await import('@hushos/auth/server');
    await auth.reportTwoStepKeys();
    await edge.db
        .update(edge.schema.twoStepKeyReaders)
        .set({ sealingSince: new Date(Date.now() - 31 * MINUTE) });
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

/*
 * Re-sealing overwrites the old seal, so the worker moves nothing to a key until every web
 * process that is running can read that key, seals under it, and has for 30 minutes. Each
 * process below is a row as a web process writes it at its readiness checks; the times are
 * given, so a rollout is played out minute by minute.
 */
describe('the worker waits for every web process', () => {
    const T0 = new Date('2026-01-10T09:00:00.000Z');
    const at = (minutes: number, seconds = 0) =>
        new Date(T0.getTime() + minutes * MINUTE + seconds * 1000);
    const id = async (key: Uint8Array) => Buffer.from(await twoStepKeyId(key));

    /* A web process on the new settings: it seals under TWO_STEP_KEY and reads all three keys. */
    const onNew = () => ({ sealing: CURRENT, readable: [CURRENT, PREVIOUS, derived] });
    /* One still on the settings from before the rotation: PREVIOUS was its key, and it never heard of CURRENT. */
    const onOld = () => ({ sealing: PREVIOUS, readable: [PREVIOUS, derived] });

    /* One readiness check of a web process, at `now`. */
    async function seen(
        instanceId: string,
        process: { sealing: Uint8Array; readable: Uint8Array[] },
        now: Date,
    ) {
        await edge.twoStepRepository.reportKeyReader({
            instanceId,
            sealingKeyId: await id(process.sealing),
            readableKeyIds: await Promise.all(process.readable.map(id)),
            now,
        });
    }
    /* The worker's run at `now`, on the keys this instance was started with. */
    const run = (now: Date) => keys.resealTwoStepSecrets({ now });

    test('with no web process seen, nothing moves', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = await row(account.factorId);
        expect(await run(at(0))).toEqual({
            status: 'waiting',
            sealedWith: await idOf(CURRENT),
            reason: 'no-reader',
            readers: 0,
            webSealsWith: [],
            readyAt: null,
        });
        expect(await row(account.factorId)).toEqual(before);
    }, 60_000);

    test('a mixed fleet blocks: one process still on the old key is enough', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = await row(account.factorId);
        const [fresh, stale] = [randomUUID(), randomUUID()];
        // The new process has been up for 40 minutes; an old one is still answering beside it.
        await seen(fresh, onNew(), at(0));
        await seen(fresh, onNew(), at(40));
        await seen(stale, onOld(), at(0));
        await seen(stale, onOld(), at(40));

        expect(await run(at(40))).toMatchObject({
            status: 'waiting',
            reason: 'cannot-read',
            readers: 2,
            webSealsWith: [await idOf(CURRENT), await idOf(PREVIOUS)].sort(),
        });
        // Moved now, the secret would be unreadable to the old process, and this person's
        // next sign-in may land on it.
        expect(await row(account.factorId)).toEqual(before);

        // A rollout taken back with both keys kept: the old process can read CURRENT, and
        // still seals under PREVIOUS. Nothing may be moved away from the key it writes with.
        await seen(stale, { sealing: PREVIOUS, readable: [CURRENT, PREVIOUS, derived] }, at(41));
        await seen(fresh, onNew(), at(41));
        expect(await run(at(41))).toMatchObject({ status: 'waiting', reason: 'other-key' });
        expect(await row(account.factorId)).toEqual(before);
    }, 60_000);

    test('a fleet fully on the new key blocks until it has been for 30 minutes', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = await row(account.factorId);
        const [one, two] = [randomUUID(), randomUUID()];
        await seen(one, onNew(), at(0));
        // The second process came up three minutes after the first: the 30 minutes are its.
        await seen(two, onNew(), at(3));
        await seen(one, onNew(), at(32, 59));
        await seen(two, onNew(), at(32, 59));

        expect(await run(at(32, 59))).toEqual({
            status: 'waiting',
            sealedWith: await idOf(CURRENT),
            reason: 'grace',
            readers: 2,
            webSealsWith: [await idOf(CURRENT)],
            readyAt: at(33).toISOString(),
        });
        // A rollout taken back in its first half hour finds every secret where it was.
        expect(await row(account.factorId)).toEqual(before);

        await seen(one, onNew(), at(33));
        await seen(two, onNew(), at(33));
        expect(await run(at(33))).toMatchObject({ status: 'done', moved: 1, left: {} });
        expect((await row(account.factorId)).sealedWith).toBe(await idOf(CURRENT));
    }, 60_000);

    test('a web process that restarts is a new reader, and the 30 minutes start again', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = await row(account.factorId);
        const first = randomUUID();
        await seen(first, onNew(), at(0));
        await seen(first, onNew(), at(20));
        // It restarts at minute 20: a new process, which says so under a new id.
        const restarted = randomUUID();
        await seen(restarted, onNew(), at(20));
        await seen(restarted, onNew(), at(31));

        // Thirty minutes after the first start, but only eleven after the restart.
        expect(await run(at(31))).toMatchObject({
            status: 'waiting',
            reason: 'grace',
            readers: 1,
            readyAt: at(50).toISOString(),
        });
        expect(await row(account.factorId)).toEqual(before);

        await seen(restarted, onNew(), at(50));
        expect(await run(at(50))).toMatchObject({ status: 'done', moved: 1 });
    }, 60_000);

    test('a process that has stopped answering stops blocking after five minutes', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = await row(account.factorId);
        const [fresh, gone] = [randomUUID(), randomUUID()];
        await seen(fresh, onNew(), at(0));
        // The old process answered its last readiness check at minute 40, and was stopped.
        await seen(gone, onOld(), at(0));
        await seen(gone, onOld(), at(40));

        await seen(fresh, onNew(), at(44, 59));
        expect(await run(at(44, 59))).toMatchObject({
            status: 'waiting',
            reason: 'cannot-read',
            readers: 2,
        });
        expect(await row(account.factorId)).toEqual(before);

        // Five minutes after its last word it is no reader any more, and the rotation goes on.
        await seen(fresh, onNew(), at(45));
        expect(await run(at(45))).toMatchObject({ status: 'done', moved: 1, left: {} });
        // Its row is kept for an hour, then deleted by the worker's own run.
        expect(await edge.db.select().from(edge.schema.twoStepKeyReaders)).toHaveLength(2);
        await seen(fresh, onNew(), at(101));
        await run(at(101));
        expect(
            (await edge.db.select().from(edge.schema.twoStepKeyReaders)).map(
                (reader) => reader.instanceId,
            ),
        ).toEqual([fresh]);
    }, 60_000);

    test('a worker given a key the web service does not have moves nothing to it', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = await row(account.factorId);
        const web = randomUUID();
        await seen(web, onNew(), at(0));
        await seen(web, onNew(), at(40));

        const stray = new Uint8Array(randomBytes(32));
        const strayRing = await keys.twoStepKeyring({
            serverSetup: await edge.serverSetup(),
            key: encoded(stray),
            previousKey: encoded(PREVIOUS),
        });
        expect(await keys.resealTwoStepSecrets({ keyring: strayRing, now: at(40) })).toMatchObject({
            status: 'waiting',
            sealedWith: await idOf(stray),
            reason: 'cannot-read',
            webSealsWith: [await idOf(CURRENT)],
        });
        expect(await row(account.factorId)).toEqual(before);
        // Moved to the stray key, no web process could have opened it again.
        expect(await opened(account.factorId, stray)).toBeNull();

        // A worker with no key at all (no TWO_STEP_KEY, no setup it can read) does nothing either.
        expect(await keys.resealTwoStepSecrets({ keyring: null, now: at(40) })).toEqual({
            status: 'no-key',
        });
        expect(await row(account.factorId)).toEqual(before);
        // It still clears the rows of web processes long gone: left to a worker that has a
        // key, they would pile up for as long as this one has none.
        expect(await edge.db.select().from(edge.schema.twoStepKeyReaders)).toHaveLength(1);
        expect(await keys.resealTwoStepSecrets({ keyring: null, now: at(101) })).toEqual({
            status: 'no-key',
        });
        expect(await edge.db.select().from(edge.schema.twoStepKeyReaders)).toEqual([]);
    }, 60_000);

    test('this web process says what it really has, and the job waits for it, with the reason as a warning', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = await row(account.factorId);
        const auth = await import('@hushos/auth/server');
        await auth.reportTwoStepKeys();
        await auth.reportTwoStepKeys();

        // One row for the process, with the key it seals under and every key it reads, by id.
        const readers = await edge.db.select().from(edge.schema.twoStepKeyReaders);
        expect(readers).toHaveLength(1);
        expect(readers[0]).toMatchObject({
            sealingKeyId: await idOf(CURRENT),
            readableKeyIds: [await idOf(CURRENT), await idOf(PREVIOUS), await idOf(derived)].sort(),
        });
        expect(JSON.stringify(readers)).not.toContain(encoded(CURRENT));

        // It only just said so: the job, as pg-boss runs it, waits out the 30 minutes.
        edge.emitted.length = 0;
        expect(await job()).toMatchObject({ status: 'waiting', reason: 'grace', readers: 1 });
        expect(await row(account.factorId)).toEqual(before);
        const line = edge.emitted.find(
            (event) => (event.twoStep as { reseal?: string } | undefined)?.reseal === 'waiting',
        );
        expect(line).toMatchObject({
            level: 'warn',
            twoStep: {
                reseal: 'waiting',
                reason: 'grace',
                sealedWith: await idOf(CURRENT),
                webProcesses: 1,
                webSealsWith: [await idOf(CURRENT)],
            },
        });
        expect(JSON.stringify(line)).toContain('not all have for 30 minutes yet');

        // The same process, half an hour on.
        await edge.db
            .update(edge.schema.twoStepKeyReaders)
            .set({ sealingSince: new Date(Date.now() - 31 * MINUTE) });
        expect(await job()).toMatchObject({ status: 'done', moved: 1 });
    }, 60_000);
});

describe('when the re-seal job fails', () => {
    test('neither the log nor what the job throws carries the failed query or its parameters', async () => {
        const account = await accountUnder(PREVIOUS);
        const before = (await edge.db.select().from(edge.schema.twoStepFactors))[0]!;
        await webIsUp();
        // The database refuses the write: Postgres names the statement, and the driver's error
        // repeats it with its parameters, which here are a nonce and a sealed secret.
        const blocked = `two_step_factors_test_block_${Date.now()}`;
        await edge.db.execute(
            `alter table two_step_factors add constraint ${blocked} check (encode(totp_key_id, 'hex') <> '${await idOf(CURRENT)}') not valid`,
        );
        edge.emitted.length = 0;
        let thrown: unknown;
        try {
            await job();
        } catch (error) {
            thrown = error;
        } finally {
            await edge.db.execute(`alter table two_step_factors drop constraint ${blocked}`);
        }

        expect(thrown).toBeInstanceOf(Error);
        const failure = thrown as Error & { code?: string; cause?: unknown };
        // What pg-boss keeps of a failed job: a name and the database's code, and no more.
        expect(failure.message).toBe('Two-step re-seal failed.');
        expect(failure.code).toBe('23514');
        expect(failure.cause).toBeUndefined();

        const line = edge.emitted.find((event) => event.failure);
        expect(line?.failure).toMatchObject({ cause: { code: '23514' } });
        const everything = `${JSON.stringify(edge.emitted)}\n${failure.stack}\n${JSON.stringify(failure, Object.getOwnPropertyNames(failure))}`;
        expect(everything).not.toMatch(/update|Failed query|params/i);
        const forms = (bytes: Uint8Array) => [
            Buffer.from(bytes).toString('hex'),
            Buffer.from(bytes).toString('base64'),
            Buffer.from(bytes).toString('base64url'),
            // How a failed query's message prints a binary parameter.
            Buffer.from(bytes).toString('utf8'),
            Buffer.from(bytes).toString('latin1'),
            Array.from(bytes).join(','),
        ];
        for (const secret of [
            ...forms(before.totpNonce!),
            ...forms(before.totpSecret!),
            ...forms(CURRENT),
            ...forms(PREVIOUS),
            account.secret,
        ])
            expect(everything).not.toContain(secret);
        // And the row is as it was: the failed write changed nothing.
        expect(await row(account.factorId)).toMatchObject({
            sealedWith: await idOf(PREVIOUS),
            nonce: before.totpNonce!.toString('hex'),
        });
    }, 60_000);
});
