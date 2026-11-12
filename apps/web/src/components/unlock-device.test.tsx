import { DeviceStorageUnreadable, StepFailure, TwoStepRequired } from '@hushos/auth/client';
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
const answerStep = vi.fn<(answer: unknown) => Promise<void>>();
const cancelStep = vi.fn();
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        login: (...args: Parameters<typeof login>) => login(...args),
        answerStep: (answer: unknown) => answerStep(answer),
        // Leaving the form lets go of a sign-in waiting at its second step.
        cancelStep: () => cancelStep(),
    },
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

/*
 * Unlocking is a sign-in, so an account with two-step sign-in can be asked for its step here
 * (a browser the account does not know). The form must ask for it in place, finish when it
 * passes, and go back to the password, with the reason, when the step is over.
 */
describe('unlocking an account that asks for a second step', () => {
    const challenge = {
        token: 'a-step-token_'.padEnd(43, 'x'),
        methods: ['totp', 'backup', 'phrase'] as ('totp' | 'backup' | 'phrase')[],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    async function toStep(onUnlocked = vi.fn()) {
        login.mockReset();
        login.mockRejectedValueOnce(new TwoStepRequired(challenge));
        answerStep.mockReset();
        const user = userEvent.setup();
        render(<UnlockDevice user={{ email: 'maya@example.com' }} onUnlocked={onUnlocked} />);
        await user.type(screen.getByLabelText('Password'), 'correct horse');
        await user.click(screen.getByRole('button', { name: 'Unlock' }));
        const code = await screen.findByLabelText('Code from your authenticator app');
        return { user, code, onUnlocked };
    }

    test('the step is asked for in place, a wrong code can be tried again, and the right one unlocks', async () => {
        const { user, code, onUnlocked } = await toStep();
        expect(screen.queryByLabelText('Password')).toBeNull();
        // Five digits never reach the server: a try is not spent on what cannot be right.
        await user.type(code, '12345');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('Enter the 6-digit code from your authenticator app.');
        expect(answerStep).not.toHaveBeenCalled();

        answerStep.mockRejectedValueOnce(new StepFailure('wrong', 'That code didn’t work.'));
        await user.type(code, '6');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('That code didn’t work.');
        expect(onUnlocked).not.toHaveBeenCalled();

        answerStep.mockResolvedValueOnce(undefined);
        await user.clear(code);
        await user.type(code, '654321');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await vi.waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
        expect(answerStep).toHaveBeenLastCalledWith({ kind: 'totp', code: '654321' });
    });

    test('a paused app stops being offered, and a step that is over goes back to the password with the reason', async () => {
        const { user, code } = await toStep();
        answerStep.mockRejectedValueOnce(
            new StepFailure('frozen', 'Your authenticator app is paused on this device.'),
        );
        await user.type(code, '123456');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('Your authenticator app is paused on this device.');
        // The backup code field took its place; the app is not among the ways offered.
        await screen.findByLabelText('Backup code');
        expect(screen.queryByRole('button', { name: 'Use your authenticator app' })).toBeNull();

        answerStep.mockRejectedValueOnce(
            new StepFailure('over', 'This sign-in timed out. Enter your password again.'),
        );
        await user.type(screen.getByLabelText('Backup code'), '7KQ2M-9XD4P');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('This sign-in timed out. Enter your password again.');
        expect(screen.getByLabelText('Password')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
    });
});
