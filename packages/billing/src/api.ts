import type { CancellationReason } from './protocol';

/*
 * What the billing pages need from the server. The web app implements it from
 * the same Eden Treaty client as the auth contract, so a changed route shows up
 * in its typecheck.
 */
export type Plan = {
    id: string;
    name: string;
    description: string | null;
    interval: 'month' | 'year';
    /* The price in the provider's default currency, minor units. */
    amount: number;
    currency: string;
    /* Every currency the plan is priced in, minor units by lowercase ISO code. */
    prices: Record<string, number>;
    quotaBytes: string;
    recommended: boolean;
};

export type Catalogue = { enabled: boolean; freeQuotaBytes: string; plans: Plan[] };

export type BillingSubscription = {
    id: string;
    productId: string;
    productName: string;
    status: string;
    recurringInterval: string;
    /* What the person actually pays, in the currency the checkout settled on. */
    amount: number | null;
    currency: string | null;
    quotaBytes: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    endedAt: string | null;
};

export type BillingSummary = {
    enabled: boolean;
    hasCustomer: boolean;
    subscription: BillingSubscription | null;
    /* A plan chosen at signup and not yet taken to checkout. */
    intendedPlan: string | null;
};

export interface BillingApi {
    catalogue(): Promise<Catalogue>;
    summary(): Promise<BillingSummary>;
    /* `url` is Polar's checkout, or its portal when a switch needs the bank's confirmation. */
    checkout(
        productId: string,
        currency?: string,
    ): Promise<{ url: string | null; confirmPayment?: boolean }>;
    portal(): Promise<{ url: string }>;
    sync(): Promise<BillingSummary>;
    cancel(input: { reason?: CancellationReason; comment?: string }): Promise<BillingSummary>;
    resume(): Promise<BillingSummary>;
}
