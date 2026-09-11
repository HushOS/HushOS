import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { appEnv } from './app';

/* The web app's auth settings, on top of the shared app settings. */
export const authEnv = createEnv({
    extends: [appEnv],
    server: {
        OPAQUE_SERVER_SETUP: z
            .string()
            .min(100)
            .max(2000)
            .regex(/^[A-Za-z0-9_-]+$/),
        OPAQUE_SERVER_SETUP_ID: z.string().min(1).max(100).default('primary'),
        // Behind a reverse proxy, the header that carries the real client address
        // (for example `x-forwarded-for` or `cf-connecting-ip`). Unset: the socket address.
        TRUSTED_PROXY_HEADER: z
            .string()
            .regex(/^[a-z0-9-]{1,64}$/)
            .optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
