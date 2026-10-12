import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { appEnv } from './app';
import { opaqueEnv } from './opaque';

/* The web app's auth settings, on top of the shared app settings and the OPAQUE setup. */
export const authEnv = createEnv({
    extends: [appEnv, opaqueEnv],
    server: {
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
