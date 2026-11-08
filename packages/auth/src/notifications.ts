import { notificationsRepository } from '@hushos/db';
import type { NotificationData, NotificationKind } from '@hushos/db/schema';
import { notificationsEnv } from '@hushos/env/notifications';
import { getSession } from './server';
import { AuthError } from './tokens';

/*
 * Notifications (docs/devices-design.md 5). Each event is a row; a push only names it, and the
 * device fetches it over its own session. Pings for the apps go to the relay
 * (`PUSH_RELAY_URL`, docs/push-relay-plan.md); Web Push comes later.
 *
 * Off by default (NOTIFICATIONS_ENABLED): then nothing is recorded and the routes answer 501.
 */

export function notificationsEnabled() {
    return notificationsEnv.NOTIFICATIONS_ENABLED;
}

/* A relay handle as the apps hand it over: 32 bytes, Base64url without padding. */
export const RELAY_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const PING_TIMEOUT_MS = 5_000;

/*
 * Pings each handle once. The relay answers every ping alike and retries nothing; a ping that
 * fails is a device that fetches the event with the rest when it next wakes, so failures are
 * counted for the caller's log and never raised.
 */
async function pingRelay(handles: string[], id: string, eventClass: 'security' | 'other') {
    const relay = notificationsEnv.PUSH_RELAY_URL;
    if (!relay || !handles.length) return { sent: 0, failed: 0 };
    const results = await Promise.allSettled(
        handles.map(async (handle) => {
            const response = await fetch(`${relay}/v1/ping`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ handle, id, class: eventClass }),
                signal: AbortSignal.timeout(PING_TIMEOUT_MS),
            });
            if (response.status !== 202) throw new Error(`relay ${response.status}`);
        }),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    return { sent: handles.length - failed, failed };
}

/*
 * Records an event for one account and pings its registered devices. Callers send it after the
 * action, as they do the email: the action already happened, so nothing here is raised.
 */
export async function notify<K extends NotificationKind>(
    userId: string,
    kind: K,
    data: NotificationData[K],
) {
    if (!notificationsEnabled()) return null;
    const recorded = await notificationsRepository.recordEvent({ userId, kind, data });
    if (!recorded) return null;
    const pinged = await pingRelay(recorded.handles, recorded.id, recorded.class);
    return { id: recorded.id, ...pinged };
}

/*
 * An invitation to a family, to the account its address belongs to (if any). The push says only
 * that there is one: the family's name is the inviter's words, and anyone can invite any address,
 * so they never reach the lock screen.
 */
export async function notifyFamilyInvitation(email: string, groupId: string, invitationId: string) {
    if (!notificationsEnabled()) return;
    const userId = await notificationsRepository.accountIdByEmail(email.trim().toLowerCase());
    if (userId) await notify(userId, 'family-invitation', { groupId, invitationId });
}

/* Someone accepted an invitation and waits to be let in: each member who can let them in is told. */
export async function notifyFamilyWaiting(groupId: string, waitingUserId: string) {
    if (!notificationsEnabled()) return;
    const holders = await notificationsRepository.memberHoldersOf(groupId);
    await Promise.all(
        holders
            .filter((userId) => userId !== waitingUserId)
            .map((userId) => notify(userId, 'family-waiting', { groupId })),
    );
}

/* ------------------------------------------------------------------------- */
/* The routes (/api/notifications)                                            */
/* ------------------------------------------------------------------------- */

function requireEnabled() {
    if (!notificationsEnabled())
        throw new AuthError('Notifications are not available on this server.', 501);
}

/* The signed-in device: notifications are per device, so a session without one has nothing here. */
async function requireDevice(sessionToken: string | null) {
    requireEnabled();
    const session = await getSession(sessionToken);
    if (!session) throw new AuthError('Sign in to manage notifications.', 401);
    if (!session.device)
        throw new AuthError('Set up this device before turning on notifications.', 409);
    return { userId: session.user.id, deviceId: session.device.id };
}

/* PUT /api/notifications/registration: this device's relay handle, replacing any it had. */
export async function registerForNotifications(sessionToken: string | null, handle: string) {
    const { userId, deviceId } = await requireDevice(sessionToken);
    if (!RELAY_HANDLE_PATTERN.test(handle)) throw new AuthError('That is not a push handle.');
    await notificationsRepository.putRegistration({ userId, deviceId, handle });
    return { registered: true as const };
}

/* DELETE /api/notifications/registration: no more pushes to this device. */
export async function unregisterForNotifications(sessionToken: string | null) {
    const { userId, deviceId } = await requireDevice(sessionToken);
    return { removed: await notificationsRepository.deleteRegistration(userId, deviceId) };
}

/* An event as a device reads it: each kind with its own data. */
export type NotificationView = {
    [K in NotificationKind]: { id: string; kind: K; data: NotificationData[K]; createdAt: string };
}[NotificationKind];

function eventView(event: notificationsRepository.NotificationEvent): NotificationView {
    return {
        id: event.id,
        kind: event.kind,
        data: event.data,
        createdAt: event.createdAt.toISOString(),
    } as NotificationView;
}

/* GET /api/notifications/:id: the event a push named. Any other id, or one past 30 days, is 404. */
export async function getNotification(sessionToken: string | null, id: string) {
    const { userId, deviceId } = await requireDevice(sessionToken);
    const event = await notificationsRepository.getEvent(userId, deviceId, id);
    if (!event) throw new AuthError('This notification is gone.', 404);
    return { notification: eventView(event) };
}

/* GET /api/notifications: what this device has not been handed yet, oldest first. */
export async function listNotifications(sessionToken: string | null) {
    const { userId, deviceId } = await requireDevice(sessionToken);
    const { events, more } = await notificationsRepository.listPending(userId, deviceId);
    return { notifications: events.map(eventView), more };
}

/* The signed-in account, for what is the account's rather than one device's. */
async function requireAccount(sessionToken: string | null) {
    requireEnabled();
    const session = await getSession(sessionToken);
    if (!session) throw new AuthError('Sign in to manage notifications.', 401);
    return session.user.id;
}

/* GET and PUT /api/notifications/settings: the toggles; security notices are not among them. */
export async function getNotificationSettings(sessionToken: string | null) {
    const userId = await requireAccount(sessionToken);
    return { settings: await notificationsRepository.getSettings(userId) };
}

export async function putNotificationSettings(
    sessionToken: string | null,
    settings: { shared: boolean; family: boolean },
) {
    const userId = await requireAccount(sessionToken);
    return { settings: await notificationsRepository.putSettings(userId, settings) };
}
