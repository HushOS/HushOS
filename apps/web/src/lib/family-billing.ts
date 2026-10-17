import type { FamilyPlan, GroupBillingSummary } from '@hushos/billing/api';
import {
    DEFAULT_CURRENCY,
    FAMILY_MAX_MEMBERS,
    MAX_MEMBERS_PER_RAISE,
    quoteUnitsChange,
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
export type FamilySubscription = NonNullable<GroupBillingSummary['subscription']>;

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

export function planState(summary: FamilyBilling): PlanState {
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
 * Whether inviting and new family folders wait for a plan: with billing on
 * and none live, nobody can be let in and the pool is empty. Unknown (still
 * loading, or unreadable) is not "no": the actions stay hidden until the
 * summary says, and the server refuses an admission without a place anyway.
 */
export function needsPlan(summary: FamilyBilling | undefined) {
    if (!summary) return true;
    return summary.enabled && summary.subscription === null;
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
    if (summary?.enabled) return summary.seats;
    return familySeats ?? null;
}

/* Said everywhere a family price or charge is shown: Polar adds tax on top. */
export const TAX_LINE = 'Plus tax where it applies; Polar adds it at checkout.';
export const TAX_ON_CHARGES = 'Plus tax where it applies; Polar adds it to each charge.';

/*
 * How much of the plan this person sees: the payer, a `billing` holder, or
 * anyone else, who sees the plan's name and the storage only. A manager
 * without `billing` reads the whole summary from the server but is shown what
 * a member is: what the family costs is the organizer's business.
 */
export type BillingAccess = 'payer' | 'billing' | 'glance';

export function billingAccess(
    summary: FamilyBilling,
    roles: readonly string[] | undefined,
): BillingAccess {
    if (summary.view !== 'manage') return 'glance';
    if (summary.payer?.you) return 'payer';
    if (roles?.includes('billing')) return 'billing';
    return 'glance';
}

/* The plan the family is on, from the catalogue; absent when it was archived or edited away. */
export function currentPlan(summary: FamilyBilling): FamilyPlan | undefined {
    const live = summary.subscription;
    return live ? summary.plans.find((plan) => plan.id === live.productId) : undefined;
}

const maxMembersOf = (summary: FamilyBilling) =>
    currentPlan(summary)?.maxMembers ?? FAMILY_MAX_MEMBERS;

/* Fewer places than this the family can't have: its members, and what the plan includes. */
export function placesFloor(summary: FamilyBilling) {
    const live = summary.subscription;
    return Math.max(live?.includedMembers ?? 0, summary.seats.used);
}

/*
 * How many places one "Add places" may add: at least one, at most the
 * server's step, never past the family maximum. Null when none can be added.
 */
export function addRange(summary: FamilyBilling) {
    const live = summary.subscription;
    if (!live) return null;
    const max = Math.min(MAX_MEMBERS_PER_RAISE, maxMembersOf(summary) - live.units);
    return max >= 1 ? { min: 1, max } : null;
}

/*
 * The places the family may have from the renewal: down to its floor, below
 * what it has now. Null when there is nothing to remove.
 */
export function removeRange(summary: FamilyBilling) {
    const live = summary.subscription;
    if (!live) return null;
    const min = placesFloor(summary);
    const max = live.units - 1;
    return max >= min ? { min, max } : null;
}

/* The plan's prices in the currency the family pays in. */
export function livePrice(summary: FamilyBilling) {
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
export function quoteAdd(summary: FamilyBilling, add: number, now = new Date()) {
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
 * What a renewal with `units` places charges: the subscription's own amount
 * (which carries any discount) moved by the per-member rate for each billable
 * place more or fewer. Null when it can't be told.
 */
export function renewalAmount(summary: FamilyBilling, units: number) {
    const live = summary.subscription;
    const price = livePrice(summary);
    if (!live || !price) return null;
    const billable = (count: number) => Math.max(0, count - live.includedMembers);
    const base = live.amount ?? price.base + price.perMember * billable(live.units);
    return {
        amount: Math.max(0, base + price.perMember * (billable(units) - billable(live.units))),
        currency: price.currency,
    };
}

/* The next charge: on the period's end, for the places the family keeps. None once it is ending. */
export function nextCharge(summary: FamilyBilling) {
    const live = summary.subscription;
    if (!live || live.cancelAtPeriodEnd) return null;
    const amount = renewalAmount(summary, live.pendingUnits ?? live.units);
    return amount ? { ...amount, on: live.currentPeriodEnd } : null;
}

export type FamilyActions = {
    /* Polar's checkout: a `billing` holder, when nobody else is the payer. */
    choosePlan: boolean;
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
    addPlaces: false,
    removePlaces: false,
    keepPlaces: false,
    portal: false,
    cancel: false,
};

/*
 * Which controls this person gets. Only the payer changes a live plan (the
 * server answers anyone else 403); a plan set to end refuses changes to its
 * places until it is resumed, in the portal. A checkout makes whoever starts
 * it the payer, so once someone is, only they can buy again.
 */
export function familyActions(
    summary: FamilyBilling,
    roles: readonly string[] | undefined,
): FamilyActions {
    const state = planState(summary);
    if (state.kind === 'off') return nothing;
    const access = billingAccess(summary, roles);
    const payer = access === 'payer';
    if (state.kind !== 'live') {
        const mayBuy =
            Boolean(roles?.includes('billing')) &&
            summary.view === 'manage' &&
            (summary.payer === null || summary.payer.you) &&
            summary.plans.length > 0;
        return { ...nothing, choosePlan: mayBuy, portal: payer };
    }
    if (!payer) return nothing;
    const changeable = !state.ending;
    const live = state.subscription;
    return {
        choosePlan: false,
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

/* The currencies every family plan is priced in, the default first, as personal plans do. */
export function familyCurrencies(plans: readonly FamilyPlan[]) {
    if (!plans.length) return [];
    const shared = plans
        .map((plan) => new Set(Object.keys(plan.prices)))
        .reduce((common, set) => new Set([...common].filter((currency) => set.has(currency))));
    const rest = [...shared].filter((currency) => currency !== DEFAULT_CURRENCY).sort();
    return shared.has(DEFAULT_CURRENCY) ? [DEFAULT_CURRENCY, ...rest] : rest;
}

/* A family plan's prices in a currency, or in the default when it has none there. */
export function familyPrice(plan: FamilyPlan, currency: string) {
    const price = plan.prices[currency];
    if (price) return { ...price, currency };
    const fallback = plan.prices[DEFAULT_CURRENCY];
    return fallback ? { ...fallback, currency: DEFAULT_CURRENCY } : null;
}
