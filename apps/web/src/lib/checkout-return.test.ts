import type { BillingSubscription } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import { CHECKOUT_SYNC_TRIES, checkoutNotice, checkoutReturn } from './checkout-return';

function subscription(overrides: Partial<BillingSubscription> = {}): BillingSubscription {
    return {
        id: 'sub_1',
        productId: 'prod_plus',
        productName: 'Plus (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 500,
        currency: 'usd',
        quotaBytes: '214748364800',
        currentPeriodEnd: '2026-11-17T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        endedAt: null,
        ...overrides,
    };
}

describe('checkoutReturn', () => {
    test('is finishing, not received, while no sync has shown a live plan', () => {
        for (const synced of [undefined, null, subscription({ endedAt: '2026-10-01T00:00:00Z' })])
            for (const tries of [0, 1, CHECKOUT_SYNC_TRIES - 1]) {
                const state = checkoutReturn({ synced, tries });
                expect(state.kind).toBe('finishing');
                expect(checkoutNotice(state).text).not.toMatch(/received/i);
            }
    });

    test('says the payment was received once a sync shows the plan live, even on the last try', () => {
        for (const tries of [1, CHECKOUT_SYNC_TRIES]) {
            const state = checkoutReturn({ synced: subscription(), tries });
            expect(state).toEqual({ kind: 'received', planName: 'Plus (monthly)' });
            expect(checkoutNotice(state).text).toBe(
                'Payment received. You’re on Plus (monthly). Thank you.',
            );
        }
    });

    test('stops at the last try and says the payment may still be processing', () => {
        // An ended subscription from before is not the new plan.
        for (const synced of [null, subscription({ endedAt: '2026-10-01T00:00:00Z' })]) {
            const state = checkoutReturn({ synced, tries: CHECKOUT_SYNC_TRIES });
            expect(state.kind).toBe('processing');
            const notice = checkoutNotice(state);
            expect(notice.tone).toBe('warning');
            expect(notice.text).toMatch(/may still be processing/);
            expect(notice.text).toMatch(/Refresh in a minute/);
            expect(notice.text).toMatch(/contact support/);
            expect(notice.text).not.toMatch(/received/i);
        }
    });
});
