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
    unwatch = auth.subscribe((state, previous) => {
        if (state.lockRevision !== previous.lockRevision) forgetNewPhrase();
    });
}
export function forgetNewPhrase() {
    unwatch?.();
    unwatch = undefined;
    newPhrase.setState({ made: null });
}
