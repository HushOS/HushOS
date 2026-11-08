import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/*
 * Notifications (docs/devices-design.md 5; docs/push-relay-plan.md). Off by default while the
 * clients that show them are built: with NOTIFICATIONS_ENABLED=false the notification routes
 * answer 501 and no event is recorded.
 *
 * PUSH_RELAY_URL is where pings for the apps go, `https://push.hushos.com` by default. Set it
 * empty to send none: the apps then see notifications only when they are open. The relay learns
 * that a handle got a ping from this server's address, and nothing about the account or what
 * happened (docs/self-hosting.md, Notifications).
 */
export const notificationsEnv = createEnv({
    server: {
        NOTIFICATIONS_ENABLED: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
        // Empty is meaningful here (no pings), so this env keeps empty strings as they are.
        PUSH_RELAY_URL: z
            .union([z.literal(''), z.url({ protocol: /^https?$/ })])
            .default('https://push.hushos.com')
            .transform((value) => (value === '' ? null : value.replace(/\/+$/, ''))),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: false,
});
