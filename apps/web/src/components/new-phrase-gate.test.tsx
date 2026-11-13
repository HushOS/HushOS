import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * The gate that shows a recovery phrase a rotation just made. It is in the root, over every
 * page, because the page the person lands on cannot be relied on: with a session that is
 * still good they are redirected away from the sign-in page to one that asks for an unlock,
 * and a phrase-only person can get no further without the words. And the words must not
 * outlive their showing: acknowledged, or the browser locked or signed out, they are gone,
 * and nothing shows them again.
 */

// The page furniture, which needs the router and a canvas; the words do not.
vi.mock('@/components/brand', () => ({ Brand: () => null }));
vi.mock('@/components/cover', () => ({ Cover: () => null }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { NewPhraseGate } = await import('./new-phrase-gate');
// The panel is loaded on demand; the dialog that keeps a phrase loads it first, and so does this.
await import('./new-phrase');
const { forgetNewPhrase, keepNewPhrase, newPhrase } = await import('@/lib/new-phrase');

const words = Array.from({ length: 24 }, (_, index) => `word${index + 1}`);
const made = {
    phrase: words.join(' '),
    applied: true as const,
    storage: null,
    from: 'rotation' as const,
};

function authStore() {
    let state = { lockRevision: 1 };
    const listeners = new Set<(next: typeof state, previous: typeof state) => void>();
    return {
        subscribe(listener: (next: typeof state, previous: typeof state) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        lock() {
            const previous = state;
            state = { lockRevision: state.lockRevision + 1 };
            for (const listener of listeners) listener(state, previous);
        },
    };
}
const shown = () => screen.queryByRole('list', { name: 'Recovery phrase' });

// jsdom has no modal dialogs: the browser's own call is recorded, and opens it as jsdom can.
const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
});
HTMLDialogElement.prototype.showModal = showModal;

beforeEach(() => act(() => forgetNewPhrase()));

describe('the new recovery phrase, shown wherever the person is', () => {
    test('shows nothing until a phrase is held, then shows all 24 words on any page, with no sign-in page under it', async () => {
        // Rendered alone: no router, no session, no page. Where the person landed is not its business.
        render(<NewPhraseGate />);
        expect(shown()).toBeNull();
        act(() => keepNewPhrase(made, authStore()));
        const list = await screen.findByRole('list', { name: 'Recovery phrase' });
        expect(within(list).getAllByRole('listitem')).toHaveLength(24);
        expect(list).toHaveTextContent('word24');
        expect(
            screen.getByRole('heading', { name: 'Save your new recovery phrase' }),
        ).toBeVisible();
        expect(screen.getByText(/Your old recovery phrase no longer works/)).toBeVisible();
    });

    test('acknowledged, the words are forgotten: nothing shows them again, in this gate or a new one', async () => {
        const user = userEvent.setup();
        const first = render(<NewPhraseGate />);
        act(() => keepNewPhrase(made, authStore()));
        await screen.findByRole('list', { name: 'Recovery phrase' });
        await user.click(screen.getByRole('button', { name: 'I’ve saved these words' }));
        expect(shown()).toBeNull();
        expect(newPhrase.getState().made).toBeNull();
        // The sign-in page after a later sign-out, say: a gate mounted afresh has nothing.
        first.unmount();
        render(<NewPhraseGate />);
        expect(shown()).toBeNull();
        expect(document.body).not.toHaveTextContent('word1');
    });

    test('a lock or a sign-out takes the words off the screen at once, unacknowledged or not', async () => {
        const auth = authStore();
        render(<NewPhraseGate />);
        act(() => keepNewPhrase(made, auth));
        await screen.findByRole('list', { name: 'Recovery phrase' });
        act(() => auth.lock());
        expect(shown()).toBeNull();
        expect(document.body).not.toHaveTextContent('word1');
        expect(newPhrase.getState().made).toBeNull();
    });

    test('is opened as a modal, so nothing under it can be reached, and Escape does not dismiss it', async () => {
        showModal.mockClear();
        render(<NewPhraseGate />);
        act(() => keepNewPhrase(made, authStore()));
        const list = await screen.findByRole('list', { name: 'Recovery phrase' });
        // The browser's modal: top layer, the rest of the page inert to keyboard and readers.
        expect(showModal).toHaveBeenCalledTimes(1);
        const dialog = list.closest('dialog')!;
        expect(showModal.mock.contexts[0]).toBe(dialog);
        // Escape asks a modal dialog to close; this one closes only by its own button.
        const cancel = new Event('cancel', { cancelable: true });
        act(() => void dialog.dispatchEvent(cancel));
        expect(cancel.defaultPrevented).toBe(true);
        expect(shown()).not.toBeNull();
        expect(newPhrase.getState().made).toEqual(made);
    });

    test('when the outcome could not be confirmed, it says to keep both phrases', async () => {
        render(<NewPhraseGate />);
        act(() => keepNewPhrase({ ...made, applied: 'unknown' }, authStore()));
        await screen.findByText(/Keep both until you have signed in/);
    });
});
