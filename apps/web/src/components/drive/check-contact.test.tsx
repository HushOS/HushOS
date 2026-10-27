import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Lookup } from '@/lib/contacts';

/*
 * Adding someone by email (People, the share dialog's "Add … as a contact"):
 * a pin taken on a family's word ("Trust as Lindqvist family does") holds the
 * server's name and address for the family's keys, so it must never stand in
 * for comparing words. Only a pin from this person's own words check counts as
 * already added.
 */
const lookup = vi.fn<() => Promise<Lookup>>();
vi.mock('@/lib/contacts', () => ({
    lookupContact: () => lookup(),
    pinContact: vi.fn(),
    replacementUnseen: () => false,
    settingsQueryOptions: () => ({ queryKey: ['settings'] }),
}));
vi.mock('@/lib/drive', () => ({ driveKeys: { shared: ['shared'] }, formatDay: () => '' }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
vi.mock('@/components/fingerprint-words', () => ({
    FingerprintWords: ({ fingerprint }: { fingerprint: string }) => (
        <ol data-fingerprint-words={fingerprint} />
    ),
}));
const { CheckContact } = await import('./check-contact');

const SAM = 'a0000000-0000-4000-8000-000000000004';
const pin = (extra: object) => ({
    userId: SAM,
    email: 'sam@example.com',
    name: 'Sam Lindqvist',
    pinnedAt: '2026-10-17T00:00:00.000Z',
    encryptionPublicKey: 'x',
    signingPublicKey: 'e',
    mlDsaPublicKeyHash: 'm',
    kemPublicKeyHash: 'k',
    fingerprint: 'f',
    ...extra,
});
const found = (pinned: Lookup['pinned']): Lookup => ({
    contact: { userId: SAM, email: 'sam@example.com', name: 'Sam Lindqvist' } as Lookup['contact'],
    fingerprint: 'words-over-all-four-keys',
    pinned,
    changed: false,
    stale: false,
    followed: false,
    upgraded: true,
});

function open() {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <CheckContact
                userId="me"
                email="sam@example.com"
                onAdded={vi.fn()}
                onCancel={vi.fn()}
            />
        </QueryClientProvider>,
    );
}

describe('checking it’s them', () => {
    beforeEach(() => lookup.mockReset());

    test('someone pinned on a family’s word is checked by their words, never taken as already added', async () => {
        lookup.mockResolvedValue(
            found(
                pin({
                    trustedVia: 'b0000000-0000-4000-8000-000000000001',
                    trustedViaFamily: 'Lindqvist family',
                }),
            ),
        );
        open();
        expect(await screen.findByRole('button', { name: 'They match' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Already in your contacts' })).toBeNull();
        expect(document.querySelector('[data-fingerprint-words]')).not.toBeNull();
        expect(
            screen.getByText(/The member list of Lindqvist family vouches for these keys/),
        ).toBeInTheDocument();
    });

    test('someone whose words this person compared is already added', async () => {
        lookup.mockResolvedValue(found(pin({})));
        open();
        expect(
            await screen.findByRole('button', { name: 'Already in your contacts' }),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'They match' })).toBeNull();
    });
});
