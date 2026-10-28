import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Lookup } from '@/lib/contacts';

/*
 * Check it's Maya (docs/optional-verification.md 6.6): They match saves the
 * check over the very lookup whose words were shown; They don't match saves
 * nothing at all, and offers Remove Maya from contacts, which asks once
 * before it removes anything. Each step replaces the one before in the same dialog:
 * one dialog on screen at a time.
 */
const lookup = vi.fn<() => Promise<Lookup>>();
const pinContact = vi.fn(async (): Promise<{ resealShares?: boolean }> => ({}));
const continueWith = vi.fn(async () => ({}));
const removeContact = vi.fn(async () => ({}));
const upgradeShares = vi.fn(async () => ({ resealed: 1, refused: 0 }));
vi.mock('@/lib/contacts', () => ({
    lookupContact: () => lookup(),
    pinContact: (...args: unknown[]) => pinContact(...(args as [])),
    continueWith: (...args: unknown[]) => continueWith(...(args as [])),
    removeContact: (...args: unknown[]) => removeContact(...(args as [])),
    addContact: vi.fn(),
    TrustMovedError: class extends Error {},
    notUpgradedWords: (name: string) => `${name} needs to sign in`,
}));
vi.mock('@/lib/integrity', () => ({ afterTrustChanged: vi.fn() }));
vi.mock('@/lib/drive', () => ({
    driveClient: { upgradeShares: () => upgradeShares() },
    driveKeys: { shared: ['shared'] },
    driveError: (error: Error) => error.message,
    formatDay: () => '3 Nov',
}));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { ContactFlowDialog } = await import('./contact-flow');

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

function open(
    start: Parameters<typeof ContactFlowDialog>[0]['start'] = {
        kind: 'check',
        person: { email: 'maya@example.com', name: 'Maya Lindqvist' },
    },
) {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ContactFlowDialog userId="me" start={start} onOpenChange={vi.fn()} />
        </QueryClientProvider>,
    );
}
/* Every dialog on screen: there must only ever be one. */
const dialogs = () => document.querySelectorAll('[role="dialog"], [role="alertdialog"]');

describe('Check it’s Maya', () => {
    beforeEach(() => {
        lookup.mockReset().mockResolvedValue(found);
        pinContact.mockClear();
        continueWith.mockClear();
        removeContact.mockClear();
        upgradeShares.mockClear();
    });

    test('They don’t match saves nothing, and Remove asks before it removes anything', async () => {
        open();
        fireEvent.click(await screen.findByRole('button', { name: 'They don’t match' }));
        expect(screen.getByText(/These don’t match\. Check Maya’s email address/)).toBeVisible();
        expect(
            screen.getByText(
                /remove Maya for now and add them again once they do\. To stop sharing something with Maya, open Share on it\.$/,
            ),
        ).toBeVisible();
        // Laid out as the changed-account notice is: in the dialog's footer, Done last in order,
        // so a phone stacks it on top at full width and a wide screen keeps it at the right.
        const footer = document.querySelector('[data-slot="dialog-footer"]') as HTMLElement;
        expect(
            within(footer)
                .getAllByRole('button')
                .map((button) => button.textContent),
        ).toEqual(['Remove Maya from contacts', 'Done']);
        expect(screen.queryByRole('button', { name: 'They match' })).toBeNull();
        expect(pinContact).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Remove Maya from contacts' }));
        expect(removeContact).not.toHaveBeenCalled();
        // The question replaces the check: one dialog, and Cancel comes back to it.
        expect(await screen.findByText('Remove Maya?')).toBeVisible();
        expect(dialogs()).toHaveLength(1);
        expect(screen.queryByText(/These don’t match/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByText(/These don’t match/)).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Remove Maya from contacts' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
        await vi.waitFor(() =>
            expect(removeContact).toHaveBeenCalledWith(expect.anything(), 'me', MAYA),
        );
        expect(pinContact).not.toHaveBeenCalled();
    });

    test('They match saves the check over the lookup whose words were shown', async () => {
        open();
        fireEvent.click(await screen.findByRole('button', { name: 'They match' }));
        await vi.waitFor(() => expect(pinContact).toHaveBeenCalledTimes(1));
        expect(pinContact).toHaveBeenCalledWith(expect.anything(), 'me', found);
    });

    test('They match over keys that changed seals what was shared again, as Continue does', async () => {
        lookup.mockResolvedValue({ ...found, changed: true, stale: false, wasVerified: true });
        pinContact.mockResolvedValueOnce({ resealShares: true });
        open();
        fireEvent.click(await screen.findByRole('button', { name: 'They match' }));
        await vi.waitFor(() => expect(upgradeShares).toHaveBeenCalledTimes(1));
    });

    test('They match after a signed succession it followed just now seals what was shared again', async () => {
        // Followed, not changed: the pin moved on and what was shared waits to be sealed to it.
        lookup.mockResolvedValue({ ...found, followed: true });
        pinContact.mockResolvedValueOnce({ resealShares: true });
        open();
        fireEvent.click(await screen.findByRole('button', { name: 'They match' }));
        await vi.waitFor(() => expect(upgradeShares).toHaveBeenCalledTimes(1));
    });

    test('over the same keys, nothing is sealed again', async () => {
        open();
        fireEvent.click(await screen.findByRole('button', { name: 'They match' }));
        await vi.waitFor(() => expect(pinContact).toHaveBeenCalledTimes(1));
        expect(upgradeShares).not.toHaveBeenCalled();
    });

    test('Check it’s Maya from the changed-account notice replaces it in the same dialog', async () => {
        lookup.mockResolvedValue({ ...found, changed: true, stale: false, wasVerified: true });
        open({
            kind: 'changed',
            change: { contactId: MAYA, name: 'Maya Lindqvist', email: 'maya@example.com' },
        });
        expect(await screen.findByText('Maya’s account changed')).toBeVisible();
        fireEvent.click(await screen.findByRole('button', { name: 'Check it’s Maya' }));
        expect(await screen.findByRole('button', { name: 'They match' })).toBeVisible();
        expect(screen.queryByText('Maya’s account changed')).toBeNull();
        expect(dialogs()).toHaveLength(1);
    });
});
