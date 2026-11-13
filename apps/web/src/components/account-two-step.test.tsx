import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Turning two-step sign-in on, in Account. The offer to remove the account's other devices
 * must do what its tick says whatever this page knows of the device list (a list that failed
 * to load, or is a moment old, must not quietly skip it); the backup codes, shown once, must
 * never wait on that removal; and an answer that is not the server's must not be read as the
 * step being on.
 */

const password = 'correct horse battery staple';
const codes = Array.from({ length: 10 }, (_, index) => `CODE${index}-AAAAA`);
const api = {
    twoStep: vi.fn(async () => ({ on: false, methods: [], backupCodesLeft: 0, totpFrozen: false })),
    securityEvents: vi.fn(async () => ({ events: [] })),
    devices: vi.fn<() => Promise<{ devices: { id: string; current: boolean }[] }>>(),
    startAuthenticator: vi.fn(async () => ({
        id: 'app-1',
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        uri: 'otpauth://totp/HushOS:maya@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    })),
    confirmAuthenticator: vi.fn<() => Promise<{ backupCodes: string[] } | { replaced: true }>>(),
    removeOtherDevices: vi.fn<(password: string) => Promise<{ removed: number }>>(),
    removeTwoStepMethod: vi.fn<() => Promise<void>>(),
    stepChallenge: vi.fn(async () => null),
};
vi.mock('@/lib/auth-client', () => ({ authClient: api }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
// Dates are worded by Drive's helpers; the module behind them opens Drive, which this page does not.
vi.mock('@/lib/drive', () => ({ formatDay: () => '13 Nov', formatTime: () => '14:08' }));
const toasts = vi.fn();
vi.mock('@/components/ui/toast', () => ({ toast: { add: (toast: unknown) => toasts(toast) } }));
// The server's flag, which this page asks a server function for: on.
vi.mock('@/lib/two-step', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    useTwoStepEnabled: () => true,
}));
const { AccountTwoStep } = await import('./account-two-step');

const user = { id: 'user-1', email: 'maya@example.com', name: 'Maya', credentialVersion: 1 };

/* From "Turn on" to the screen with the QR code and the offer. */
async function toTheOffer() {
    const person = userEvent.setup();
    render(
        <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
            <AccountTwoStep user={user as never} />
        </QueryClientProvider>,
    );
    await person.click(await screen.findByRole('button', { name: 'Turn on' }));
    await person.type(screen.getByLabelText('Password'), password);
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    const code = await screen.findByLabelText('Code from your authenticator app');
    return { person, code };
}

beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockClear();
    toasts.mockClear();
    api.devices.mockRejectedValue(new Error('offline'));
    api.confirmAuthenticator.mockResolvedValue({ backupCodes: codes });
    api.removeOtherDevices.mockResolvedValue({ removed: 0 });
});

describe('turning two-step sign-in on', () => {
    test('a device list that could not be read does not skip the removal: the box is there, ticked, claims no number, and removes', async () => {
        const { person, code } = await toTheOffer();
        const offer = screen.getByRole('checkbox', { name: /Remove my other devices/ });
        expect(offer).toBeChecked();
        // No count is claimed for a list nobody could read.
        expect(screen.getByText(/Any other device signed in to your account/)).toBeVisible();
        expect(screen.queryByText(/other devices? (is|are) signed in/)).toBeNull();
        await person.type(code, '123456');
        await person.click(screen.getByRole('button', { name: 'Turn on' }));
        await screen.findByRole('heading', { name: 'Save your backup codes' });
        await waitFor(() => expect(api.removeOtherDevices).toHaveBeenCalledWith(password));
    });

    test('a list that shows no other device does not skip it either, and a list that shows some says how many', async () => {
        // Only this browser in the list: another may have signed in since it was read.
        api.devices.mockResolvedValue({ devices: [{ id: 'this', current: true }] });
        const first = await toTheOffer();
        await screen.findByText(/Any other device signed in to your account/);
        await first.person.type(first.code, '123456');
        await first.person.click(screen.getByRole('button', { name: 'Turn on' }));
        await screen.findByRole('heading', { name: 'Save your backup codes' });
        await waitFor(() => expect(api.removeOtherDevices).toHaveBeenCalledTimes(1));
    });

    test('with two others listed the line says so, and unticked nothing is removed', async () => {
        api.devices.mockResolvedValue({
            devices: [
                { id: 'this', current: true },
                { id: 'phone', current: false },
                { id: 'laptop', current: false },
            ],
        });
        const { person, code } = await toTheOffer();
        await screen.findByText(/2 other devices are signed in without the second step/);
        await person.click(screen.getByRole('checkbox', { name: /Remove my other devices/ }));
        await person.type(code, '123456');
        await person.click(screen.getByRole('button', { name: 'Turn on' }));
        await screen.findByRole('heading', { name: 'Save your backup codes' });
        expect(api.removeOtherDevices).not.toHaveBeenCalled();
    });

    test('the codes are shown, and Done closes the dialog, while the removal is still running; its failure is said afterwards', async () => {
        let fail!: (error: Error) => void;
        api.removeOtherDevices.mockReturnValue(
            new Promise((_resolve, reject) => {
                fail = reject;
            }),
        );
        const { person, code } = await toTheOffer();
        await person.type(code, '123456');
        await person.click(screen.getByRole('button', { name: 'Turn on' }));
        // The codes are on screen though the removal has not answered.
        const list = await screen.findByRole('list', { name: 'Backup codes' });
        expect(list).toHaveTextContent(codes[0]!);
        expect(api.removeOtherDevices).toHaveBeenCalledTimes(1);
        const done = screen.getByRole('button', { name: 'Done' });
        expect(done).toBeEnabled();
        await person.click(done);
        await waitFor(() =>
            expect(screen.queryByRole('heading', { name: 'Save your backup codes' })).toBeNull(),
        );
        // The request fails after the dialog has gone: the person is still told.
        fail(new Error('timeout'));
        await waitFor(() =>
            expect(toasts).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Your other devices weren’t removed' }),
            ),
        );
    });

    test('an answer without the backup codes is not read as the step being on, or as an app replaced', async () => {
        // The server's answer to a replacement, where turning the step on was asked for.
        api.confirmAuthenticator.mockResolvedValue({ replaced: true });
        const { person, code } = await toTheOffer();
        await person.type(code, '123456');
        await person.click(screen.getByRole('button', { name: 'Turn on' }));
        await screen.findByText(/can’t tell whether two-step sign-in was turned on/);
        expect(screen.queryByRole('heading', { name: 'Save your backup codes' })).toBeNull();
        expect(screen.queryByText('Authenticator app replaced.')).toBeNull();
        expect(api.removeOtherDevices).not.toHaveBeenCalled();
        // The settings behind the dialog were read again, to show what is true.
        expect(api.twoStep.mock.calls.length).toBeGreaterThan(1);
    });
});

/*
 * Replacing the app offers no removal of devices and must do none. The trap: another tab
 * removed the app meanwhile, so this confirmation turns the step on and comes back with
 * codes, the path that removes devices when turning on was what the person asked for.
 */
describe('replacing the authenticator app', () => {
    test('never removes a device, even when the confirmation comes back with backup codes', async () => {
        api.twoStep.mockResolvedValue({
            on: true,
            methods: [
                {
                    id: 'app-0',
                    kind: 'totp',
                    name: null,
                    createdAt: '2026-11-01T10:00:00.000Z',
                    lastUsedAt: null,
                    synced: false,
                },
            ],
            backupCodesLeft: 10,
            totpFrozen: false,
        } as never);
        api.devices.mockResolvedValue({
            devices: [
                { id: 'this', current: true },
                { id: 'phone', current: false },
            ],
        });
        const person = userEvent.setup();
        render(
            <QueryClientProvider
                client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
            >
                <AccountTwoStep user={user as never} />
            </QueryClientProvider>,
        );
        await person.click(await screen.findByRole('button', { name: 'Replace' }));
        await person.type(screen.getByLabelText('Password'), password);
        await person.click(screen.getByRole('button', { name: 'Continue' }));
        const code = await screen.findByLabelText('Code from your authenticator app');
        // No removal is offered here.
        expect(screen.queryByRole('checkbox', { name: /Remove my other devices/ })).toBeNull();
        await person.type(code, '123456');
        await person.click(screen.getByRole('button', { name: 'Replace app' }));
        // The codes are shown, since the step was turned on after all.
        await screen.findByRole('heading', { name: 'Save your backup codes' });
        expect(api.removeOtherDevices).not.toHaveBeenCalled();
    });
});

/*
 * Turning it off, when the server's answer does not arrive: the removal may have gone through,
 * so the section behind the dialog must be read again, or Account keeps saying the step is
 * on for an account that no longer has one.
 */
describe('turning two-step sign-in off', () => {
    test.each([
        ['an answer that was not the server’s', 'lost'],
        ['a gateway’s 502', 'gateway'],
        ['a dropped connection', 'network'],
    ])(
        '%s reads the settings again, so the page never keeps claiming the step is on',
        async (_name, kind) => {
            const { LostReply } = await import('@hushos/auth/client');
            api.twoStep.mockResolvedValue({
                on: true,
                methods: [
                    {
                        id: 'app-0',
                        kind: 'totp',
                        name: null,
                        createdAt: '2026-11-01T10:00:00.000Z',
                        lastUsedAt: null,
                        synced: false,
                    },
                ],
                backupCodesLeft: 10,
                totpFrozen: false,
            } as never);
            api.removeTwoStepMethod.mockRejectedValue(
                kind === 'lost'
                    ? new LostReply(
                          'The server’s answer didn’t arrive, so HushOS can’t tell whether two-step sign-in was turned off. Check before you try again.',
                      )
                    : kind === 'gateway'
                      ? Object.assign(new Error('Bad gateway'), { status: 502 })
                      : new TypeError('Failed to fetch'),
            );
            const person = userEvent.setup();
            render(
                <QueryClientProvider
                    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
                >
                    <AccountTwoStep user={user as never} />
                </QueryClientProvider>,
            );
            await person.click(await screen.findByRole('button', { name: 'Turn off' }));
            const reads = api.twoStep.mock.calls.length;
            await person.type(screen.getByLabelText('Password'), password);
            await person.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn off' }),
            );
            await waitFor(() => expect(api.twoStep.mock.calls.length).toBeGreaterThan(reads));
        },
    );
});
