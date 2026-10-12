import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/*
 * The OPAQUE server setup, on its own so the database package can derive the
 * server hash key from it without loading the rest of the auth settings.
 */
export const opaqueEnv = createEnv({
    server: {
        // Unset, the server makes one on first start and keeps it in the database.
        OPAQUE_SERVER_SETUP: z
            .string()
            .min(100)
            .max(2000)
            .regex(/^[A-Za-z0-9_-]+$/)
            .optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
