import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from './client';
import {
    accountDevices,
    groupMemberships,
    NOTIFICATION_KINDS,
    notificationEvents,
    notificationRegistrations,
    notificationSettings,
    type NotificationClass,
    type NotificationKind,
    users,
} from './schema';

/* Notifications (docs/devices-design.md 5); the tables are in schema/notifications.ts. */

/* While a device has an unfetched `other` ping this recent, no other `other` ping goes. */
export const OTHER_PING_COALESCE_MS = 60_000;
/* How long an event can be fetched; a device that slept longer finds it gone. */
export const NOTIFICATION_RETENTION_DAYS = 30;
/* The most a list hands a device at once; it asks again for the rest. */
export const NOTIFICATION_LIST_LIMIT = 100;

export type NotificationEvent = {
    id: string;
    kind: NotificationKind;
    data: Record<string, unknown>;
    createdAt: Date;
};

const eventColumns = {
    id: notificationEvents.id,
    kind: notificationEvents.kind,
    data: notificationEvents.data,
    createdAt: notificationEvents.createdAt,
};

const liveDevice = and(
    eq(accountDevices.id, notificationRegistrations.deviceId),
    isNull(accountDevices.revokedAt),
);

/*
 * Registers (or replaces) a device's relay handle. A new registration's list starts after the
 * newest event the account already has, so a device that just asked for pushes is not handed
 * everything from the last 30 days.
 */
export async function putRegistration(input: { userId: string; deviceId: string; handle: string }) {
    return db.transaction(async (tx) => {
        const [newest] = await tx
            .select({ seq: notificationEvents.seq })
            .from(notificationEvents)
            .where(eq(notificationEvents.userId, input.userId))
            .orderBy(desc(notificationEvents.seq))
            .limit(1);
        await tx
            .insert(notificationRegistrations)
            .values({
                deviceId: input.deviceId,
                userId: input.userId,
                handle: input.handle,
                listSeq: newest?.seq ?? 0,
            })
            .onConflictDoUpdate({
                target: notificationRegistrations.deviceId,
                // A device keeps its own place in the list when its handle changes.
                set: { handle: input.handle, updatedAt: sql`now()` },
                where: eq(notificationRegistrations.userId, input.userId),
            });
    });
}

/* Whether this device had a registration, now removed. */
export async function deleteRegistration(userId: string, deviceId: string) {
    const removed = await db
        .delete(notificationRegistrations)
        .where(
            and(
                eq(notificationRegistrations.deviceId, deviceId),
                eq(notificationRegistrations.userId, userId),
            ),
        )
        .returning({ deviceId: notificationRegistrations.deviceId });
    return removed.length > 0;
}

export async function getSettings(userId: string) {
    const [row] = await db
        .select({ shared: notificationSettings.shared, family: notificationSettings.family })
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, userId));
    return row ?? { shared: true, family: true };
}

export async function putSettings(userId: string, settings: { shared: boolean; family: boolean }) {
    await db
        .insert(notificationSettings)
        .values({ userId, ...settings })
        .onConflictDoUpdate({
            target: notificationSettings.userId,
            set: { ...settings, updatedAt: sql`now()` },
        });
    return settings;
}

/* The setting that turns a kind off, or none for a security notice. */
function settingOf(kind: NotificationKind): 'shared' | 'family' | null {
    if (NOTIFICATION_KINDS[kind] === 'security') return null;
    return kind === 'shared' ? 'shared' : 'family';
}

/*
 * Records an event for an account and says which handles to ping, or that the person turned this
 * kind off (nothing recorded). Security notices always go to every live registered device. An
 * `other` event skips a device that still has an unfetched `other` ping from the last minute: it
 * will fetch this one with the rest when it wakes. Those it pings are marked pinged in the same
 * transaction, so two events at once cannot both ping a device.
 */
export async function recordEvent(input: {
    userId: string;
    kind: NotificationKind;
    data?: Record<string, unknown>;
    now?: Date;
}): Promise<{ id: string; class: NotificationClass; handles: string[] } | null> {
    const eventClass = NOTIFICATION_KINDS[input.kind];
    const setting = settingOf(input.kind);
    if (setting && !(await getSettings(input.userId))[setting]) return null;
    const now = input.now ?? new Date();
    return db.transaction(async (tx) => {
        const [event] = await tx
            .insert(notificationEvents)
            .values({
                userId: input.userId,
                kind: input.kind,
                data: input.data ?? {},
                createdAt: now,
            })
            .returning({ id: notificationEvents.id });
        const registered = await tx
            .select({
                deviceId: notificationRegistrations.deviceId,
                handle: notificationRegistrations.handle,
                otherPingedAt: notificationRegistrations.otherPingedAt,
                otherPingOpen: notificationRegistrations.otherPingOpen,
            })
            .from(notificationRegistrations)
            .innerJoin(accountDevices, liveDevice)
            .where(eq(notificationRegistrations.userId, input.userId))
            .for('update', { of: notificationRegistrations });
        if (eventClass === 'security')
            return { id: event!.id, class: eventClass, handles: registered.map((r) => r.handle) };
        const coalesceFrom = now.getTime() - OTHER_PING_COALESCE_MS;
        const due = registered.filter(
            (r) =>
                !(r.otherPingOpen && r.otherPingedAt && r.otherPingedAt.getTime() > coalesceFrom),
        );
        if (due.length)
            await tx
                .update(notificationRegistrations)
                .set({ otherPingedAt: now, otherPingOpen: true })
                .where(
                    inArray(
                        notificationRegistrations.deviceId,
                        due.map((r) => r.deviceId),
                    ),
                );
        return { id: event!.id, class: eventClass, handles: due.map((r) => r.handle) };
    });
}

/* A fetch from this device answers its open ping, so the next `other` event pings it again. */
async function fetched(userId: string, deviceId: string) {
    await db
        .update(notificationRegistrations)
        .set({ otherPingOpen: false })
        .where(
            and(
                eq(notificationRegistrations.deviceId, deviceId),
                eq(notificationRegistrations.userId, userId),
                eq(notificationRegistrations.otherPingOpen, true),
            ),
        );
}

/* One of the account's events by the id a push named, or null for any other id or an expired one. */
export async function getEvent(userId: string, deviceId: string, id: string) {
    const [event] = await db
        .select(eventColumns)
        .from(notificationEvents)
        .where(
            and(
                eq(notificationEvents.id, id),
                eq(notificationEvents.userId, userId),
                gt(notificationEvents.createdAt, retentionStart()),
            ),
        );
    await fetched(userId, deviceId);
    return (event as NotificationEvent | undefined) ?? null;
}

/*
 * What this device has not been handed yet, oldest first, and moves its place past them. A device
 * that is not registered gets the account's events of the last 30 days, without a place to keep.
 */
export async function listPending(userId: string, deviceId: string) {
    return db.transaction(async (tx) => {
        const [registration] = await tx
            .select({ listSeq: notificationRegistrations.listSeq })
            .from(notificationRegistrations)
            .where(
                and(
                    eq(notificationRegistrations.deviceId, deviceId),
                    eq(notificationRegistrations.userId, userId),
                ),
            )
            .for('update');
        const rows = await tx
            .select({ seq: notificationEvents.seq, ...eventColumns })
            .from(notificationEvents)
            .where(
                and(
                    eq(notificationEvents.userId, userId),
                    gt(notificationEvents.seq, registration?.listSeq ?? 0),
                    gt(notificationEvents.createdAt, retentionStart()),
                ),
            )
            .orderBy(notificationEvents.seq)
            .limit(NOTIFICATION_LIST_LIMIT + 1);
        const page = rows.slice(0, NOTIFICATION_LIST_LIMIT);
        if (registration)
            await tx
                .update(notificationRegistrations)
                .set({
                    otherPingOpen: false,
                    ...(page.length ? { listSeq: page.at(-1)!.seq } : {}),
                })
                .where(eq(notificationRegistrations.deviceId, deviceId));
        return {
            events: page.map((row) => ({
                id: row.id,
                kind: row.kind,
                data: row.data,
                createdAt: row.createdAt,
            })),
            more: rows.length > NOTIFICATION_LIST_LIMIT,
        };
    });
}

function retentionStart() {
    return new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/* Deletes events past their 30 days, in batches until none are left; the cleanup job calls it. */
export async function purgeExpiredEvents(batchSize = 500) {
    let total = 0;
    for (;;) {
        const doomed = db
            .select({ seq: notificationEvents.seq })
            .from(notificationEvents)
            .where(lt(notificationEvents.createdAt, retentionStart()))
            .limit(batchSize);
        const removed = await db
            .delete(notificationEvents)
            .where(inArray(notificationEvents.seq, doomed))
            .returning({ seq: notificationEvents.seq });
        total += removed.length;
        if (removed.length < batchSize) return total;
    }
}

/* The account an invited address belongs to, if any: an invitation to it is also a notification. */
export async function accountIdByEmail(normalizedEmail: string) {
    const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.normalizedEmail, normalizedEmail))
        .limit(1);
    return row?.id ?? null;
}

/* Who is told that someone waits to be let into a family: its active members who hold `members`. */
export async function memberHoldersOf(groupId: string) {
    const rows = await db
        .select({ userId: groupMemberships.userId })
        .from(groupMemberships)
        .where(
            and(
                eq(groupMemberships.groupId, groupId),
                eq(groupMemberships.state, 'active'),
                sql`'members' = any(${groupMemberships.roles})`,
            ),
        );
    return rows.map((row) => row.userId);
}
