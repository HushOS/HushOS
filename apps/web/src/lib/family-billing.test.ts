import type { FamilyPlan } from '@hushos/billing/api';
import { describe, expect, test } from 'vitest';
import {
    addRange,
    familyActions,
    pendingTier,
    renewalAmount,
    tierMoves,
    familyCurrencies,
    needsPlan,
    nextCharge,
    placesOf,
    quoteAdd,
    removeRange,
    seatNoteFor,
    tierTooSmall,
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
    tier: null,
    recommended: false,
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
                  pendingProductId: null,
                  paidProductId: FAMILY,
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
            // The single plan has no other tier billed monthly to move to.
            changePlan: false,
            keepTier: false,
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
            changePlan: false,
            keepTier: false,
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

/*
 * The three tiers as seed.ts makes them: four included, then 150 a member (ten months of
 * it a year); the base at its own monthly and yearly price.
 */
const GIB = 1024 ** 3;
function tierPlan(
    tier: 'plus' | 'pro' | 'max',
    gib: number,
    base: { usd: number; inr: number },
    interval: 'month' | 'year',
) {
    const times = interval === 'year' ? 10 : 1;
    const yearly = {
        plus: { usd: 9600, inr: 390000 },
        pro: { usd: 19200, inr: 780000 },
        max: { usd: 28800, inr: 1380000 },
    }[tier];
    const label = { plus: 'Plus', pro: 'Pro', max: 'Max' }[tier];
    return {
        id: `${tier}-${interval}`,
        name: `Family ${label} (${interval === 'year' ? 'yearly' : 'monthly'})`,
        description: null,
        interval,
        tier,
        recommended: tier === 'pro',
        prices: {
            usd: { base: interval === 'year' ? yearly.usd : base.usd, perMember: 150 * times },
            inr: { base: interval === 'year' ? yearly.inr : base.inr, perMember: 5900 * times },
        },
        includedMembers: 4,
        maxMembers: 20,
        quotaBytes: String(gib * GIB),
    } satisfies FamilyPlan;
}
const tiers: FamilyPlan[] = [
    tierPlan('plus', 800, { usd: 1000, inr: 39900 }, 'month'),
    tierPlan('plus', 800, { usd: 1000, inr: 39900 }, 'year'),
    tierPlan('pro', 2048, { usd: 2000, inr: 79900 }, 'month'),
    tierPlan('pro', 2048, { usd: 2000, inr: 79900 }, 'year'),
    tierPlan('max', 4096, { usd: 3000, inr: 139900 }, 'month'),
    tierPlan('max', 4096, { usd: 3000, inr: 139900 }, 'year'),
];

/* A family on a tier, as the server summarises it. */
function onTier(
    productId: string,
    overrides: Parameters<typeof summary>[0] & {
        usedBytes?: bigint;
        pendingProductId?: string | null;
        paidProductId?: string;
        currency?: string;
    } = {},
): FamilyBillingFull {
    const base = summary({ ...overrides, units: overrides.units ?? 4 });
    const on = tiers.find((candidate) => candidate.id === productId)!;
    return {
        ...base,
        plans: tiers,
        subscription: base.subscription && {
            ...base.subscription,
            productId,
            productName: on.name,
            recurringInterval: on.interval,
            currency: overrides.currency ?? 'usd',
            includedMembers: 4,
            quotaBytes: on.quotaBytes,
            pendingProductId: overrides.pendingProductId ?? null,
            paidProductId: overrides.paidProductId ?? productId,
        },
        storage: { usedBytes: String(overrides.usedBytes ?? 0n), quotaBytes: on.quotaBytes },
    };
}

describe('places with four included', () => {
    test('the floor is four, the next charge counts places past four, and a raise past four is charged', () => {
        expect(removeRange(onTier('pro-month', { units: 6, used: 2 }))).toEqual({ min: 4, max: 5 });
        expect(removeRange(onTier('pro-month', { units: 4, used: 2 }))).toBeNull();
        expect(renewalAmount(onTier('pro-month', { units: 6 }), 6)).toEqual({
            amount: 2000 + 2 * 150,
            currency: 'usd',
        });
        // Three to six: only the two past the four included are charged, the whole period left.
        expect(quoteAdd(onTier('pro-month', { units: 3 }), 3, start)?.amount).toBe(300);
        expect(quoteAdd(onTier('pro-month', { units: 4 }), 1, left(0.5))?.amount).toBe(75);
        expect(addRange(onTier('pro-month', { units: 18 }))).toEqual({ min: 1, max: 2 });
    });
});

describe('tierMoves', () => {
    test('offers the other tiers billed the same way, smallest first, each up or down', () => {
        const moves = tierMoves(onTier('pro-month', { units: 7 }), left(0.5));
        expect(moves.map((move) => [move.plan.id, move.direction])).toEqual([
            ['plus-month', 'down'],
            ['max-month', 'up'],
        ]);
        // Up: half of the 10.00 difference now; then Max at seven places from the renewal.
        expect(moves[1]).toMatchObject({
            now: { amount: 500, currency: 'usd' },
            renews: { amount: 3000 + 3 * 150, currency: 'usd' },
            over: 0n,
        });
        // Down: nothing now, Plus at seven places from the renewal.
        expect(moves[0]).toMatchObject({ now: null, renews: { amount: 1000 + 3 * 150 } });
        // A yearly family moves between yearly tiers.
        expect(tierMoves(onTier('max-year')).map((move) => [move.plan.id, move.direction])).toEqual(
            [
                ['plus-year', 'down'],
                ['pro-year', 'down'],
            ],
        );
    });

    test('a smaller tier says how much more the family stores than its pool', () => {
        const pool = BigInt(800 * GIB);
        const over = (usedBytes: bigint) =>
            tierMoves(onTier('max-month', { usedBytes })).find(
                (move) => move.plan.id === 'plus-month',
            )?.over;
        expect(over(pool + 1n)).toBe(1n);
        expect(over(pool)).toBe(0n);
        expect(over(pool + BigInt(428 * GIB))).toBe(BigInt(428 * GIB));
        // Family Pro's 2 TB takes it all.
        expect(
            tierMoves(onTier('max-month', { usedBytes: pool + 1n })).find(
                (move) => move.plan.id === 'pro-month',
            )?.over,
        ).toBe(0n);
    });

    test('is quoted in the family’s currency and renews at a scheduled cut’s places', () => {
        const inr = tierMoves(onTier('plus-month', { currency: 'inr' }), start);
        expect(inr.map((move) => move.now)).toEqual([
            { amount: 79900 - 39900, currency: 'inr' },
            { amount: 139900 - 39900, currency: 'inr' },
        ]);
        const cut = tierMoves(onTier('pro-month', { units: 8, pendingUnits: 6 }));
        expect(cut.find((move) => move.direction === 'up')?.renews?.amount).toBe(3000 + 2 * 150);
    });

    test('the next charge follows a scheduled move to a smaller tier', () => {
        const moving = onTier('max-month', { units: 6, pendingProductId: 'plus-month' });
        expect(pendingTier(moving)?.id).toBe('plus-month');
        expect(nextCharge(moving)).toMatchObject({ amount: 1000 + 2 * 150, currency: 'usd' });
        expect(nextCharge(onTier('max-month', { units: 6 }))?.amount).toBe(3000 + 2 * 150);
    });

    test('a family on an older, dearer price is quoted what it pays, not today’s list', () => {
        // Family Pro yearly signed up at 200 USD when a year was ten months; the list is now 192.
        const old = onTier('pro-year', { units: 6, amount: 20000 + 2 * 1500 });
        expect(nextCharge(old)).toEqual({
            amount: 23000,
            currency: 'usd',
            on: end.toISOString(),
        });
        expect(renewalAmount(old, 6)?.amount).toBe(23000);
        // A cut keeps the base it pays: 200 and one place, not 192 and one.
        expect(
            nextCharge(onTier('pro-year', { units: 6, pendingUnits: 5, amount: 23000 }))?.amount,
        ).toBe(20000 + 1500);
        // A move to a smaller tier at the renewal is charged at that tier's price now.
        expect(
            nextCharge(
                onTier('pro-year', { units: 6, pendingProductId: 'plus-year', amount: 23000 }),
            )?.amount,
        ).toBe(9600 + 2 * 1500);
        // Up to Max with half the period left: half of 288 less half of the 200 it pays, 44
        // (at the list's 192 it would read 48), then Max at its own price from the renewal.
        const up = tierMoves(old, left(0.5)).find((move) => move.direction === 'up');
        expect(up).toMatchObject({
            plan: { id: 'max-year' },
            now: { amount: 4400, currency: 'usd' },
            renews: { amount: 28800 + 2 * 1500, currency: 'usd' },
        });
    });

    test('an amount at or below the list may be a discount, so the list price stands', () => {
        // 200 for six places on Family Pro yearly: below the 222 list, as a discount leaves it.
        const discounted = onTier('pro-year', { units: 6, amount: 20000 });
        expect(nextCharge(discounted)?.amount).toBe(19200 + 2 * 1500);
        const up = tierMoves(discounted, left(0.5)).find((move) => move.direction === 'up');
        expect(up?.now?.amount).toBe(4800);
        // Exactly the list is the list.
        expect(nextCharge(onTier('pro-year', { units: 6, amount: 22200 }))?.amount).toBe(22200);
    });

    test('only the payer changes the plan, while it renews and its last payment went through', () => {
        const organizer = ['billing', 'members'];
        expect(familyActions(onTier('pro-month'), organizer)).toMatchObject({
            changePlan: true,
            keepTier: false,
        });
        expect(familyActions(onTier('pro-month', { you: false }), organizer).changePlan).toBe(
            false,
        );
        expect(familyActions(onTier('pro-month', { ending: true }), organizer).changePlan).toBe(
            false,
        );
        const overdue = onTier('pro-month');
        overdue.subscription!.status = 'past_due';
        expect(familyActions(overdue, organizer)).toMatchObject({
            changePlan: false,
            keepTier: false,
        });
        expect(
            familyActions(onTier('pro-month', { pendingProductId: 'plus-month' }), organizer)
                .keepTier,
        ).toBe(true);
        // Nothing stacks on a charge the bank hasn't confirmed: an upgrade, or places.
        expect(
            familyActions(onTier('max-month', { paidProductId: 'pro-month' }), organizer)
                .changePlan,
        ).toBe(false);
        expect(
            familyActions(onTier('pro-month', { units: 6, paidUnits: 5 }), organizer).changePlan,
        ).toBe(false);
    });
});

describe('tierTooSmall', () => {
    const GIB = 1024n ** 3n;
    const plus = { name: 'Family Plus (monthly)', quotaBytes: String(800n * GIB) };
    const own = (bytes: bigint) => ({ usedBytes: String(bytes), pool: null });

    test('a tier exactly as big as their files is offered; one byte more than it holds is not', () => {
        expect(tierTooSmall(own(800n * GIB), plus)).toBeNull();
        // The server refuses anything over the pool, checked to the byte, and says it in whole GB.
        expect(tierTooSmall(own(800n * GIB + 1n), plus)).toBe(
            'Your files take 801 GB, more than Family Plus’s 800 GB. Choose a bigger plan or free at least 1 GB.',
        );
    });

    test('says it in the server’s words, rounded up', () => {
        expect(tierTooSmall(own(950n * GIB - 5n), plus)).toBe(
            'Your files take 950 GB, more than Family Plus’s 800 GB. Choose a bigger plan or free at least 150 GB.',
        );
    });

    test('pooled figures are the family’s, not theirs: nothing is refused from them', () => {
        expect(
            tierTooSmall(
                { usedBytes: String(900n * GIB), pool: { groupId: 'g', name: 'F' } },
                plus,
            ),
        ).toBeNull();
        expect(tierTooSmall(undefined, plus)).toBeNull();
    });
});
