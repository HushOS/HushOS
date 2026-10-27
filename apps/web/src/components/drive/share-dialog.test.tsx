import type { DriveNode } from '@hushos/drive/client';
import { QueryClient, QueryClientProvider, queryOptions } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Pin } from '@/lib/contacts';

/*
 * The share sheet (docs/optional-verification.md 6.3, 6.7): what someone
 * asked to share is what gets shared. A share that meets a changed account
 * opens the notice in the sheet's own place (one dialog), and once Continue
 * settles it the share they asked for goes ahead, with the role they chose,
 * on a fresh look at the item. Someone new by email is shared with as the
 * picker beside the field says, never always as a viewer.
 */
// The people field (cmdk) measures and scrolls its list; jsdom has neither.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;
if (!('scrollIntoView' in Element.prototype))
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {} });

const SAM = 'a0000000-0000-4000-8000-000000000003';
const sam: Pin = {
    userId: SAM,
    email: 'sam@example.com',
    name: 'Sam Okafor',
    pinnedAt: '2026-10-27T00:00:00.000Z',
    encryptionPublicKey: 'x',
    signingPublicKey: 'e',
    fingerprint: '',
};
const item = { id: 'file-1', name: 'notes.md', kind: 'file', parentId: 'root' } as DriveNode;
const fresh = { ...item, keyEpoch: 3 } as DriveNode;

const share = vi.fn(async () => ({}));
const granteeKeys = vi.fn();
const continueWith = vi.fn(async () => sam);
const addContact = vi.fn();
const currentNode = vi.fn(async () => fresh);

vi.mock('@/components/drive/drive-shell', () => ({ useDrive: () => ({ userId: 'me' }) }));
vi.mock('@/lib/contacts', () => {
    class AccountChangedError extends Error {
        constructor(
            readonly contactId: string,
            readonly person: string,
        ) {
            super('changed');
        }
    }
    return {
        AccountChangedError,
        TrustMovedError: class extends Error {},
        accountChangeOf: () => null,
        addContact: (...args: unknown[]) => addContact(...(args as [])),
        continueWith: (...args: unknown[]) => continueWith(...(args as [])),
        granteeKeys: (...args: unknown[]) => granteeKeys(...(args as [])),
        lookupContact: async () => ({
            contact: { userId: SAM, email: sam.email, name: sam.name },
            fingerprint: 'f',
            pinned: sam,
            changed: true,
            stale: false,
            verified: false,
            wasVerified: false,
            heldFingerprint: 'h',
            followed: false,
            upgraded: true,
        }),
        notUpgradedWords: (name: string) => name,
        pinContact: vi.fn(),
        settingsQueryOptions: () =>
            queryOptions({
                queryKey: ['settings'],
                queryFn: async () => ({
                    settings: { version: 2, contacts: { [SAM]: sam } },
                    version: 1,
                }),
            }),
        shareeStanding: async () => 'ok',
        useAccountChanges: () => 0,
    };
});
vi.mock('@/lib/drive', () => ({
    driveClient: {
        nodeShares: async () => [],
        nodeLinks: async () => [],
        share: (...args: unknown[]) => share(...(args as [])),
        upgradeShares: async () => ({ resealed: 0, refused: 0 }),
    },
    displayName: (node: DriveNode) => node.name,
    driveError: (error: Error) => error.message,
    driveKeys: { all: ['drive'], shared: ['drive', 'shared'], mine: ['drive', 'mine'] },
    formatDay: () => '3 Nov',
    formatWhen: () => 'today',
}));
vi.mock('@/lib/rotation', () => ({
    currentNode: (...args: unknown[]) => currentNode(...(args as [])),
    rotateAfterRevoke: vi.fn(),
}));
vi.mock('@/lib/session', () => ({
    sessionQueryOptions: queryOptions({
        queryKey: ['session'],
        queryFn: async () => ({ name: 'Maya', email: 'maya@example.com' }),
    }),
}));
vi.mock('@/lib/integrity', () => ({ afterTrustChanged: vi.fn() }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { ShareDialog } = await import('./share-dialog');

function open() {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ShareDialog node={item} open onOpenChange={vi.fn()} />
        </QueryClientProvider>,
    );
}
const dialogs = () => document.querySelectorAll('[role="dialog"], [role="alertdialog"]');

/* Picks "Can edit" in a role select, as a person does. */
async function canEdit(label: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: label }));
    await user.click(await screen.findByRole('option', { name: 'Can edit' }));
    await vi.waitFor(() =>
        expect(screen.getByRole('combobox', { name: label })).toHaveTextContent('Can edit'),
    );
}

describe('the share sheet', () => {
    beforeEach(() => {
        share.mockClear();
        granteeKeys.mockReset();
        continueWith.mockClear();
        addContact.mockReset();
        currentNode.mockClear();
    });

    test('a share that met a changed account goes ahead after Continue, as asked', async () => {
        const { AccountChangedError } = await import('@/lib/contacts');
        granteeKeys
            .mockRejectedValueOnce(new AccountChangedError(SAM, 'Sam Okafor'))
            .mockResolvedValue({ userId: SAM, encryptionPublicKey: 'x2', kemPublicKey: 'k2' });
        open();
        const field = await screen.findByRole('combobox', { name: 'Add people' });
        fireEvent.pointerDown(field);
        fireEvent.click(await screen.findByRole('option', { name: /Sam Okafor/ }));
        await canEdit('What Sam Okafor can do');
        fireEvent.click(screen.getByRole('button', { name: 'Share' }));

        // The notice fills the sheet's own place: one dialog, the sheet's content gone.
        expect(await screen.findByText('Sam’s account changed')).toBeVisible();
        expect(screen.queryByText('Who can open this?')).toBeNull();
        expect(dialogs()).toHaveLength(1);
        expect(share).not.toHaveBeenCalled();

        fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
        // With the keys looked up again, the item as it is now, and the role chosen before.
        expect(share).toHaveBeenCalledWith(
            fresh,
            { userId: SAM, encryptionPublicKey: 'x2', kemPublicKey: 'k2' },
            'editor',
        );
        expect(granteeKeys).toHaveBeenCalledTimes(2);
        expect(await screen.findByText('Who can open this?')).toBeVisible();
    });

    test('closing the notice comes back to the sheet and shares nothing', async () => {
        const { AccountChangedError } = await import('@/lib/contacts');
        granteeKeys.mockRejectedValue(new AccountChangedError(SAM, 'Sam Okafor'));
        open();
        const field = await screen.findByRole('combobox', { name: 'Add people' });
        fireEvent.pointerDown(field);
        fireEvent.click(await screen.findByRole('option', { name: /Sam Okafor/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Share' }));
        const notice = await screen.findByText('Sam’s account changed');
        fireEvent.click(within(dialogs()[0] as HTMLElement).getByRole('button', { name: 'Close' }));
        expect(await screen.findByText('Who can open this?')).toBeVisible();
        expect(notice).not.toBeInTheDocument();
        expect(share).not.toHaveBeenCalled();
    });

    test('someone new by email is shared with as the picker beside the field says', async () => {
        addContact.mockResolvedValue({
            outcome: 'added',
            pin: { ...sam, userId: 'new', email: 'new@example.com', name: 'New Person' },
        });
        granteeKeys.mockResolvedValue({
            userId: 'new',
            encryptionPublicKey: 'n',
            kemPublicKey: 'k',
        });
        open();
        const field = await screen.findByRole('combobox', { name: 'Add people' });
        await canEdit('What they can do');
        fireEvent.change(field, { target: { value: 'new@example.com' } });
        fireEvent.click(await screen.findByRole('option', { name: 'Share with new@example.com' }));
        await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
        expect(share).toHaveBeenCalledWith(fresh, expect.anything(), 'editor');
    });
});
