import { createEnv } from '@t3-oss/env-nextjs';
import * as z from 'zod';

export const clientEnvs = createEnv({
    client: {
        NEXT_PUBLIC_DOMAIN: z.string(),
        NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL: z.string().url().optional(),
        NEXT_PUBLIC_COMMIT_SHA: z.string().default('none'),
    },
    experimental__runtimeEnv: {
        NEXT_PUBLIC_DOMAIN: process.env.NEXT_PUBLIC_DOMAIN,
        NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL: process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL,
        NEXT_PUBLIC_COMMIT_SHA: process.env.NEXT_PUBLIC_COMMIT_SHA,
    },
    emptyStringAsUndefined: true,
});

export type ClientEnvs = typeof clientEnvs;
