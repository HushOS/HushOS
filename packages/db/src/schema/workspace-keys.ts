import { sql } from 'drizzle-orm';
import {
    check,
    foreignKey,
    index,
    integer,
    pgTable,
    primaryKey,
    smallint,
    timestamp,
    uuid,
} from 'drizzle-orm/pg-core';
import { bytea, users } from './auth';
import { groupRosters, groups } from './groups';
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

/*
 * A group area's workspace key sealed to a member (docs/groups-design.md 2.6):
 * one per area, key version, grantee and grantee identity (readers take the
 * newest that opens). Older versions stay, since a
 * rotation under way still needs them. The composite key to the workspace
 * carries the group, so a grant can name neither another group's area nor a
 * personal workspace; the roster it names must be stored, by version and
 * digest together.
 */
export const areaGrants = pgTable(
    'area_grants',
    {
        workspaceId: uuid('workspace_id').notNull(),
        workspaceKeyVersion: integer('workspace_key_version').notNull(),
        granteeUserId: uuid('grantee_user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        granteeKeyVersion: integer('grantee_key_version').notNull(),
        granterUserId: uuid('granter_user_id').notNull(),
        rosterVersion: integer('roster_version').notNull(),
        rosterDigest: bytea('roster_digest').notNull(),
        envelope: bytea().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        // One row per grantee identity: a grant to a newer identity never replaces one that opens.
        primaryKey({
            columns: [
                table.workspaceId,
                table.workspaceKeyVersion,
                table.granteeUserId,
                table.granteeKeyVersion,
            ],
        }),
        index('area_grants_grantee_idx').on(table.granteeUserId),
        index('area_grants_group_idx').on(table.groupId, table.granteeUserId),
        foreignKey({
            name: 'area_grants_workspace_fk',
            columns: [table.workspaceId, table.groupId],
            foreignColumns: [workspaces.id, workspaces.groupId],
        }).onDelete('cascade'),
        foreignKey({
            name: 'area_grants_roster_fk',
            columns: [table.groupId, table.rosterVersion, table.rosterDigest],
            foreignColumns: [groupRosters.groupId, groupRosters.version, groupRosters.digest],
        }),
        check(
            'area_grants_valid',
            sql`${table.workspaceKeyVersion} >= 1 and ${table.granteeKeyVersion} >= 1 and ${table.rosterVersion} >= 1 and octet_length(${table.rosterDigest}) = 32 and octet_length(${table.envelope}) = 4565`,
        ),
    ],
);
