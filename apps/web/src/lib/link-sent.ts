/*
 * The address a sign-up or password-reset link was sent to, kept for this tab
 * only (sessionStorage), so "Check your inbox" can name it and send another
 * link; it never goes in the URL. It goes once a link is used, in this tab or
 * in another one the email opened (they hear of it on a BroadcastChannel), and
 * at sign-out (lib/device-data.ts).
 */

export const LINK_SENT_KEY = 'hushos-link-sent';
const CHANNEL = 'hushos-link-used';

const listeners = new Set<() => void>();
const changed = () => {
    for (const listener of listeners) listener();
};

function channel() {
    try {
        return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    } catch {
        return null;
    }
}

function drop() {
    try {
        sessionStorage.removeItem(LINK_SENT_KEY);
    } catch {
        /* Nothing kept. */
    }
    changed();
}

export function rememberSent(value: unknown) {
    try {
        sessionStorage.setItem(LINK_SENT_KEY, JSON.stringify(value));
    } catch {
        /* Without storage the inbox page just says "your inbox". */
    }
    changed();
}

export function readSent(): string | null {
    try {
        return sessionStorage.getItem(LINK_SENT_KEY);
    } catch {
        return null;
    }
}

/* A link was used: the address goes here and in every other tab of this browser. */
export function forgetSent() {
    drop();
    const sender = channel();
    try {
        sender?.postMessage('used');
    } catch {
        /* Other tabs keep theirs until they close or sign out. */
    } finally {
        sender?.close();
    }
}

// Any tab that ever showed the sign-up or reset form hears a link used elsewhere, wherever it is now.
if (typeof window !== 'undefined') {
    const receiver = channel();
    if (receiver) receiver.onmessage = () => drop();
}

/* For useSyncExternalStore: the inbox page follows a link used in another tab. */
export function subscribeSent(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}
