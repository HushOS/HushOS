import { describe, expect, test } from 'vitest';
import { CryptoError } from './errors';
import { NOT_THIS_ACCOUNT, OLDER_CHAIN, OPEN_SETTINGS, SPLIT_CHAIN } from './protocol';
import { acceptFromRecord } from './record-acceptance';

/*
 * The order acceptance runs in against a device record (record-acceptance.ts,
 * the core's accept_served). Each attempt is scripted: what it answers, in
 * order, and the test reads which attempts ran. A wrong order either takes a
 * chain without the record's marks (a rollback), refuses a family for good on
 * a damaged cache, or reports a race as "the server keeps serving an older
 * member list" when one fetch from version 1 would have settled it.
 */

type Answer = 'accepted' | Error;
const refused = () => new CryptoError('This is an older member list than this device has seen.');
const older = () => new CryptoError(OLDER_CHAIN);
const split = () => new CryptoError(SPLIT_CHAIN);
class RouteError extends Error {}

async function run(recordVersion: number | null, answers: Answer[]) {
    const attempts: string[] = [];
    let at = 0;
    const accept = async (after: number, withoutCache: boolean) => {
        attempts.push(`${after}${withoutCache ? ' without cache' : ''}`);
        const answer = answers[at++];
        if (answer === undefined) throw new Error('an attempt nobody scripted');
        if (answer instanceof Error) throw answer;
        return answer;
    };
    try {
        return {
            result: await acceptFromRecord(recordVersion, accept, (e) => e instanceof RouteError),
            attempts,
        };
    } catch (error) {
        return { error, attempts };
    }
}

describe('the order acceptance runs in', () => {
    test('every attempt but the last says it is retried, so the worker keeps the family committed until the last refusal', async () => {
        const flags = async (recordVersion: number | null, answers: Answer[]) => {
            const seen: boolean[] = [];
            let at = 0;
            await acceptFromRecord(recordVersion, async (_after, _withoutCache, retried) => {
                seen.push(retried);
                const answer = answers[at++]!;
                if (answer instanceof Error) throw answer;
                return answer;
            }).catch(() => undefined);
            return seen;
        };
        expect(await flags(5, [refused(), refused(), refused()])).toEqual([true, true, false]);
        expect(await flags(0, [refused(), refused()])).toEqual([true, false]);
        // Without a record the one attempt is the last: its refusal uncommits.
        expect(await flags(null, [refused()])).toEqual([false]);
    });

    test('without a record, once, from version 1, whatever it answers', async () => {
        const { error, attempts } = await run(null, [refused()]);
        expect(attempts).toEqual(['0']);
        expect((error as Error).message).toMatch(/older member list/);
        expect((await run(null, [older()])).attempts).toEqual(['0']);
    });

    test('a refused continuation goes from version 1 with the cache, then without it', async () => {
        expect(await run(5, [refused(), 'accepted'])).toEqual({
            result: 'accepted',
            attempts: ['5', '0'],
        });
        expect(await run(5, [refused(), refused(), 'accepted'])).toEqual({
            result: 'accepted',
            attempts: ['5', '0', '0 without cache'],
        });
        // A record stored at version 0 starts from version 1: the second attempt is the last.
        expect((await run(0, [refused(), 'accepted'])).attempts).toEqual(['0', '0 without cache']);
    });

    test('a continuation overtaken by a later commit fetches from version 1 once, and only there is it the answer', async () => {
        expect(await run(5, [older(), 'accepted'])).toEqual({
            result: 'accepted',
            attempts: ['5', '0'],
        });
        // Overtaken from version 1 with the cache: the caller's, no attempt without the cache.
        const second = await run(5, [older(), split()]);
        expect(second.attempts).toEqual(['5', '0']);
        expect((second.error as Error).message).toBe(SPLIT_CHAIN);
        // Overtaken without the cache: the caller's too.
        const third = await run(5, [refused(), refused(), older()]);
        expect(third.attempts).toEqual(['5', '0', '0 without cache']);
        expect((third.error as Error).message).toBe(OLDER_CHAIN);
        // Overtaken on a first attempt that was already from version 1: the answer at once.
        const fromOne = await run(0, [older()]);
        expect(fromOne.attempts).toEqual(['0']);
        expect((fromOne.error as Error).message).toBe(OLDER_CHAIN);
    });

    test('the route’s own answers are never retried', async () => {
        const first = await run(5, [new RouteError('not-member')]);
        expect(first.attempts).toEqual(['5']);
        expect(first.error).toBeInstanceOf(RouteError);
        const second = await run(5, [refused(), new RouteError('not-member')]);
        expect(second.attempts).toEqual(['5', '0']);
        expect(second.error).toBeInstanceOf(RouteError);
    });

    test('a session or account that changed, or settings not open, is never retried', async () => {
        for (const message of [NOT_THIS_ACCOUNT, OPEN_SETTINGS]) {
            const first = await run(5, [new CryptoError(message)]);
            expect(first.attempts).toEqual(['5']);
            expect((first.error as Error).message).toBe(message);
            const second = await run(5, [refused(), new CryptoError(message)]);
            expect(second.attempts).toEqual(['5', '0']);
            expect((second.error as Error).message).toBe(message);
        }
    });
});
