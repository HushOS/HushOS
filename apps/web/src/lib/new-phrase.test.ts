import { beforeEach, describe, expect, test } from 'vitest';
import {
    forgetNewPhrase,
    keepNewPhrase,
    newPhrase,
    phraseShownOnItsPage,
    whenLocked,
    type NewPhrase,
} from './new-phrase';

/*
 * A recovery phrase held in the tab for showing. It is plaintext that opens the account, so
 * the rule is strict: only the person who just made the change in this tab sees it. It must
 * be gone the moment they have acknowledged it, and the moment the browser is locked or
 * signed out, here or in another tab, or the next person at the screen reads it.
 */

const made: NewPhrase = {
    phrase: Array.from({ length: 24 }, (_, index) => `word${index + 1}`).join(' '),
    applied: true,
    storage: null,
    from: 'rotation',
};

/* The auth store, as far as a lock or a sign-out shows in it: here or from another tab. */
function authStore() {
    let state = { lockRevision: 1, unlockedUserId: null as string | null };
    const listeners = new Set<(next: typeof state, previous: typeof state) => void>();
    return {
        subscribe(listener: (next: typeof state, previous: typeof state) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(patch: Partial<typeof state>) {
            const previous = state;
            state = { ...state, ...patch };
            for (const listener of listeners) listener(state, previous);
        },
        listeners: () => listeners.size,
    };
}

beforeEach(forgetNewPhrase);

describe('a new recovery phrase held for showing', () => {
    test('is held until it is acknowledged, and then is gone for good', () => {
        const auth = authStore();
        keepNewPhrase(made, auth);
        expect(newPhrase.getState().made).toEqual(made);
        forgetNewPhrase();
        expect(newPhrase.getState().made).toBeNull();
        // Nothing brings it back, and nothing is still listening for it.
        auth.set({ lockRevision: 2 });
        expect(newPhrase.getState().made).toBeNull();
        expect(auth.listeners()).toBe(0);
    });

    test('is gone the moment the browser is locked or signed out, here or in another tab', () => {
        const auth = authStore();
        keepNewPhrase(made, auth);
        // Unlocking, restoring, anything that is not a lock or a sign-out, leaves it.
        auth.set({ unlockedUserId: 'user-1' });
        expect(newPhrase.getState().made).toEqual(made);
        // A lock or a sign-out raises the revision, in this tab or (through storage) another.
        auth.set({ lockRevision: 2 });
        expect(newPhrase.getState().made).toBeNull();
        expect(auth.listeners()).toBe(0);
    });

    test('is gone when the page is left, so the Back button cannot bring it back; a tab only hidden or frozen keeps it', () => {
        const auth = authStore();
        keepNewPhrase(made, auth);
        // In another app or tab to save the words: the same person comes back to this screen.
        document.dispatchEvent(new Event('visibilitychange'));
        document.dispatchEvent(new Event('freeze'));
        document.dispatchEvent(new Event('resume'));
        expect(newPhrase.getState().made).toEqual(made);
        // Navigated away, closed, or stored in the back-forward cache. The auth client locks
        // the keys here without a lock that anyone is told of, so nothing else clears this.
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        expect(newPhrase.getState().made).toBeNull();
        expect(auth.listeners()).toBe(0);
        // Brought back from that cache: the page's memory is as it was left, without the words.
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        expect(newPhrase.getState().made).toBeNull();
    });

    test('is done with once its own page shows the same words, and kept when that page shows the phrase from before', () => {
        const auth = authStore();
        keepNewPhrase({ ...made, applied: 'unknown' }, auth);
        // A rotation whose reply was lost, in a browser still signed in: the recovery page
        // fetches the backup, and the server may hand back the phrase it had before.
        phraseShownOnItsPage(Array.from({ length: 24 }, (_, index) => `old${index + 1}`).join(' '));
        expect(newPhrase.getState().made?.phrase).toBe(made.phrase);
        // The rotation did land: the page shows these very words, however they are spaced.
        phraseShownOnItsPage(`  ${made.phrase.replaceAll(' ', '\n')} `);
        expect(newPhrase.getState().made).toBeNull();
        expect(auth.listeners()).toBe(0);
        // With nothing held, a fetched phrase changes nothing.
        phraseShownOnItsPage(made.phrase);
        expect(newPhrase.getState().made).toBeNull();
    });

    test('a later change replaces it, and only the later one is watched', () => {
        const first = authStore();
        const second = authStore();
        keepNewPhrase(made, first);
        const next = { ...made, phrase: 'other words', applied: 'unknown' as const };
        keepNewPhrase(next, second);
        expect(first.listeners()).toBe(0);
        first.set({ lockRevision: 2 });
        expect(newPhrase.getState().made).toEqual(next);
        second.set({ lockRevision: 2 });
        expect(newPhrase.getState().made).toBeNull();
    });
});

describe('a new recovery phrase a page keeps itself (the reset page)', () => {
    test('is told the moment the browser is locked or signed out, and no more once the page stops listening', () => {
        const auth = authStore();
        let gone = 0;
        const stop = whenLocked(auth, () => gone++);
        auth.set({ unlockedUserId: 'someone' });
        expect(gone).toBe(0);
        auth.set({ lockRevision: 2 });
        expect(gone).toBe(1);
        stop();
        expect(auth.listeners()).toBe(0);
        auth.set({ lockRevision: 3 });
        expect(gone).toBe(1);
    });
});
