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

/* A family plan: a fixed base and a per-member price beyond those included, per currency. */
export type FamilyPlan = {
    id: string;
    name: string;
    description: string | null;
    interval: 'month' | 'year';
    /* Minor units by lowercase ISO code; every plan has the provider's default currency. */
    prices: Record<string, { base: number; perMember: number }>;
    includedMembers: number;
    maxMembers: number;
    /* The family's whole pool, whatever the member count. */
    quotaBytes: string;
};

/*
 * What a family's billing page shows. Its managers and its payer get the whole
 * of it (`view: 'manage'`); any other member gets the plan's name, its state
 * and the pool (`view: 'member'`), with no plans, prices or amounts.
 */
export type GroupBillingSummary = {
    enabled: boolean;
    view: 'manage' | 'member';
    plans: FamilyPlan[];
    /* Who pays: the only person who can add or remove places, or open the portal. */
    payer: { userId: string; you: boolean } | null;
    subscription: {
        id: string;
        productId: string;
        productName: string;
        status: string;
        recurringInterval: string;
        amount: number | null;
        currency: string | null;
        units: number;
        /* Places paid for; fewer than `units` while a raise waits for the bank's confirmation. */
        paidUnits: number;
        /* A cut to this many places at the period's end; it already blocks new admissions. */
        pendingUnits: number | null;
        includedMembers: number;
        quotaBytes: string;
        /* With the end, what a raise is prorated over: the web quotes it with `quoteUnitsChange`. */
        currentPeriodStart: string;
        currentPeriodEnd: string;
        cancelAtPeriodEnd: boolean;
    } | null;
    /*
     * The plan the family had last, once none is live: it ran out or was
     * cancelled. Null while a plan is live, and for a family that never had one.
     */
    lastPlan: { productName: string; endedAt: string } | null;
    /* The family's storage pool: every family folder's bytes against the plan's size. */
    storage: { usedBytes: string; quotaBytes: string } | null;
    seats: { used: number; limit: number };
    /*
     * What one more place costs now, before tax: the rest of this period at
     * the per-member price, truncated to the minor unit as Polar charges it.
     */
    nextPlace: { amount: number; currency: string } | null;
};

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

/* A family's plan (`/api/billing/groups/:id`); only its payer changes it. */
export interface GroupBillingApi {
    summary(groupId: string): Promise<GroupBillingSummary>;
    /* Polar's hosted checkout; whoever starts it becomes the family's payer. */
    checkout(groupId: string, productId: string, currency?: string): Promise<{ url: string }>;
    /*
     * More places are charged at once; fewer are scheduled for the period's
     * end. `url` is the portal when the bank wants the payer to confirm.
     */
    setUnits(
        groupId: string,
        units: number,
    ): Promise<{ billing: GroupBillingSummary; url: string | null; confirmPayment?: true }>;
    portal(groupId: string): Promise<{ url: string }>;
    sync(groupId: string): Promise<GroupBillingSummary>;
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
