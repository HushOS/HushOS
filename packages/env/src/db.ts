import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const postgresUrl = z
    .url()
    .refine(
        (value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
        'Use a PostgreSQL connection URL.',
    );
export const dbEnv = createEnv({
    server: { DATABASE_URL: postgresUrl, MIGRATION_DATABASE_URL: postgresUrl.optional() },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
