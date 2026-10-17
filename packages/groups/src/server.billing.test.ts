import type * as PolarSdk from '@polar-sh/sdk/2026-10';
import type { Member } from '../test/kit';
import { PolarClientError } from '@polar-sh/sdk';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Admission with billing on (docs/groups-design.md 3.5): the real group
 * domain, crypto core and database, with Polar's client replaced at the SDK
 * boundary by a fake that keeps the sandbox's rules (spike E3, E8). A place
 * is bought only by the payer, after every check, and the newcomer is let in
 * only once Polar answers 200; a refused charge leaves nothing to undo.
 */
process.env.BILLING_PROVIDER = 'polar';
process.env.POLAR_ENVIRONMENT = 'sandbox';
process.env.POLAR_ACCESS_TOKEN = 'polar_oat_test';
process.env.POLAR_WEBHOOK_SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;

const FAMILY = '55555555-aaaa-4aaa-8aaa-555555555555';
const DAY = 24 * 60 * 60 * 1000;

type Subscription = {
    id: string;
    status: string;
    product_id: string;
    recurring_interval: 'month';
    amount: number;
    currency: string;
    current_period_start: string;
    current_period_end: string;
    cancel_at_period_end: boolean;
    ended_at: string | null;
    units: number;
    pending_update: { units: number } | null;
};

const polar = {
    teams: new Map<string, { id: string; subscriptions: Subscription[] }>(),
    subscriptions: new Map<string, Subscription>(),
    refusal: null as { error: string; detail: string } | null,
    updates: [] as Record<string, unknown>[],
};

/* A family plan with one member included, so a family of two already needs a paid place. */
const familyPlan = {
    id: FAMILY,
    name: 'Family (monthly)',
    description: null,
    is_recurring: true,
    is_archived: false,
    recurring_interval: 'month',
    metadata: {
        hushos_plan: 'family',
        hushos_group_kind: 'family',
        quota_bytes: String(1024 ** 4),
        included_members: '1',
    },
    prices: [
        { amount_type: 'fixed', price_currency: 'usd', price_amount: 1500, is_archived: false },
        {
            amount_type: 'unit_based',
            price_currency: 'usd',
            is_archived: false,
            tiers: {
                type: 'graduated',
                tiers: [
                    { bound: 1, unit_amount: '0' },
                    { bound: null, unit_amount: '200' },
                ],
            },
            minimum_units: 1,
        },
    ],
};

const notFound = () => new PolarClientError(404, { error: 'ResourceNotFound' });

const fakeClient = {
    products: {
        async *iterList() {
            yield familyPlan;
        },
    },
    customers: {
        async getStateExternal(externalId: string) {
            const team = polar.teams.get(externalId);
            if (!team) throw notFound();
            return {
                id: team.id,
                external_id: externalId,
                active_subscriptions: team.subscriptions.filter((s) => s.status === 'active'),
            };
        },
    },
    subscriptions: {
        async get(id: string) {
            const subscription = polar.subscriptions.get(id);
            if (!subscription) throw notFound();
            return structuredClone(subscription);
        },
        // A raise is charged at once; a refused charge (402) changes nothing (spike E8).
        async update(id: string, body: { units?: number; proration_behavior?: string }) {
            polar.updates.push({ id, ...body });
            const subscription = polar.subscriptions.get(id);
            if (!subscription) throw notFound();
            if (body.units !== undefined) {
                if (body.proration_behavior === 'next_period') {
                    subscription.pending_update = { units: body.units };
                    return structuredClone(subscription);
                }
                if (body.units > subscription.units && polar.refusal)
                    throw new PolarClientError(402, polar.refusal);
                subscription.units = body.units;
                subscription.pending_update = null;
            }
            return structuredClone(subscription);
        },
    },
    // No order waits for payment here: every raise this fake accepts is paid.
    orders: {
        async list() {
            return { items: [] };
        },
    },
    customerSessions: {
        async create(body: { external_customer_id: string; external_member_id?: string }) {
            return {
                customer_portal_url: `https://polar.test/portal/${body.external_customer_id}/${body.external_member_id}`,
            };
        },
    },
};

vi.mock('@polar-sh/sdk/2026-10', async (importOriginal) => {
    const real = await importOriginal<typeof PolarSdk>();
    return { ...real, createPolar: () => fakeClient };
});

const { groupsRepository, billingRepository, driveRepository } = await import('@hushos/db');
const { closeDatabase, resetDatabase } = await import('../../db/test/helpers');
const kit = await import('../test/kit');
const groups = await import('./server');
const billing = await import('@hushos/billing/server');

beforeEach(async () => {
    await resetDatabase();
    polar.teams.clear();
    polar.subscriptions.clear();
    polar.refusal = null;
    polar.updates = [];
});
afterAll(closeDatabase);

/* The family's plan at Polar and here, as a completed checkout and its delivery leave it. */
async function onPlan(fam: Awaited<ReturnType<typeof kit.family>>, units: number) {
    await billingRepository.recordGroupCustomer({
        groupId: fam.groupId,
        provider: 'polar',
        providerCustomerId: `cus_${fam.groupId.slice(0, 8)}`,
        payerUserId: fam.organizer.userId,
    });
    const subscription: Subscription = {
        id: `sub_${fam.groupId.slice(0, 8)}`,
        status: 'active',
        product_id: FAMILY,
        recurring_interval: 'month',
        amount: 1500,
        currency: 'usd',
        current_period_start: new Date(Date.now() - DAY).toISOString(),
        current_period_end: new Date(Date.now() + 29 * DAY).toISOString(),
        cancel_at_period_end: false,
        ended_at: null,
        units,
        pending_update: null,
    };
    polar.teams.set(`group:${fam.groupId}`, { id: `cus_${fam.groupId.slice(0, 8)}`, subscriptions: [subscription] });
    polar.subscriptions.set(subscription.id, subscription);
    await billing.reconcileGroup(fam.groupId);
    return subscription;
}

/* `m` accepted, and the admitting call built once, so a refused call is resent as the same bytes. */
async function admission(fam: Awaited<ReturnType<typeof kit.family>>, m: Member) {
    await kit.accepted(fam, m);
    const { at, call } = await kit.nextRoster(fam, fam.organizer, [
        ...kit.entries(fam.h),
        m.who.entry([]),
    ]);
    return {
        ...call,
        grants: [await kit.grantWire(fam.groupId, fam.areaId, 1, fam.organizer.who, m.who, at)],
    };
}

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        if (error instanceof groups.GroupError)
            return { code: error.code, status: error.status, data: error.data };
        throw error;
    }
    throw new Error('Expected a refusal.');
}

const state = async (groupId: string, userId: string) =>
    (await groupsRepository.listMembers(groupId)).find((m) => m.userId === userId)?.state;
const raises = () => polar.updates.filter((u) => u.proration_behavior === 'invoice');

describe('admission with billing on', () => {
    test('a family starts with an empty pool: its areas hold nothing free', async () => {
        const fam = await kit.family();
        expect((await driveRepository.getStorage(fam.areaId))?.allowance).toBe(0n);
        await onPlan(fam, 1);
        expect((await driveRepository.getStorage(fam.areaId))?.allowance).toBe(1024n ** 4n);
    });

    test('without a plan nobody is let in, and Polar is not asked', async () => {
        const fam = await kit.family();
        const newcomer = await kit.member();
        const call = await admission(fam, newcomer);
        expect(
            await refusal(groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call)),
        ).toMatchObject({ code: 'seats', status: 402, data: { reason: 'no-plan' } });
        expect(await state(fam.groupId, newcomer.userId)).toBe('accepted');
        expect(polar.updates).toEqual([]);
    });

    test('a declined charge lets nobody in and changes nothing; the same call lands once Polar says 200', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 1);
        const newcomer = await kit.member();
        const call = await admission(fam, newcomer);
        const before = await kit.head(fam.groupId);
        polar.refusal = {
            error: 'PaymentFailed',
            detail: 'Payment failed with reason: card_error.',
        };
        expect(
            await refusal(groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call)),
        ).toMatchObject({ code: 'seats', status: 402, data: { reason: 'declined' } });
        expect(await state(fam.groupId, newcomer.userId)).toBe('accepted');
        expect(await kit.head(fam.groupId)).toEqual(before);
        expect(subscription.units).toBe(1);
        expect((await groupsRepository.getGroupRow(fam.groupId))?.seatLimit).toBe(1);
        // The bank wants a confirmation: the portal, and still nobody let in.
        polar.refusal = { error: 'PaymentActionRequired', detail: 'Confirm the payment.' };
        expect(
            await refusal(groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call)),
        ).toMatchObject({
            code: 'seats',
            status: 402,
            data: {
                reason: 'confirm',
                url: `https://polar.test/portal/group:${fam.groupId}/${fam.organizer.userId}`,
            },
        });
        expect(await state(fam.groupId, newcomer.userId)).toBe('accepted');
        polar.refusal = null;
        await groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call);
        expect(await state(fam.groupId, newcomer.userId)).toBe('active');
        expect(subscription.units).toBe(2);
        expect((await groupsRepository.getGroupRow(fam.groupId))?.seatLimit).toBe(2);
        // Each attempt asked Polar once for the same second place: two refused, one charged.
        expect(raises().map((u) => u.units)).toEqual([2, 2, 2]);
    });

    test('a manager who does not pay cannot buy a place; a place already paid for needs no charge', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 2);
        const holder = await kit.member();
        // The second place is paid for: no charge to let the holder in.
        await kit.admitted(fam, holder, ['members']);
        expect(raises()).toEqual([]);
        expect(await state(fam.groupId, holder.userId)).toBe('active');
        // Full at two: the holder admitting a third would have the payer charged.
        const third = await kit.member();
        await kit.accepted(fam, third);
        const { at, call } = await kit.nextRoster(fam, holder, [
            ...kit.entries(fam.h),
            third.who.entry([]),
        ]);
        const body = {
            ...call,
            grants: [await kit.grantWire(fam.groupId, fam.areaId, 1, holder.who, third.who, at)],
        };
        expect(
            await refusal(groups.admit(holder.userId, fam.groupId, third.userId, body)),
        ).toMatchObject({ code: 'seats', status: 402, data: { reason: 'payer' } });
        expect(polar.updates).toEqual([]);
        expect(subscription.units).toBe(2);
        expect(await state(fam.groupId, third.userId)).toBe('accepted');
    });

    test('the payer of a live plan cannot leave, even beside another billing holder, nor dissolve it as its last member', async () => {
        const alone = await kit.family();
        await onPlan(alone, 1);
        // Leaving last would dissolve the family; the card would go on being charged.
        expect(await refusal(groups.leave(alone.organizer.userId, alone.groupId))).toMatchObject({
            code: 'payer',
            status: 409,
        });
        expect(await state(alone.groupId, alone.organizer.userId)).toBe('active');
        expect((await groupsRepository.getGroupRow(alone.groupId))?.dissolvedAt).toBeNull();

        polar.teams.clear();
        polar.subscriptions.clear();
        const fam = await kit.family();
        await onPlan(fam, 2);
        const holder = await kit.member();
        await kit.admitted(fam, holder, ['billing', 'members']);
        expect(await refusal(groups.leave(fam.organizer.userId, fam.groupId))).toMatchObject({
            code: 'payer',
            status: 409,
        });
        expect(await state(fam.groupId, fam.organizer.userId)).toBe('active');
    });
});
