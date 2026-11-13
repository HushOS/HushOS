import '@/lib/server-only';
import { t } from 'elysia';

/*
 * What /api/notifications answers (docs/devices-design.md 5). Each kind's data is spelled out:
 * only what the server already knows and the device needs to write its notice, and nothing a
 * stray field could add on the way out.
 */

const uuid = t.String({ format: 'uuid' });
const at = { id: uuid, createdAt: t.String() };

/* One event as the device fetches it, told apart by `kind`. */
export const notificationSchema = t.Union([
    t.Object({
        ...at,
        kind: t.Union([
            t.Literal('new-device'),
            t.Literal('device-removed'),
            t.Literal('password-attempts'),
            // Two-step sign-in's notices (docs/two-step-design.md 7): the kind says it all.
            t.Literal('two-step-on'),
            t.Literal('two-step-off'),
            t.Literal('two-step-app-added'),
            t.Literal('two-step-app-removed'),
            t.Literal('backup-codes-made'),
            t.Literal('phrase-used'),
            t.Literal('phrase-replaced'),
            t.Literal('password-reset'),
            t.Literal('account-key-rotated'),
            t.Literal('step-failed'),
            t.Literal('change-step-failed'),
            t.Literal('totp-frozen'),
            t.Literal('two-step-key-added'),
            t.Literal('two-step-key-removed'),
            t.Literal('key-counter'),
            // Approving on another device (12): the method's notices, and the prompt.
            t.Literal('two-step-device-added'),
            t.Literal('two-step-device-removed'),
            t.Literal('approval-request'),
        ]),
        data: t.Object({}),
    }),
    // How many backup codes are left, as the email says it: none to nine.
    t.Object({
        ...at,
        kind: t.Literal('backup-code-used'),
        data: t.Object({ left: t.Integer({ minimum: 0, maximum: 9 }) }),
    }),
    t.Object({
        ...at,
        kind: t.Literal('devices-removed'),
        data: t.Object({ count: t.Integer({ minimum: 1 }) }),
    }),
    // The device names the sender from its own pins and the item from the share's keys.
    t.Object({
        ...at,
        kind: t.Literal('shared'),
        data: t.Object({
            granterUserId: uuid,
            shareId: uuid,
            role: t.Union([t.Literal('viewer'), t.Literal('editor')]),
        }),
    }),
    t.Object({
        ...at,
        kind: t.Literal('family-invitation'),
        data: t.Object({ groupId: uuid, invitationId: uuid }),
    }),
    t.Object({
        ...at,
        kind: t.Literal('family-waiting'),
        data: t.Object({ groupId: uuid }),
    }),
]);

export const notificationResponse = t.Object({ notification: notificationSchema });
export const notificationsResponse = t.Object({
    notifications: t.Array(notificationSchema),
    more: t.Boolean(),
});
export const registeredResponse = t.Object({ registered: t.Literal(true) });
export const unregisteredResponse = t.Object({ removed: t.Boolean() });
/*
 * The toggles, and the push relay this server pings (`PUSH_RELAY_URL`): the phone apps register
 * there, and null means this server sends them no pushes.
 */
export const notificationSettingsResponse = t.Object({
    settings: t.Object({ shared: t.Boolean(), family: t.Boolean() }),
    relay: t.Union([t.String(), t.Null()]),
});
/* The VAPID public key a browser subscribes with: an uncompressed P-256 point, Base64url. */
export const webPushKeyResponse = t.Object({
    publicKey: t.String({ pattern: '^[A-Za-z0-9_-]{87}$' }),
});
