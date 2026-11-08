import { authRepository, notificationsRepository } from '@hushos/db';
import type { NotificationData, NotificationKind } from '@hushos/db/schema';
import { notificationsEnv } from '@hushos/env/notifications';
import { log as serverLog } from '@hushos/logging';
import { authEnv } from '@hushos/env/auth';
import { getSession } from './server';
import { AuthError } from './tokens';
import {
    isPushEndpoint,
    isSubscriptionKey,
    makeVapidKeys,
    sendWebPush,
    vapidKeys,
    type VapidKeys,
} from './webpush';

/*
 * Notifications (docs/devices-design.md 5). Each event is a row; a push only names it, and the
 * device fetches it over its own session. Pings for the apps go to the relay
 * (`PUSH_RELAY_URL`, docs/push-relay-plan.md); browsers' go straight to their push service, signed
 * with this server's VAPID key (webpush.ts).
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
                // The relay never redirects; one that did would be sent the handle again.
                redirect: 'error',
            });
            // Nothing to read: release the connection.
            await response.body?.cancel();
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
    const [pinged, pushed] = await Promise.all([
        pingRelay(recorded.handles, recorded.id, recorded.class),
        pushToBrowsers(recorded.webPush, recorded.id, recorded.class),
    ]);
    // The counts only: a relay or push service that answers badly is the operator's to see.
    if (pinged.failed || pushed.failed)
        serverLog.warn({
            message: 'Some notification pings failed.',
            notifications: { kind, relay: pinged, webPush: pushed },
        });
    return { id: recorded.id, ...pinged, webPush: pushed };
}

let vapid: Promise<VapidKeys> | undefined;
/* This server's VAPID keys, made and stored at first use (docs/devices-design.md 5). */
function vapidKeysOnce() {
    vapid ??= authRepository
        .ensureServerSecret('webpush-vapid', () => JSON.stringify(makeVapidKeys()))
        .then((stored) =>
            vapidKeys(JSON.parse(stored) as { privateKey: string; publicKey: string }),
        )
        .catch((error: unknown) => {
            vapid = undefined;
            throw error;
        });
    return vapid;
}

/* Pushes the event id to each browser; a subscription its push service dropped is deleted. */
async function pushToBrowsers(
    targets: notificationsRepository.WebPushTarget[],
    id: string,
    eventClass: 'security' | 'other',
) {
    if (!targets.length) return { sent: 0, failed: 0, gone: 0 };
    const keys = await vapidKeysOnce();
    const outcomes = await Promise.all(
        targets.map(async (target) => {
            const outcome = await sendWebPush(
                keys,
                authEnv.APP_ORIGIN,
                target,
                id,
                eventClass === 'security' ? 'high' : 'normal',
            );
            if (outcome === 'gone')
                await notificationsRepository.dropWebSubscription(target.deviceId, target.endpoint);
            return outcome;
        }),
    );
    return {
        sent: outcomes.filter((o) => o === 'delivered').length,
        failed: outcomes.filter((o) => o === 'failed').length,
        gone: outcomes.filter((o) => o === 'gone').length,
    };
}

/* GET /api/notifications/web-push-key: the public key a browser subscribes with. */
export async function getWebPushKey(sessionToken: string | null) {
    await requireAccount(sessionToken);
    return { publicKey: (await vapidKeysOnce()).publicKey };
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
export type PushRegistration =
    | { kind: 'relay'; handle: string }
    | {
          kind: 'webpush';
          subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
      };

export async function registerForNotifications(
    sessionToken: string | null,
    registration: PushRegistration,
) {
    const { userId, deviceId } = await requireDevice(sessionToken);
    if (registration.kind === 'relay') {
        if (!RELAY_HANDLE_PATTERN.test(registration.handle))
            throw new AuthError('That is not a push handle.');
        await notificationsRepository.putRegistration({
            userId,
            deviceId,
            target: { handle: registration.handle },
        });
    } else {
        const { endpoint } = registration.subscription;
        // Base64url without padding, as some browsers send it padded.
        const keys = {
            p256dh: registration.subscription.keys.p256dh.replace(/=+$/, ''),
            auth: registration.subscription.keys.auth.replace(/=+$/, ''),
        };
        // Only the browsers' own push services: else this server would post wherever a client said.
        if (!isPushEndpoint(endpoint))
            throw new AuthError('This browser’s push service isn’t one HushOS can reach.');
        if (
            !/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) ||
            !/^[A-Za-z0-9_-]{22}$/.test(keys.auth) ||
            !isSubscriptionKey(keys.p256dh, keys.auth)
        )
            throw new AuthError('That is not a push subscription.');
        await notificationsRepository.putRegistration({
            userId,
            deviceId,
            target: { webPush: { endpoint, p256dh: keys.p256dh, auth: keys.auth } },
        });
    }
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
    const { userId } = await requireDevice(sessionToken);
    const event = await notificationsRepository.getEvent(userId, id);
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
