import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FamilyBilling } from '@/lib/family-billing';

/*
 * After a declined charge the payer is offered Card and invoices beside the retry. Closed while
 * that portal is still opening, the dialog must open again with its retry pressable: the
 * button that was opening went with the dialog, and nothing else would ever let it go.
 */

const declined = Object.assign(
    new Error(
        'Your bank declined this charge. Nothing was charged and no places were added. Try another card in Card and invoices, or ask your bank.',
    ),
    { code: 'declined' },
);
const setUnits = vi.fn(async (..._args: unknown[]): Promise<never> => {
    throw declined;
});
const changePlan = vi.fn(async (..._args: unknown[]): Promise<never> => {
    throw declined;
});
// Polar's portal address never comes back while the test looks.
const portal = vi.fn((..._args: unknown[]) => new Promise<{ url: string }>(() => {}));
vi.mock('@/lib/billing-api', () => ({
    groupBillingApi: {
        setUnits: (...args: unknown[]) => setUnits(...args),
        changePlan: (...args: unknown[]) => changePlan(...args),
        portal: (...args: unknown[]) => portal(...args),
    },
    billingApi: {},
}));
// The other summaries the section reads (the person's own plan and storage, the family): never
// fetched here, as the client's queries never run.
const idle = (...key: unknown[]) => ({ queryKey: key, queryFn: () => new Promise(() => {}) });
vi.mock('@/lib/billing', () => ({
    billingQueryOptions: idle('billing'),
    localeHintQueryOptions: idle('locale-hint'),
}));
vi.mock('@/lib/queries', () => ({ storageQueryOptions: idle('storage') }));
vi.mock('@/lib/families', () => ({
    familyQueryOptions: (userId: string, groupId: string) => idle('family', userId, groupId),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { add: vi.fn() } }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { FamilyPlan } = await import('./family-billing');
const { familyBillingQueryOptions } = await import('@/lib/family-billing');

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const tier = (key: 'plus' | 'pro' | 'max', label: string, gib: number, base: number) => ({
    id: `${key}-month`,
    name: `Family ${label} (monthly)`,
    description: null,
    interval: 'month' as const,
    tier: key,
    recommended: key === 'pro',
    prices: { usd: { base, perMember: 150 } },
    includedMembers: 4,
    maxMembers: 20,
    quotaBytes: String(gib * GB),
});

const summary: FamilyBilling = {
    enabled: true,
    view: 'manage',
    plans: [
        tier('plus', 'Plus', 800, 1000),
        tier('pro', 'Pro', 2048, 2000),
        tier('max', 'Max', 4096, 3000),
    ],
    payer: { userId: 'payer', you: true },
    subscription: {
        id: 'sub',
        productId: 'pro-month',
        productName: 'Family Pro (monthly)',
        status: 'active',
        recurringInterval: 'month',
        amount: 2600,
        currency: 'usd',
        units: 8,
        paidUnits: 8,
        pendingUnits: null,
        pendingProductId: null,
        paidProductId: 'pro-month',
        includedMembers: 4,
        quotaBytes: String(2048 * GB),
        currentPeriodStart: new Date(Date.now() - 11 * DAY).toISOString(),
        currentPeriodEnd: new Date(Date.now() + 20 * DAY).toISOString(),
        cancelAtPeriodEnd: false,
    },
    lastPlan: null,
    storage: { usedBytes: String(300 * GB), quotaBytes: String(2048 * GB) },
    usage: { ownBytes: '0', foldersBytes: String(300 * GB), members: [] },
    seats: { used: 6, limit: 8 },
    nextPlace: { amount: 96, currency: 'usd' },
};

function renderBilling() {
    const client = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    client.setQueryData(familyBillingQueryOptions('payer', 'g').queryKey, summary);
    render(
        <QueryClientProvider client={client}>
            <FamilyPlan
                place="bottom"
                userId="payer"
                groupId="g"
                family="Holm family"
                roles={['organizer', 'billing']}
                onCheckoutSeen={() => {}}
            />
        </QueryClientProvider>,
    );
}

describe('Card and invoices after a declined charge', () => {
    beforeEach(() => {
        setUnits.mockClear();
        changePlan.mockClear();
        portal.mockClear();
    });

    test.each([
        { opens: 'Add places', retry: 'Add 1 place' },
        { opens: 'Change plan', retry: 'Change to Family Max' },
    ])(
        '$opens closed while the portal opens comes back with its retry pressable',
        async ({ opens, retry }) => {
            const user = userEvent.setup();
            renderBilling();
            await user.click(screen.getByRole('button', { name: opens }));
            let dialog = await screen.findByRole('dialog', { name: opens });
            await user.click(within(dialog).getByRole('button', { name: retry }));
            const card = await within(dialog).findByRole('button', { name: /^Card and invoices/ });
            await user.click(card);
            expect(portal).toHaveBeenCalledWith('g');
            await within(dialog).findByRole('button', { name: /^Opening/ });
            await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

            await user.click(screen.getByRole('button', { name: opens }));
            dialog = await screen.findByRole('dialog', { name: opens });
            expect(within(dialog).getByRole('button', { name: retry })).toBeEnabled();
            expect(within(dialog).queryByRole('button', { name: /^Card and invoices/ })).toBeNull();
        },
    );
});
