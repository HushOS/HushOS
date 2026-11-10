import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Turning two-step sign-in on ends with ten backup codes that exist only in the server's one
 * reply. They must reach the screen whatever happens next: the section refreshes itself
 * afterwards, and on a dropped connection that refresh hangs, then fails. Held back behind it,
 * the step would be on and the only copy of the codes waiting in a variable.
 */
const CODES = Array.from({ length: 10 }, (_, index) => `7KQ2M-9XD${index}P`);
const status = vi.fn<() => Promise<unknown>>();
const startTotp = vi.fn(async () => ({
    id: 'factor',
    secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    uri: 'otpauth://totp/HushOS:maya%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=HushOS',
}));
const confirmTotp = vi.fn(async () => ({ backupCodes: CODES }));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        startTotp: (...args: unknown[]) => startTotp(...(args as [])),
        confirmTotp: (...args: unknown[]) => confirmTotp(...(args as [])),
        devices: async () => ({ devices: [] }),
    },
}));
vi.mock('@/lib/two-step-status', () => ({
    twoStepQueryOptions: { queryKey: ['account', 'two-step'], queryFn: () => status() },
}));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
// The other account dialogs share a module with the shell these dialogs use; none is drawn here.
vi.mock('@/lib/drive', () => ({
    driveClient: {},
    driveError: String,
    driveOpenQueryOptions: vi.fn(),
}));
vi.mock('@/lib/contacts', () => ({ succeedIdentity: vi.fn() }));
vi.mock('@/lib/sign-out', () => ({ forgetDevice: vi.fn() }));
const { AccountTwoStep } = await import('./account-two-step');

beforeEach(() => {
    status.mockReset();
    status.mockResolvedValue({ on: false, methods: [], backupCodesLeft: 0, totpFrozen: false });
});

describe('turning two-step sign-in on', () => {
    test('shows the backup codes while refreshing the section hangs, and lets go of the setup key', async () => {
        const user = userEvent.setup();
        render(
            <QueryClientProvider
                client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
            >
                <AccountTwoStep user={{ email: 'maya@example.com' }} />
            </QueryClientProvider>,
        );
        await user.click(await screen.findByRole('button', { name: 'Turn on' }));
        const dialog = await screen.findByRole('dialog');
        await user.type(within(dialog).getByLabelText('Your password'), 'correct horse');
        await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
        expect(
            await within(dialog).findByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP'),
        ).toBeVisible();

        // The connection drops as the code is confirmed: the reply arrives, the refresh never does.
        status.mockReturnValue(new Promise(() => {}));
        await user.type(within(dialog).getByLabelText(/Enter the six-digit code/), '123456');
        await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));

        const list = await within(dialog).findByRole('list', { name: 'Backup codes' });
        expect(
            within(list)
                .getAllByRole('listitem')
                .map((item) => item.textContent),
        ).toEqual(CODES);
        expect(confirmTotp).toHaveBeenCalledWith('factor', '123456', false);
        // The key has done its work: it is not kept on screen or in the dialog behind the codes.
        expect(within(dialog).queryByText(/JBSW/)).toBeNull();
        // The refresh was asked for, and is still out.
        expect(status.mock.calls.length).toBeGreaterThan(1);
        expect(within(dialog).getByRole('button', { name: 'I’ve saved them' })).toBeVisible();
    });
});
