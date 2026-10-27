import { createAuthClient } from '@hushos/auth/client';
import type { AuthApi } from '@hushos/auth/api';
import type { CryptoTransport } from '@hushos/auth/crypto-transport';
import type { DeviceKeyStore } from '@hushos/auth/device-storage';
import type { DriveNode } from '@hushos/drive/client';
import { createMemoryJournal } from '@hushos/drive/journal';
import { createTransferManager, SignedOutError, type MemoryFile } from '@hushos/drive/transfers';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ authClient: { store: { subscribe: () => () => {} } } }));
const { createDeviceSession } = await import('./device-session');

/*
 * A copy or a move reads and seals its bytes before it queues them. If the person signs out
 * meanwhile, the sign-out deletes the upload journal; queueing then would write the file's
 * name back into a fresh one. Nothing is queued from a sign-out until a real sign-in, and
 * never by work that began before the sign-out, signed in again or not.
 */
const USER = '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';

function signedInClient() {
    const transport: CryptoTransport = {
        request: async (operation) =>
            (operation === 'remember'
                ? {
                      version: 1,
                      keyVersion: 1,
                      credentialVersion: 1,
                      userId: USER,
                      deviceKeyId: 'device-key-1',
                      nonce: 'AAAAAAAAAAAAAAAA',
                      encryptedKey: 'B'.repeat(64),
                  }
                : {}) as never,
        lock() {},
        onLock() {},
    };
    const keys: DeviceKeyStore = {
        create: async () => ({ id: 'device-key-1', key: {} as CryptoKey }),
        load: async () => null,
        clear: async () => {},
    };
    const api = {
        loginStart: async () => ({ attemptToken: 'attempt' }),
        loginFinish: async () => ({
            user: { id: USER, email: 'maya@example.com', credentialVersion: 1 },
            envelope: { keyVersion: 1, credentialVersion: 1 },
        }),
        logout: async () => ({}),
    } as unknown as AuthApi;
    return createAuthClient(() => transport, keys, api);
}

const folder = { id: 'root', name: 'My files', kind: 'folder', keyEpoch: 1 } as DriveNode;
const copy = (name: string): MemoryFile => ({
    kind: 'memory',
    name,
    size: 4,
    type: 'text/plain',
    lastModified: 1,
    parts: [new Uint8Array(4)],
});

beforeEach(() => localStorage.clear());

describe('queueing uploads around a sign-out', () => {
    test('a copy begun before a sign-out is never queued, before or after the next sign-in', async () => {
        const auth = signedInClient();
        await auth.login('maya@example.com', 'correct horse');
        const session = createDeviceSession(auth.store);
        const journal = createMemoryJournal();
        // The engine never gets far enough to need the worker or the server here.
        const manager = createTransferManager({
            rpc: (() => new Promise(() => {})) as never,
            api: {} as never,
            journal,
            session,
        });
        const enqueue = (name: string, from?: { generation: number }) =>
            manager.enqueue(
                [{ file: copy(name), parent: folder, origin: 'copy', stash: 'stash-1' }],
                from,
            );

        // A copy starts reading while signed in.
        const began = { generation: session.generation() };
        // The person signs out of this browser (the sign-out shuts the session, then logs out).
        session.signedOut();
        await auth.logout();
        expect(() => enqueue('payroll.xlsx', began)).toThrow(SignedOutError);
        expect(() => enqueue('fresh.txt')).toThrow(SignedOutError);
        // A lock is no sign-in: nothing opens it.
        await auth.lock();
        expect(() => enqueue('fresh.txt')).toThrow(SignedOutError);
        expect(journal.queued.size).toBe(0);

        // A real sign-in reopens it, for work begun from now on only.
        await auth.login('maya@example.com', 'correct horse');
        expect(auth.store.getState().unlockedUserId).toBe(USER);
        expect(() => enqueue('payroll.xlsx', began)).toThrow(SignedOutError);
        expect(journal.queued.size).toBe(0);
        const [id] = enqueue('later.txt', { generation: session.generation() });
        expect(id).toBeTruthy();
        await vi.waitFor(() => expect(journal.queued.size).toBe(1));
    });
});
