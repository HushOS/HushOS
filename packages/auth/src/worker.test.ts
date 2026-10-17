import { CryptoError, SavedAccessError } from '@hushos/crypto';
import { describe, expect, test, vi } from 'vitest';

/*
 * The worker's side of a failed operation (worker.ts): an account operation
 * that fails resets the session (its state is no longer to be trusted), while
 * a Drive or family operation's failure is an ordinary error and leaves the
 * session, and every key under the work still running, as it was. Otherwise a
 * server serving a family member list that does not hold could lock the
 * account on every sync. Only the operations the worker lists as family ones
 * count: one merely named like them still resets.
 */

const session = vi.hoisted(() => ({ handle: vi.fn(), reset: vi.fn() }));
vi.mock('@hushos/crypto', async (actual) => ({
    ...(await actual<Record<string, unknown>>()),
    createCryptoSession: () => session,
}));

const posted: unknown[] = [];
vi.stubGlobal('self', { postMessage: (message: unknown) => posted.push(message) });
await import('./worker');
const worker = globalThis.self as unknown as {
    onmessage: (event: {
        data: { id: number; operation: string; input: unknown };
    }) => Promise<void>;
};

async function fail(operation: string) {
    session.reset.mockClear();
    session.handle.mockRejectedValueOnce(new Error('refused'));
    await worker.onmessage({ data: { id: 1, operation, input: {} } });
    return session.reset.mock.calls.length > 0;
}

describe('a failed worker operation', () => {
    test.each([
        'groupAccept',
        'groupStage',
        'groupRestage',
        'groupStoreOpen',
        'identityConsent',
        'driveOpenNodes',
    ])('%s leaves the session as it was', async (operation) => {
        expect(await fail(operation)).toBe(false);
    });

    test.each(['unlock', 'identityOpen', 'settingsOpen', 'groupNotAFamilyOperation'])(
        '%s resets it',
        async (operation) => {
            expect(await fail(operation)).toBe(true);
        },
    );
});

/*
 * The client erases the saved unlock only for `invalid`, so the worker must say it for a saved
 * access that does not open, and for nothing else: any other failure would erase it.
 */
describe('a failed restore', () => {
    async function answer(error: Error) {
        posted.length = 0;
        session.handle.mockRejectedValueOnce(error);
        await worker.onmessage({ data: { id: 2, operation: 'restore', input: {} } });
        return posted[0] as { invalid?: boolean };
    }

    test('that did not open with the device key is marked invalid', async () => {
        expect((await answer(new SavedAccessError('does not open'))).invalid).toBe(true);
    });

    test('for any other reason is not', async () => {
        expect((await answer(new CryptoError('Your account was locked.'))).invalid).toBeUndefined();
        expect((await answer(new Error('worker reset'))).invalid).toBeUndefined();
    });
});
