import type { UnconfirmedPhrase } from '@hushos/auth/client';
import { useSyncExternalStore } from 'react';

/*
 * A new recovery phrase from a change whose reply never arrived (docs/two-step-design.md 4,
 * "When the reply is lost"), on its way from the dialog that made it to the page that shows
 * it (/new-phrase). The person is signed out by then, so the server cannot serve it again:
 * this is the only copy. It is held here, in this tab's memory, and nowhere else: not in the
 * URL, the history entry, storage or a query cache, so a reload, a closed tab or leaving the
 * page ends it.
 */
export type HeldPhrase = UnconfirmedPhrase & { account: { id: string; email: string } };

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

export const heldPhrase = () => held;

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};

/* The phrase while it is held: null once the page showing it is left, and on the server. */
export function useHeldPhrase() {
    return useSyncExternalStore(subscribe, heldPhrase, () => null);
}
