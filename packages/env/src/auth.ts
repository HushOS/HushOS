import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const authEnv = createEnv({
    server: {
        INITIAL_STORAGE_QUOTA_BYTES: z
            .string()
            .regex(/^[0-9]{1,16}$/)
            .default('1073741824')
            .transform(BigInt),
        APP_ORIGIN: z
            .url()
            .refine((value) => {
                const url = new URL(value);
                return (
                    url.pathname === '/' &&
                    !url.search &&
                    !url.hash &&
                    !url.username &&
                    !url.password &&
                    (url.protocol === 'https:' ||
                        (url.protocol === 'http:' &&
                            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
                );
            }, 'Use an HTTPS origin or HTTP localhost without a path, query, or credentials.')
            .transform((value) => new URL(value).origin),
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
