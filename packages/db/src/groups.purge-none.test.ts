import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, expect, test } from 'vitest';

// A worker started without billing: it can't read whether a family's plan still runs.
process.env.BILLING_PROVIDER = 'none';

const { closeDatabase, createTestAccount, createTestFamily, resetDatabase } =
    await import('../test/helpers');
const { db } = await import('./client');
const groups = await import('./groups');
const { groupBillingCustomers, groups: groupsTable, workspaces } = await import('./schema');

beforeEach(resetDatabase);
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

test('with billing off, a dissolved family that ever had a billing customer waits; one that never did goes', async () => {
    const billed = await dissolvedLongAgo();
    const never = await dissolvedLongAgo();
    await db.insert(groupBillingCustomers).values({
        groupId: billed,
        provider: 'polar',
        providerCustomerId: 'cus_billed',
    });
    expect(
        await groups.purgeDissolvedFamilies(groups.DISSOLVED_FAMILY_RETENTION_DAYS),
    ).toMatchObject({ families: 1 });
    expect(await groups.getGroupRow(never)).toBeNull();
    expect(await groups.getGroupRow(billed)).not.toBeNull();
});
