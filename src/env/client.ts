import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const clientEnvs = createEnv({
    client: {
        NEXT_PUBLIC_DOMAIN: z.string(),
        NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL: z.string().url().optional(),
    },
    experimental__runtimeEnv: {
        NEXT_PUBLIC_DOMAIN: process.env.NEXT_PUBLIC_DOMAIN,
        NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL: process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL,
    },
    emptyStringAsUndefined: true,
});

export type ClientEnvs = typeof clientEnvs;
