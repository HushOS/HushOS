import type { BillingSubscription } from '@hushos/billing/api';

/*
 * Back from Polar's checkout the plan is not live yet: the webhook is usually
 * ahead of the browser, but not always. The page asks the server to re-read
 * Polar every five seconds, six times at most (about half a minute), and
 * calls the payment received only once a sync shows the plan active or in its
 * trial. A plan that is past due or unpaid exists but has not been paid for.
 * The server allows ten syncs a person every ten minutes; once it refuses one,
 * asking again is pointless, so the page stops and says it may be processing.
 * Six leaves four of those ten for a refresh.
 */
export const CHECKOUT_SYNC_TRIES = 6;
export const CHECKOUT_SYNC_INTERVAL_MS = 5_000;

export type CheckoutReturn =
    | { kind: 'finishing' }
    | { kind: 'received'; planName: string }
    | { kind: 'processing' };

const PAID = new Set(['active', 'trialing']);

/*
 * What a sync last said, how many have been asked for (answered or failed), and
 * whether the server refused one for too many refreshes.
 */
export function checkoutReturn(input: {
    synced: BillingSubscription | null | undefined;
    tries: number;
    limited?: boolean;
}): CheckoutReturn {
    const { synced, tries, limited = false } = input;
    if (synced && !synced.endedAt && PAID.has(synced.status))
        return { kind: 'received', planName: synced.productName };
    return limited || tries >= CHECKOUT_SYNC_TRIES ? { kind: 'processing' } : { kind: 'finishing' };
}

/* A sync the server refused for too many refreshes: the payment may still be processing, not failed. */
export function isRateLimited(error: unknown) {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'rate-limited'
    );
}

export const SUPPORT_LABEL = 'contact support';

export function checkoutNotice(state: CheckoutReturn) {
    switch (state.kind) {
        case 'finishing':
            return { tone: 'info' as const, busy: true, text: 'Finishing your payment…' };
        case 'received':
            return {
                tone: 'success' as const,
                text: `Payment received. You’re on ${state.planName}. Thank you.`,
            };
        case 'processing':
            return {
                tone: 'warning' as const,
                text: `Your payment may still be processing. Refresh in a minute. If your plan doesn’t appear, ${SUPPORT_LABEL}.`,
            };
    }
}
