import { DeviceStorageUnreadable, StepFailure, TwoStepRequired } from '@hushos/auth/client';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * When this browser's device key could not be read, unlocking offers "Unlock as a new device"
 * beside "Try again". The choice belongs to the press that made it: one that fails validation
 * must leave nothing behind, or a later "Try again" would quietly register a new device.
 */
const login =
    vi.fn<
        (
            email: string,
            password: string,
            options?: { asNewDevice?: boolean; owner?: object },
        ) => Promise<void>
    >();
const answerStep = vi.fn<(answer: unknown) => Promise<void>>();
const cancelStep = vi.fn<(owner?: object) => void>();
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
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        store: locks,
        login: (...args: Parameters<typeof login>) => login(...args),
        answerStep: (answer: unknown) => answerStep(answer),
        // Leaving the form lets go of a sign-in waiting at its second step.
        cancelStep: (owner?: object) => cancelStep(owner),
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
    expect(login).toHaveBeenLastCalledWith(
        'maya@example.com',
        'correct horse',
        expect.objectContaining({ asNewDevice: false }),
    );
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
        expect(login).toHaveBeenLastCalledWith(
            'maya@example.com',
            'correct horse',
            expect.objectContaining({ asNewDevice: false }),
        );
    });

    test('the new-device press unlocks as a new device', async () => {
        const { user } = await refusedOnce();
        await user.click(screen.getByRole('button', { name: 'Unlock as a new device' }));
        await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
        expect(login).toHaveBeenLastCalledWith(
            'maya@example.com',
            'correct horse',
            expect.objectContaining({ asNewDevice: true }),
        );
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
        // The cursor is back in the field, though the button was what was pressed: the next
        // code can be typed at once, and a screen reader is not left on nothing.
        await vi.waitFor(() => expect(code).toHaveFocus());

        answerStep.mockResolvedValueOnce(undefined);
        await user.clear(code);
        await user.type(code, '654321');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await vi.waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
        expect(answerStep).toHaveBeenLastCalledWith({ kind: 'totp', code: '654321' });
    });

    test('choosing another way moves the cursor to its field, and what the address limit refused can be sent again', async () => {
        const { user, code } = await toStep();
        await user.click(screen.getByRole('button', { name: 'Use your recovery phrase' }));
        const phrase = await screen.findByLabelText('Recovery phrase');
        await vi.waitFor(() => expect(phrase).toHaveFocus());
        await user.click(screen.getByRole('button', { name: 'Use your authenticator app' }));
        await vi.waitFor(() =>
            expect(screen.getByLabelText('Code from your authenticator app')).toHaveFocus(),
        );
        expect(code.isConnected).toBe(false);

        answerStep.mockRejectedValueOnce(new StepFailure('busy', 'Too many requests. Try again.'));
        const field = screen.getByLabelText('Code from your authenticator app');
        await user.type(field, '123456');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('Too many requests. Try again.');
        // The step is still here, with every way still offered.
        expect(screen.getByRole('button', { name: 'Use a backup code' })).toBeEnabled();
        answerStep.mockResolvedValueOnce(undefined);
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await vi.waitFor(() => expect(answerStep).toHaveBeenCalledTimes(2));
    });

    test('a method the server cannot check is withdrawn alone: the app’s codes go, and a backup code is still offered and sent', async () => {
        const { user, code } = await toStep();
        answerStep.mockRejectedValueOnce(
            new StepFailure(
                'unavailable',
                'Two-step sign-in is unavailable on this server right now.',
            ),
        );
        await user.type(code, '123456');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('Two-step sign-in is unavailable on this server right now.');
        // The backup codes are under their own key: still offered, beside the phrase.
        const backup = await screen.findByLabelText('Backup code');
        expect(screen.getByRole('button', { name: 'Use your recovery phrase' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: 'Use your authenticator app' })).toBeNull();
        answerStep.mockResolvedValueOnce(undefined);
        await user.type(backup, '7KQ2M-9XD4P');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await vi.waitFor(() =>
            expect(answerStep).toHaveBeenLastCalledWith({ kind: 'backup', code: '7KQ2M-9XD4P' }),
        );
    });

    test('too many wrong codes on an account with no phrase to offer: both code fields go, and the form says there is nothing left to try', async () => {
        // An account whose step offers no recovery phrase.
        login.mockReset();
        login.mockRejectedValueOnce(
            new TwoStepRequired({ ...challenge, methods: ['totp', 'backup'] }),
        );
        answerStep.mockReset();
        const user = userEvent.setup();
        render(<UnlockDevice user={{ email: 'maya@example.com' }} />);
        await user.type(screen.getByLabelText('Password'), 'correct horse');
        await user.click(screen.getByRole('button', { name: 'Unlock' }));
        const code = await screen.findByLabelText('Code from your authenticator app');
        answerStep.mockRejectedValueOnce(
            new StepFailure('limited', 'Too many wrong codes. Try again in 15 minutes.'),
        );
        await user.type(code, '123456');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('Too many wrong codes. Try again in 15 minutes.');
        await screen.findByText(
            'There is no other way to answer this step from here right now. Start again in a while.',
        );
        // No field is left that could only be refused, and nothing to send.
        expect(screen.queryByLabelText('Code from your authenticator app')).toBeNull();
        expect(screen.queryByLabelText('Backup code')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Start again' })).toBeEnabled();
    });

    test('a lock in another tab takes a typed recovery phrase off the screen and goes back to the password', async () => {
        const { user } = await toStep();
        await user.click(screen.getByRole('button', { name: 'Use your recovery phrase' }));
        const phrase = await screen.findByLabelText('Recovery phrase');
        await user.type(phrase, 'abandon ability able about above');
        act(() => locks.lock());
        await screen.findByText('This browser was locked. Sign in again.');
        expect(screen.queryByLabelText('Recovery phrase')).toBeNull();
        expect(screen.queryByDisplayValue(/abandon ability/)).toBeNull();
        expect(screen.getByLabelText('Password')).toHaveValue('');
    });

    test('a paused app stops being offered, and a step that is over goes back to the password with the reason', async () => {
        const { user, code } = await toStep();
        answerStep.mockRejectedValueOnce(
            new StepFailure('frozen', 'Your authenticator app is paused on this device.'),
        );
        await user.type(code, '123456');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('Your authenticator app is paused on this device.');
        // The backup code field took its place and the cursor with it; the app is not among
        // the ways offered.
        const backup = await screen.findByLabelText('Backup code');
        expect(screen.queryByRole('button', { name: 'Use your authenticator app' })).toBeNull();
        await vi.waitFor(() => expect(backup).toHaveFocus());
        // Continue, pressed before anything is typed there: the app's code from before is
        // still in the draft, and must not go out again under a field that shows no app.
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('Enter one of your backup codes, 10 characters.');
        expect(answerStep).toHaveBeenCalledTimes(1);

        answerStep.mockRejectedValueOnce(
            new StepFailure('over', 'This sign-in timed out. Enter your password again.'),
        );
        await user.type(screen.getByLabelText('Backup code'), '7KQ2M-9XD4P');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByText('This sign-in timed out. Enter your password again.');
        // What was sent is the backup code that was shown, not the app's code typed before it.
        expect(answerStep).toHaveBeenLastCalledWith({ kind: 'backup', code: '7KQ2M-9XD4P' });
        expect(screen.getByLabelText('Password')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Unlock' })).toBeEnabled();
    });

    test('the form is on the page twice: the one that closes lets go of its own sign-in only, never the other’s step', async () => {
        // The locked page's form, which the person uses, and the Unlock dialog's, which they close.
        cancelStep.mockClear();
        login.mockReset();
        login.mockRejectedValueOnce(new TwoStepRequired(challenge));
        const user = userEvent.setup();
        const inline = render(<UnlockDevice user={{ email: 'maya@example.com' }} />);
        const inDialog = render(<UnlockDevice user={{ email: 'maya@example.com' }} />);
        await user.type(inline.getAllByLabelText('Password')[0]!, 'correct horse');
        await user.click(inline.getAllByRole('button', { name: 'Unlock' })[0]!);
        await inline.findByLabelText('Code from your authenticator app');
        const started = login.mock.calls[0]![2]!.owner;
        expect(started).toBeTypeOf('object');

        inDialog.unmount();
        // What the closing form lets go of is named, and it is not the other form's sign-in.
        expect(cancelStep).toHaveBeenCalledTimes(1);
        const left = cancelStep.mock.calls[0]![0];
        expect(left).toBeTypeOf('object');
        expect(left).not.toBe(started);
        // The step is still on screen, and still answerable.
        expect(inline.getByLabelText('Code from your authenticator app')).toBeVisible();

        // The form that started it does let go of it when it goes.
        inline.unmount();
        expect(cancelStep).toHaveBeenLastCalledWith(started);
    });
});
