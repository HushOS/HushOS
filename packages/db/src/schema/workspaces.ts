import { sql } from 'drizzle-orm';
import {
    bigint,
    check,
    index,
    integer,
    pgTable,
    text,
    timestamp,
    unique,
    uuid,
} from 'drizzle-orm/pg-core';
import { groups } from './groups';

export type WorkspaceOwnerKind = 'personal' | 'group';
export type AreaKind = 'shared';

/*
 * Two counters serialise Drive writes within a workspace. `change_seq` is taken by
 * every change to any node (the changed node keeps the value; a listing caches
 * against it and the change feed is a range on it). `key_epoch_seq` numbers every
 * node key epoch, so a rotation's target exceeds every epoch the workspace has had.
 * Every tree write locks the workspace row to take the next value.
 *
 * A workspace is owned by a person (`personal`, with its `personal_workspaces`
 * row) or by a group (`group`, one of the group's areas: docs/groups-server.md 1).
 * An area carries its group, its kind and the id seed its id derives from under
 * the group (`scopedId('workspace', groupId, idSeed)`), which a grantee needs to
 * check the area belongs to the group. `workspace_key_version` is the current
 * workspace key; grants of older versions stay while a rotation runs.
 */
export const workspaces = pgTable(
    'workspaces',
    {
        id: uuid().defaultRandom().primaryKey(),
        changeSeq: bigint('change_seq', { mode: 'number' }).notNull().default(0),
        keyEpochSeq: integer('key_epoch_seq').notNull().default(0),
        /*
         * The highest change sequence of any tombstone the purge job has deleted. A
         * feed cursor below it may have missed a deletion, and the feed says so.
         */
        tombstonesDroppedThrough: bigint('tombstones_dropped_through', { mode: 'number' })
            .notNull()
            .default(0),
        // Defaults to personal so a container of the previous release, which knows no owner
        // kind, still creates sign-up workspaces during a rolling update.
        ownerKind: text('owner_kind').$type<WorkspaceOwnerKind>().notNull().default('personal'),
        // Restrict: a group's areas go before the group does (the 30-day deletion job, 1e).
        groupId: uuid('group_id').references(() => groups.id, { onDelete: 'restrict' }),
        areaKind: text('area_kind').$type<AreaKind>(),
        idSeed: text('id_seed'),
        workspaceKeyVersion: integer('workspace_key_version').notNull().default(1),
        // Set when a member who could open this area leaves or is removed; cleared by the rotation.
        rotationDueAt: timestamp('rotation_due_at', { withTimezone: true }),
        /*
         * A group area a manager deleted (its roster tombstone, docs/groups-design.md 2.10):
         * served to no one from then, and purged with everything in it after Drive's trash
         * retention (TRASH_RETENTION_DAYS).
         */
        deletedAt: timestamp('deleted_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'workspaces_counters_valid',
            sql`${table.changeSeq} >= 0 and ${table.keyEpochSeq} >= 0 and ${table.tombstonesDroppedThrough} >= 0`,
        ),
        check('workspaces_owner_kind_valid', sql`${table.ownerKind} in ('personal', 'group')`),
        check(
            'workspaces_owner_valid',
            sql`(${table.ownerKind} = 'group') = (${table.groupId} is not null) and (${table.areaKind} is not null) = (${table.groupId} is not null) and (${table.idSeed} is not null) = (${table.groupId} is not null)`,
        ),
        check(
            'workspaces_area_valid',
            sql`(${table.areaKind} is null or ${table.areaKind} = 'shared') and (${table.idSeed} is null or ${table.idSeed} ~ '^[A-Za-z0-9_-]{22}$') and ${table.workspaceKeyVersion} > 0`,
        ),
        // For composite foreign keys: a grant names its area and the area's group together.
        unique('workspaces_id_group').on(table.id, table.groupId),
        // A group's areas, and the restrict check when a group row goes.
        index('workspaces_group_idx')
            .on(table.groupId)
            .where(sql`${table.groupId} is not null`),
        // Only a group's areas are deleted this way, and the purge finds them by when.
        check(
            'workspaces_deleted_valid',
            sql`${table.deletedAt} is null or ${table.groupId} is not null`,
        ),
        index('workspaces_deleted_idx')
            .on(table.deletedAt)
            .where(sql`${table.deletedAt} is not null`),
    ],
);
