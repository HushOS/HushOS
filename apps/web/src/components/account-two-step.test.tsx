import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
/* The auth client's store, as far as a lock shows in it: a lock or a sign-out, here or in another tab. */
const locks = (() => {
    let state = { lockRevision: 1, locks: 0 };
    const listeners = new Set<(next: typeof state, previous: typeof state) => void>();
    return {
        subscribe(listener: (next: typeof state, previous: typeof state) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getState: () => state,
        lock() {
            const previous = state;
            state = { ...state, locks: state.locks + 1 };
            for (const listener of listeners) listener(state, previous);
        },
    };
})();
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
    removeTwoStepMethod: vi.fn<() => Promise<{ removed: true; on: boolean }>>(),
    stepChallenge: vi.fn(async () => null),
    canUsePasskeys: () => true,
    startPasskey: vi.fn(async () => ({ registrationToken: 'registration', options: {} })),
    addPasskey:
        vi.fn<
            (started: unknown, name?: string) => Promise<{ method: object; backupCodes?: string[] }>
        >(),
    renameTwoStepMethod: vi.fn(async () => ({ method: {} })),
    setTwoStepDefault: vi.fn(async (kind: string) => ({ defaultKind: kind })),
    store: locks,
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

const view = () =>
    render(
        <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
            <AccountTwoStep user={user as never} />
        </QueryClientProvider>,
    );

/* From the app's Add to the screen with the QR code and the offer. */
async function toTheOffer() {
    const person = userEvent.setup();
    render(
        <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
            <AccountTwoStep user={user as never} />
        </QueryClientProvider>,
    );
    await person.click(await screen.findByRole('button', { name: 'Add authenticator app' }));
    await person.type(screen.getByLabelText('Password'), password);
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    const code = await screen.findByLabelText('Code from your authenticator app');
    return { person, code };
}

/* What a change did is said once, in a toast, and nowhere on the page. */
const said = (title: string) =>
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', title }));

beforeEach(() => {
    for (const mock of Object.values(api)) if ('mockClear' in mock) mock.mockClear();
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
        expect(screen.getByText('They’ll need to sign in again.')).toBeVisible();
        expect(screen.queryByText(/other devices? will need/)).toBeNull();
        await person.type(code, '123456');
        await person.click(screen.getByRole('button', { name: 'Turn on' }));
        await screen.findByRole('heading', { name: 'Save your backup codes' });
        await waitFor(() => expect(api.removeOtherDevices).toHaveBeenCalledWith(password));
    });

    test('a list that shows no other device does not skip it either, and a list that shows some says how many', async () => {
        // Only this browser in the list: another may have signed in since it was read.
        api.devices.mockResolvedValue({ devices: [{ id: 'this', current: true }] });
        const first = await toTheOffer();
        await screen.findByText('They’ll need to sign in again.');
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
        await screen.findByText('2 other devices will need to sign in again.');
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
        expect(toasts).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
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
        await person.click(
            await screen.findByRole('button', { name: 'Replace authenticator app' }),
        );
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
            await person.click(
                await screen.findByRole('button', { name: 'Turn off authenticator app' }),
            );
            const reads = api.twoStep.mock.calls.length;
            await person.type(screen.getByLabelText('Password'), password);
            await person.click(
                within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn off' }),
            );
            await waitFor(() => expect(api.twoStep.mock.calls.length).toBeGreaterThan(reads));
        },
    );
});

/*
 * The setup key and the backup codes are secrets: a lock or a sign-out in another tab, while
 * they are on screen, must take them off it, and an answer that arrives after must not put
 * them back. Account stays mounted when the browser locks, so the dialog has to do it.
 */
describe('a lock while two-step secrets are on screen', () => {
    test('closes the codes the moment the browser locks, and a late answer does not bring them back', async () => {
        api.twoStep.mockResolvedValue({
            on: false,
            methods: [],
            backupCodesLeft: 0,
            totpFrozen: false,
        });
        const { person, code } = await toTheOffer();
        await person.type(code, '123456');
        await person.click(screen.getByRole('button', { name: 'Turn on' }));
        await screen.findByRole('list', { name: 'Backup codes' });
        act(() => locks.lock());
        await waitFor(() =>
            expect(screen.queryByRole('list', { name: 'Backup codes' })).toBeNull(),
        );
        expect(screen.queryByText(codes[0]!)).toBeNull();
    });

    test('an authenticator key that arrives after a lock is never shown', async () => {
        api.twoStep.mockResolvedValue({
            on: false,
            methods: [],
            backupCodesLeft: 0,
            totpFrozen: false,
        });
        let answer!: (value: { id: string; secret: string; uri: string }) => void;
        api.startAuthenticator.mockReturnValueOnce(
            new Promise((resolve) => {
                answer = resolve;
            }),
        );
        const person = userEvent.setup();
        render(
            <QueryClientProvider
                client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
            >
                <AccountTwoStep user={user as never} />
            </QueryClientProvider>,
        );
        await person.click(await screen.findByRole('button', { name: 'Add authenticator app' }));
        await person.type(screen.getByLabelText('Password'), password);
        await person.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(api.startAuthenticator).toHaveBeenCalled());
        act(() => locks.lock());
        answer({
            id: 'app-1',
            secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
            uri: 'otpauth://totp/HushOS:x?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(screen.queryByText(/JBSW/)).toBeNull();
        expect(screen.queryByLabelText('Code from your authenticator app')).toBeNull();
    });
});

/*
 * Passkeys and security keys, and the default (docs/two-step-design.md 3, 12). The list must
 * say what each key is without claiming more than is true; a key is asked only on the press
 * that adds it; the default is where the server says it is; and the last method is turned
 * off, not removed.
 */
describe('passkeys, security keys and the default', () => {
    const method = (id: string, kind: 'totp' | 'webauthn', extra: object = {}) => ({
        id,
        kind,
        name: kind === 'webauthn' ? 'Desk key' : null,
        createdAt: '2026-11-01T10:00:00.000Z',
        lastUsedAt: null,
        synced: false,
        ...extra,
    });
    const account = (methods: object[], defaultKind: string | null = null) =>
        api.twoStep.mockResolvedValue({
            on: methods.length > 0,
            methods,
            backupCodesLeft: methods.length > 0 ? 10 : 0,
            totpFrozen: false,
            defaultKind,
        } as never);
    const keyRows = () =>
        screen.queryAllByRole('listitem').filter((row) => 'twoStepKeyRow' in row.dataset);

    test('each key is a row of its own that says where it lives, under a row for the kind that counts them', async () => {
        account([method('k1', 'webauthn')], 'webauthn');
        const { unmount } = view();
        const [row] = await waitFor(() => {
            expect(keyRows()).toHaveLength(1);
            return keyRows();
        });
        expect(within(row!).getByText('Desk key')).toBeVisible();
        // A key bound to one device is not called synced.
        expect(screen.queryByText(/Saved in a password manager/)).toBeNull();
        expect(screen.getByText('1 key')).toBeVisible();
        unmount();

        account(
            [
                method('k1', 'webauthn', { name: 'Passkey', synced: true }),
                method('k2', 'webauthn', { name: 'Blue key' }),
                method('app', 'totp'),
            ],
            'webauthn',
        );
        view();
        const rows = await waitFor(() => {
            expect(keyRows()).toHaveLength(2);
            return keyRows();
        });
        expect(within(rows[0]!).getByText(/Saved in a password manager/)).toBeVisible();
        expect(within(rows[1]!).queryByText(/Saved in a password manager/)).toBeNull();
        expect(screen.getByText('2 keys')).toBeVisible();
    });

    test('Add belongs to the kind, never to a key: it is on the kind’s row, and each key has only its own two actions', async () => {
        account(
            [method('k1', 'webauthn'), method('k2', 'webauthn', { name: 'Spare' })],
            'webauthn',
        );
        view();
        const rows = await waitFor(() => {
            expect(keyRows()).toHaveLength(2);
            return keyRows();
        });
        const add = screen.getByRole('button', { name: 'Add passkey or security key' });
        for (const row of rows) {
            expect(row).not.toContainElement(add);
            expect(
                within(row)
                    .getAllByRole('button')
                    .map((button) => button.textContent),
            ).toEqual(['Rename', 'Remove']);
        }
        // On the row that names the kind and counts its keys, in that row's actions.
        const kind = add.closest('[data-two-step-keys]');
        expect(kind).toHaveAttribute('data-two-step-keys', '2');
        expect(add.closest('[data-setting-actions]')).not.toBeNull();
        expect(within(kind as HTMLElement).queryAllByRole('listitem')).toHaveLength(0);
    });

    test('with ten keys there is no Add, and the row says that is the most; with none it says so', async () => {
        account(
            Array.from({ length: 10 }, (_, index) =>
                method(`k${index}`, 'webauthn', { name: `Key ${index}` }),
            ),
            'webauthn',
        );
        const { unmount } = view();
        await waitFor(() => expect(keyRows()).toHaveLength(10));
        expect(screen.queryByRole('button', { name: 'Add passkey or security key' })).toBeNull();
        expect(screen.getByText('10 keys, the most an account can have')).toBeVisible();
        unmount();

        account([method('app', 'totp')], 'totp');
        view();
        await screen.findByRole('button', { name: 'Add passkey or security key' });
        expect(keyRows()).toHaveLength(0);
        expect(screen.getByText('Not added')).toBeVisible();
    });

    test('the section says whether the step is on once, beside its title', async () => {
        account([method('app', 'totp')], 'totp');
        const { unmount } = view();
        const on = await screen.findByText('On');
        expect(on.closest('section')).toBe(
            screen.getByRole('region', { name: /Two-step sign-in/ }),
        );
        // Read out with what it is the state of, not as a bare "On".
        expect(on.parentElement).toHaveTextContent('Two-step sign-in: On');
        expect(screen.getAllByText('On')).toHaveLength(1);
        expect(screen.queryByText('Status')).toBeNull();
        unmount();

        account([]);
        view();
        await screen.findByText('Off');
        expect(screen.getAllByText('Off')).toHaveLength(1);
        expect(screen.queryByText('On')).toBeNull();
        // Neither kind is there: each says so, and no more.
        expect(screen.getAllByText('Not added')).toHaveLength(2);
    });

    test('Default is beside the kind the server says comes first, and Make default asks for the other', async () => {
        account([method('k1', 'webauthn'), method('app', 'totp')], 'totp');
        const person = userEvent.setup();
        view();
        const make = await screen.findByRole('button', {
            name: 'Make passkey or security key the default',
        });
        // One Default, on the app's row; no Make default there.
        expect(screen.getAllByText('Default')).toHaveLength(1);
        expect(
            screen.queryByRole('button', { name: 'Make authenticator app the default' }),
        ).toBeNull();
        account([method('k1', 'webauthn'), method('app', 'totp')], 'webauthn');
        await person.click(make);
        expect(api.setTwoStepDefault).toHaveBeenCalledWith('webauthn');
        // The page shows what the server now says, not what was pressed.
        await screen.findByRole('button', { name: 'Make authenticator app the default' });
        said('Passkey or security key is now the default');
        // Said in the toast only: no line of it stays on the page.
        expect(screen.queryByText(/is now the default/)).toBeNull();
    });

    test('two backup codes or fewer are shown as a warning, in the same words and with no sentence', async () => {
        const left = (count: number) =>
            api.twoStep.mockResolvedValue({
                on: true,
                methods: [method('app', 'totp')],
                backupCodesLeft: count,
                totpFrozen: false,
                defaultKind: 'totp',
            } as never);
        const warned = () => document.querySelector('[data-codes-low]');
        for (const [count, words, low] of [
            [3, '3 of 10 left', false],
            [2, '2 of 10 left', true],
            [0, 'None left', true],
        ] as const) {
            left(count);
            const { unmount } = view();
            const value = await screen.findByText(words);
            expect(warned() !== null).toBe(low);
            if (low) expect(warned()).toBe(value);
            expect(screen.queryByText(/Make a new set/)).toBeNull();
            unmount();
        }
    });

    test('with one kind of method there is nothing to choose, so neither Default nor Make default shows', async () => {
        account(
            [method('k1', 'webauthn'), method('k2', 'webauthn', { name: 'Spare' })],
            'webauthn',
        );
        view();
        await waitFor(() => expect(keyRows()).toHaveLength(2));
        expect(screen.queryByText('Default')).toBeNull();
        expect(screen.queryByRole('button', { name: /the default$/ })).toBeNull();
    });

    test('a refused Make default is said, and nothing claims a change', async () => {
        account([method('k1', 'webauthn'), method('app', 'totp')], 'totp');
        api.setTwoStepDefault.mockRejectedValueOnce(
            Object.assign(
                new Error('Sign out and sign in again on this device to change your default.'),
                { status: 403 },
            ),
        );
        const person = userEvent.setup();
        view();
        await person.click(
            await screen.findByRole('button', { name: 'Make passkey or security key the default' }),
        );
        expect(await screen.findByRole('alert')).toHaveTextContent('Sign out and sign in again');
        expect(toasts).not.toHaveBeenCalled();
        expect(
            screen.getByRole('button', { name: 'Make passkey or security key the default' }),
        ).toBeVisible();
    });

    test('the last method is turned off, any other is removed, and each says which it did', async () => {
        account([method('k1', 'webauthn'), method('app', 'totp')], 'webauthn');
        api.removeTwoStepMethod.mockResolvedValue({ removed: true, on: true });
        const person = userEvent.setup();
        const { unmount } = view();
        await person.click(await screen.findByRole('button', { name: 'Remove Desk key' }));
        const dialog = screen.getByRole('dialog');
        expect(
            within(dialog).getByRole('heading', { name: 'Remove this passkey or security key?' }),
        ).toBeVisible();
        await person.type(within(dialog).getByLabelText('Password'), password);
        await person.click(within(dialog).getByRole('button', { name: 'Remove' }));
        await waitFor(() =>
            expect(api.removeTwoStepMethod).toHaveBeenCalledWith('k1', password, undefined),
        );
        await waitFor(() => said('Passkey or security key removed'));
        unmount();

        // The only method: the same press is turning the step off, and is worded so.
        account([method('k1', 'webauthn')], 'webauthn');
        view();
        await person.click(await screen.findByRole('button', { name: 'Turn off Desk key' }));
        expect(screen.queryByRole('button', { name: 'Remove Desk key' })).toBeNull();
        expect(
            within(screen.getByRole('dialog')).getByRole('heading', {
                name: 'Turn off two-step sign-in?',
            }),
        ).toBeVisible();
    });

    test('a key is asked only on the press that adds it, and a closed sheet keeps the setup for another press', async () => {
        account([method('app', 'totp')], 'totp');
        const person = userEvent.setup();
        view();
        await person.click(
            await screen.findByRole('button', { name: 'Add passkey or security key' }),
        );
        await person.type(screen.getByLabelText('Password'), password);
        await person.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByRole('heading', { name: 'Add your passkey or security key' });
        expect(api.startPasskey).toHaveBeenCalledTimes(1);
        // The password was taken and the options are here: the key has still not been asked.
        expect(api.addPasskey).not.toHaveBeenCalled();
        // A second method turns nothing on, so no devices are offered for removal.
        expect(screen.queryByRole('checkbox', { name: /Remove my other devices/ })).toBeNull();

        // The sheet is closed: nothing was sent, and the same setup takes another press.
        api.addPasskey.mockRejectedValueOnce(
            Object.assign(new Error('Your passkey or security key wasn’t added. Try again.'), {
                kept: true,
            }),
        );
        await person.type(screen.getByLabelText('Name'), 'Blue key');
        await person.click(screen.getByRole('button', { name: 'Add' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('wasn’t added');
        api.addPasskey.mockResolvedValueOnce({ method: method('k9', 'webauthn') });
        await person.click(screen.getByRole('button', { name: 'Add' }));
        await waitFor(() => expect(api.addPasskey).toHaveBeenCalledTimes(2));
        expect(api.addPasskey.mock.calls[1]![1]).toBe('Blue key');
        // The password was asked once.
        expect(api.startPasskey).toHaveBeenCalledTimes(1);
        await waitFor(() => said('Passkey or security key added'));
    });

    test('the first key turns the step on: the codes are shown, and the other devices go as ticked', async () => {
        account([]);
        api.addPasskey.mockResolvedValue({ method: method('k1', 'webauthn'), backupCodes: codes });
        const person = userEvent.setup();
        view();
        await person.click(
            await screen.findByRole('button', { name: 'Add passkey or security key' }),
        );
        await person.type(screen.getByLabelText('Password'), password);
        await person.click(screen.getByRole('button', { name: 'Continue' }));
        expect(
            await screen.findByRole('checkbox', { name: /Remove my other devices/ }),
        ).toBeChecked();
        await person.click(screen.getByRole('button', { name: 'Add and turn on' }));
        const list = await screen.findByRole('list', { name: 'Backup codes' });
        expect(within(list).getAllByRole('listitem')).toHaveLength(10);
        await waitFor(() => expect(api.removeOtherDevices).toHaveBeenCalledWith(password));
    });

    test('a refusal from the server ends the setup: the key’s one answer is used, and the password is asked again', async () => {
        account([method('app', 'totp')], 'totp');
        api.addPasskey.mockRejectedValue(
            Object.assign(
                new Error('That passkey or security key couldn’t be added. Start again.'),
                { status: 400, code: 'key-refused' },
            ),
        );
        const person = userEvent.setup();
        view();
        await person.click(
            await screen.findByRole('button', { name: 'Add passkey or security key' }),
        );
        await person.type(screen.getByLabelText('Password'), password);
        await person.click(screen.getByRole('button', { name: 'Continue' }));
        await person.click(await screen.findByRole('button', { name: 'Add' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Start again');
        // Back at the password, not left on a press that can never work again.
        expect(
            screen.getByRole('heading', { name: 'Add a passkey or security key?' }),
        ).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    });
});
