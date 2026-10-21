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
