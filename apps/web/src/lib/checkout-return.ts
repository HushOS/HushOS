import type { BillingSubscription } from '@hushos/billing/api';

/*
 * Back from Polar's checkout the plan is not live yet: the webhook is usually
 * ahead of the browser, but not always. The page asks the server to re-read
 * Polar every three seconds, ten times at most (about half a minute), and
 * calls the payment received only once a sync shows the plan live.
 */
export const CHECKOUT_SYNC_TRIES = 10;
export const CHECKOUT_SYNC_INTERVAL_MS = 3_000;

export type CheckoutReturn =
    | { kind: 'finishing' }
    | { kind: 'received'; planName: string }
    | { kind: 'processing' };

/* What a sync last said, and how many have been asked for (answered or failed). */
export function checkoutReturn(input: {
    synced: BillingSubscription | null | undefined;
    tries: number;
}): CheckoutReturn {
    const { synced, tries } = input;
    if (synced && !synced.endedAt) return { kind: 'received', planName: synced.productName };
    return tries >= CHECKOUT_SYNC_TRIES ? { kind: 'processing' } : { kind: 'finishing' };
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
