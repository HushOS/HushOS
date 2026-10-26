import type { CancellationReason, FamilyTier } from './protocol';

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

/*
 * The public plan catalogue. `families` lists the family plans only where
 * this server serves families (GROUPS_ENABLED) and sells plans; it is empty
 * everywhere else, so a page cannot offer a plan the server would refuse.
 */
export type Catalogue = {
    enabled: boolean;
    freeQuotaBytes: string;
    plans: Plan[];
    families: FamilyPlan[];
};

/* A family plan: a fixed base and a per-member price beyond those included, per currency. */
export type FamilyPlan = {
    id: string;
    name: string;
    description: string | null;
    interval: 'month' | 'year';
    /* Family Plus, Pro or Max (`hushos_tier`); null for the single Family plan before the tiers. */
    tier: FamilyTier | null;
    /* The tier the pages lead with (`hushos_recommended`). */
    recommended: boolean;
    /* Minor units by lowercase ISO code; every plan has the provider's default currency. */
    prices: Record<string, { base: number; perMember: number }>;
    includedMembers: number;
    maxMembers: number;
    /* The family's whole pool, whatever the member count. */
    quotaBytes: string;
};

/*
 * What a family's billing page shows. Its `billing` holders and its payer get
 * the whole of it (`view: 'manage'`); any other member, a manager without
 * `billing` included, gets `FamilyPlanGlance`.
 */
export type GroupBillingSummary = FamilyBillingDetail | FamilyPlanGlance;

/*
 * A family plan Polar still holds that gives nothing, shown while no plan is live: its
 * payment didn't go through (`unpaid`, `incomplete`: `payment-failed`) or it is paused.
 * The pool and the extra places are gone meanwhile (docs/groups-design.md 3.5); a new
 * checkout ends it first. Absent from servers before this field.
 */
export type FamilyLapsedPlan = {
    productName: string;
    standing: 'payment-failed' | 'paused';
    /* Every such plan of the family (subscription ids): what a confirmed checkout ends. */
    ids: string[];
};

/* The lapsed plan as a member's glance carries it: no ids, and whether this person pays for it. */
export type FamilyLapsedGlance = {
    productName: string;
    standing: 'payment-failed' | 'paused';
    /* This person pays for it: it ends at once when they leave. */
    youPay: boolean;
    /* Only for the person who pays: every such plan's id, to confirm the leave by. */
    ids?: string[];
};

/*
 * A member's view: the plan's name, the storage used and the pool's size,
 * and whether a plan is live at all, which is what keeps inviting, letting
 * people in and new family folders shut (the server refuses them anyway). No
 * prices, places, payer or state of the subscription.
 */
export type FamilyPlanGlance = {
    enabled: boolean;
    view: 'member';
    hasPlan: boolean;
    planName: string | null;
    /* While no plan is live: one Polar still holds whose payment failed, or that is paused. */
    lapsedPlan?: FamilyLapsedGlance | null;
    storage: { usedBytes: string; quotaBytes: string } | null;
    /* Absent with billing off. */
    usage?: FamilyUsage;
};

/*
 * Who stores what in the family's pool (docs/families-shared-pool.md 3.9). Every
 * figure but the caller's own is rounded on the server, so no other member's
 * exact usage reaches the browser.
 */
export type FamilyUsage = {
    /* The caller's own files (My files, its Trash and older versions), exact; null if not a member. */
    ownBytes: string | null;
    /* Every family folder together, in whole GiB rounded up. */
    foldersBytes: string;
    /*
     * For the organizer and every `members` or `billing` holder only (null for anyone
     * else): each active member's own files in whole GiB, rounded up, largest first;
     * "0" is anything under 1 GiB ("Under 1 GB"). Never names, counts or contents.
     */
    members: { userId: string; ownBytesRounded: string }[] | null;
};

export type FamilyBillingDetail = {
    enabled: boolean;
    view: 'manage';
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
        /* A smaller tier the family moves to at the period's end (a plan change at renewal). */
        pendingProductId: string | null;
        /*
         * The tier paid for: the product of the newest paid order. Another than `productId`
         * while an upgrade's charge waits for the bank (the family keeps this tier's pool, as
         * `storage` shows), and null while nothing is paid.
         */
        paidProductId: string | null;
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
    /*
     * While no plan is live: one Polar still holds whose payment failed, or that is paused.
     * The page shows it in place of `lastPlan`; choosing a plan ends it first.
     */
    lapsedPlan?: FamilyLapsedPlan | null;
    /*
     * The family's storage pool as Drive reads it: every family folder's bytes
     * against the pool's size (zero once a plan has ended). Null for a family
     * with no pool, made before this server sold plans and never on one: its
     * folders keep their own allowance.
     */
    storage: { usedBytes: string; quotaBytes: string } | null;
    /* Absent with billing off. */
    usage?: FamilyUsage;
    seats: { used: number; limit: number };
    /*
     * What one more place costs now, before tax and any discount: the rest of
     * this period at the per-member price, truncated to the minor unit as
     * Polar charges it.
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
    /*
     * The family whose plan this person's storage comes from, while their own
     * files draw from its pool; no personal plan can be bought meanwhile.
     */
    family: { name: string; planName: string | null } | null;
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
    /*
     * `endLapsed`: the lapsed plans (subscription ids, `FamilyLapsedPlan.ids`) the person
     * confirmed end now. Unless they are exactly the family's, it is refused with code
     * `ends-lapsed` and nothing is ended.
     */
    checkout(
        groupId: string,
        productId: string,
        currency?: string,
        endLapsed?: string[],
    ): Promise<{ url: string }>;
    /*
     * More places are charged at once; fewer are scheduled for the period's
     * end. `url` is the portal when the bank wants the payer to confirm.
     */
    setUnits(
        groupId: string,
        units: number,
    ): Promise<{ billing: GroupBillingSummary; url: string | null; confirmPayment?: true }>;
    /*
     * Moves the family to another tier of the same billing period: a bigger
     * one now, charged prorated; a smaller one at the period's end; its own
     * tier withdraws a scheduled move. `url` is the portal when the bank wants
     * the payer to confirm the charge.
     */
    changePlan(
        groupId: string,
        productId: string,
    ): Promise<{
        billing: GroupBillingSummary;
        url: string | null;
        confirmPayment?: true;
        when: 'now' | 'renewal' | 'kept';
    }>;
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
