import type { BillingSubscription } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import { unwrap } from './api-client';
import {
    CHECKOUT_SYNC_TRIES,
    checkoutNotice,
    checkoutReturn,
    isRateLimited,
} from './checkout-return';

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

/* A plan that exists at Polar but has not been paid for, or is the old one. */
const unpaid = [
    subscription({ status: 'past_due' }),
    subscription({ status: 'unpaid' }),
    subscription({ status: 'incomplete' }),
    subscription({ endedAt: '2026-10-01T00:00:00Z' }),
];

describe('checkoutReturn', () => {
    test('is finishing, not received, while no sync has shown a paid plan', () => {
        for (const synced of [undefined, null, ...unpaid])
            for (const tries of [0, 1, CHECKOUT_SYNC_TRIES - 1]) {
                const state = checkoutReturn({ synced, tries });
                expect(state.kind, synced?.status).toBe('finishing');
                expect(checkoutNotice(state).text).not.toMatch(/received/i);
            }
    });

    test('says the payment was received for an active or trialing plan, naming that plan, even on the last try', () => {
        for (const status of ['active', 'trialing'])
            for (const tries of [1, CHECKOUT_SYNC_TRIES]) {
                const synced = subscription({ status, productName: 'Max (yearly)' });
                const state = checkoutReturn({ synced, tries });
                expect(state, status).toEqual({ kind: 'received', planName: 'Max (yearly)' });
                const notice = checkoutNotice(state);
                expect(notice.tone).toBe('success');
                expect(notice.text).toMatch(/received/i);
                expect(notice.text).toContain('Max (yearly)');
            }
    });

    test('stops at the last try and says the payment may still be processing', () => {
        for (const synced of [null, ...unpaid]) {
            const state = checkoutReturn({ synced, tries: CHECKOUT_SYNC_TRIES });
            expect(state.kind, synced?.status).toBe('processing');
            const notice = checkoutNotice(state);
            expect(notice.tone).toBe('warning');
            expect(notice.text).toMatch(/may still be processing/);
            expect(notice.text).toMatch(/contact support/);
            expect(notice.text).not.toMatch(/received/i);
        }
    });

    test('gives up after six syncs, leaving a refresh room in the server’s ten every ten minutes', () => {
        expect(checkoutReturn({ synced: null, tries: 5 }).kind).toBe('finishing');
        expect(checkoutReturn({ synced: null, tries: 6 }).kind).toBe('processing');
    });

    test('a sync refused for too many refreshes stops at once and says processing, not failed', () => {
        for (const tries of [0, 1, CHECKOUT_SYNC_TRIES - 1]) {
            const state = checkoutReturn({ synced: null, tries, limited: true });
            expect(state.kind).toBe('processing');
            expect(checkoutNotice(state).tone).toBe('warning');
        }
        // A plan an earlier sync showed paid is still received.
        expect(checkoutReturn({ synced: subscription(), tries: 2, limited: true }).kind).toBe(
            'received',
        );
    });

    test('only the server’s rate-limited refusal counts as one, as it reaches the page', async () => {
        const refusal = (status: number, value: unknown) =>
            unwrap(Promise.resolve({ data: null, error: { status, value } })).catch(
                (error: unknown) => error,
            );
        expect(
            isRateLimited(
                await refusal(429, { message: 'Too many refreshes.', code: 'rate-limited' }),
            ),
        ).toBe(true);
        expect(isRateLimited(await refusal(503, { message: 'Billing is unavailable.' }))).toBe(
            false,
        );
        expect(isRateLimited(await refusal(401, { message: 'Sign in.', code: 'signed-out' }))).toBe(
            false,
        );
        expect(isRateLimited(new TypeError('Failed to fetch'))).toBe(false);
    });
});
