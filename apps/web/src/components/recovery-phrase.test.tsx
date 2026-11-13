import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * The recovery page's fetch of the phrase, and the words a rotation left to be shown
 * (lib/new-phrase.ts). After a rotation whose reply was lost, in a browser that stayed
 * signed in, the held words may be the only copy of the phrase that now opens the account,
 * and the server may still serve the phrase from before. Fetching that one must not throw
 * the held words away; fetching the same words means they are on their own page, and done.
 */

const backup = vi.hoisted(() => ({ phrase: '' }));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        restore: () => Promise.resolve(),
        recoveryBackup: () => Promise.resolve({ recoveryVersion: 2, phrase: backup.phrase }),
    },
}));
vi.mock('@/lib/auth-view', () => ({
    useAuthView: (select: (state: { lockRevision: number; unlockedUserId: string }) => unknown) =>
        select({ lockRevision: 1, unlockedUserId: 'user-1' }),
}));
// The page furniture, which needs the router, a canvas and the worker; the query does not.
vi.mock('@/components/brand', () => ({ LogoBadge: () => null }));
vi.mock('@/components/cover', () => ({ Cover: () => null }));
vi.mock('@/components/auth-layout', () => ({ AuthLayout: () => null, AuthNote: () => null }));
vi.mock('@/components/unlock-device', () => ({ UnlockDevice: () => null }));
vi.mock('@/components/qr-code', () => ({ QrCode: () => null }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { useRecoveryBackup } = await import('./recovery-phrase');
const { forgetNewPhrase, keepNewPhrase, newPhrase } = await import('@/lib/new-phrase');

const phrase = (word: string) =>
    Array.from({ length: 24 }, (_, index) => `${word}${index + 1}`).join(' ');
const held = {
    phrase: phrase('new'),
    applied: 'unknown' as const,
    storage: null,
    from: 'rotation' as const,
};
const auth = { subscribe: () => () => {} };
const user = { id: 'user-1', email: 'ada@example.com', credentialVersion: 2 } as Parameters<
    typeof useRecoveryBackup
>[0];

function fetched() {
    const client = new QueryClient();
    return renderHook(() => useRecoveryBackup(user), {
        wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
    });
}

beforeEach(forgetNewPhrase);

describe('the recovery page’s phrase and the words a rotation left to be shown', () => {
    test('the phrase from before, served after a rotation that may not have landed, leaves the new words held', async () => {
        keepNewPhrase(held, auth);
        backup.phrase = phrase('old');
        const page = fetched();
        await waitFor(() => expect(page.result.current.backup?.phrase).toBe(phrase('old')));
        expect(newPhrase.getState().made).toEqual(held);
    });

    test('the same words on their own page are done with', async () => {
        keepNewPhrase(held, auth);
        backup.phrase = held.phrase;
        const page = fetched();
        await waitFor(() => expect(page.result.current.backup?.phrase).toBe(held.phrase));
        expect(newPhrase.getState().made).toBeNull();
    });
});
