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

/* Referrals: a person's invite, and what it has earned. */
/* One kind of reward: how much has been earned, per event, and at most. */
export type RewardTotals = { count: number; bytes: string; bonusBytes: string; capBytes: string };

export type ReferralSummary = {
    code: string;
    /* The invite link, absolute. */
    url: string;
    joined: number;
    /* Storage earned when invited accounts were set up. */
    signup: RewardTotals;
    /* Storage earned when invited accounts first paid for a plan. */
    paid: RewardTotals;
    /* For a creator with an affiliate record: their code, sign-ups and earnings. */
    affiliate: AffiliateView | null;
};

export type EarningTotals = Record<string, { unpaid: number; paid: number }>;

export type AffiliateView = {
    id: string;
    name: string;
    slug: string;
    code: string;
    url: string;
    percentOff: number;
    duration: 'once' | 'forever' | 'repeating';
    durationMonths: number | null;
    commissionBps: number;
    active: boolean;
    userId: string | null;
    notes: string | null;
    providerDiscountId: string | null;
    createdAt: string;
    stats: { signups: number; orders: number; earnings: EarningTotals };
};

export type AffiliateInput = {
    name: string;
    slug: string;
    code: string;
    percentOff: number;
    duration: 'once' | 'forever' | 'repeating';
    durationMonths?: number | null;
    commissionBps: number;
    userEmail?: string | null;
    notes?: string | null;
};

/* What a landing page shows: the offer, and the plans with the discount applied. */
/* What a discount does: a share of the price, or an amount in one currency, for how long. */
export type DiscountTerms =
    | {
          type: 'percentage';
          percentOff: number;
          duration: 'once' | 'forever' | 'repeating';
          durationMonths: number | null;
      }
    | {
          type: 'fixed';
          amount: number;
          currency: string;
          duration: 'once' | 'forever' | 'repeating';
          durationMonths: number | null;
      };

/*
 * A page at /go/<slug>: a creator's (their slug or code), or a code the
 * operator made at Polar and shared as a link. Either way, signing up from it
 * carries the code to checkout.
 */
export type OfferLanding = {
    kind: 'affiliate' | 'code';
    /* The creator's name, or the discount's name at the provider. */
    name: string;
    code: string;
    terms: DiscountTerms;
    endsAt: string | null;
    /* Plans the offer is limited to, by product id; empty means every paid plan. */
    productIds: string[];
    catalogue: Catalogue;
};

export type ReferralLanding = {
    inviter: string;
    bonusBytes: string;
    paidBonusBytes: string;
    freeBytes: string;
};

export interface GrowthApi {
    referrals(): Promise<ReferralSummary>;
    /* Keeps an offer's code for the signed-in person's next checkout. */
    rememberCoupon(code: string): Promise<{ code: string }>;
    listAffiliates(): Promise<AffiliateView[]>;
    createAffiliate(input: AffiliateInput): Promise<AffiliateView>;
    updateAffiliate(
        id: string,
        patch: Partial<AffiliateInput> & { active?: boolean },
    ): Promise<AffiliateView>;
    deleteAffiliate(id: string): Promise<{ deleted: true }>;
    markAffiliatePaid(id: string): Promise<{ paid: number }>;
}

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
