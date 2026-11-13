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
    // Two-step sign-in's notices (docs/two-step-design.md 7), each under the name its email has.
    'two-step-on': 'security',
    'two-step-off': 'security',
    'two-step-app-added': 'security',
    'two-step-app-removed': 'security',
    'backup-codes-made': 'security',
    'backup-code-used': 'security',
    'phrase-used': 'security',
    'phrase-replaced': 'security',
    'password-reset': 'security',
    'account-key-rotated': 'security',
    'step-failed': 'security',
    'change-step-failed': 'security',
    'totp-frozen': 'security',
    // Passkeys and security keys (docs/two-step-design.md 3, 7).
    'two-step-key-added': 'security',
    'two-step-key-removed': 'security',
    'key-counter': 'security',
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
    'two-step-on': Record<string, never>;
    'two-step-off': Record<string, never>;
    'two-step-app-added': Record<string, never>;
    'two-step-app-removed': Record<string, never>;
    'backup-codes-made': Record<string, never>;
    /* How many backup codes the account has left, as the email says it. */
    'backup-code-used': { left: number };
    'phrase-used': Record<string, never>;
    'phrase-replaced': Record<string, never>;
    'password-reset': Record<string, never>;
    'account-key-rotated': Record<string, never>;
    'step-failed': Record<string, never>;
    'change-step-failed': Record<string, never>;
    'totp-frozen': Record<string, never>;
    'two-step-key-added': Record<string, never>;
    'two-step-key-removed': Record<string, never>;
    'key-counter': Record<string, never>;
    shared: { granterUserId: string; shareId: string; role: 'viewer' | 'editor' };
    'family-invitation': { groupId: string; invitationId: string };
    'family-waiting': { groupId: string };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (value: unknown) => typeof value === 'string' && UUID.test(value);
const isCount = (value: unknown, least: number, most: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most;

/* What each kind's data must be, field by field. A kind with no entry records nothing. */
const DATA_FIELDS: Partial<Record<NotificationKind, Record<string, (value: unknown) => boolean>>> =
    {
        'devices-removed': { count: (value) => isCount(value, 1, Number.MAX_SAFE_INTEGER) },
        // A set is ten codes and one was just used: nine at most are left, and none can be.
        'backup-code-used': { left: (value) => isCount(value, 0, 9) },
        shared: {
            granterUserId: isUuid,
            shareId: isUuid,
            role: (value) => value === 'viewer' || value === 'editor',
        },
        'family-invitation': { groupId: isUuid, invitationId: isUuid },
        'family-waiting': { groupId: isUuid },
    };

/*
 * Whether `data` is exactly what an event of `kind` records: every field its kind has, in
 * range, and no other. An event is refused before it is stored unless this holds, because a
 * device cannot use one that does not: its app refuses the event, and a field no kind has
 * could carry words to a lock screen.
 */
export function notificationDataValid(kind: NotificationKind, data: unknown) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
    const fields = DATA_FIELDS[kind] ?? {};
    const given = Object.keys(data);
    return (
        given.length === Object.keys(fields).length &&
        given.every((name) => fields[name]?.((data as Record<string, unknown>)[name]) === true)
    );
}

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
        // The phone apps' relay handle, or a browser's Web Push subscription: one or the other.
        handle: text(),
        webEndpoint: text('web_endpoint'),
        webP256dh: text('web_p256dh'),
        webAuth: text('web_auth'),
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
            sql`${table.handle} is null or ${table.handle} ~ '^[A-Za-z0-9_-]{43}$'`,
        ),
        // A browser's subscription: an HTTPS endpoint, its P-256 key (65 bytes) and auth secret (16).
        check(
            'notification_registrations_web_valid',
            sql`${table.webEndpoint} is null or (${table.webEndpoint} like 'https://%' and length(${table.webEndpoint}) <= 1024 and ${table.webP256dh} ~ '^[A-Za-z0-9_-]{87}$' and ${table.webAuth} ~ '^[A-Za-z0-9_-]{22}$')`,
        ),
        // One or the other, never both or neither.
        check(
            'notification_registrations_one_kind',
            sql`(${table.handle} is not null) <> (${table.webEndpoint} is not null)`,
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
