import type {
    FamilyBillingDetail,
    FamilyPlan,
    FamilyPlanGlance,
    GroupBillingSummary,
} from '@hushos/billing/api';
import {
    DEFAULT_CURRENCY,
    FAMILY_MAX_MEMBERS,
    MAX_MEMBERS_PER_RAISE,
    quoteTierChange,
    quoteUnitsChange,
    spaceOf,
} from '@hushos/billing/protocol';
import { queryOptions } from '@tanstack/react-query';
import { groupBillingApi } from '@/lib/billing-api';
import { familyKeys } from '@/lib/families-shell';

/*
 * What a family's Billing section shows and offers (docs/groups-design.md
 * 3.5), worked out from the server's summary and the viewer's roles. Pure, so
 * the money it shows and who may act on it are tested without a page: a raise
 * is quoted with the server's own `quoteUnitsChange`, truncated as Polar
 * charges it, and every action mirrors a refusal the server would give.
 */

export type FamilyBilling = GroupBillingSummary;
/* The priced summary a payer or `billing` holder gets; members get a FamilyPlanGlance. */
export type FamilyBillingFull = FamilyBillingDetail;
export type FamilyGlance = FamilyPlanGlance;
export type FamilySubscription = NonNullable<FamilyBillingDetail['subscription']>;

/* The family's plan, read once per page. Members' own refetches keep it current. */
export const familyBillingQueryOptions = (userId: string, groupId: string) =>
    queryOptions({
        queryKey: [...familyKeys.family(userId, groupId), 'billing'] as const,
        queryFn: () => groupBillingApi.summary(groupId),
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: 1,
    });

export type PlanState =
    /* The server sells no plans: nothing is gated and no section shows. */
    | { kind: 'off' }
    /* Never paid for: the "Choose a plan" step. */
    | { kind: 'none' }
    /* A plan ran out or was cancelled, and nothing has replaced it. */
    | { kind: 'lapsed'; productName: string; endedAt: string }
    | {
          kind: 'live';
          subscription: FamilySubscription;
          /* Cancelled: it runs to the period's end, then stops. */
          ending: boolean;
          /* A renewal the bank refused, being retried. */
          overdue: boolean;
      };

export function planState(summary: FamilyBillingFull): PlanState {
    if (!summary.enabled) return { kind: 'off' };
    const live = summary.subscription;
    if (live)
        return {
            kind: 'live',
            subscription: live,
            ending: live.cancelAtPeriodEnd,
            overdue: live.status === 'past_due',
        };
    if (summary.lastPlan) return { kind: 'lapsed', ...summary.lastPlan };
    return { kind: 'none' };
}

/*
 * A renewal the bank refused, and this person pays: then Manage payment and invoices is the
 * family page's one blue button, and Invite someone steps back to outline.
 */
export function paymentNeedsYou(summary: FamilyBilling | undefined) {
    return Boolean(
        summary?.enabled &&
        summary.view === 'manage' &&
        summary.payer?.you &&
        summary.subscription?.status === 'past_due',
    );
}

/*
 * Whether inviting and new family folders wait for a plan: with billing on
 * and none live, nobody can be let in and the pool is empty. Unknown (still
 * loading, or unreadable) is not "no": the actions stay hidden until the
 * summary says, and the server refuses an admission without a place anyway.
 */
export function needsPlan(summary: FamilyBilling | undefined) {
    if (!summary) return true;
    if (!summary.enabled) return false;
    return summary.view === 'member' ? !summary.hasPlan : summary.subscription === null;
}

/*
 * The places every surface shows (the page header, Billing, Let them in):
 * where plans are sold, the paid limit from the billing summary, which the
 * server works out from the live plan (bought, paid for, and any cut already
 * scheduled); elsewhere, the family's own seat limit. One source, so the
 * header can never say 6 while Billing says 8.
 */
export function placesOf(
    familySeats: { used: number; limit: number } | undefined,
    summary: FamilyBilling | undefined,
) {
    // A member's glance carries no places: the family's row, which billing writes from the same plan.
    if (summary?.enabled && summary.view === 'manage') return summary.seats;
    return familySeats ?? null;
}

/*
 * Said everywhere a family price or charge is shown: Polar adds tax on top.
 * Amounts after checkout are list prices: the summary carries no discount, so
 * a discounted family is told the figure is before it, never a wrong total.
 */
export { TAX_LINE } from '@/lib/plans';
export const TAX_ON_CHARGES =
    'Before any discount. Plus tax where it applies; Polar adds it to each charge.';

/*
 * How much of the plan this person sees: the payer, a `billing` holder, or
 * anyone else, who gets the server's glance (the plan's name and the storage).
 */
export type BillingAccess = 'payer' | 'billing' | 'glance';

export function billingAccess(summary: FamilyBilling): BillingAccess {
    if (summary.view !== 'manage') return 'glance';
    return summary.payer?.you ? 'payer' : 'billing';
}

/* The plan the family is on, from the catalogue; absent when it was archived or edited away. */
export function currentPlan(summary: FamilyBillingFull): FamilyPlan | undefined {
    const live = summary.subscription;
    return live ? summary.plans.find((plan) => plan.id === live.productId) : undefined;
}

const maxMembersOf = (summary: FamilyBillingFull) =>
    currentPlan(summary)?.maxMembers ?? FAMILY_MAX_MEMBERS;

/* Fewer places than this the family can't have: its members, and what the plan includes. */
export function placesFloor(summary: FamilyBillingFull) {
    const live = summary.subscription;
    return Math.max(live?.includedMembers ?? 0, summary.seats.used);
}

/*
 * How many places one "Add places" may add: at least one, at most the
 * server's step, never past the family maximum. Null when none can be added.
 */
export function addRange(summary: FamilyBillingFull) {
    const live = summary.subscription;
    if (!live) return null;
    const max = Math.min(MAX_MEMBERS_PER_RAISE, maxMembersOf(summary) - live.units);
    return max >= 1 ? { min: 1, max } : null;
}

/*
 * The places the family may have from the renewal: down to its floor, below
 * what it has now. Null when there is nothing to remove.
 */
export function removeRange(summary: FamilyBillingFull) {
    const live = summary.subscription;
    if (!live) return null;
    const min = placesFloor(summary);
    const max = live.units - 1;
    return max >= min ? { min, max } : null;
}

/* The plan's prices in the currency the family pays in. */
export function livePrice(summary: FamilyBillingFull) {
    const live = summary.subscription;
    const plan = currentPlan(summary);
    if (!live?.currency || !plan) return null;
    const price = plan.prices[live.currency];
    return price ? { ...price, currency: live.currency } : null;
}

/*
 * What adding `add` places costs now, before tax: the rest of this period at
 * the per-member rate, over the places past those included, truncated once
 * over the whole raise as Polar charges it (two places at 199.98 each is 399,
 * not 2 × 199). Null when it can't be quoted (no price in that currency).
 */
export function quoteAdd(summary: FamilyBillingFull, add: number, now = new Date()) {
    const live = summary.subscription;
    const price = livePrice(summary);
    if (!live || !price) return null;
    return {
        amount: quoteUnitsChange({
            perMember: price.perMember,
            includedMembers: live.includedMembers,
            fromUnits: live.units,
            toUnits: live.units + add,
            periodStart: new Date(live.currentPeriodStart),
            periodEnd: new Date(live.currentPeriodEnd),
            now,
        }),
        currency: price.currency,
    };
}

/*
 * What the family pays a period on its own tier, when that differs from the list: a family
 * that signed up before a price change keeps its old price (Polar keeps it on the
 * subscription), so the catalogue's list price would quote charges it will never see. Its
 * base is the subscription's amount less the places past those included at the per-member
 * rate. Polar's amount is after any discount, which only ever lowers it, so an amount above
 * the list can only be an older, dearer price and is taken as paid; one at or below the list
 * may be a discount, and the list stands, as the page says ("Before any discount"). Null
 * when the list is what applies.
 */
export function paidPrice(summary: FamilyBillingFull) {
    const live = summary.subscription;
    const price = livePrice(summary);
    if (!live || !price || live.amount == null || live.currency !== price.currency) return null;
    const billable = Math.max(0, live.units - live.includedMembers);
    const list = price.base + price.perMember * billable;
    if (live.amount <= list) return null;
    return { total: live.amount, base: live.amount - price.perMember * billable };
}

/*
 * What a period with `units` places charges: the base and the per-member rate
 * for each place past those included, on the family's plan or on `plan` (a
 * tier it may move to). The family's own tier at the base it pays (paidPrice),
 * any other at list price: a move to another tier is charged at its price now.
 * The same prices the raise is quoted from, so the two never disagree; a
 * discount Polar applies comes off both, which the page says ("Before any discount").
 */
export function renewalAmount(summary: FamilyBillingFull, units: number, plan?: FamilyPlan) {
    const live = summary.subscription;
    const on = plan ?? currentPlan(summary);
    const price = live?.currency && on ? on.prices[live.currency] : undefined;
    if (!live?.currency || !on || !price) return null;
    const billable = Math.max(0, units - on.includedMembers);
    const base = (on.id === live.productId && paidPrice(summary)?.base) || price.base;
    return { amount: base + price.perMember * billable, currency: live.currency };
}

/* An upgrade whose charge the bank hasn't confirmed: the family keeps the tier it paid for. */
export const upgradeWaiting = (live: FamilySubscription) => live.paidProductId !== live.productId;

/* The smaller tier the family moves to at the period's end, if one is scheduled. */
export function pendingTier(summary: FamilyBillingFull): FamilyPlan | undefined {
    const id = summary.subscription?.pendingProductId;
    return id ? summary.plans.find((plan) => plan.id === id) : undefined;
}

/*
 * The next charge: on the period's end, for the places the family keeps, at
 * the tier it moves to if one is scheduled. None once it is ending.
 */
export function nextCharge(summary: FamilyBillingFull) {
    const live = summary.subscription;
    if (!live || live.cancelAtPeriodEnd) return null;
    // Nothing scheduled: the subscription renews as it stands, at what the family pays.
    const paid = live.pendingUnits == null && !live.pendingProductId ? paidPrice(summary) : null;
    if (paid && live.currency)
        return { amount: paid.total, currency: live.currency, on: live.currentPeriodEnd };
    const amount = renewalAmount(summary, live.pendingUnits ?? live.units, pendingTier(summary));
    return amount ? { ...amount, on: live.currentPeriodEnd } : null;
}

/*
 * A tier the payer may move the family to: the others billed the same way
 * (monthly or yearly) and priced in the family's currency, smallest pool
 * first, with what each move means, as the server's changeGroupPlan does it.
 * A bigger pool is `up`: charged now, about `now` (Polar rounds its two lines
 * on their own), then `renews` each period from the renewal. A smaller one is
 * `down`: `renews` from the renewal, nothing now and nothing refunded, and only
 * once the family fits: `over` is how much more it stores (the family folders
 * and every pooled member's own files) than its pool (0 when it fits), which
 * the server refuses too.
 */
export type TierMove = {
    plan: FamilyPlan;
    direction: 'up' | 'down';
    now: { amount: number; currency: string } | null;
    renews: { amount: number; currency: string } | null;
    over: bigint;
};

export function tierMoves(summary: FamilyBillingFull, now = new Date()): TierMove[] {
    const live = summary.subscription;
    const current = currentPlan(summary);
    const currency = live?.currency;
    if (!live || !current || !currency) return [];
    const list = current.prices[currency];
    if (!list) return [];
    // Proration credits the base the family pays now, not today's list price for its tier.
    const from = { ...list, base: paidPrice(summary)?.base ?? list.base };
    const used = BigInt(summary.storage?.usedBytes ?? '0');
    const renewalUnits = live.pendingUnits ?? live.units;
    return summary.plans
        .filter(
            (plan) =>
                plan.id !== current.id &&
                plan.interval === current.interval &&
                plan.quotaBytes !== current.quotaBytes &&
                currency in plan.prices &&
                live.units >= plan.includedMembers,
        )
        .map((plan) => {
            const to = plan.prices[currency]!;
            const pool = BigInt(plan.quotaBytes);
            const up = pool > BigInt(current.quotaBytes);
            return {
                plan,
                direction: up ? ('up' as const) : ('down' as const),
                now: up
                    ? {
                          amount: quoteTierChange({
                              from: { ...from, includedMembers: current.includedMembers },
                              to: { ...to, includedMembers: plan.includedMembers },
                              units: live.units,
                              periodStart: new Date(live.currentPeriodStart),
                              periodEnd: new Date(live.currentPeriodEnd),
                              now,
                          }),
                          currency,
                      }
                    : null,
                renews: renewalAmount(summary, renewalUnits, plan),
                over: !up && used > pool ? used - pool : 0n,
            };
        });
}

export type FamilyActions = {
    /* Polar's checkout: a `billing` holder, when nobody else is the payer. */
    choosePlan: boolean;
    /* Move to another tier: the payer, while the plan renews and its last payment went through. */
    changePlan: boolean;
    /* Withdraw a move to a smaller tier scheduled for the renewal. */
    keepTier: boolean;
    addPlaces: boolean;
    removePlaces: boolean;
    /* Withdraw a scheduled cut: free, and the places stay. */
    keepPlaces: boolean;
    /* "Manage payment and invoices": the payer's billing portal. */
    portal: boolean;
    /* Cancelling is done in the portal; offered while the plan renews. */
    cancel: boolean;
};

const nothing: FamilyActions = {
    choosePlan: false,
    changePlan: false,
    keepTier: false,
    addPlaces: false,
    removePlaces: false,
    keepPlaces: false,
    portal: false,
    cancel: false,
};

/*
 * Which controls this person gets. Only the payer changes a live plan (the
 * server answers anyone else 403); a plan set to end refuses changes to its
 * places until it is resumed, in the portal. With no live plan, any `billing`
 * holder may check out and becomes the payer (the server moves the family's
 * customer to them); the portal stays the payer's.
 */
export function familyActions(
    summary: FamilyBilling,
    roles: readonly string[] | undefined,
): FamilyActions {
    if (summary.view !== 'manage') return nothing;
    const state = planState(summary);
    if (state.kind === 'off') return nothing;
    const payer = billingAccess(summary) === 'payer';
    if (state.kind !== 'live')
        return {
            ...nothing,
            choosePlan: Boolean(roles?.includes('billing')) && summary.plans.length > 0,
            portal: payer,
        };
    if (!payer) return nothing;
    const changeable = !state.ending;
    const live = state.subscription;
    return {
        choosePlan: false,
        // The server refuses a move while the bank holds a renewal; the card comes first. Nor
        // does anything stack on a charge the bank hasn't confirmed, places or an upgrade.
        changePlan:
            changeable &&
            !state.overdue &&
            !upgradeWaiting(live) &&
            live.paidUnits >= live.units &&
            tierMoves(summary).length > 0,
        keepTier: changeable && !state.overdue && live.pendingProductId !== null,
        addPlaces: changeable && addRange(summary) !== null,
        removePlaces:
            changeable &&
            removeRange(summary) !== null &&
            (live.pendingUnits === null || live.pendingUnits > placesFloor(summary)),
        keepPlaces: changeable && live.pendingUnits !== null,
        portal: true,
        cancel: changeable,
    };
}

/*
 * What "Let them in" means for a full family, said before the payer presses
 * it (the server's ensureGroupSeat): a place the bank hasn't confirmed waits
 * for it; a place a scheduled cut is removing is simply kept, at no charge
 * now; otherwise one more place is bought at once. Null when a place is free,
 * or this person doesn't pay.
 */
export type SeatNote =
    | { kind: 'bank' }
    | { kind: 'keep'; from: string }
    | { kind: 'charge'; now: { amount: number; currency: string }; perMember: number };

export function seatNoteFor(summary: FamilyBilling | undefined): SeatNote | null {
    if (!summary?.enabled || summary.view !== 'manage' || !summary.payer?.you) return null;
    const live = summary.subscription;
    if (!live || live.cancelAtPeriodEnd) return null;
    const target = summary.seats.used + 1;
    if (target <= summary.seats.limit) return null;
    if (target <= live.units) {
        if (live.paidUnits < target) return { kind: 'bank' };
        if (live.pendingUnits !== null && live.pendingUnits < target)
            return { kind: 'keep', from: live.currentPeriodEnd };
        return null;
    }
    const price = livePrice(summary);
    if (!price || !summary.nextPlace) return null;
    return { kind: 'charge', now: summary.nextPlace, perMember: price.perMember };
}

/* The currencies every family plan is priced in, the default first, as personal plans do. */
export function familyCurrencies(plans: readonly FamilyPlan[]) {
    if (!plans.length) return [];
    const shared = plans
        .map((plan) => new Set(Object.keys(plan.prices)))
        .reduce((common, set) => new Set([...common].filter((currency) => set.has(currency))));
    const rest = [...shared].filter((currency) => currency !== DEFAULT_CURRENCY).sort();
    return shared.has(DEFAULT_CURRENCY) ? [DEFAULT_CURRENCY, ...rest] : rest;
}

/* In lib/plans, shared with the pricing page, which must not load this module's API clients. */
export { familyPrice } from '@/lib/plans';

const GIB = 1n << 30n;
const wholeGibUp = (bytes: bigint) => ((bytes + GIB - 1n) / GIB) * GIB;

/*
 * Whether a family tier can be someone's new family's first plan: once it is live, their own
 * files draw from it, so the server refuses a tier smaller than what they store (startGroupCheckout,
 * docs/families-shared-pool.md 3.2), checked exactly against their own stored bytes. Said here
 * before the family is made, in the server's words (whole GB, rounded up), so nobody is left with
 * a family and no plan. `storage` is the account's own figures (/api/auth/storage while not pooled);
 * unknown, or pooled already (someone in a family can't make another), nothing is refused here.
 */
export function tierTooSmall(
    storage: { usedBytes: string; pool: unknown } | null | undefined,
    plan: Pick<FamilyPlan, 'name' | 'quotaBytes'>,
) {
    if (!storage || storage.pool) return null;
    const used = BigInt(storage.usedBytes);
    const room = BigInt(plan.quotaBytes);
    if (used <= room) return null;
    const tier = plan.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '');
    return `Your files take ${spaceOf(wholeGibUp(used))}, more than ${tier}’s ${spaceOf(room)}. Choose a bigger plan or free at least ${spaceOf(wholeGibUp(used - room))}.`;
}
