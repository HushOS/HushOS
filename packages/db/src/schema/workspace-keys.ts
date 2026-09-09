import { sql } from 'drizzle-orm';
import {
    check,
    index,
    integer,
    pgTable,
    primaryKey,
    smallint,
    timestamp,
    uuid,
} from 'drizzle-orm/pg-core';
import { bytea, users } from './auth';
import { workspaces } from './workspaces';

/*
 * One row per member per workspace: the workspace key wrapped under a key derived
 * from that member's account root. `key_version` is the member's root revision
 * that wrapped it; `workspace_key_version` is the workspace key's own epoch.
 */
export const workspaceKeys = pgTable(
    'workspace_keys',
    {
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        version: smallint().notNull().default(1),
        keyVersion: integer('key_version').notNull(),
        workspaceKeyVersion: integer('workspace_key_version').notNull().default(1),
        wrappingSalt: bytea('wrapping_salt').notNull(),
        wrappingNonce: bytea('wrapping_nonce').notNull(),
        encryptedKey: bytea('encrypted_key').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.workspaceId, table.userId] }),
        index('workspace_keys_user_idx').on(table.userId),
        check(
            'workspace_keys_versions_valid',
            sql`${table.version} = 1 and ${table.keyVersion} > 0 and ${table.workspaceKeyVersion} > 0`,
        ),
        check(
            'workspace_keys_lengths_valid',
            sql`octet_length(${table.wrappingSalt}) = 32 and octet_length(${table.wrappingNonce}) = 24 and octet_length(${table.encryptedKey}) = 48`,
        ),
    ],
);
