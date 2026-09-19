import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/*
 * Two counters serialise Drive writes within a workspace. `change_seq` is taken by
 * every change to any node (the changed node keeps the value; a listing caches
 * against it and the change feed is a range on it). `key_epoch_seq` numbers every
 * node key epoch, so a rotation's target exceeds every epoch the workspace has had.
 * Every tree write locks the workspace row to take the next value.
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
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'workspaces_counters_valid',
            sql`${table.changeSeq} >= 0 and ${table.keyEpochSeq} >= 0 and ${table.tombstonesDroppedThrough} >= 0`,
        ),
    ],
);
