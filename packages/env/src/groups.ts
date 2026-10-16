import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/*
 * Groups (docs/groups-server.md). Off by default through milestone 1b: the
 * group routes answer as though they did not exist until GROUPS_ENABLED is
 * true. The 1c release turns it on, or removes it.
 *
 * Until pooled storage (1e), each group area gets its own allowance and each
 * group its own seat count, both from here; a group's own seat limit, once
 * billing writes one, wins over the default.
 */
export const groupsEnv = createEnv({
    server: {
        GROUPS_ENABLED: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
        // Active members a group may have, the creator included (Apple and Google families are 6).
        GROUP_SEAT_LIMIT_DEFAULT: z
            .string()
            .regex(/^[0-9]{1,5}$/)
            .default('6')
            .transform(Number)
            .refine((value) => value >= 1 && value <= 10_000, {
                message: 'GROUP_SEAT_LIMIT_DEFAULT must be between 1 and 10000.',
            }),
        /*
         * Until pooled plans (1e) charge areas to someone, each area's allowance is free:
         * these cap how much an account can hand itself. Areas per group, and live groups
         * one account may have created.
         */
        GROUP_AREA_LIMIT: z
            .string()
            .regex(/^[0-9]{1,4}$/)
            .default('10')
            .transform(Number)
            .refine((value) => value >= 1 && value <= 1024, {
                message: 'GROUP_AREA_LIMIT must be between 1 and 1024.',
            }),
        GROUP_OWNED_LIMIT: z
            .string()
            .regex(/^[0-9]{1,4}$/)
            .default('3')
            .transform(Number)
            .refine((value) => value >= 1 && value <= 1000, {
                message: 'GROUP_OWNED_LIMIT must be between 1 and 1000.',
            }),
        // The allowance each new group area starts with; default 10 GiB.
        GROUP_AREA_QUOTA_BYTES: z
            .string()
            .regex(/^[0-9]{1,16}$/)
            .default(String(10n * 1024n * 1024n * 1024n))
            .transform(BigInt),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
