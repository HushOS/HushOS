import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../src/client';
import { personalWorkspaces, users, workspaceStorage, workspaces } from '../src/schema';

/* Empties every application table between tests; migrations and pg-boss are left alone. */
export async function resetDatabase() {
    const tables = await db.execute<{ tablename: string }>(
        sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => `"${row.tablename}"`).join(', ');
    if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}

/* A user with a personal workspace and base allowance, without the OPAQUE ceremony. */
export async function createTestAccount(input: { email?: string; quotaBytes?: bigint } = {}) {
    const email = input.email ?? `${randomUUID()}@hushos.test`;
    const [user] = await db
        .insert(users)
        .values({ name: 'Test', email, normalizedEmail: email, emailVerifiedAt: new Date() })
        .returning({ id: users.id });
    if (!user) throw new Error('Could not create the test user.');
    const [workspace] = await db.insert(workspaces).values({}).returning({ id: workspaces.id });
    if (!workspace) throw new Error('Could not create the test workspace.');
    await db.insert(personalWorkspaces).values({ userId: user.id, workspaceId: workspace.id });
    await db.insert(workspaceStorage).values({
        workspaceId: workspace.id,
        baseQuotaBytes: input.quotaBytes ?? 1_073_741_824n,
    });
    return { userId: user.id, workspaceId: workspace.id, email };
}

export async function closeDatabase() {
    await db.$client.end();
}
