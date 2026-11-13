import '@/lib/server-only';
import { Elysia, t } from 'elysia';
import { Value } from 'typebox/value';
import * as auth from '@hushos/auth/server';
import { guards, uuidSchema } from '@/lib/api/shared.server';
import {
    notificationResponse,
    notificationSchema,
    notificationSettingsResponse,
    notificationsResponse,
    registeredResponse,
    unregisteredResponse,
    webPushKeyResponse,
} from '@/lib/api/notifications-responses.server';

/*
 * Notifications (/api/notifications; docs/devices-design.md 5). Per device: its relay handle, and
 * the events it fetches over its own session. 501 while NOTIFICATIONS_ENABLED is off.
 */
/*
 * Whether an event is one a device can be handed: its kind and data as the reply's schema has
 * them. One that is not (a row from a newer release after a rollback, or one a bug stored) is
 * left out here, by itself. Refused by the reply's own check instead, it would fail the whole
 * list, and the list has already moved the device past every event in that page: one bad row
 * would cost the device all the others.
 */
const readable = (notification: unknown) => Value.Check(notificationSchema, notification);

export const notificationsApi = new Elysia()
    .use(guards)
    .guard({ mutation: true, session: 'notifications' }, (app) =>
        app
            .get(
                '/notifications',
                { response: { 200: notificationsResponse } },
                async ({ sessionToken, log }) => {
                    const page = await auth.listNotifications(sessionToken);
                    const notifications = page.notifications.filter(readable);
                    const skipped = page.notifications.length - notifications.length;
                    // The operator's to see: the counts only, never what a row held.
                    if (skipped) log.set({ notifications: { unreadable: skipped } });
                    return { notifications, more: page.more };
                },
            )
            .put(
                '/notifications/registration',
                {
                    // The phone apps' relay handle, or a browser's Web Push subscription.
                    body: t.Union([
                        t.Object({
                            kind: t.Literal('relay'),
                            handle: t.String({ pattern: auth.RELAY_HANDLE_PATTERN.source }),
                        }),
                        t.Object({
                            kind: t.Literal('webpush'),
                            subscription: t.Object({
                                endpoint: t.String({ maxLength: 1024 }),
                                keys: t.Object({
                                    p256dh: t.String({ maxLength: 90 }),
                                    auth: t.String({ maxLength: 26 }),
                                }),
                            }),
                        }),
                    ]),
                    response: { 200: registeredResponse },
                },
                ({ sessionToken, body }) => auth.registerForNotifications(sessionToken, body),
            )
            .delete(
                '/notifications/registration',
                // A JSON body ({}), as every mutation here: the request guard refuses one without.
                { body: t.Object({}), response: { 200: unregisteredResponse } },
                ({ sessionToken }) => auth.unregisterForNotifications(sessionToken),
            )
            .get(
                '/notifications/web-push-key',
                { response: { 200: webPushKeyResponse } },
                ({ sessionToken }) => auth.getWebPushKey(sessionToken),
            )
            .get(
                '/notifications/settings',
                { response: { 200: notificationSettingsResponse } },
                ({ sessionToken }) => auth.getNotificationSettings(sessionToken),
            )
            .put(
                '/notifications/settings',
                {
                    body: t.Object({ shared: t.Boolean(), family: t.Boolean() }),
                    response: { 200: notificationSettingsResponse },
                },
                ({ sessionToken, body }) => auth.putNotificationSettings(sessionToken, body),
            )
            .get(
                '/notifications/:id',
                { params: t.Object({ id: uuidSchema }), response: { 200: notificationResponse } },
                async ({ sessionToken, params, log }) => {
                    const found = await auth.getNotification(sessionToken, params.id);
                    if (readable(found.notification)) return found;
                    // As for an event that is gone: the device shows its fallback text.
                    log.set({ notifications: { unreadable: 1 } });
                    throw new auth.AuthError('This notification is gone.', 404);
                },
            ),
    );
