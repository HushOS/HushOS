import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Lookup } from '@/lib/contacts';

/*
 * Check it's Maya (docs/optional-verification.md 6.6): They match saves the
 * check over the very lookup whose words were shown; They don't match saves
 * nothing at all, and offers Stop sharing with Maya, which asks once before
 * it ends anything.
 */
const lookup = vi.fn<() => Promise<Lookup>>();
const pinContact = vi.fn(async () => ({}));
const stopSharing = vi.fn(async () => 2);
vi.mock('@/lib/contacts', () => ({
    lookupContact: () => lookup(),
    pinContact: (...args: unknown[]) => pinContact(...(args as [])),
    notUpgradedWords: (name: string) => `${name} needs to sign in`,
}));
vi.mock('@/lib/rotation', () => ({
    stopSharingWithPerson: (...args: unknown[]) => stopSharing(...(args as [])),
}));
vi.mock('@/lib/integrity', () => ({ afterTrustChanged: vi.fn() }));
vi.mock('@/lib/drive', () => ({
    driveKeys: { shared: ['shared'] },
    driveError: (error: Error) => error.message,
    formatDay: () => '3 Nov',
}));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { CheckContactDialog } = await import('./check-contact');

const MAYA = 'a0000000-0000-4000-8000-000000000002';
const found: Lookup = {
    contact: {
        userId: MAYA,
        email: 'maya@example.com',
        name: 'Maya Lindqvist',
    } as Lookup['contact'],
    fingerprint: '0123456789abcdef0123456789abcdef01234567',
    pinned: {
        userId: MAYA,
        email: 'maya@example.com',
        name: 'Maya Lindqvist',
        pinnedAt: '2026-10-27T00:00:00.000Z',
        encryptionPublicKey: 'x',
        signingPublicKey: 'e',
        fingerprint: '',
    },
    changed: false,
    stale: true,
    verified: false,
    wasVerified: false,
    heldFingerprint: null,
    followed: false,
    upgraded: true,
};

function open() {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <CheckContactDialog
                userId="me"
                person={{ email: 'maya@example.com', name: 'Maya Lindqvist' }}
                onOpenChange={vi.fn()}
            />
        </QueryClientProvider>,
    );
}

describe('Check it’s Maya', () => {
    beforeEach(() => {
        lookup.mockReset().mockResolvedValue(found);
        pinContact.mockClear();
        stopSharing.mockClear();
    });

    test('They don’t match saves nothing, and Stop sharing asks before it ends anything', async () => {
        open();
        fireEvent.click(await screen.findByRole('button', { name: 'They don’t match' }));
        expect(screen.getByText(/These don’t match\. Check Maya’s email address/)).toBeVisible();
        expect(screen.queryByRole('button', { name: 'They match' })).toBeNull();
        expect(pinContact).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Maya' }));
        expect(stopSharing).not.toHaveBeenCalled();
        fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }));
        await vi.waitFor(() => expect(stopSharing).toHaveBeenCalledWith(expect.anything(), MAYA));
        expect(pinContact).not.toHaveBeenCalled();
    });

    test('They match saves the check over the lookup whose words were shown', async () => {
        open();
        fireEvent.click(await screen.findByRole('button', { name: 'They match' }));
        await vi.waitFor(() => expect(pinContact).toHaveBeenCalledTimes(1));
        expect(pinContact).toHaveBeenCalledWith(expect.anything(), 'me', found);
    });
});
