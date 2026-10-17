import type { FamilyPlan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import {
    addRange,
    familyActions,
    familyCurrencies,
    needsPlan,
    nextCharge,
    placesOf,
    quoteAdd,
    removeRange,
    seatNoteFor,
    type FamilyBillingFull,
    type FamilyGlance,
} from './family-billing';

const FAMILY = 'fam-monthly';
const start = new Date('2026-10-17T04:32:15Z');
const end = new Date('2026-11-17T04:32:15Z');
const span = end.getTime() - start.getTime();
/* A moment with `share` of the period left. */
const left = (share: number) => new Date(end.getTime() - share * span);

const plan: FamilyPlan = {
    id: FAMILY,
    name: 'Family (monthly)',
    description: null,
    interval: 'month',
    prices: { usd: { base: 1500, perMember: 200 }, inr: { base: 59900, perMember: 7900 } },
    includedMembers: 6,
    maxMembers: 20,
    quotaBytes: String(2 * 1024 ** 4),
};

/*
 * The priced summary as the server builds it: its seat limit is the server's
 * seatLimitOf (bought, paid for, and any scheduled cut, whichever is lowest).
 */
function summary(
    overrides: {
        units?: number;
        paidUnits?: number;
        used?: number;
        pendingUnits?: number | null;
        ending?: boolean;
        you?: boolean;
        payer?: null;
        live?: boolean;
        lastPlan?: FamilyBillingFull['lastPlan'];
        amount?: number;
    } = {},
): FamilyBillingFull {
    const units = overrides.units ?? 6;
    const paidUnits = overrides.paidUnits ?? units;
    const pendingUnits = overrides.pendingUnits ?? null;
    const live = overrides.live !== false;
    return {
        enabled: true,
        view: 'manage',
        plans: [plan],
        payer: overrides.payer === null ? null : { userId: 'payer', you: overrides.you ?? true },
        subscription: live
            ? {
                  id: 'sub',
                  productId: FAMILY,
                  productName: 'Family (monthly)',
                  status: 'active',
                  recurringInterval: 'month',
                  amount: overrides.amount ?? 1500 + 200 * Math.max(0, units - 6),
                  currency: 'usd',
                  units,
                  paidUnits,
                  pendingUnits,
                  includedMembers: 6,
                  quotaBytes: plan.quotaBytes,
                  currentPeriodStart: start.toISOString(),
                  currentPeriodEnd: end.toISOString(),
                  cancelAtPeriodEnd: overrides.ending ?? false,
              }
            : null,
        lastPlan: overrides.lastPlan ?? null,
        storage: { usedBytes: '0', quotaBytes: plan.quotaBytes },
        seats: {
            used: overrides.used ?? 1,
            limit: live ? Math.max(1, Math.min(units, paidUnits, pendingUnits ?? units)) : 1,
        },
        nextPlace: live ? { amount: 126, currency: 'usd' } : null,
    };
}

/* What a member without `billing` gets: no prices, places, payer or state. */
const glance = (hasPlan: boolean): FamilyGlance => ({
    enabled: true,
    view: 'member',
    hasPlan,
    planName: hasPlan ? 'Family (monthly)' : null,
    storage: { usedBytes: '0', quotaBytes: hasPlan ? plan.quotaBytes : '0' },
});

describe('quoteAdd', () => {
    test('truncates once over the whole raise, as Polar charges it, not per place', () => {
        // Spike E3: one place with 0.99994 of the month left was charged 199.
        expect(quoteAdd(summary(), 1, left(0.99994))?.amount).toBe(199);
        // Two places are 399.976, charged 399: adding the one-place quote twice says 398.
        expect(quoteAdd(summary(), 2, left(0.99994))?.amount).toBe(399);
        expect(quoteAdd(summary(), 1, left(0.99994))?.currency).toBe('usd');
    });

    test('places within the included members cost nothing, and only the part past them is charged', () => {
        expect(quoteAdd(summary({ units: 4 }), 2, start)?.amount).toBe(0);
        // From four to eight: two of the four are past the included six.
        expect(quoteAdd(summary({ units: 4 }), 4, start)?.amount).toBe(400);
        // Half the period left: half the rate.
        expect(quoteAdd(summary({ units: 6 }), 3, left(0.5))?.amount).toBe(300);
    });

    test('is prorated over the period the server sent, not a calendar month', () => {
        // A third of the period left: 66.67 floors to 66.
        expect(quoteAdd(summary(), 1, left(1 / 3))?.amount).toBe(66);
        // Past the period's end there is nothing left to charge for.
        expect(quoteAdd(summary(), 1, new Date(end.getTime() + 1000))?.amount).toBe(0);
    });

    test('a plan priced in no currency the family pays in is not quoted', () => {
        const odd = summary();
        odd.subscription!.currency = 'eur';
        expect(quoteAdd(odd, 1, start)).toBeNull();
    });
});

describe('places', () => {
    test('one raise adds at most five, and never past twenty members', () => {
        expect(addRange(summary({ units: 6 }))).toEqual({ min: 1, max: 5 });
        expect(addRange(summary({ units: 18 }))).toEqual({ min: 1, max: 2 });
        expect(addRange(summary({ units: 20 }))).toBeNull();
    });

    test('a cut never goes below the members, nor what the plan includes', () => {
        expect(removeRange(summary({ units: 9, used: 3 }))).toEqual({ min: 6, max: 8 });
        expect(removeRange(summary({ units: 9, used: 7 }))).toEqual({ min: 7, max: 8 });
        expect(removeRange(summary({ units: 6, used: 2 }))).toBeNull();
        expect(removeRange(summary({ units: 8, used: 8 }))).toBeNull();
    });

    test('the next charge is the list price for the places kept, whatever the subscription’s amount', () => {
        expect(nextCharge(summary({ units: 9 }))).toEqual({
            amount: 2100,
            currency: 'usd',
            on: end.toISOString(),
        });
        expect(nextCharge(summary({ units: 9, pendingUnits: 7 }))?.amount).toBe(1700);
        // A discounted subscription (1050 for nine places): the figure is the list price, said
        // to be before any discount; mixing the discounted amount with full-price places gave 450.
        expect(nextCharge(summary({ units: 9, pendingUnits: 6, amount: 1050 }))?.amount).toBe(1500);
        expect(nextCharge(summary({ units: 9, amount: 1050 }))?.amount).toBe(2100);
        expect(nextCharge(summary({ units: 9, ending: true }))).toBeNull();
    });
});

describe('who gets which controls', () => {
    const organizer = ['billing', 'members'];

    test('the payer adds, removes, manages payment and cancels', () => {
        expect(familyActions(summary({ units: 8, used: 3 }), organizer)).toEqual({
            choosePlan: false,
            addPlaces: true,
            removePlaces: true,
            keepPlaces: false,
            portal: true,
            cancel: true,
        });
    });

    test('a billing holder who isn’t the payer changes nothing on a live plan', () => {
        expect(Object.values(familyActions(summary({ you: false }), organizer))).not.toContain(
            true,
        );
    });

    test('a member’s glance, a manager without billing included, gets no controls at all', () => {
        expect(Object.values(familyActions(glance(true), ['members']))).not.toContain(true);
        expect(Object.values(familyActions(glance(false), ['members']))).not.toContain(true);
    });

    test('a plan set to end can only be resumed in the portal: no place changes, no second cancel', () => {
        expect(familyActions(summary({ units: 8, used: 3, ending: true }), organizer)).toEqual({
            choosePlan: false,
            addPlaces: false,
            removePlaces: false,
            keepPlaces: false,
            portal: true,
            cancel: false,
        });
    });

    test('a scheduled cut can be withdrawn, and not cut further once it reaches the floor', () => {
        const actions = familyActions(summary({ units: 9, used: 3, pendingUnits: 6 }), organizer);
        expect(actions.keepPlaces).toBe(true);
        expect(actions.removePlaces).toBe(false);
        expect(
            familyActions(summary({ units: 9, used: 3, pendingUnits: 8 }), organizer).removePlaces,
        ).toBe(true);
    });

    test('with no live plan any billing holder can choose one, even when someone else paid before', () => {
        const lapsed = { productName: 'Family (monthly)', endedAt: end.toISOString() };
        expect(familyActions(summary({ live: false, payer: null }), organizer).choosePlan).toBe(
            true,
        );
        // The former payer's family: the server moves billing to whoever checks out now.
        const theirs = familyActions(
            summary({ live: false, lastPlan: lapsed, you: false }),
            organizer,
        );
        expect(theirs).toMatchObject({ choosePlan: true, portal: false });
        // Without `billing` (a priced view can't happen then, but roles decide it).
        expect(familyActions(summary({ live: false, payer: null }), ['members']).choosePlan).toBe(
            false,
        );
    });

    test('nothing is offered on a server that sells no plans', () => {
        const off = { ...summary({ live: false, payer: null }), enabled: false };
        expect(Object.values(familyActions(off, organizer))).not.toContain(true);
    });
});

describe('seatNoteFor', () => {
    test('a full family’s payer is told a place is bought now, at the server’s quote', () => {
        expect(seatNoteFor(summary({ units: 8, used: 8 }))).toEqual({
            kind: 'charge',
            now: { amount: 126, currency: 'usd' },
            perMember: 200,
        });
        // A free place: nothing to say.
        expect(seatNoteFor(summary({ units: 8, used: 7 }))).toBeNull();
    });

    test('a place a scheduled cut is removing is kept, for nothing now', () => {
        // Eight bought, cut to six at renewal, six taken: the seventh is one of the eight.
        expect(seatNoteFor(summary({ units: 8, used: 6, pendingUnits: 6 }))).toEqual({
            kind: 'keep',
            from: end.toISOString(),
        });
    });

    test('a place the bank hasn’t confirmed waits for it, and is never quoted as a new charge', () => {
        expect(seatNoteFor(summary({ units: 8, paidUnits: 6, used: 6 }))).toEqual({ kind: 'bank' });
    });

    test('nobody but the payer is told, and nothing while the plan is ending', () => {
        expect(seatNoteFor(summary({ units: 8, used: 8, you: false }))).toBeNull();
        expect(seatNoteFor(summary({ units: 8, used: 8, ending: true }))).toBeNull();
        expect(seatNoteFor(glance(true))).toBeNull();
    });
});

describe('needsPlan', () => {
    test('invites and folders wait for a live plan, but only where plans are sold', () => {
        expect(needsPlan(summary())).toBe(false);
        expect(needsPlan(summary({ live: false, payer: null }))).toBe(true);
        expect(needsPlan({ ...summary({ live: false, payer: null }), enabled: false })).toBe(false);
        // A member's glance says the same through hasPlan.
        expect(needsPlan(glance(true))).toBe(false);
        expect(needsPlan(glance(false))).toBe(true);
        // Not yet known: hidden rather than shown and taken away.
        expect(needsPlan(undefined)).toBe(true);
    });
});

describe('familyCurrencies', () => {
    test('only currencies every plan has, the default first', () => {
        const yearly = {
            ...plan,
            id: 'y',
            prices: { usd: plan.prices.usd!, gbp: plan.prices.usd! },
        };
        expect(familyCurrencies([plan])).toEqual(['usd', 'inr']);
        expect(familyCurrencies([plan, yearly])).toEqual(['usd']);
        expect(familyCurrencies([])).toEqual([]);
    });
});

describe('placesOf', () => {
    test('where plans are sold, every surface shows the paid limit from billing, not the family row', () => {
        // The family row says six (the instance default); the plan pays for eight.
        expect(placesOf({ used: 3, limit: 6 }, summary({ units: 8, used: 3 }))).toEqual({
            used: 3,
            limit: 8,
        });
        // A cut to six at renewal, which the family row hasn't caught up with: the server's
        // limit already counts the cut, so the header says six while eight are bought.
        expect(
            placesOf({ used: 3, limit: 8 }, summary({ units: 8, used: 3, pendingUnits: 6 })),
        ).toEqual({ used: 3, limit: 6 });
    });

    test('a member’s glance carries no places, so the family’s row stands; so does a server without plans', () => {
        expect(placesOf({ used: 3, limit: 8 }, glance(true))).toEqual({ used: 3, limit: 8 });
        const off = { ...summary(), enabled: false };
        expect(placesOf({ used: 2, limit: 6 }, off)).toEqual({ used: 2, limit: 6 });
        expect(placesOf({ used: 2, limit: 6 }, undefined)).toEqual({ used: 2, limit: 6 });
        expect(placesOf(undefined, undefined)).toBeNull();
    });
});
