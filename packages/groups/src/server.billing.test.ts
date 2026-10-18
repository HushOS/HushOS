import type * as PolarSdk from '@polar-sh/sdk/2026-10';
import type { Member } from '../test/kit';
import { createHash, randomBytes } from 'node:crypto';
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
    // No order waits for payment here: every raise this fake accepts is paid, and each plan's
    // checkout order was paid, which is what gives the family its tier and pool.
    orders: {
        async list(query: { subscription_id?: string; status?: string }) {
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
const { closeDatabase, createTestAccount, resetDatabase } = await import('../../db/test/helpers');
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

    test('someone who made a family since accepting is refused before Polar is asked for a place', async () => {
        const fam = await kit.family();
        await onPlan(fam, 1);
        const newcomer = await kit.member();
        const call = await admission(fam, newcomer);
        // One family per account: theirs, made after they accepted.
        await kit.family(newcomer);
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
