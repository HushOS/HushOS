import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, expect, test } from 'vitest';

// A worker started without billing: it can't read whether a family's plan still runs.
process.env.BILLING_PROVIDER = 'none';

const { closeDatabase, createTestAccount, createTestFamily, resetDatabase } =
    await import('../test/helpers');
const { db } = await import('./client');
const groups = await import('./groups');
const {
    groupBillingCustomers,
    groupBillingSubscriptions,
    groups: groupsTable,
    workspaces,
} = await import('./schema');

beforeEach(resetDatabase);
const DAY = 24 * 60 * 60 * 1000;
afterAll(closeDatabase);

/* A family dissolved past the retention, its folders already purged. */
async function dissolvedLongAgo() {
    const { userId } = await createTestAccount();
    const { groupId } = await createTestFamily({ organizerId: userId });
    const long = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await db.update(groupsTable).set({ dissolvedAt: long }).where(eq(groupsTable.id, groupId));
    await db.update(workspaces).set({ deletedAt: long }).where(eq(workspaces.groupId, groupId));
    await groups.purgeDeletedAreas(groups.DISSOLVED_FAMILY_RETENTION_DAYS);
    return groupId;
}

test('with billing off, a dissolved family whose mirror still holds a plan able to charge waits; one whose plans ended goes', async () => {
    const running = await dissolvedLongAgo();
    const ended = await dissolvedLongAgo();
    const never = await dissolvedLongAgo();
    const row = (groupId: string, id: string, endedAt: Date | null, status: string) => ({
        id,
        groupId,
        provider: 'polar',
        productId: 'prod_family',
        productName: 'Family (monthly)',
        status,
        recurringInterval: 'month',
        units: 4,
        includedMembers: 4,
        quotaBytes: 0n,
        currentPeriodStart: new Date(Date.now() - 2 * DAY),
        currentPeriodEnd: new Date(Date.now() + 28 * DAY),
        endedAt,
    });
    for (const groupId of [running, ended])
        await db.insert(groupBillingCustomers).values({
            groupId,
            provider: 'polar',
            providerCustomerId: `cus_${groupId.slice(0, 8)}`,
        });
    await db
        .insert(groupBillingSubscriptions)
        .values([
            row(running, 'sub_running', null, 'active'),
            row(ended, 'sub_ended', new Date(Date.now() - 60 * DAY), 'canceled'),
        ]);
    expect(
        await groups.purgeDissolvedFamilies(groups.DISSOLVED_FAMILY_RETENTION_DAYS),
    ).toMatchObject({ families: 2 });
    expect(await groups.getGroupRow(running)).not.toBeNull();
    expect(await groups.getGroupRow(ended)).toBeNull();
    expect(await groups.getGroupRow(never)).toBeNull();
});

test('with billing off, a plan set to end whose period is over has ended: its family goes; one set to end still in its period waits', async () => {
    const ranOut = await dissolvedLongAgo();
    const stillRunning = await dissolvedLongAgo();
    for (const groupId of [ranOut, stillRunning])
        await db.insert(groupBillingCustomers).values({
            groupId,
            provider: 'polar',
            providerCustomerId: `cus_${groupId.slice(0, 8)}`,
        });
    const row = (groupId: string, id: string, periodEnd: Date) => ({
        id,
        groupId,
        provider: 'polar',
        productId: 'prod_family',
        productName: 'Family (monthly)',
        // Set to end when the family was dissolved with billing on; billing was turned off since.
        status: 'active',
        cancelAtPeriodEnd: true,
        recurringInterval: 'month',
        units: 4,
        includedMembers: 4,
        quotaBytes: 0n,
        currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY),
        currentPeriodEnd: periodEnd,
        endedAt: null,
    });
    await db
        .insert(groupBillingSubscriptions)
        .values([
            row(ranOut, 'sub_ran_out', new Date(Date.now() - DAY)),
            row(stillRunning, 'sub_still', new Date(Date.now() + DAY)),
        ]);
    expect(
        await groups.purgeDissolvedFamilies(groups.DISSOLVED_FAMILY_RETENTION_DAYS),
    ).toMatchObject({ families: 1 });
    expect(await groups.getGroupRow(ranOut)).toBeNull();
    expect(await groups.getGroupRow(stillRunning)).not.toBeNull();
});
