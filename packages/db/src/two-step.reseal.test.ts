import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { registered, sha256 } from '../test/accounts';
import { closeDatabase, resetDatabase } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import { twoStepBackupCodes, twoStepFactors, twoStepKeyReaders } from './schema';
import * as twoStep from './two-step';

/*
 * Re-sealing after a rotation of the two-step key, the rows (docs/two-step-design.md 8). The
 * worker reads sealed secrets here and writes them back under the current key. The repository
 * opens nothing, so secrets are fixed bytes of the right length; what it must hold is that a
 * row is replaced only while it is still the row that was read, that nothing but the seal
 * changes, and that the worker is shown every row under another key exactly once.
 */

const HOUR = 60 * 60_000;

const fixed = (label: string, length: number) =>
    createHash('sha512').update(`hushos-reseal-test:${label}`).digest().subarray(0, length);
const keyId = (label: string) => fixed(`key:${label}`, 8);
/* A sealed TOTP secret as the server stores it, under the key `key` names. */
const seal = (key: string, label: string) => ({
    keyId: keyId(key),
    nonce: fixed(`${label}:nonce`, 24),
    sealedSecret: fixed(`${label}:secret`, 36),
});
const codeSet = (key: string, label: string) => ({
    keyId: keyId(key),
    hashes: Array.from({ length: 10 }, (_, index) => fixed(`${label}:code:${index}`, 32)),
});

async function session(userId: string) {
    const token = sha256(randomUUID());
    const result = await auth.createSession({
        userId,
        credentialVersion: 1,
        tokenHash: token,
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + HOUR),
    });
    if (!result || 'suspended' in result || 'twoStep' in result) throw new Error('No session.');
    return token;
}

/* An account with an app sealed under `key`: confirmed (last step 1,000, ten codes) unless `pending`. */
async function account(key: string, label: string, options: { pending?: boolean } = {}) {
    const { user } = await registered();
    const token = await session(user.id);
    const factorId = randomUUID();
    const sealed = seal(key, label);
    const started = await twoStep.startTotpFactor({ id: factorId, userId: user.id, ...sealed });
    if (started.status !== 'ok') throw new Error(`Start ${started.status}.`);
    if (!options.pending) {
        const confirmed = await twoStep.confirmTotpFactor({
            userId: user.id,
            factorId,
            step: 1_000,
            sessionTokenHash: token,
            credentialVersion: 1,
            backupCodes: codeSet(key, label),
        });
        if (confirmed.status !== 'ok') throw new Error(`Confirmation ${confirmed.status}.`);
    }
    return { userId: user.id, factorId, sealed };
}

async function stored(factorId: string) {
    const [row] = await db.select().from(twoStepFactors).where(eq(twoStepFactors.id, factorId));
    return row;
}
const sealOf = (row: Awaited<ReturnType<typeof stored>>) =>
    row && { keyId: row.totpKeyId, nonce: row.totpNonce, sealedSecret: row.totpSecret };

/* Every row the worker is shown for `current`, walked as the worker walks: page by page. */
async function walk(current: string, limit: number) {
    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
        const page: twoStep.SealedTotp[] = await twoStep.listTotpSealedOutside({
            keyId: keyId(current),
            after,
            limit,
        });
        seen.push(...page.map((row) => row.id));
        const last = page.at(-1);
        if (!last) return seen;
        after = last.id;
    }
}

beforeEach(resetDatabase);
afterAll(closeDatabase);

describe('the secrets shown for re-sealing', () => {
    test('are those under any key but the current one, pending apps too, each with what its seal names', async () => {
        const old = await account('old', 'a');
        const derived = await account('derived', 'b');
        const pending = await account('old', 'c', { pending: true });
        const current = await account('current', 'd');

        const page = await twoStep.listTotpSealedOutside({ keyId: keyId('current') });
        expect(page.map((row) => row.id).sort()).toEqual(
            [old.factorId, derived.factorId, pending.factorId].sort(),
        );
        expect(page.map((row) => row.id)).not.toContain(current.factorId);
        // The seal's associated data names the account and the method: both come with the row.
        const shown = page.find((row) => row.id === derived.factorId)!;
        expect(shown.userId).toBe(derived.userId);
        expect({
            keyId: shown.keyId,
            nonce: shown.nonce,
            sealedSecret: shown.sealedSecret,
        }).toEqual(derived.sealed);
    });

    test('a walk in small pages meets every one of them once, and passes the rows it cannot move', async () => {
        const ids: string[] = [];
        for (let index = 0; index < 7; index++)
            ids.push((await account(index % 2 ? 'old' : 'lost', `row-${index}`)).factorId);
        await account('current', 'kept');

        // Nothing is moved between pages, as when the worker has no key for any of them: a
        // walk that asked for "the first rows under another key" again would never end.
        for (const limit of [1, 2, 3, 7, 50])
            expect(await walk('current', limit), `limit ${limit}`).toEqual([...ids].sort());
        // A limit outside what a page may hold is brought into it, never read as "everything" or "nothing".
        expect(
            await twoStep.listTotpSealedOutside({ keyId: keyId('current'), limit: 0 }),
        ).toHaveLength(1);
    });
});

describe('re-sealing one secret', () => {
    test('writes the new seal and nothing else: the last accepted step, the confirmation and the account stay', async () => {
        const { factorId, sealed, userId } = await account('old', 'a');
        const before = (await stored(factorId))!;
        const to = seal('current', 'a-moved');

        expect(await twoStep.resealTotpSecret({ id: factorId, from: sealed, to })).toBe(true);

        const after = (await stored(factorId))!;
        expect(sealOf(after)).toEqual(to);
        // A re-seal that reset the last step would make an already used code good again.
        expect(after.totpLastStep).toBe(1_000);
        expect({ ...after, totpKeyId: null, totpNonce: null, totpSecret: null }).toEqual({
            ...before,
            totpKeyId: null,
            totpNonce: null,
            totpSecret: null,
        });
        // The account still has the step on, with the same method.
        expect((await twoStep.getTotpFactor(userId))!.id).toBe(factorId);
        expect(await twoStep.listTotpSealedOutside({ keyId: keyId('current') })).toEqual([]);
    });

    test('a second write from the same read changes nothing: the first one already moved the row', async () => {
        const { factorId, sealed } = await account('old', 'a');
        const first = seal('current', 'first');
        expect(await twoStep.resealTotpSecret({ id: factorId, from: sealed, to: first })).toBe(
            true,
        );
        // A retried job, or a second worker that read the row before the first wrote it.
        const second = seal('current', 'second');
        expect(await twoStep.resealTotpSecret({ id: factorId, from: sealed, to: second })).toBe(
            false,
        );
        expect(sealOf(await stored(factorId))).toEqual(first);
    });

    test('two runs racing for one row: exactly one wins, and the row is whole', async () => {
        const { factorId, sealed } = await account('old', 'a');
        const candidates = Array.from({ length: 6 }, (_, index) => seal('current', `run-${index}`));
        const results = await Promise.all(
            candidates.map((to) => twoStep.resealTotpSecret({ id: factorId, from: sealed, to })),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        // The winner's key id, nonce and bytes together, never a mix of two writes.
        expect(sealOf(await stored(factorId))).toEqual(candidates[results.indexOf(true)]);
    });

    test('a row that is no longer what was read is left alone: another key id, another nonce, other bytes', async () => {
        const { factorId, sealed } = await account('old', 'a');
        const to = seal('current', 'moved');
        const stale = [
            // Read under a key the row is no longer under.
            { ...sealed, keyId: keyId('older') },
            // The same key, but not the same seal: the row was written since.
            { ...sealed, nonce: fixed('other:nonce', 24) },
            { ...sealed, sealedSecret: fixed('other:secret', 36) },
        ];
        for (const from of stale)
            expect(await twoStep.resealTotpSecret({ id: factorId, from, to })).toBe(false);
        expect(sealOf(await stored(factorId))).toEqual(sealed);
    });

    test('an app that was replaced or removed since it was read is not brought back or overwritten', async () => {
        // Replaced: a new pending app for the same account takes the old pending one's place.
        const first = await account('old', 'first', { pending: true });
        const replacement = randomUUID();
        const started = await twoStep.startTotpFactor({
            id: replacement,
            userId: first.userId,
            ...seal('current', 'replacement'),
        });
        expect(started.status).toBe('ok');
        const to = seal('current', 'moved');
        expect(await twoStep.resealTotpSecret({ id: first.factorId, from: first.sealed, to })).toBe(
            false,
        );
        expect(await stored(first.factorId)).toBeUndefined();
        expect(sealOf(await stored(replacement))).toEqual(seal('current', 'replacement'));

        // Two accounts whose rows hold the same sealed bytes (a copied row): only the one named moves.
        const one = await account('old', 'same');
        const other = await account('old', 'same');
        expect(await twoStep.resealTotpSecret({ id: one.factorId, from: one.sealed, to })).toBe(
            true,
        );
        expect(sealOf(await stored(other.factorId))).toEqual(other.sealed);
    });

    test('a code accepted while the row is being re-sealed stays accepted', async () => {
        const { factorId, sealed, userId } = await account('old', 'a');
        const to = seal('current', 'moved');
        // A sign-in that passes the step with the code for step 1,001, at the same moment.
        const tokenHash = sha256(randomUUID());
        await twoStep.createStepAttempt({
            purpose: 'login',
            tokenHash,
            userId,
            credentialVersion: 1,
            device: null,
            previousTokenHash: null,
            expiresAt: new Date(Date.now() + 5 * 60_000),
        });
        const taken = await twoStep.takeStepAnswer({
            tokenHash,
            method: 'totp',
            purpose: 'login',
            sessionTokenHash: null,
        });
        expect(taken.status).toBe('ok');
        const [moved, opened] = await Promise.all([
            twoStep.resealTotpSecret({ id: factorId, from: sealed, to }),
            twoStep.openSteppedSession({
                tokenHash,
                spend: { method: 'totp', factorId, step: 1_001 },
                session: {
                    tokenHash: sha256(randomUUID()),
                    expiresAt: new Date(Date.now() + HOUR),
                },
            }),
        ]);
        expect(moved).toBe(true);
        expect(opened.status).toBe('ok');
        const after = (await stored(factorId))!;
        expect(sealOf(after)).toEqual(to);
        // Whichever committed first, the step that was spent is still spent.
        expect(after.totpLastStep).toBe(1_001);
    });
});

describe('what is still under each key', () => {
    test('counts secrets by key, and the accounts that still have an unused backup code under it', async () => {
        const a = await account('old', 'a');
        await account('old', 'b');
        await account('old', 'c', { pending: true });
        await account('current', 'd');

        const count = async () => {
            const under = await twoStep.sealedUnder();
            const hex = <T extends { keyId: Buffer }>(rows: T[], value: (row: T) => number) =>
                Object.fromEntries(rows.map((row) => [row.keyId.toString('hex'), value(row)]));
            return {
                totp: hex(under.totp, (row) => row.secrets),
                backupCodes: hex(under.backupCodes, (row) => row.accounts),
            };
        };
        const old = keyId('old').toString('hex');
        const current = keyId('current').toString('hex');
        // Three secrets under the old key (the pending one too); two accounts' code sets, not twenty codes.
        expect(await count()).toEqual({
            totp: { [old]: 3, [current]: 1 },
            backupCodes: { [old]: 2, [current]: 1 },
        });

        // A re-sealed secret moves between the counts; its backup codes stay where they were hashed.
        await twoStep.resealTotpSecret({
            id: a.factorId,
            from: a.sealed,
            to: seal('current', 'a-moved'),
        });
        // And a set with no unused code left holds nobody to the old key any more.
        await db
            .update(twoStepBackupCodes)
            .set({ usedAt: new Date() })
            .where(eq(twoStepBackupCodes.userId, a.userId));
        expect(await count()).toEqual({
            totp: { [old]: 2, [current]: 2 },
            backupCodes: { [old]: 1, [current]: 1 },
        });
    });
});

describe('the web processes that read two-step rows', () => {
    const MINUTE = 60_000;
    const T0 = new Date('2026-11-13T12:00:00.000Z');
    const after = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);
    const report = (instanceId: string, sealing: string, readable: string[], now: Date) =>
        twoStep.reportKeyReader({
            instanceId,
            sealingKeyId: keyId(sealing),
            readableKeyIds: readable.map(keyId),
            now,
        });
    const hex = (label: string) => keyId(label).toString('hex');
    const live = async (now: Date) => (await twoStep.liveKeyReaders(now)).readers;

    test('each process has one row: its first word starts the clock, later ones only say it is still there', async () => {
        const web = randomUUID();
        await report(web, 'b', ['a', 'b'], T0);
        await report(web, 'b', ['a', 'b'], after(3));
        await report(web, 'b', ['b', 'a', 'b'], after(4));

        expect(await db.select().from(twoStepKeyReaders)).toHaveLength(1);
        expect(await live(after(4))).toEqual([
            {
                instanceId: web,
                sealingKeyId: hex('b'),
                readableKeyIds: [hex('a'), hex('b')].sort(),
                // Since its first word, not its latest: the grace is counted from here.
                sealingSince: T0,
                seenAt: after(4),
            },
        ]);
        // A word that arrives late (two checks racing) never moves a process back in time.
        await report(web, 'b', ['a', 'b'], after(2));
        expect((await live(after(4)))[0]!.seenAt).toEqual(after(4));
    });

    test('a process that now seals under another key starts its clock again', async () => {
        const web = randomUUID();
        await report(web, 'a', ['a'], T0);
        await report(web, 'b', ['a', 'b'], after(10));
        expect((await live(after(10)))[0]).toMatchObject({
            sealingKeyId: hex('b'),
            sealingSince: after(10),
        });
    });

    test('a process counts for five minutes after its last word, and no longer', async () => {
        const running = randomUUID();
        const stopped = randomUUID();
        await report(stopped, 'a', ['a'], T0);
        await report(running, 'b', ['a', 'b'], after(4));

        const seen = async (minutes: number, seconds = 0) =>
            (await live(new Date(after(minutes).getTime() + seconds * 1000)))
                .map((reader) => reader.instanceId)
                .sort();
        expect(await seen(4, 59)).toEqual([running, stopped].sort());
        // Five minutes after its last word, the stopped one is no reader any more.
        expect(await seen(5)).toEqual([running]);
        expect(await seen(9)).toEqual([]);
        // Read without a moment, the database's own clock is used: these words are from 2026-11-13 noon.
        expect((await twoStep.liveKeyReaders()).readers).toEqual([]);
    });

    test('rows of processes not seen for an hour are deleted, and no sooner', async () => {
        const old = randomUUID();
        const recent = randomUUID();
        await report(old, 'a', ['a'], T0);
        await report(recent, 'b', ['b'], after(30));
        expect(await twoStep.dropStaleKeyReaders(after(60))).toBe(0);
        expect(await twoStep.dropStaleKeyReaders(after(61))).toBe(1);
        expect((await db.select().from(twoStepKeyReaders)).map((row) => row.instanceId)).toEqual([
            recent,
        ]);
    });

    test('only key ids are stored: a whole key is refused, and so is a process that cannot read the key it seals under', async () => {
        const web = randomUUID();
        // 32 bytes is a key, not its id: it must never be written where ids are kept.
        await expect(
            twoStep.reportKeyReader({
                instanceId: web,
                sealingKeyId: fixed('a-whole-key', 32),
                readableKeyIds: [keyId('a')],
                now: T0,
            }),
        ).rejects.toThrow('A two-step key id is 8 bytes.');
        await expect(
            twoStep.reportKeyReader({
                instanceId: web,
                sealingKeyId: keyId('a'),
                readableKeyIds: [keyId('a'), fixed('a-whole-key', 32)],
                now: T0,
            }),
        ).rejects.toThrow('A two-step key id is 8 bytes.');
        await expect(report(web, 'b', ['a'], T0)).rejects.toThrow();
        expect(await db.select().from(twoStepKeyReaders)).toEqual([]);
    });
});
