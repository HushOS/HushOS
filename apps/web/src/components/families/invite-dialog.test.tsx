import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Invite someone with "Let them manage the family" ticked (6.8): the inviter's
 * own record of it, by the invitation the server made and the address typed,
 * is what later asks them, once that person is let in and checked. Unticked,
 * nothing is recorded, whatever roles the server keeps for the invitation.
 */

const invite = vi.fn(async (..._args: unknown[]) => ({
    id: 'invitation-1',
    expiresAt: '2026-11-11T00:00:00.000Z',
}));
const keepInvitedRole = vi.fn(async (..._args: unknown[]) => true);
vi.mock('@/lib/groups/api', () => ({
    GroupApiError: class extends Error {},
    groupsApi: { invite: (...args: unknown[]) => invite(...args) },
}));
vi.mock('@/lib/family-pending', () => ({
    keepInvitedRole: (...args: unknown[]) => keepInvitedRole(...args),
}));
vi.mock('@/lib/families', () => ({
    familyKeys: { invitations: (userId: string, groupId: string) => ['inv', userId, groupId] },
}));
vi.mock('@/components/ui/toast', () => ({ toast: { add: vi.fn() } }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { InviteDialog } = await import('./invite-dialog');

async function send(manage: boolean) {
    const user = userEvent.setup();
    render(
        <QueryClientProvider client={new QueryClient()}>
            <InviteDialog
                userId="alice"
                groupId="g"
                family="Holm family"
                open
                onOpenChange={() => {}}
            />
        </QueryClientProvider>,
    );
    await user.type(screen.getByLabelText('Email'), ' Sam@Example.com ');
    if (manage)
        await user.click(screen.getByRole('checkbox', { name: 'Let them manage the family' }));
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(invite).toHaveBeenCalled());
}

describe('Invite someone', () => {
    beforeEach(() => {
        invite.mockClear();
        keepInvitedRole.mockClear();
    });

    test('ticked: the inviter keeps the invitation and the address they typed', async () => {
        await send(true);
        expect(invite).toHaveBeenCalledWith('g', 'Sam@Example.com', ['members']);
        await waitFor(() =>
            expect(keepInvitedRole).toHaveBeenCalledWith(
                expect.anything(),
                'alice',
                'g',
                'invitation-1',
                'Sam@Example.com',
            ),
        );
    });

    test('unticked: nothing is kept', async () => {
        await send(false);
        expect(invite).toHaveBeenCalledWith('g', 'Sam@Example.com', []);
        expect(keepInvitedRole).not.toHaveBeenCalled();
    });
});
