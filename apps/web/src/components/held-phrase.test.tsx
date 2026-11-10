import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { forgetPhrase, holdPhrase, type HeldPhrase } from '@/lib/unconfirmed-phrase';

/*
 * The screen that holds a new recovery phrase whose change went unanswered is the only place
 * the phrase exists. Whatever goes wrong around it, the words must stay readable, and nothing
 * on it may lead away from them.
 */
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { HeldPhraseScreen } = await import('./held-phrase');
const { Brand } = await import('./brand');

const WORDS = Array.from({ length: 24 }, (_, index) => `word${index + 1}`);
const held = (Screen: HeldPhrase['Screen']): HeldPhrase => ({
    account: { id: 'user', email: 'maya@example.com' },
    phrase: WORDS.join(' '),
    recovery: {} as HeldPhrase['recovery'],
    Screen,
});

afterEach(() => {
    forgetPhrase();
    document.title = '';
});

describe('the screen that holds an unconfirmed recovery phrase', () => {
    test('a screen that fails to draw still shows the 24 words, in order, under the same title', () => {
        // React reports what the boundary caught; the report is not what is under test.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const done = vi.fn();
        const Broken = () => {
            throw new Error('The kit could not be drawn.');
        };
        render(<HeldPhraseScreen held={held(Broken)} onDone={done} />);
        const heading = screen.getByRole('heading', { name: 'Save your new recovery phrase' });
        expect(heading).toHaveFocus();
        const items = screen.getByRole('list', { name: 'Recovery phrase' }).querySelectorAll('li');
        expect([...items].map((item) => item.textContent)).toEqual(WORDS);
        // Still a way on, and it is the caller's.
        screen.getByRole('button', { name: 'Finish' }).click();
        expect(done).toHaveBeenCalledOnce();
    });

    test('names the tab and takes the focus while it is up, and gives the tab its name back', () => {
        document.title = 'Account · HushOS';
        const Shown = () => (
            <main>
                <h1>Save your new recovery phrase</h1>
            </main>
        );
        const { unmount } = render(<HeldPhraseScreen held={held(Shown)} onDone={() => {}} />);
        expect(document.title).toBe('Save your new recovery phrase · HushOS');
        expect(screen.getByRole('heading')).toHaveFocus();
        unmount();
        expect(document.title).toBe('Account · HushOS');
    });

    test('a page title set underneath does not take the tab’s name back', async () => {
        const Shown = () => <h1>Save your new recovery phrase</h1>;
        render(<HeldPhraseScreen held={held(Shown)} onDone={() => {}} />);
        // As React places a route's new title: before the first one in the head.
        const routed = document.createElement('title');
        routed.textContent = 'Sign in · HushOS';
        document.head.prepend(routed);
        await vi.waitFor(() =>
            expect(document.title).toBe('Save your new recovery phrase · HushOS'),
        );
        routed.remove();
    });

    test('asks before the tab is closed or reloaded, in the old way too, and stops asking once it is gone', () => {
        const Shown = () => <h1>Save your new recovery phrase</h1>;
        const { unmount } = render(<HeldPhraseScreen held={held(Shown)} onDone={() => {}} />);
        const leaving = () => {
            const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
            let legacy: unknown;
            Object.defineProperty(event, 'returnValue', {
                set(value) {
                    legacy = value;
                },
                get: () => legacy,
            });
            window.dispatchEvent(event);
            return { prevented: event.defaultPrevented, legacy };
        };
        expect(leaving()).toEqual({ prevented: true, legacy: '' });
        unmount();
        expect(leaving()).toEqual({ prevented: false, legacy: undefined });
    });

    test('the mark is no link while a phrase is held: a press cannot move the address under it', () => {
        holdPhrase(held(() => null));
        const { unmount } = render(<Brand />);
        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.getByText('HushOS')).toBeInTheDocument();
        // Gone before the phrase is forgotten: the link it becomes again needs a router.
        unmount();
    });
});
