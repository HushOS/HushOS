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
        canUsePasskeys: () => passkeysHere,
    },
}));
/* Whether this browser can use a passkey: it named the method to the server, or it did not. */
let passkeysHere = true;
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
        methods: ['totp', 'backup', 'phrase'] as ('webauthn' | 'totp' | 'backup' | 'phrase')[],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    /* The other ways are behind one button: opens it, and presses the way named. */
    async function another(user: ReturnType<typeof userEvent.setup>, way: string) {
        await user.click(screen.getByRole('button', { name: 'Use another way' }));
        await user.click(screen.getByRole('button', { name: way }));
    }
    async function toStep(onUnlocked = vi.fn(), asked: object = challenge) {
        login.mockReset();
        login.mockRejectedValueOnce(new TwoStepRequired(asked as typeof challenge));
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
        await another(user, 'Use your recovery phrase');
        const phrase = await screen.findByLabelText('Recovery phrase');
        await vi.waitFor(() => expect(phrase).toHaveFocus());
        await another(user, 'Use your authenticator app');
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
        await user.click(screen.getByRole('button', { name: 'Use another way' }));
        expect(screen.getByRole('button', { name: 'Use a backup code' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Use your recovery phrase' })).toBeEnabled();
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
        await user.click(screen.getByRole('button', { name: 'Use another way' }));
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
        await another(user, 'Use your recovery phrase');
        const phrase = await screen.findByLabelText('Recovery phrase');
        await user.type(phrase, 'abandon ability able about above');
        act(() => locks.lock());
        await screen.findByText('This browser was locked. Sign in again.');
        expect(screen.queryByLabelText('Recovery phrase')).toBeNull();
        expect(screen.queryByDisplayValue(/abandon ability/)).toBeNull();
        expect(screen.getByLabelText('Password')).toHaveValue('');
    });

    test('leaving the page takes a typed recovery phrase with it, so the Back button cannot bring it back', async () => {
        const { user } = await toStep();
        await another(user, 'Use your recovery phrase');
        await user.type(
            await screen.findByLabelText('Recovery phrase'),
            'abandon ability able about above',
        );
        act(() => {
            window.dispatchEvent(new Event('pagehide'));
        });
        expect(screen.queryByDisplayValue(/abandon ability/)).toBeNull();
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

/*
 * One way to confirm (docs/two-step-design.md 12): the step opens on the account's usual way,
 * with the rest behind Use another way. A passkey is a button, and its sheet opens on the
 * press, never when the step appears. When the usual way is not on offer the form says one
 * line that names no reason.
 */
describe('the step opens on the account’s usual way', () => {
    const base = {
        token: 'a-step-token_'.padEnd(43, 'x'),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    const webauthn = {
        challenge: 'Y2hhbGxlbmdl',
        rpId: 'localhost',
        timeout: 300_000,
        userVerification: 'discouraged',
        allowCredentials: [{ id: 'a2V5', type: 'public-key' }],
    };
    async function stepWith(challenge: object, onUnlocked = vi.fn()) {
        passkeysHere = true;
        login.mockReset();
        login.mockRejectedValueOnce(new TwoStepRequired({ ...base, ...challenge } as never));
        answerStep.mockReset();
        const user = userEvent.setup();
        render(<UnlockDevice user={{ email: 'maya@example.com' }} onUnlocked={onUnlocked} />);
        await user.type(screen.getByLabelText('Password'), 'correct horse');
        await user.click(screen.getByRole('button', { name: 'Unlock' }));
        await vi.waitFor(() => expect(screen.queryByLabelText('Password')).toBeNull());
        return { user, onUnlocked };
    }

    test('a passkey first is a button: nothing asks the key until it is pressed, and the others wait behind Use another way', async () => {
        const { user, onUnlocked } = await stepWith({
            methods: ['webauthn', 'totp', 'backup', 'phrase'],
            webauthn,
        });
        const press = await screen.findByRole('button', { name: 'Use your passkey' });
        // The step is on screen, and the key has not been asked: no sheet on load.
        expect(answerStep).not.toHaveBeenCalled();
        // No code field, and no list of other ways until it is asked for.
        expect(screen.queryByLabelText('Code from your authenticator app')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Use your authenticator app' })).toBeNull();
        expect(screen.queryByText('Your usual way isn’t available for this sign-in.')).toBeNull();

        // A sheet that was closed: said here, and the same step takes the press again.
        answerStep.mockRejectedValueOnce(
            new StepFailure(
                'wrong',
                'Your passkey or security key wasn’t used. Try again, or use another way.',
            ),
        );
        await user.click(press);
        await screen.findByText(/wasn’t used/);
        expect(onUnlocked).not.toHaveBeenCalled();
        answerStep.mockResolvedValueOnce(undefined);
        await user.click(screen.getByRole('button', { name: 'Use your passkey' }));
        await vi.waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
        expect(answerStep).toHaveBeenLastCalledWith({ kind: 'webauthn' });
    });

    test('Use another way lists the rest in the server’s order, and the one chosen is what is sent', async () => {
        const { user } = await stepWith({
            methods: ['webauthn', 'totp', 'backup', 'phrase'],
            webauthn,
        });
        await user.click(await screen.findByRole('button', { name: 'Use another way' }));
        const ways = screen
            .getAllByRole('button')
            .map((button) => button.textContent)
            .filter((text) => text?.startsWith('Use ') && text !== 'Use your passkey');
        expect(ways).toEqual([
            'Use your authenticator app',
            'Use a backup code',
            'Use your recovery phrase',
        ]);
        await user.click(screen.getByRole('button', { name: 'Use a backup code' }));
        answerStep.mockResolvedValueOnce(undefined);
        await user.type(await screen.findByLabelText('Backup code'), '7KQ2M-9XD4P');
        // The button is the form's own again, and the passkey is one of the other ways now.
        expect(screen.queryByRole('button', { name: 'Use your passkey' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Use another way' }));
        expect(
            screen.getByRole('button', { name: 'Use your passkey or security key' }),
        ).toBeEnabled();
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await vi.waitFor(() =>
            expect(answerStep).toHaveBeenLastCalledWith({ kind: 'backup', code: '7KQ2M-9XD4P' }),
        );
    });

    test('an account whose default is its app opens on the code, though it has a passkey too', async () => {
        await stepWith({ methods: ['totp', 'webauthn', 'backup', 'phrase'], webauthn });
        expect(await screen.findByLabelText('Code from your authenticator app')).toBeVisible();
        expect(screen.queryByRole('button', { name: 'Use your passkey' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });

    test('when the usual way is not on offer the form says so in one line that names no reason', async () => {
        await stepWith({ methods: ['totp', 'backup', 'phrase'], defaultUnavailable: true });
        const note = await screen.findByText('Your usual way isn’t available for this sign-in.');
        expect(note).toBeVisible();
        expect(note.textContent).not.toMatch(/passkey|device|paused|frozen/i);
    });

    test('a way left out of a list this browser named everything for means a newer HushOS has it; left out because this browser can’t, only the one line', async () => {
        const first = await stepWith({
            methods: ['totp', 'backup', 'phrase'],
            withheld: true,
            defaultUnavailable: true,
        });
        expect(
            await screen.findByText('Update HushOS to use your passkey or another device.'),
        ).toBeVisible();
        expect(screen.queryByText(/Your usual way/)).toBeNull();
        expect(first.user).toBeDefined();
    });

    test('a browser that can’t use passkeys is not told to update for one', async () => {
        login.mockReset();
        login.mockRejectedValueOnce(
            new TwoStepRequired({
                ...base,
                methods: ['totp', 'backup', 'phrase'],
                withheld: true,
                defaultUnavailable: true,
            } as never),
        );
        passkeysHere = false;
        const user = userEvent.setup();
        render(<UnlockDevice user={{ email: 'maya@example.com' }} />);
        await user.type(screen.getByLabelText('Password'), 'correct horse');
        await user.click(screen.getByRole('button', { name: 'Unlock' }));
        expect(
            await screen.findByText('Your usual way isn’t available for this sign-in.'),
        ).toBeVisible();
        expect(screen.queryByText(/Update HushOS/)).toBeNull();
        passkeysHere = true;
    });
});
