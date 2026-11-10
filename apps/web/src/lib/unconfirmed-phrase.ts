import type { UnconfirmedPhrase } from '@hushos/auth/client';
import { useSyncExternalStore, type ComponentType } from 'react';

/*
 * A new recovery phrase from a change whose reply never arrived (docs/two-step-design.md 4,
 * "When the reply is lost"). The person may be signed out by then, so the server cannot serve
 * it again: this is the only copy, and the connection it would take to load anything has just
 * failed. So the dialog that made it hands it over here together with the screen that shows
 * it, both already in memory, and the root document draws that screen in place of the page
 * (routes/__root.tsx): no navigation, no request and no chunk stands between the phrase and
 * the person. It is held in this tab's memory and nowhere else: not in the URL, the history
 * entry, storage or a query cache, so a reload or a closed tab ends it, as does the screen's
 * own Finish.
 */
/* The screen's title and what it says under it: also the tab's name, and the plain fallback's words. */
export const PHRASE_TITLE = 'Save your new recovery phrase';
export const PHRASE_ABOUT =
    'We lost the connection while making this change. If it went through, this is your new recovery phrase. Save it, then sign in.';

export type PhraseScreenProps = UnconfirmedPhrase & {
    account: { id: string; email: string };
    onDone: () => void;
};
export type HeldPhrase = Omit<PhraseScreenProps, 'onDone'> & {
    /* The screen, from the chunk that made the phrase: showing it loads nothing. */
    Screen: ComponentType<PhraseScreenProps>;
};

let held: HeldPhrase | null = null;
const listeners = new Set<() => void>();
const changed = () => {
    for (const listener of listeners) listener();
};

export function holdPhrase(value: HeldPhrase) {
    held = value;
    changed();
}

export function forgetPhrase() {
    if (!held) return;
    held = null;
    changed();
}

const heldPhrase = () => held;
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};

/* The phrase while it is held: null once its screen is left, and on the server. */
export function useHeldPhrase() {
    return useSyncExternalStore(subscribe, heldPhrase, () => null);
}
