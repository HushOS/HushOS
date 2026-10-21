import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useSyncExternalStore } from 'react';
import { afterMembershipChange } from '@/lib/families';
import { usePageRestored } from '@/lib/page-restore';

/*
 * Create and pay (docs/families-shared-pool.md 7.4): a family is made, then the browser leaves
 * for Polar's checkout. Two things hold across that.
 *
 * While it opens (`opening`, this page only): the family exists, but the page under the dialog
 * goes on showing what it showed (Plans its family tiers, Account → Family "no family"), whatever
 * reads the families again meanwhile (a focus, a poll, another invalidation). Otherwise the
 * page swaps, the dialog unmounts in the middle of "Creating…", and Choose a plan is offered
 * while the first checkout is about to open.
 *
 * Once it has left (`left`, this tab's sessionStorage, so a reload sees it too): Back from the
 * checkout goes on to the family's page, where Choose a plan is, whether the browser restores
 * the page from its back-forward cache or loads it again. The address is never touched before
 * leaving: the router follows every history change, and would start moving the page.
 */

type Opening = { userId: string };
let opening: Opening | null = null;
const listeners = new Set<() => void>();
const changed = () => {
    for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export function checkoutOpening(userId: string) {
    opening = { userId };
    changed();
}

export function checkoutNotOpening() {
    if (!opening) return;
    opening = null;
    changed();
}

/* Whether a family is being made and its checkout opened for `userId` on this page. */
export function useCheckoutOpening(userId: string | undefined) {
    return useSyncExternalStore(
        subscribe,
        () => Boolean(userId) && opening?.userId === userId,
        () => false,
    );
}

const KEY = 'hushos.family-checkout';
/* Long enough for a checkout, short enough that a tab used for something else isn't redirected. */
const FRESH_MS = 60 * 60 * 1000;
let leftHere: { userId: string; at: number } | null = null;

/* Just before the browser leaves for the checkout. */
export function leftForCheckout(userId: string) {
    leftHere = { userId, at: Date.now() };
    try {
        sessionStorage.setItem(KEY, JSON.stringify(leftHere));
    } catch {
        // Private windows can refuse storage: a restore from the cache still has `leftHere`.
    }
}

/* Whether Back from the checkout brought `userId` here, read once: it is forgotten as it's read. */
export function takeBackFromCheckout(userId: string) {
    let mark = leftHere;
    leftHere = null;
    try {
        const stored = sessionStorage.getItem(KEY);
        sessionStorage.removeItem(KEY);
        if (!mark && stored) mark = JSON.parse(stored) as typeof leftHere;
    } catch {
        // Nothing stored, or nothing readable: only this page's own mark counts.
    }
    return Boolean(
        mark &&
        mark.userId === userId &&
        typeof mark.at === 'number' &&
        Date.now() - mark.at < FRESH_MS,
    );
}

/*
 * On the pages a checkout leaves from (Plans, Account → Family), as they load and as the browser
 * restores them: back from a family's checkout, go on to the family's page, read afresh.
 * `stay`: this already is that page (Account → Family with nothing chosen, or the checkout's
 * own return with its `checkout_id`), so the mark is only forgotten and the family read again.
 */
export function useBackFromCheckout(userId: string | undefined, { stay = false } = {}) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const goOn = () => {
        if (!userId || !takeBackFromCheckout(userId)) return;
        checkoutNotOpening();
        const fresh = afterMembershipChange(queryClient, userId);
        if (!stay)
            void fresh.then(() => navigate({ to: '/app/family', search: {}, replace: true }));
    };
    useEffect(goOn, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
    usePageRestored(goOn);
}
