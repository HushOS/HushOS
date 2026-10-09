import { beforeEach, describe, expect, test } from 'vitest';
import { createAuthStore } from './store';

/*
 * The saved unlock lives in localStorage and loads only when the store is first
 * used. Losing it means the next visit asks for the password, so a change made
 * before it has loaded must never be saved over it.
 */
const KEY = 'hushos-device-unlock';
const items = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
        getItem: (name: string) => items.get(name) ?? null,
        setItem: (name: string, value: string) => void items.set(name, value),
        removeItem: (name: string) => void items.delete(name),
    },
});

const device = {
    version: 1,
    keyVersion: 1,
    credentialVersion: 1,
    userId: '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4',
    deviceKeyId: 'device-key-1',
    nonce: 'AAAAAAAAAAAAAAAA',
    encryptedKey: 'B'.repeat(64),
};
const saved = () => JSON.parse(items.get(KEY) ?? 'null')?.state ?? null;

beforeEach(() => {
    items.clear();
    items.set(KEY, JSON.stringify({ state: { device, lockRevision: 3 }, version: 1 }));
});

describe('the saved unlock', () => {
    test('survives a lock on a fresh page before the store has loaded', async () => {
        const { store } = createAuthStore();
        // What lock() and a restore's first step do on a page that just opened.
        store.setState({ unlockedUserId: null });
        store.setState({ restoring: true, restoreStep: 'rehydrate' });
        expect(saved()).toEqual({ device, lockRevision: 3 });
        await store.persist.rehydrate();
        expect(store.getState().device).toEqual(device);
        expect(store.getState().lockRevision).toBe(3);
    });

    test('is still saved and cleared once the store has loaded', async () => {
        const { store } = createAuthStore();
        await store.persist.rehydrate();
        store.setState({ lockRevision: 4 });
        expect(saved()).toEqual({ device, lockRevision: 4 });
        store.setState({ device: null });
        expect(saved()).toEqual({ device: null, lockRevision: 4 });
    });
});
