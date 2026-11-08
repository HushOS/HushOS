import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { authRepository, billingRepository, db } from '@hushos/db';
import { driveObjects } from '@hushos/db/schema';
import { registered, sha256 } from '../../../../../packages/db/test/accounts';
import {
    closeDatabase,
    createTestFamily,
    resetDatabase,
    setTestAdmin,
    setTestUsedBytes,
} from '../../../../../packages/db/test/helpers';
import { loadApi } from '@/test/api-app';

/*
 * The operator's overview and workspace list, from real rows through the real routes. Much of
 * what they serve is raw SQL whose TypeScript type is only asserted (`sql<number>`, `sum()`,
 * `max()`), so the unit tests' typed samples cannot tell a count that comes back as a string or a
 * date that comes back unparsed. Here the route's response schema meets what Postgres really
 * returns: a mismatch is a 500 for the operator, and fails here first.
 */

const DAY = 24 * 60 * 60 * 1000;
const AUDITED = new Date('2026-11-01T09:30:00.000Z');
let api: Awaited<ReturnType<typeof loadApi>>;
let cookie: string;
let workspaceId: string;

const plan = (id: string, status: string) => ({
    paidTier: { productId: 'prod_family', quotaBytes: 100n },
    id,
    productId: 'prod_family',
    productName: 'Family (monthly)',
    status,
    recurringInterval: 'month',
    amount: 1500,
    currency: 'usd',
    units: 6,
    paidUnits: 6,
    pendingUnits: null,
    pendingProductId: null,
    includedMembers: 6,
    quotaBytes: 100n,
    currentPeriodStart: new Date(Date.now() - DAY),
    currentPeriodEnd: new Date(Date.now() + 29 * DAY),
    cancelAtPeriodEnd: false,
    endedAt: null,
});

beforeAll(async () => {
    await resetDatabase();
    // An operator signed in, as the admin pages are reached.
    const admin = await registered();
    workspaceId = admin.workspaceId;
    await setTestAdmin(admin.user.id);
    const token = randomBytes(32).toString('base64url');
    await authRepository.createSession({
        userId: admin.user.id,
        credentialVersion: 1,
        tokenHash: sha256(token),
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + DAY),
    });
    cookie = `hushos-session=${token}`;

    // Stored bytes, and objects in each state the overview counts: one ready and audited, one
    // missing (listed with its sizes and dates), one pending.
    await setTestUsedBytes(workspaceId, 5_000_000_000n);
    for (const [status, auditedAt] of [
        ['ready', AUDITED],
        ['missing', AUDITED],
        ['pending', null],
    ] as const) {
        const id = randomUUID();
        await db.insert(driveObjects).values({
            id,
            workspaceId,
            objectKey: `ws/${workspaceId}/${id}`,
            contentSuite: 2,
            chunkSize: 8 * 1024 * 1024,
            chunkCount: 1,
            contentNonce: Buffer.alloc(16),
            ciphertextSize: 3_000_000_116n,
            status,
            auditedAt,
        });
    }

    // A family with two plans that can both charge, one of them a change Polar would not keep.
    const { groupId } = await createTestFamily({ organizerId: admin.user.id, pooled: true });
    await billingRepository.applyGroupState({
        readingFrom: await billingRepository.readingStamp(),
        groupId,
        provider: 'polar',
        customerId: 'cus_family',
        subscriptions: [plan('sub_a', 'active'), plan('sub_b', 'unpaid')],
        graceMs: 3 * DAY,
    });
    await billingRepository.setReissueGaveUp('sub_a', new Date(), 'not-kept');
    // A deleted family's plan still billing, which HushOS has set out to end.
    const gone = randomUUID();
    const {
        paidTier: _,
        paidUnits: __,
        pendingUnits: ___,
        pendingProductId: ____,
        ...orphan
    } = plan('sub_orphan', 'active');
    await billingRepository.recordOrphanedSubscription(gone, orphan);
    await billingRepository.beginLapsedRevoke({
        subscriptionId: 'sub_orphan',
        userId: gone,
        at: new Date(),
        owner: 'run',
        leaseMs: 60_000,
    });

    api = await loadApi();
});

afterAll(closeDatabase);

const get = (path: string) =>
    api.handle(new Request(`http://localhost${path}`, { headers: { cookie } }));

test('the overview serves what Postgres holds, every raw count and date as its schema says', async () => {
    const response = await get('/api/admin/overview');
    expect(response.status).toBe(200);
    const overview = await response.json();
    expect(overview.people).toEqual({ total: 1, admins: 1 });
    expect(overview.workspaces.usedBytes).toBe('5000000000');
    expect(overview.objects).toMatchObject({
        total: 3,
        ready: 1,
        missing: 1,
        pending: 1,
        bytes: '3000000116',
        lastAuditedAt: AUDITED.toISOString(),
    });
    expect(overview.missing).toEqual([
        expect.objectContaining({
            workspaceId,
            ciphertextSize: '3000000116',
            auditedAt: AUDITED.toISOString(),
        }),
    ]);
    expect(overview.stuckPlanChanges).toEqual([
        expect.objectContaining({ subscriptionId: 'sub_a', reason: 'not-kept' }),
    ]);
    expect(overview.doubleCharges).toEqual([
        expect.objectContaining({
            kind: 'family',
            subscriptions: [
                { id: 'sub_a', status: 'active' },
                { id: 'sub_b', status: 'unpaid' },
            ],
        }),
    ]);
    expect(overview.orphanedPlans).toEqual([
        expect.objectContaining({ subscriptionId: 'sub_orphan' }),
    ]);
});

test('the workspace list serves its raw sizes and counts as its schema says, sorted by storage', async () => {
    const response = await get('/api/admin/workspaces?sort=stored');
    expect(response.status).toBe(200);
    const page = await response.json();
    const row = page.workspaces.find((entry: { id: string }) => entry.id === workspaceId);
    expect(row).toMatchObject({ usedBytes: '5000000000', missing: 1 });
    expect(typeof row.quotaBytes).toBe('string');
    expect(Date.parse(row.createdAt)).not.toBeNaN();
});
