import '@/lib/server-only';
import { Elysia, t } from 'elysia';
import * as auth from '@hushos/auth/server';
import { guards, uuidSchema } from '@/lib/api/shared.server';
import {
    notificationResponse,
    notificationSettingsResponse,
    notificationsResponse,
    registeredResponse,
    unregisteredResponse,
} from '@/lib/api/notifications-responses.server';

/*
 * Notifications (/api/notifications; docs/devices-design.md 5). Per device: its relay handle, and
 * the events it fetches over its own session. 501 while NOTIFICATIONS_ENABLED is off.
 */
export const notificationsApi = new Elysia()
    .use(guards)
    .guard({ mutation: true, session: 'notifications' }, (app) =>
        app
            .get(
                '/notifications',
                { response: { 200: notificationsResponse } },
                ({ sessionToken }) => auth.listNotifications(sessionToken),
            )
            .put(
                '/notifications/registration',
                {
                    // The relay's handle; Web Push will add `{ kind: 'webpush', subscription }`.
                    body: t.Object({
                        kind: t.Literal('relay'),
                        handle: t.String({ pattern: auth.RELAY_HANDLE_PATTERN.source }),
                    }),
                    response: { 200: registeredResponse },
                },
                ({ sessionToken, body }) =>
                    auth.registerForNotifications(sessionToken, body.handle),
            )
            .delete(
                '/notifications/registration',
                // A JSON body ({}), as every mutation here: the request guard refuses one without.
                { body: t.Object({}), response: { 200: unregisteredResponse } },
                ({ sessionToken }) => auth.unregisterForNotifications(sessionToken),
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
                ({ sessionToken, params }) => auth.getNotification(sessionToken, params.id),
            ),
    );
