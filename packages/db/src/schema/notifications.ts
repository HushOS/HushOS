import { sql } from 'drizzle-orm';
import {
    bigint,
    bigserial,
    boolean,
    check,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uuid,
} from 'drizzle-orm/pg-core';
import { accountDevices, users } from './auth';

/*
 * Notifications (docs/devices-design.md 5). A push carries nothing about what happened: each
 * event is a row here, the push names it by a random id, and the device fetches the row over its
 * own session and writes the notification itself.
 */

/* What an event can be, and whether it is a security notice (never off) or one a person can turn off. */
export const NOTIFICATION_KINDS = {
    'new-device': 'security',
    'device-removed': 'security',
    'devices-removed': 'security',
    'password-attempts': 'security',
    shared: 'other',
    'family-invitation': 'other',
    'family-waiting': 'other',
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
export type NotificationClass = (typeof NOTIFICATION_KINDS)[NotificationKind];

/* What each kind records: only facts the server already holds, never a name it cannot read. */
export type NotificationData = {
    'new-device': Record<string, never>;
    'device-removed': Record<string, never>;
    'devices-removed': { count: number };
    'password-attempts': Record<string, never>;
    shared: { granterUserId: string; shareId: string; role: 'viewer' | 'editor' };
    'family-invitation': { groupId: string; invitationId: string };
    'family-waiting': { groupId: string };
};

const kinds = Object.keys(NOTIFICATION_KINDS)
    .map((kind) => `'${kind}'`)
    .join(', ');

/*
 * One per device that asked for pushes: the relay handle its app was given (docs/devices-design.md
 * 5, "The relay"), never the APNs or FCM token, which only the relay holds. A device removed or
 * signed out has its registration deleted with its sessions (auth's endDeviceSessions, sign-out),
 * and one revoked as idle is swept by the cleanup job; pings skip revoked devices meanwhile.
 *
 * - list_seq: the newest event GET /api/notifications has handed this device, so a list returns
 *   only what came after.
 * - other_pinged_at, other_ping_open: when this device was last pinged for an `other` event, and
 *   whether it has fetched anything since. While a ping from the last minute is unfetched, no
 *   other `other` ping goes (the device fetches every pending event when it wakes).
 */
export const notificationRegistrations = pgTable(
    'notification_registrations',
    {
        deviceId: uuid('device_id')
            .primaryKey()
            .references(() => accountDevices.id, { onDelete: 'cascade' }),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        handle: text().notNull(),
        listSeq: bigint('list_seq', { mode: 'number' }).notNull().default(0),
        otherPingedAt: timestamp('other_pinged_at', { withTimezone: true }),
        otherPingOpen: boolean('other_ping_open').notNull().default(false),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index('notification_registrations_user_idx').on(table.userId),
        // A relay handle: 32 bytes, Base64url without padding.
        check(
            'notification_registrations_handle_valid',
            sql`${table.handle} ~ '^[A-Za-z0-9_-]{43}$'`,
        ),
    ],
);

/*
 * What happened, as only the server knows it: the kind, and the few facts it already holds (who
 * shared, which family). Never a name it cannot read. `id` is what a push names; `seq` orders an
 * account's events for a device's list. Kept 30 days.
 */
export const notificationEvents = pgTable(
    'notification_events',
    {
        seq: bigserial({ mode: 'number' }).primaryKey(),
        id: uuid().notNull().unique().defaultRandom(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        kind: text().$type<NotificationKind>().notNull(),
        data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index('notification_events_user_seq_idx').on(table.userId, table.seq),
        index('notification_events_created_idx').on(table.createdAt),
        check('notification_events_kind_valid', sql.raw(`kind in (${kinds})`)),
    ],
);

/*
 * The toggles a person can change (docs/devices-design.md 5, Settings). Security notices are not
 * here: they cannot be turned off. No row means the defaults, both on.
 */
export const notificationSettings = pgTable('notification_settings', {
    userId: uuid('user_id')
        .primaryKey()
        .references(() => users.id, { onDelete: 'cascade' }),
    shared: boolean().notNull().default(true),
    family: boolean().notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
