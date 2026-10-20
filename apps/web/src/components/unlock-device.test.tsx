import { DeviceStorageUnreadable } from '@hushos/auth/client';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * When this browser's device key could not be read, unlocking offers "Unlock as a new device"
 * beside "Try again". The choice belongs to the press that made it: one that fails validation
 * must leave nothing behind, or a later "Try again" would quietly register a new device.
 */
const login =
    vi.fn<
        (email: string, password: string, options?: { asNewDevice?: boolean }) => Promise<void>
    >();
vi.mock('@/lib/auth-client', () => ({
    authClient: { login: (...args: Parameters<typeof login>) => login(...args) },
}));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { UnlockDevice } = await import('./unlock-device');

beforeEach(() => {
    login.mockReset();
    login.mockRejectedValueOnce(new DeviceStorageUnreadable('unavailable'));
    login.mockResolvedValue(undefined);
});

async function refusedOnce() {
    const user = userEvent.setup();
    render(<UnlockDevice user={{ email: 'maya@example.com' }} />);
    const password = screen.getByLabelText('Password');
    await user.type(password, 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByRole('button', { name: 'Unlock as a new device' });
    expect(login).toHaveBeenLastCalledWith('maya@example.com', 'correct horse', {
        asNewDevice: false,
    });
    return { user, password };
}

describe('unlocking when the device key could not be read', () => {
    test('a new-device press that fails validation does not make the next try a new device', async () => {
        const { user, password } = await refusedOnce();
        await user.clear(password);
        await user.click(screen.getByRole('button', { name: 'Unlock as a new device' }));
        await screen.findByText('Enter your password.');
        expect(login).toHaveBeenCalledTimes(1);

        await user.type(password, 'correct horse');
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
        expect(login).toHaveBeenLastCalledWith('maya@example.com', 'correct horse', {
            asNewDevice: false,
        });
    });

    test('the new-device press unlocks as a new device', async () => {
        const { user } = await refusedOnce();
        await user.click(screen.getByRole('button', { name: 'Unlock as a new device' }));
        await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
        expect(login).toHaveBeenLastCalledWith('maya@example.com', 'correct horse', {
            asNewDevice: true,
        });
    });
});
