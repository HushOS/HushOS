import type * as PolarSdk from '@polar-sh/sdk/2026-10';
import type { Member } from '../test/kit';
import { createHash, randomBytes } from 'node:crypto';
import { PolarClientError } from '@polar-sh/sdk';
import { Client } from 'pg';
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
    /* A revoke Polar refuses (status, error name) while set. */
    revokeRefusal: null as { status: number; error: string } | null,
    revokes: [] as string[],
    /* Runs once as Polar lists a plan's orders: the revoke's own read, a payment landing then. */
    beforeOrders: null as (() => void | Promise<void>) | null,
    /* Runs once as Polar lists the family's plans: the lapsed-plan lookup's first read. */
    beforeList: null as (() => void | Promise<void>) | null,
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
        // A team customer's subscriptions, ended ones included.
        async list(query: { external_customer_id?: string }) {
            const hook = polar.beforeList;
            polar.beforeList = null;
            await hook?.();
            const team = query.external_customer_id
                ? polar.teams.get(query.external_customer_id)
                : undefined;
            return { items: (team?.subscriptions ?? []).map((s) => structuredClone(s)) };
        },
        async *iterList(query: { external_customer_id?: string }) {
            const hook = polar.beforeList;
            polar.beforeList = null;
            await hook?.();
            const team = query.external_customer_id
                ? polar.teams.get(query.external_customer_id)
                : undefined;
            for (const s of team?.subscriptions ?? []) yield structuredClone(s);
        },
        // Ends it now; one already ended is refused as Polar refuses it.
        async revoke(id: string) {
            polar.revokes.push(id);
            const subscription = polar.subscriptions.get(id);
            if (!subscription) throw notFound();
            if (polar.revokeRefusal)
                throw new PolarClientError(polar.revokeRefusal.status, {
                    error: polar.revokeRefusal.error,
                });
            if (subscription.ended_at)
                throw new PolarClientError(403, { error: 'AlreadyCanceledSubscription' });
            subscription.status = 'canceled';
            subscription.ended_at = new Date().toISOString();
            return structuredClone(subscription);
        },
        // A raise is charged at once; a refused charge (402) changes nothing (spike E8).
        async update(
            id: string,
            body: { units?: number; proration_behavior?: string; cancel_at_period_end?: boolean },
        ) {
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
            if (body.cancel_at_period_end !== undefined)
                subscription.cancel_at_period_end = body.cancel_at_period_end;
            return structuredClone(subscription);
        },
    },
    // No order waits for payment here: every raise this fake accepts is paid, and each plan's
    // checkout order was paid, which is what gives the family its tier and pool.
    orders: {
        async list(query: { subscription_id?: string; status?: string }) {
            const hook = polar.beforeOrders;
            polar.beforeOrders = null;
            await hook?.();
            const subscription = query.subscription_id
                ? polar.subscriptions.get(query.subscription_id)
                : undefined;
            if (query.status === 'pending' || !subscription) return { items: [] };
            return {
                items: [
                    {
                        id: `order_create_${subscription.id}`,
                        subscription_id: subscription.id,
                        status: 'paid',
                        paid: true,
                        due_amount: 0,
                        refunded_amount: 0,
                        billing_reason: 'subscription_create',
                        product_id: subscription.product_id,
                        currency: 'usd',
                        created_at: new Date(Date.now() - 60 * DAY).toISOString(),
                    },
                ],
            };
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

const { groupsRepository, billingRepository, driveRepository, scopedId } =
    await import('@hushos/db');
const { areaKeyCommitment } = await import('../../crypto/src/area-keys');
const { tombstoneAt } = await import('../../crypto/src/group-testkit');
const {
    closeDatabase,
    createTestAccount,
    createTestFamily,
    resetDatabase,
    setTestMember,
    setTestUsedBytes,
} = await import('../../db/test/helpers');
const kit = await import('../test/kit');
const { db } = await import('../../db/src/client');
const { eq, sql } = await import('drizzle-orm');
const { groupKeySeals } = await import('../../db/src/schema');
const groups = await import('./server');
const billing = await import('@hushos/billing/server');

beforeEach(async () => {
    await resetDatabase();
    polar.teams.clear();
    polar.subscriptions.clear();
    polar.refusal = null;
    polar.updates = [];
    polar.revokeRefusal = null;
    polar.revokes = [];
    polar.beforeOrders = null;
    polar.beforeList = null;
});
afterAll(closeDatabase);

/* The family's plan at Polar and here, as a completed checkout and its delivery leave it. */
async function onPlan(
    fam: Awaited<ReturnType<typeof kit.family>>,
    units: number,
    payerUserId = fam.organizer.userId,
) {
    await billingRepository.recordGroupCustomer({
        groupId: fam.groupId,
        provider: 'polar',
        providerCustomerId: `cus_${fam.groupId.slice(0, 8)}`,
        payerUserId,
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
    polar.teams.set(`group:${fam.groupId}`, {
        id: `cus_${fam.groupId.slice(0, 8)}`,
        subscriptions: [subscription],
    });
    polar.subscriptions.set(subscription.id, subscription);
    await billing.reconcileGroup(fam.groupId);
    return subscription;
}

/* The plan ran out at Polar, and HushOS has heard. */
async function endPlan(fam: Awaited<ReturnType<typeof kit.family>>, subscription: Subscription) {
    subscription.status = 'canceled';
    subscription.ended_at = new Date().toISOString();
    polar.teams.get(`group:${fam.groupId}`)!.subscriptions = [];
    await billing.reconcileGroup(fam.groupId);
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
        // Accepted while a plan ran, which then ended.
        const subscription = await onPlan(fam, 1);
        const newcomer = await kit.member();
        const call = await admission(fam, newcomer);
        await endPlan(fam, subscription);
        polar.updates = [];
        expect(
            await refusal(groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call)),
        ).toMatchObject({ code: 'seats', status: 402, data: { reason: 'no-plan' } });
        expect(await state(fam.groupId, newcomer.userId)).toBe('accepted');
        expect(polar.updates).toEqual([]);
    });

    test('someone in another family since accepting is refused before Polar is asked for a place', async () => {
        const fam = await kit.family();
        await onPlan(fam, 1);
        const newcomer = await kit.member();
        const call = await admission(fam, newcomer);
        // One family per account: another one they're in since they accepted (let in there; the
        // rows are written directly, as making one while waiting is refused).
        await createTestFamily({ organizerId: newcomer.userId });
        const before = await kit.head(fam.groupId);
        polar.updates = [];
        expect(
            await refusal(groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call)),
        ).toMatchObject({ code: 'in-family', status: 409, data: { reason: 'newcomer' } });
        expect(polar.updates).toEqual([]);
        expect(await state(fam.groupId, newcomer.userId)).toBe('accepted');
        expect(await kit.head(fam.groupId)).toEqual(before);
        expect((await groupsRepository.getGroupRow(fam.groupId))?.seatLimit).toBe(1);
    });

    test('someone who makes a family while the admission is being checked is still refused before the charge', async () => {
        const fam = await kit.family();
        await onPlan(fam, 1);
        const newcomer = await kit.member();
        const call = await admission(fam, newcomer);
        polar.updates = [];
        /*
         * The route's first check passes (no family yet); then the chain checks wait on the
         * chain cache, which this session holds. Meanwhile the newcomer's own family lands
         * (rows written directly: it needs no chain cache). Let go, the admission must ask
         * again before it charges.
         */
        const blocker = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        let admitting: Promise<unknown> | undefined;
        try {
            await blocker.query('begin');
            await blocker.query('lock table group_chain_caches in access exclusive mode');
            admitting = refusal(
                groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call),
            );
            expect(await kit.lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
            await createTestFamily({ organizerId: newcomer.userId });
        } finally {
            await blocker.query('commit');
            await blocker.end();
        }
        expect(await admitting).toMatchObject({
            code: 'in-family',
            status: 409,
            data: { reason: 'newcomer' },
        });
        expect(polar.updates).toEqual([]);
        expect(await state(fam.groupId, newcomer.userId)).toBe('accepted');
    });

    test('someone whose own files don’t fit in the family’s free space is refused before Polar is asked for a place', async () => {
        const fam = await kit.family();
        await onPlan(fam, 1);
        const newcomer = await kit.member();
        const call = await admission(fam, newcomer);
        // The pool is 1 TiB and holds nothing yet: theirs is one byte more.
        await setTestUsedBytes(newcomer.workspaceId, 1024n ** 4n + 1n);
        const before = await kit.head(fam.groupId);
        polar.updates = [];
        const refused = await refusal(
            groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call),
        );
        expect(refused).toMatchObject({ code: 'pool-full', status: 409 });
        // No figure reaches the managers: not theirs, not how much is free.
        expect(refused.data).toBeUndefined();
        expect(polar.updates).toEqual([]);
        expect(await state(fam.groupId, newcomer.userId)).toBe('accepted');
        expect(await kit.head(fam.groupId)).toEqual(before);
        // Exactly what is free fits; the same call then lands.
        await setTestUsedBytes(newcomer.workspaceId, 1024n ** 4n);
        await groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call);
        expect(await state(fam.groupId, newcomer.userId)).toBe('active');
    });

    test('a pool that fills while the admission is being checked still refuses it before the charge', async () => {
        const fam = await kit.family();
        await onPlan(fam, 1);
        const newcomer = await kit.member();
        const call = await admission(fam, newcomer);
        await setTestUsedBytes(newcomer.workspaceId, 1024n ** 3n);
        polar.updates = [];
        // The route's first check passes; the chain checks wait on the chain cache, held here,
        // while the organizer's own files fill the pool.
        const blocker = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        let admitting: Promise<unknown> | undefined;
        try {
            await blocker.query('begin');
            await blocker.query('lock table group_chain_caches in access exclusive mode');
            admitting = refusal(
                groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call),
            );
            expect(await kit.lockWaiters(blocker, 1)).toBeGreaterThanOrEqual(1);
            await setTestUsedBytes(fam.organizer.workspaceId, 1024n ** 4n);
        } finally {
            await blocker.query('commit');
            await blocker.end();
        }
        expect(await admitting).toMatchObject({ code: 'pool-full', status: 409 });
        expect(polar.updates).toEqual([]);
        expect(await state(fam.groupId, newcomer.userId)).toBe('accepted');
    });

    test('an invitee in a family hears that before hearing the family has no plan', async () => {
        const fam = await kit.family();
        const invitee = await kit.member();
        await kit.family(invitee);
        const token = randomBytes(32).toString('base64url');
        await groupsRepository.createInvitation({
            groupId: fam.groupId,
            email: invitee.email,
            normalizedEmail: invitee.email,
            tokenHash: createHash('sha256').update(token).digest(),
            roles: [],
            invitedBy: fam.organizer.userId,
            expiresAt: new Date(Date.now() + DAY),
        });
        // No plan here, so without the family rule first this would be `no-plan` (402).
        expect(
            await refusal(groups.acceptInvitation(invitee.userId, token, kit.ADDRESS)),
        ).toMatchObject({ code: 'in-family', status: 409, data: { reason: 'self' } });
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

    test('removing the payer is refused while the plan is live; a member who does not pay can be removed, and can leave', async () => {
        const fam = await kit.family();
        await onPlan(fam, 3);
        const holder = await kit.member();
        await kit.admitted(fam, holder, ['members']);
        // A roster outside the kit's history: the refusal comes before anything is checked.
        const forged = await kit.forgedRoster(fam, holder, (roster) => ({
            ...roster,
            members: roster.members.map((entry) =>
                entry.userId === fam.organizer.userId
                    ? { ...entry, status: 'left' as const }
                    : entry,
            ),
        }));
        const { revision } = await kit.head(fam.groupId);
        expect(
            await refusal(
                groups.removeMember(holder.userId, fam.groupId, fam.organizer.userId, {
                    expectedRevision: revision,
                    roster: kit.wire(forged),
                }),
            ),
        ).toMatchObject({ code: 'payer', status: 409 });
        expect(await state(fam.groupId, fam.organizer.userId)).toBe('active');

        // The organizer removes a member who does not pay: the roster rotates the folder.
        const plain = await kit.member();
        await kit.admitted(fam, plain);
        const before = kit.entries(fam.h).find((entry) => entry.userId === plain.userId)!;
        const { at, call } = await kit.nextRoster(
            fam,
            fam.organizer,
            kit.withEntry(fam.h, { ...before, status: 'left' }),
        );
        await groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
            ...call,
            rotations: [await kit.rotationWire(fam.areaId, fam.organizer.who, 1)],
            grants: [
                await kit.grantWire(
                    fam.groupId,
                    fam.areaId,
                    2,
                    fam.organizer.who,
                    fam.organizer.who,
                    at,
                ),
                await kit.grantWire(fam.groupId, fam.areaId, 2, fam.organizer.who, holder.who, at),
            ],
        });
        expect(await state(fam.groupId, plain.userId)).toBe('removed');
        // And one who does not pay leaves on their own.
        await groups.leave(holder.userId, fam.groupId);
        expect(await state(fam.groupId, holder.userId)).toBe('left');
    });

    test('the last member cannot dissolve a family whose plan someone still pays for; once cancelled they can', async () => {
        const fam = await kit.family();
        // The payer is someone else: the last member does not pay, and still cannot dissolve it.
        const payer = await createTestAccount();
        const subscription = await onPlan(fam, 1, payer.userId);
        expect(await refusal(groups.leave(fam.organizer.userId, fam.groupId))).toMatchObject({
            code: 'payer',
            status: 409,
        });
        expect((await groupsRepository.getGroupRow(fam.groupId))?.dissolvedAt).toBeNull();
        subscription.cancel_at_period_end = true;
        await billing.reconcileGroup(fam.groupId);
        expect(await groups.leave(fam.organizer.userId, fam.groupId)).toEqual({
            state: 'left',
            dissolved: true,
        });
    });

    test('the last member leaving dissolves the family and queues its plan to be set to end; a member leaving before them does not', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 2);
        const other = await kit.member();
        await kit.admitted(fam, other, []);
        subscription.cancel_at_period_end = true;
        await billing.reconcileGroup(fam.groupId);
        const queued: string[] = [];
        billing.setDissolveCancelQueue(async (groupId) => {
            queued.push(groupId);
        });
        try {
            expect(await groups.leave(other.userId, fam.groupId)).toEqual({ state: 'left' });
            expect(queued).toEqual([]);
            // The payer took the cancellation back in the portal, and no delivery came yet: only
            // the leave route can queue the job (the mirror still says the plan ends).
            subscription.cancel_at_period_end = false;
            expect(await groups.leave(fam.organizer.userId, fam.groupId)).toEqual({
                state: 'left',
                dissolved: true,
            });
            expect(queued).toEqual([fam.groupId]);
            // The worker runs it: the plan is set to end at its period's end, not revoked.
            expect(await billing.cancelDissolvedPlan(fam.groupId)).toEqual({
                cancelled: 1,
                refused: 0,
                revoked: 0,
            });
            expect(subscription).toMatchObject({ cancel_at_period_end: true, ended_at: null });
        } finally {
            billing.setDissolveCancelQueue(undefined);
        }
    });

    test.each(['paused', 'unpaid'])(
        'the payer of a %s plan has it revoked before they leave, so it can’t resume or be paid on their card',
        async (status) => {
            const fam = await kit.family();
            const subscription = await onPlan(fam, 1);
            subscription.status = status;
            await billing.reconcileGroup(fam.groupId);
            // Nothing live: they may leave, and as its last member, dissolve it, once they
            // confirm the plan ends (asked first, by id).
            expect(await refusal(groups.leave(fam.organizer.userId, fam.groupId))).toEqual({
                code: 'ends-lapsed',
                status: 409,
                data: {
                    plans: [
                        {
                            id: subscription.id,
                            name: 'Family',
                            standing: status === 'paused' ? 'paused' : 'payment-failed',
                        },
                    ],
                },
            });
            expect(polar.revokes).toEqual([]);
            expect(
                await groups.leave(fam.organizer.userId, fam.groupId, {
                    endsLapsed: [subscription.id],
                }),
            ).toEqual({
                state: 'left',
                dissolved: true,
            });
            expect(polar.revokes).toEqual([subscription.id]);
            expect(subscription).toMatchObject({
                status: 'canceled',
                ended_at: expect.any(String),
            });
            // The family's ending, written before the revoke: a payment taken later is refunded.
            expect(await billingRepository.getPlanEnding(subscription.id)).toMatchObject({
                userId: fam.groupId,
                groupId: null,
                revokedAt: expect.any(Date),
            });
        },
    );

    test('a payer whose lapsed plan Polar won’t revoke stays, and is told why', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 1);
        subscription.status = 'paused';
        await billing.reconcileGroup(fam.groupId);
        polar.revokeRefusal = { status: 409, error: 'SubscriptionLocked' };
        const refused = groups.leave(fam.organizer.userId, fam.groupId, {
            endsLapsed: [subscription.id],
        });
        await expect(refused).rejects.toMatchObject({
            code: 'payer',
            status: 409,
            message:
                'Polar is still working on a change to the family’s Family plan, so it can’t be ended yet. Try again later, or contact support.',
        });
        expect(await state(fam.groupId, fam.organizer.userId)).toBe('active');
        expect((await groupsRepository.getGroupRow(fam.groupId))?.dissolvedAt).toBeNull();
        expect(subscription.ended_at).toBeNull();
    });

    test('a removal refused (an outsider, a member who doesn’t manage, a stale member list) ends nothing', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 3);
        const plain = await kit.member();
        await kit.admitted(fam, plain);
        const outsider = await kit.member();
        // The organizer pays for a paused plan.
        subscription.status = 'paused';
        await billing.reconcileGroup(fam.groupId);
        const forged = await kit.forgedRoster(fam, plain, (roster) => ({
            ...roster,
            members: roster.members.map((entry) =>
                entry.userId === fam.organizer.userId
                    ? { ...entry, status: 'left' as const }
                    : entry,
            ),
        }));
        const { revision } = await kit.head(fam.groupId);
        for (const remover of [outsider.userId, plain.userId])
            await expect(
                groups.removeMember(remover, fam.groupId, fam.organizer.userId, {
                    expectedRevision: revision,
                    roster: kit.wire(forged),
                }),
            ).rejects.toBeInstanceOf(groups.GroupError);
        // The organizer's own removal of the payer, built on a member list already replaced.
        await expect(
            groups.removeMember(fam.organizer.userId, fam.groupId, fam.organizer.userId, {
                expectedRevision: revision - 1,
                roster: kit.wire(forged),
            }),
        ).rejects.toBeTruthy();
        expect(polar.revokes).toEqual([]);
        expect(subscription.ended_at).toBeNull();
        expect(await billingRepository.getPlanEnding(subscription.id)).toBeNull();
    });

    test('a leave its own rule refuses ends nothing; a member who doesn’t pay leaves without touching the plan', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 2);
        const plain = await kit.member();
        await kit.admitted(fam, plain);
        subscription.status = 'paused';
        await billing.reconcileGroup(fam.groupId);
        // The organizer (who pays) may not leave while others stay: refused before anything ends.
        expect(await refusal(groups.leave(fam.organizer.userId, fam.groupId))).toMatchObject({
            code: 'organizer',
        });
        expect(polar.revokes).toEqual([]);
        // Someone who doesn't pay for it leaves: the family's plan is not theirs to end.
        expect(await groups.leave(plain.userId, fam.groupId)).toEqual({ state: 'left' });
        expect(polar.revokes).toEqual([]);
        expect(subscription.ended_at).toBeNull();
    });

    /* A family of the organizer and `plain`, who pays for its plan, now paused; and `third`. */
    async function pausedPayer(withThird = false) {
        const fam = await kit.family();
        const subscription = await onPlan(fam, withThird ? 3 : 2);
        const plain = await kit.member();
        await kit.admitted(fam, plain);
        const third = withThird ? await kit.member() : null;
        if (third) await kit.admitted(fam, third);
        // Billing passed to them earlier (their card on the plan), and the plan paused since.
        expect(
            await billingRepository.setGroupPayer(fam.groupId, fam.organizer.userId, plain.userId),
        ).toBe(true);
        subscription.status = 'paused';
        await billing.reconcileGroup(fam.groupId);
        return { fam, subscription, plain, third };
    }
    /* The organizer's removal of `target`, marking `marked` left (the target, unless a test says otherwise). */
    async function removal(
        fam: Awaited<ReturnType<typeof kit.family>>,
        marked: Member[],
        remaining: Member[],
        signer: Member = fam.organizer,
    ) {
        let entries = kit.entries(fam.h);
        for (const m of marked) {
            const before = entries.find((entry) => entry.userId === m.userId)!;
            entries = entries.map((entry) =>
                entry.userId === m.userId ? { ...before, status: 'left' as const } : entry,
            );
        }
        const { at, call } = await kit.nextRoster(fam, signer, entries);
        return {
            ...call,
            rotations: [await kit.rotationWire(fam.areaId, signer.who, 1)],
            grants: await Promise.all(
                [signer, ...remaining].map((m) =>
                    kit.grantWire(fam.groupId, fam.areaId, 2, signer.who, m.who, at),
                ),
            ),
        };
    }

    test('removing the family’s only billing holder, who pays for a paused plan, ends nothing: the write would refuse it', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 2);
        const payer = await kit.member();
        await kit.admitted(fam, payer, ['billing']);
        // The organizer hands billing over: keeps members and guardian, drops billing.
        const { call: roles } = await kit.nextRoster(
            fam,
            fam.organizer,
            kit.withEntry(fam.h, fam.organizer.who.entry(['guardian', 'members'])),
        );
        await groups.patchMember(fam.organizer.userId, fam.groupId, fam.organizer.userId, roles);
        expect(
            await billingRepository.setGroupPayer(fam.groupId, fam.organizer.userId, payer.userId),
        ).toBe(true);
        subscription.status = 'paused';
        await billing.reconcileGroup(fam.groupId);
        const call = await removal(fam, [payer], []);
        // Refused by the write's own rule (no `billing` holder would be left), confirmed or not,
        // and before anything ends: never asked to confirm a removal that can't happen.
        for (const endsLapsed of [undefined, [subscription.id]])
            expect(
                await refusal(
                    groups.removeMember(fam.organizer.userId, fam.groupId, payer.userId, {
                        ...call,
                        ...(endsLapsed ? { endsLapsed } : {}),
                    }),
                ),
            ).toMatchObject({ code: 'invalid', status: 400 });
        expect(polar.revokes).toEqual([]);
        expect(subscription.ended_at).toBeNull();
        expect(await state(fam.groupId, payer.userId)).toBe('active');
    });

    test('a co-manager removing the organizer, the only billing holder, who pays for a paused plan: refused, nothing ended', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 2);
        const manager = await kit.member();
        await kit.admitted(fam, manager, ['members']);
        subscription.status = 'paused';
        await billing.reconcileGroup(fam.groupId);
        const call = await removal(fam, [fam.organizer], [], manager);
        expect(
            await refusal(
                groups.removeMember(manager.userId, fam.groupId, fam.organizer.userId, {
                    ...call,
                    endsLapsed: [subscription.id],
                }),
            ),
        ).toEqual({ code: 'invalid', status: 400, data: { reason: 'no-billing' } });
        expect(polar.revokes).toEqual([]);
        expect(subscription.ended_at).toBeNull();
        expect(await state(fam.groupId, fam.organizer.userId)).toBe('active');
    });

    test('a payer whose plan was paid again a moment ago can’t leave or be removed: it runs, on their card', async () => {
        const { fam, subscription, plain } = await pausedPayer();
        // Paid in the portal: live at Polar, its delivery not in yet.
        subscription.status = 'active';
        await expect(
            groups.leave(plain.userId, fam.groupId, { endsLapsed: [subscription.id] }),
        ).rejects.toMatchObject({
            code: 'payer',
            message:
                'The family’s plan was just paid for again, so it runs, on your card. Cancel it in the billing portal at hushos.com first, or contact support.',
        });
        expect(polar.revokes).toEqual([]);
        expect(await state(fam.groupId, plain.userId)).toBe('active');
        // Read again: the family's page shows the plan.
        expect((await billingRepository.getLiveGroupSubscription(fam.groupId))?.status).toBe(
            'active',
        );
        // Billing marked live now: the removal's own first question refuses it, as for any live
        // plan, before anything starts.
        await expect(
            groups.removalPreview(fam.organizer.userId, fam.groupId, plain.userId),
        ).rejects.toMatchObject({
            code: 'payer',
            message:
                'They pay for this family’s plan. They can cancel it in Billing on the family’s page; then you can remove them.',
        });
    });

    test('a payer whose plan was paid again a moment ago can’t be removed either, before the mirror knows', async () => {
        const { fam, subscription, plain } = await pausedPayer();
        subscription.status = 'active';
        await expect(
            groups.removalPreview(fam.organizer.userId, fam.groupId, plain.userId),
        ).rejects.toMatchObject({
            code: 'payer',
            message:
                'They pay for the family’s plan, which was just paid for again. They can cancel it in the billing portal; then you can remove them.',
        });
        expect(polar.revokes).toEqual([]);
    });

    test('a plan resumed while it is being ended keeps its payer: the leave or the removal is refused, nothing ended', async () => {
        for (const how of ['leave', 'remove'] as const) {
            const { fam, subscription, plain } = await pausedPayer();
            const call = how === 'remove' ? await removal(fam, [plain], []) : null;
            // Resumed in the portal just as the revoke reads the plan's orders.
            polar.beforeOrders = () => {
                subscription.status = 'active';
            };
            const going =
                how === 'leave'
                    ? groups.leave(plain.userId, fam.groupId, { endsLapsed: [subscription.id] })
                    : groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
                          ...call!,
                          endsLapsed: [subscription.id],
                      });
            await expect(going).rejects.toMatchObject({ code: 'payer', status: 409 });
            expect(polar.revokes).toEqual([]);
            expect(subscription.ended_at).toBeNull();
            expect(await state(fam.groupId, plain.userId)).toBe('active');
            polar.revokes = [];
        }
    });

    test('a plan on a product HushOS can’t read, resumed while the leave ends it, keeps its payer: read at Polar, not the mirror', async () => {
        const { fam, subscription, plain } = await pausedPayer();
        // An archived product: the mirror never holds such a plan as live.
        subscription.product_id = 'prod_archived';
        polar.beforeOrders = () => {
            subscription.status = 'active';
        };
        await expect(
            groups.leave(plain.userId, fam.groupId, { endsLapsed: [subscription.id] }),
        ).rejects.toMatchObject({
            code: 'payer',
            message:
                'The family’s plan was just paid for again, so it runs, on your card. Cancel it in the billing portal at hushos.com first, or contact support.',
        });
        expect(polar.revokes).toEqual([]);
        expect(await state(fam.groupId, plain.userId)).toBe('active');
    });

    test('the last member’s leave lets a resumed plan run only if it really dissolves the family: someone admitted meanwhile makes it refused', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 1);
        subscription.status = 'paused';
        await billing.reconcileGroup(fam.groupId);
        const newcomer = await createTestAccount();
        // Resumed during the revoke, and someone let in at the same moment.
        polar.beforeOrders = async () => {
            subscription.status = 'active';
            await setTestMember({
                groupId: fam.groupId,
                userId: newcomer.userId,
                state: 'active',
                roles: ['billing', 'members'],
            });
            // With a seal of the current key, as an admission gives: a holder the leave counts.
            const [seal] = await db
                .select()
                .from(groupKeySeals)
                .where(eq(groupKeySeals.holderUserId, fam.organizer.userId));
            await db.insert(groupKeySeals).values({ ...seal!, holderUserId: newcomer.userId });
        };
        await expect(
            groups.leave(fam.organizer.userId, fam.groupId, { endsLapsed: [subscription.id] }),
        ).rejects.toMatchObject({
            code: 'payer',
            status: 409,
            message:
                'The family’s plan was just paid for again, so it runs, on your card. Cancel it in the billing portal at hushos.com first, or contact support.',
        });
        expect(await state(fam.groupId, fam.organizer.userId)).toBe('active');
        expect((await groupsRepository.getGroupRow(fam.groupId))?.dissolvedAt).toBeNull();
    });

    test('the last member’s leave with a plan already running before the lookup must dissolve the family: someone admitted meanwhile makes it refused', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 1);
        subscription.status = 'paused';
        await billing.reconcileGroup(fam.groupId);
        // Resumed in the portal before the leave: running at Polar, the mirror still paused.
        subscription.status = 'active';
        const newcomer = await createTestAccount();
        // A holder let in between the leave's preview and its write.
        polar.beforeList = async () => {
            await setTestMember({
                groupId: fam.groupId,
                userId: newcomer.userId,
                state: 'active',
                roles: ['billing', 'members'],
            });
            const [seal] = await db
                .select()
                .from(groupKeySeals)
                .where(eq(groupKeySeals.holderUserId, fam.organizer.userId));
            await db.insert(groupKeySeals).values({ ...seal!, holderUserId: newcomer.userId });
        };
        await expect(
            groups.leave(fam.organizer.userId, fam.groupId, { endsLapsed: [subscription.id] }),
        ).rejects.toMatchObject({ code: 'payer', status: 409 });
        expect(await state(fam.groupId, fam.organizer.userId)).toBe('active');
        expect((await groupsRepository.getGroupRow(fam.groupId))?.dissolvedAt).toBeNull();
    });

    test('a payer’s removal the write refuses after its member-list rules (a folder key overtaken) ends nothing', async () => {
        const { fam, subscription, plain } = await pausedPayer();
        const call = await removal(fam, [plain], []);
        // A node written at the epoch the removal's rotation drew: the write's rotation step refuses.
        await db.execute(
            sql`update drive_nodes set key_epoch = ${call.rotations[0]!.targetEpoch} where workspace_id = ${fam.areaId} and parent_id is null`,
        );
        expect(
            await refusal(
                groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
                    ...call,
                    endsLapsed: [subscription.id],
                }),
            ),
        ).toMatchObject({ code: 'epoch-stale', status: 409 });
        expect(polar.revokes).toEqual([]);
        expect(subscription.ended_at).toBeNull();
        expect(await state(fam.groupId, plain.userId)).toBe('active');
    });

    test('the removal preview is paced: it reads Polar each time', async () => {
        const { fam, plain } = await pausedPayer();
        for (let i = 0; i < 20; i++)
            await groups.removalPreview(fam.organizer.userId, fam.groupId, plain.userId);
        await expect(
            groups.removalPreview(fam.organizer.userId, fam.groupId, plain.userId),
        ).rejects.toMatchObject({ code: 'rate-limited', status: 429 });
    });

    test('the removal preview names nothing for someone who doesn’t pay, and is only for managers', async () => {
        const { fam, plain } = await pausedPayer();
        expect(
            await groups.removalPreview(fam.organizer.userId, fam.groupId, fam.organizer.userId),
        ).toEqual({ plans: [] });
        await expect(
            groups.removalPreview(plain.userId, fam.groupId, fam.organizer.userId),
        ).rejects.toMatchObject({ status: 403 });
    });

    test('a member removed while they pay for a paused plan has it revoked, once the remover confirms it', async () => {
        const { fam, subscription, plain } = await pausedPayer();
        const call = await removal(fam, [plain], []);
        // Asked first: the plan is named, nothing ends and nobody is removed.
        expect(
            await refusal(
                groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, call),
            ),
        ).toEqual({
            code: 'ends-lapsed',
            status: 409,
            data: { plans: [{ id: subscription.id, name: 'Family', standing: 'paused' }] },
        });
        expect(polar.revokes).toEqual([]);
        expect(await state(fam.groupId, plain.userId)).toBe('active');
        // Confirming another plan than the one found ends nothing: asked again.
        expect(
            await refusal(
                groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
                    ...call,
                    endsLapsed: ['sub_some_other'],
                }),
            ),
        ).toMatchObject({ code: 'ends-lapsed' });
        expect(polar.revokes).toEqual([]);
        // The removal's own preview names it the same way, before anything is changed.
        expect(
            await groups.removalPreview(fam.organizer.userId, fam.groupId, plain.userId),
        ).toEqual({
            plans: [{ id: subscription.id, name: 'Family', standing: 'paused' }],
        });
        // Confirmed: the same call, ending it.
        await groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
            ...call,
            endsLapsed: [subscription.id],
        });
        expect(await state(fam.groupId, plain.userId)).toBe('removed');
        expect(polar.revokes).toEqual([subscription.id]);
        expect(subscription.ended_at).toBeTruthy();
    });

    test('a removal that doesn’t mark the payer left ends nothing', async () => {
        const { fam, subscription, plain, third } = await pausedPayer(true);
        // A roster that marks someone else left while it claims to remove the payer.
        const wrong = await removal(fam, [third!], [plain]);
        expect(
            await refusal(
                groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
                    ...wrong,
                    endsLapsed: [subscription.id],
                }),
            ),
        ).toMatchObject({ status: 400 });
        expect(polar.revokes).toEqual([]);
        expect(subscription.ended_at).toBeNull();
        expect(await state(fam.groupId, plain.userId)).toBe('active');
    });

    test('a removal refused for a departure it doesn’t mark left ends nothing', async () => {
        const { fam, subscription, plain, third } = await pausedPayer(true);
        // Someone else left meanwhile, and the removal doesn't mark them: the write answers
        // left-due, and the plan is still there.
        expect(await groups.leave(third!.userId, fam.groupId)).toEqual({ state: 'left' });
        const stale = await removal(fam, [plain], [third!]);
        expect(
            await refusal(
                groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, {
                    ...stale,
                    endsLapsed: [subscription.id],
                }),
            ),
        ).toMatchObject({ code: 'left-due', status: 409 });
        expect(polar.revokes).toEqual([]);
        expect(subscription.ended_at).toBeNull();
        expect(await state(fam.groupId, plain.userId)).toBe('active');
    });

    test('a payer whose plan’s first payment still waits on the bank can’t leave or be removed yet; nothing ends', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 2);
        const plain = await kit.member();
        await kit.admitted(fam, plain);
        expect(
            await billingRepository.setGroupPayer(fam.groupId, fam.organizer.userId, plain.userId),
        ).toBe(true);
        subscription.status = 'incomplete';
        (subscription as Subscription & { created_at: string }).created_at = new Date(
            Date.now() - 60 * 60 * 1000,
        ).toISOString();
        await billing.reconcileGroup(fam.groupId);
        const waiting =
            'A checkout for the family’s Family plan is still waiting for the bank. Finish or abandon it, then try again tomorrow.';
        await expect(groups.leave(plain.userId, fam.groupId)).rejects.toMatchObject({
            code: 'payer',
            message: waiting,
        });
        // Refused before the remover is even asked to confirm ending it.
        const call = await removal(fam, [plain], []);
        await expect(
            groups.removeMember(fam.organizer.userId, fam.groupId, plain.userId, call),
        ).rejects.toMatchObject({
            code: 'payer',
            message:
                'A checkout for the family’s Family plan, which they pay for, is still waiting for the bank. Try again tomorrow.',
        });
        expect(polar.revokes).toEqual([]);
        expect(await state(fam.groupId, plain.userId)).toBe('active');
    });

    test('a payer who cancelled can leave; the family keeps the plan until it ends', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 2);
        const holder = await kit.member();
        await kit.admitted(fam, holder, ['billing', 'members']);
        subscription.cancel_at_period_end = true;
        await billing.reconcileGroup(fam.groupId);
        expect(await groups.leave(fam.organizer.userId, fam.groupId)).toEqual({ state: 'left' });
        expect((await groupsRepository.getGroupRow(fam.groupId))?.seatLimit).toBe(2);
        expect((await driveRepository.getStorage(fam.areaId))?.allowance).toBe(1024n ** 4n);
    });

    test('a newcomer who pays for a personal plan has its end queued once they are let in, not before', async () => {
        const fam = await kit.family();
        await onPlan(fam, 2);
        const newcomer = await kit.member();
        const jobs: { userId: string; groupId: string | null }[] = [];
        billing.setEndPersonalPlanQueue(async (job) => {
            jobs.push(job);
        });
        try {
            // Their own Pro, as HushOS's mirror of Polar holds it.
            await billingRepository.applyCustomerState({
                readingFrom: await billingRepository.readingStamp(),
                userId: newcomer.userId,
                provider: 'polar',
                customerId: 'cus_newcomer',
                subscriptions: [
                    {
                        id: 'sub_newcomer',
                        productId: 'pro',
                        productName: 'Pro (monthly)',
                        status: 'active',
                        recurringInterval: 'month',
                        amount: 1000,
                        currency: 'usd',
                        quotaBytes: 500n * 1024n ** 3n,
                        currentPeriodEnd: new Date(Date.now() + 10 * DAY),
                        cancelAtPeriodEnd: false,
                        endedAt: null,
                    },
                ],
                graceMs: 0,
            });
            const call = await admission(fam, newcomer);
            // Accepted and waiting: not pooled, so nothing ends.
            await billing.reconcileGroup(fam.groupId);
            expect(jobs).toEqual([]);
            await groups.admit(fam.organizer.userId, fam.groupId, newcomer.userId, call);
            expect(jobs).toEqual([
                expect.objectContaining({ userId: newcomer.userId, groupId: fam.groupId }),
            ]);
        } finally {
            billing.setEndPersonalPlanQueue(undefined);
        }
    });
});

/* A new family folder's call (route 21): its roster row, root, self-grant and the creator's grant. */
async function areaCall(fam: Awaited<ReturnType<typeof kit.family>>) {
    const areaSeed = randomBytes(16).toString('base64url');
    const areaId = scopedId('workspace', fam.groupId, areaSeed)!;
    const { at, call } = await kit.nextRoster(fam, fam.organizer, kit.entries(fam.h), {
        areas: [
            {
                workspaceId: areaId,
                workspaceKeyVersion: 1,
                commitment: await areaKeyCommitment(randomBytes(32)),
            },
        ],
    });
    return {
        ...call,
        area: {
            workspaceId: areaId,
            idSeed: areaSeed,
            root: await kit.rootWire(areaId, fam.organizer.who),
            selfGrant: kit.selfGrant(areaId),
        },
        grants: [
            await kit.grantWire(fam.groupId, areaId, 1, fam.organizer.who, fam.organizer.who, at),
        ],
    };
}

describe('places', () => {
    test('the family and its billing summary report the same paid limit, through a scheduled cut', async () => {
        const fam = await kit.family();
        await onPlan(fam, 3);
        const payer = { id: fam.organizer.userId, name: 'Maya', email: fam.organizer.email };
        const limits = async () => ({
            family: (await groups.getGroup(fam.organizer.userId, fam.groupId)).seats.limit,
            billing: await billing
                .getGroupBilling(payer, fam.groupId)
                .then((summary) => (summary.view === 'manage' ? summary.seats.limit : null)),
        });
        expect(await limits()).toEqual({ family: 3, billing: 3 });
        // A cut to two at renewal blocks the third place now, on both.
        await billing.setGroupUnits(payer, fam.groupId, 2);
        expect(await limits()).toEqual({ family: 2, billing: 2 });
    });
});

describe('a family without a plan', () => {
    test('invites nobody and makes no family folder, and stores nothing for trying', async () => {
        const fam = await kit.family();
        const before = await kit.head(fam.groupId);
        expect(
            await refusal(
                groups.invite(fam.organizer.userId, fam.groupId, {
                    email: 'sam@hushos.test',
                    roles: [],
                }),
            ),
        ).toMatchObject({ code: 'no-plan', status: 402 });
        // Its refusal names the family, as the person reads it.
        await expect(
            groups.invite(fam.organizer.userId, fam.groupId, {
                email: 'sam@hushos.test',
                roles: [],
            }),
        ).rejects.toThrow('Choose a plan for The Family first.');
        expect(await groupsRepository.listOpenInvitations(fam.groupId)).toEqual([]);
        expect(
            await refusal(
                groups.createArea(fam.organizer.userId, fam.groupId, await areaCall(fam)),
            ),
        ).toMatchObject({ code: 'no-plan', status: 402 });
        // The member list, and so its areas, are as they were.
        expect(await kit.head(fam.groupId)).toEqual(before);
    });

    test('with a plan it does both; once the plan ends it stops again', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 1);
        await groups.invite(fam.organizer.userId, fam.groupId, {
            email: 'sam@hushos.test',
            roles: [],
        });
        expect(await groupsRepository.listOpenInvitations(fam.groupId)).toHaveLength(1);
        expect(
            await groups.createArea(fam.organizer.userId, fam.groupId, await areaCall(fam)),
        ).toMatchObject({ version: 2 });

        // The plan ran out: the family keeps what it has, and adds no one and nothing.
        await endPlan(fam, subscription);
        expect(
            await refusal(
                groups.invite(fam.organizer.userId, fam.groupId, {
                    email: 'ana@hushos.test',
                    roles: [],
                }),
            ),
        ).toMatchObject({ code: 'no-plan', status: 402 });
        const head = await kit.head(fam.groupId);
        expect(
            await refusal(
                groups.createArea(fam.organizer.userId, fam.groupId, await areaCall(fam)),
            ),
        ).toMatchObject({ code: 'no-plan', status: 402 });
        expect(await kit.head(fam.groupId)).toEqual(head);
    });

    test('still deletes a family folder, with no plan ever or after one ended: deleting adds no storage', async () => {
        const deleteCall = async (
            fam: Awaited<ReturnType<typeof kit.family>>,
            workspaceId: string,
            version: number,
        ) =>
            (
                await kit.nextRoster(fam, fam.organizer, kit.entries(fam.h), {
                    areas: [tombstoneAt(workspaceId, version)],
                })
            ).call;
        // Never had a plan: its first folder goes.
        const never = await kit.family();
        // Tombstones are format 2's (design 2.10): the chain switches up at its next roster.
        never.h.format = 2;
        await groups.deleteArea(
            never.organizer.userId,
            never.groupId,
            never.areaId,
            await deleteCall(never, never.areaId, 2),
        );
        expect(await kit.head(never.groupId)).toMatchObject({ rosterVersion: 2 });
        // A plan that ended: a folder made while it ran goes too, freeing its space.
        const ended = await kit.family();
        const subscription = await onPlan(ended, 1);
        const made = await areaCall(ended);
        await groups.createArea(ended.organizer.userId, ended.groupId, made);
        await endPlan(ended, subscription);
        ended.h.format = 2;
        await groups.deleteArea(
            ended.organizer.userId,
            ended.groupId,
            made.area.workspaceId,
            await deleteCall(ended, made.area.workspaceId, 2),
        );
        expect(await kit.head(ended.groupId)).toMatchObject({ rosterVersion: 3 });
    });

    test('an invitation sent while the plan ran can’t be accepted once it ends, and works again once renewed', async () => {
        const fam = await kit.family();
        const subscription = await onPlan(fam, 2);
        const sam = await kit.member();
        // Sent while the plan ran (the token is in the mail; the kit makes one it can read).
        const token = randomBytes(32).toString('base64url');
        await groupsRepository.createInvitation({
            groupId: fam.groupId,
            email: sam.email,
            normalizedEmail: sam.email,
            tokenHash: createHash('sha256').update(token).digest(),
            roles: [],
            invitedBy: fam.organizer.userId,
            expiresAt: new Date(Date.now() + DAY),
        });
        await endPlan(fam, subscription);
        expect(
            await refusal(groups.acceptInvitation(sam.userId, token, '203.0.113.9')),
        ).toMatchObject({
            code: 'no-plan',
            status: 402,
            data: { invitee: true },
        });
        expect(await state(fam.groupId, sam.userId)).toBeUndefined();
        await onPlan(fam, 2);
        expect(await groups.acceptInvitation(sam.userId, token, '203.0.113.9')).toMatchObject({
            state: 'accepted',
        });
    });

    test('someone outside the family hears that they are not in it, never whether it has a plan', async () => {
        const fam = await kit.family();
        const outsider = await kit.member();
        const answer = await refusal(
            groups.invite(outsider.userId, fam.groupId, { email: 'sam@hushos.test', roles: [] }),
        );
        expect(answer.code).toBe('not-member');
    });
});
