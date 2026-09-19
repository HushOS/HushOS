import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { workspaces } from './workspaces';

export const personalWorkspaces = pgTable('personal_workspaces', {
    userId: uuid('user_id')
        .primaryKey()
        .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
        .notNull()
        .unique()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
});

// Byte counts are bigint end to end. APIs serialize them as decimal strings.
export const workspaceStorage = pgTable(
    'workspace_storage',
    {
        workspaceId: uuid('workspace_id')
            .primaryKey()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        baseQuotaBytes: bigint('base_quota_bytes', { mode: 'bigint' }).notNull(),
        usedBytes: bigint('used_bytes', { mode: 'bigint' }).notNull().default(0n),
        reservedBytes: bigint('reserved_bytes', { mode: 'bigint' }).notNull().default(0n),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check(
            'workspace_storage_nonnegative',
            sql`${table.baseQuotaBytes} >= 0 and ${table.usedBytes} >= 0 and ${table.reservedBytes} >= 0`,
        ),
    ],
);

// An authenticated billing adapter can grant storage by a unique provider reference.
// No public quota-write API: checkout and webhook verification are a separate integration.
export const storageEntitlements = pgTable(
    'storage_entitlements',
    {
        id: uuid().defaultRandom().primaryKey(),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        source: text().notNull(),
        sourceReference: text('source_reference').notNull().unique(),
        quotaBytes: bigint('quota_bytes', { mode: 'bigint' }).notNull(),
        startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index('storage_entitlements_workspace_idx').on(table.workspaceId),
        check(
            'storage_entitlements_valid',
            sql`${table.quotaBytes} > 0 and (${table.expiresAt} is null or ${table.expiresAt} > ${table.startsAt})`,
        ),
    ],
);
