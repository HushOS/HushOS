import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const serverEnvs = createEnv({
    server: {
        DATABASE_URL: z.string().url(),
    },
    runtimeEnv: process.env,
});

export type ServerEnvs = typeof serverEnvs;
