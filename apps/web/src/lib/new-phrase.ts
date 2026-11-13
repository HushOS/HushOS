import { createStore } from 'zustand/vanilla';

/*
 * The recovery phrase a rotation just made, held in this tab's memory for as long as it takes
 * to show it. A new recovery phrase or a new account key replaces the phrase, and the old one
 * stops working once the server accepts the change. When this browser is then not signed in
 * again, the page that would show the new words is behind a sign-in whose second step may
 * need them: so they are shown at once, over whatever page the person is on or lands on
 * (`NewPhraseGate`, in the root), until they say they have saved them.
 *
 * Only the person who just made the change in this tab sees them. The words stay on screen
 * until they are acknowledged, however long that takes; nothing times them out. They go the
 * moment they are acknowledged, and the moment this browser is locked or signed out, here or
 * in another tab: never left behind for whoever comes to the screen next. Never stored: a
 * reload forgets them, as any page showing a phrase does.
 *
 * They go when the page does, too (`pagehide`): the document is being left for another site,
 * or closed, or put in the back-forward cache, and a page brought back from that cache by
 * the Back button comes back as it was, memory and all, for whoever presses it. The auth
 * client locks the keys on the same event, without the lock or sign-out that is watched for
 * here, so this listens for it itself. A tab that is only hidden or frozen in the background
 * is not leaving: the person is in their password manager or their notes, saving the words,
 * and comes back to the same screen they left, so `visibilitychange` and `freeze` keep them.
 */
export type NewPhrase = {
    phrase: string;
    /* Whether the change went through: yes, or could not be confirmed. */
    applied: true | 'unknown';
    /* Why this browser was not signed in again, when its own storage was the reason. */
    storage: string | null;
    /* What made it: a reset with the old phrase, or a rotation from Account. */
    from: 'reset' | 'rotation';
};

/* The auth store, as far as this needs it: a lock or a sign-out anywhere raises `lockRevision`. */
type Locks = {
    subscribe(
        listener: (state: { lockRevision: number }, previous: { lockRevision: number }) => void,
    ): () => void;
};

export const newPhrase = createStore<{ made: NewPhrase | null }>(() => ({ made: null }));
let unwatch: (() => void) | undefined;

export function keepNewPhrase(made: NewPhrase, auth: Locks) {
    unwatch?.();
    newPhrase.setState({ made });
    const unsubscribe = whenLocked(auth, forgetNewPhrase);
    const staying = whenPageLeaves(forgetNewPhrase);
    unwatch = () => {
        unsubscribe();
        staying();
    };
}
/*
 * Runs `gone` the moment this browser is locked or signed out, here or in another tab. For
 * anything showing a new phrase from its own memory. Returns what stops listening.
 */
export function whenLocked(auth: Locks, gone: () => void) {
    return auth.subscribe((state, previous) => {
        if (state.lockRevision !== previous.lockRevision) gone();
    });
}
/*
 * Runs `gone` when this page is left: for another site, closed, or put in the back-forward
 * cache. For anything showing a new phrase from the page's own memory, which a page brought
 * back from that cache would show again. Returns what stops listening.
 */
export function whenPageLeaves(gone: () => void) {
    window.addEventListener('pagehide', gone);
    return () => window.removeEventListener('pagehide', gone);
}
export function forgetNewPhrase() {
    unwatch?.();
    unwatch = undefined;
    newPhrase.setState({ made: null });
}
/*
 * The recovery page has fetched and is showing `phrase`. When those are the words held here,
 * they have their own page now and the copy has nothing more to do. When they are not, they
 * are the phrase from before a rotation the server may never have applied (its reply was
 * lost, and this browser stayed signed in): the held words may be the only copy of the
 * phrase that now opens the account, and stay until the person says they have saved them.
 */
export function phraseShownOnItsPage(phrase: string) {
    const held = newPhrase.getState().made?.phrase;
    if (held !== undefined && words(held) === words(phrase)) forgetNewPhrase();
}
const words = (phrase: string) => phrase.trim().split(/\s+/).join(' ');
