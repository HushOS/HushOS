import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/* Settings every server process shares: the web app, the worker, the migration job. */
export const appEnv = createEnv({
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
        // The legal name of whoever runs this instance, shown in the terms and privacy
        // policy. Unset, those pages speak of "the organisation or person who hosts it".
        OPERATOR_NAME: z.string().trim().min(1).max(200).optional(),
        OPERATOR_JURISDICTION: z.string().trim().min(1).max(200).optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
